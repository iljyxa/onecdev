import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import * as vscode from 'vscode';
import { BasedOnXmlService } from '../../infra/xml/BasedOnXmlService';
import { ConfigurationXmlEditor } from '../../infra/xml/ConfigurationXmlEditor';
import { ExchangePlanContentService } from '../../infra/xml/ExchangePlanContentService';
import { SubsystemXmlService } from '../../infra/xml/SubsystemXmlService';
import type { CommandServices } from '../../ui/commands/_shared';
import { registerShowPropertiesCommand } from '../../ui/commands/properties/ShowPropertiesCommand';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { PropertiesViewController } from '../../ui/views/properties/PropertiesViewController';
import { PropertiesViewProvider } from '../../ui/views/properties/PropertiesViewProvider';
import { type PropertiesPanelState, PropertiesViewSession } from '../../ui/views/properties/PropertiesViewSession';
import { NAVIGATOR_PROPERTIES_VIEW_ID, PROPERTIES_PLACEMENT_CONTEXT, PROPERTIES_VIEW_ID } from '../../ui/views/properties/propertiesViewPlacement';
import { TypeRegistryService } from '../../ui/views/properties/TypeRegistryService';

const root = path.resolve(__dirname, '../../..');

suite('PropertiesViewProvider (#205)', () => {
  let subscriptions: vscode.Disposable[];
  let context: vscode.ExtensionContext;
  let controller: PropertiesViewController;
  let session: PropertiesViewSession;
  let reads: string[];
  let errors: unknown[];

  setup(() => {
    subscriptions = [];
    reads = [];
    errors = [];
    const workspaceState = new Map<string, unknown>();
    context = {
      subscriptions,
      extensionUri: vscode.Uri.file(root),
      workspaceState: {
        get: (key: string) => workspaceState.get(key),
        update: (key: string, value: unknown) => {
          workspaceState.set(key, value);
          return Promise.resolve();
        },
      },
    } as unknown as vscode.ExtensionContext;
    controller = new PropertiesViewController(
      new SubsystemXmlService(),
      new ExchangePlanContentService(),
      new TypeRegistryService(),
      new ConfigurationXmlEditor(),
      new BasedOnXmlService(),
      {
        refreshActiveView: () => { void session.refresh(); },
        replaceActiveNode: (node) => { void session.selectNode(node); },
      }
    );
    session = new PropertiesViewSession((node) => {
      reads.push(node.textLabel);
      return controller.getViewState();
    });
  });

  teardown(async () => {
    await vscode.commands.executeCommand('setContext', PROPERTIES_PLACEMENT_CONTEXT, undefined);
    for (const item of subscriptions.reverse()) {
      item.dispose();
    }
    assert.deepEqual(errors, []);
  });

  function createProvider(viewId: string): PropertiesViewProvider {
    return new PropertiesViewProvider(context, viewId, session, controller, (error) => errors.push(error));
  }

  test('при открытии запрашивает текущий узел, а команды устаревшей панели не редактируют XML', async () => {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-properties-panel-'));
    const fixture = path.join(root, 'example/2.20/src/cf/Configuration.xml');
    const firstXml = path.join(configRoot, 'Configuration.xml');
    const secondXml = path.join(configRoot, 'Second', 'Configuration.xml');
    fs.mkdirSync(path.dirname(secondXml));
    fs.copyFileSync(fixture, firstXml);
    fs.copyFileSync(fixture, secondXml);
    const node = (label: string, xmlPath: string) =>
      new MetadataNode({ label, nodeKind: 'configuration', xmlPath }, vscode.TreeItemCollapsibleState.None);
    const first = node('Первая конфигурация', firstXml);
    const second = node('Вторая конфигурация', secondXml);
    const provider = createProvider(PROPERTIES_VIEW_ID);
    const states: PropertiesPanelState[] = [];
    const messages = new vscode.EventEmitter<unknown>();
    const visibility = new vscode.EventEmitter<void>();
    const disposal = new vscode.EventEmitter<void>();
    subscriptions.push(messages, visibility, disposal);
    const view = {
      visible: false,
      webview: {
        html: '',
        options: {},
        cspSource: 'vscode-webview://fake',
        asWebviewUri: (uri: vscode.Uri) => uri,
        onDidReceiveMessage: messages.event,
        postMessage: ({ state }: { state: PropertiesPanelState }) => {
          states.push(state);
          return Promise.resolve(true);
        },
      },
      onDidChangeVisibility: visibility.event,
      onDidDispose: disposal.event,
    };
    try {
      provider.resolveWebviewView(view as unknown as vscode.WebviewView);
      assert.match(view.webview.html, /"viewKind":"properties"/);
      provider.selectNode(first);
      messages.fire({ type: 'ready' });
      await setImmediate();
      assert.deepEqual(reads, []);

      view.visible = true;
      visibility.fire();
      await setImmediate();
      const firstVersion = states.at(-1)?.generation;
      assert.deepEqual(reads, [first.textLabel]);

      messages.fire({
        type: 'command', command: 'propertyChanged', viewVersion: firstVersion,
        payload: { key: 'Comment', value: 'Правка принята до смены выделения' },
      });
      provider.selectNode(second);
      assert.equal(controller.getActiveNode(), second);
      messages.fire({
        type: 'command', command: 'propertyChanged', viewVersion: firstVersion,
        payload: { key: 'Comment', value: 'Устаревшее изменение' },
      });
      await setImmediate();
      assert.deepEqual(reads, [first.textLabel, second.textLabel]);
      assert.equal(fs.readFileSync(firstXml, 'utf8'), fs.readFileSync(fixture, 'utf8'));
      assert.equal(fs.readFileSync(secondXml, 'utf8'), fs.readFileSync(fixture, 'utf8'));

      const secondVersion = states.at(-1)?.generation;
      messages.fire({
        type: 'command', command: 'propertyChanged', viewVersion: secondVersion,
        payload: { key: 'Comment', value: 'Записано через панель' },
      });
      messages.fire({
        type: 'command', command: 'propertyChanged', viewVersion: secondVersion,
        payload: { controlId: 'Comment', value: 'Сохранено из поля' },
      });
      messages.fire({
        type: 'command', command: 'propertyChanged', viewVersion: secondVersion,
        payload: { value: 'Поле не указано' },
      });
      await setImmediate();
      assert.match(fs.readFileSync(secondXml, 'utf8'), /<v8:content>Сохранено из поля<\/v8:content>/);
      messages.fire({
        type: 'command', command: 'clearFormProperty', viewVersion: secondVersion, payload: { key: 'DefaultMainForm' },
      });
      messages.fire({ type: 'command', command: 'clearFormProperty', viewVersion: secondVersion });
      await setImmediate();

      provider.handleMetadataRemoved(first);
      assert.equal(session.getActiveNode(), second);
      provider.handleMetadataRemoved(second);
      assert.equal(controller.getActiveNode(), undefined);
      assert.equal(states.at(-1)?.kind, 'empty');

      view.visible = false;
      visibility.fire();
      messages.fire({ type: 'command', command: 'clearFormProperty', viewVersion: secondVersion });
      const readsBeforeClose = reads.length;
      provider.selectNode(first);
      disposal.fire();
      provider.selectNode(undefined);
      await setImmediate();
      assert.equal(reads.length, readsBeforeClose);
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });

  test('регистрирует обе раскладки и открывает панель из меню или палитры', async () => {
    // Отдельные тестовые команды фиксируют фактический фокус через границу VS Code.
    const focusId = 'onecdevPropertiesTest.focus';
    const focuses: unknown[] = [];
    subscriptions.push(vscode.commands.registerCommand(focusId, (options: unknown) => { focuses.push(options); }));
    createProvider(NAVIGATOR_PROPERTIES_VIEW_ID).register();
    const provider = createProvider('onecdevPropertiesTest');
    provider.register();
    // Вторая регистрация проверяет современную ветку условия размещения.
    createProvider(PROPERTIES_VIEW_ID).register();

    registerShowPropertiesCommand(context, { propertiesViewProvider: provider } as CommandServices);
    const node = new MetadataNode({ label: 'Выбрано через меню', nodeKind: 'Catalog' }, vscode.TreeItemCollapsibleState.None);
    await vscode.commands.executeCommand('onecdev.openPropertiesView');
    await vscode.commands.executeCommand('onecdev.showProperties', node);
    assert.equal(session.getActiveNode(), node);
    assert.deepEqual(focuses, [undefined, undefined]);

    await Promise.all([provider.openByDefault(), provider.openByDefault()]);
    await provider.openByDefault();
    assert.deepEqual(focuses, [undefined, undefined, { preserveFocus: true }]);
  });
});
