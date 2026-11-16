import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { RepositoryHistoryService } from '../../infra/repository/history/RepositoryHistoryService';
import { RepositoryService, type RepositoryNodeRef } from '../../infra/repository/RepositoryService';
import {
  openRepositoryHistory,
  registerRepositoryHistoryCommands,
  type RepositoryHistoryCommandServices,
  type RepositoryHistoryNotifier,
} from '../../ui/commands/repository/RepositoryHistoryCommands';
import { RepositoryHistoryViewProvider } from '../../ui/views/repositoryHistory/RepositoryHistoryViewProvider';
import { type FakeWebviewPanelFactory, installFakeWebviewPanels } from './support/fakeWebviewPanel';

/**
 * Команды «История хранилища» (корень) и «История в хранилище» (объект) (#117): узел дерева →
 * область панели. Настоящие RepositoryService над копиями example/2.21/src/cf и EVOLC, настоящие
 * сервис истории и провайдер; подменены панель (headless-хост) и сессия — «не подключено», чтобы
 * панель не ходила в сеть. Ожидаемый uuid — из ConfigDumpInfo.xml копии, независимо от production-кода.
 */

const ROOT = path.resolve(__dirname, '../../../');
const EXAMPLE_CF = path.join(ROOT, 'example', '2.21', 'src', 'cf');
const EXAMPLE_EVOLC = path.join(ROOT, 'example', '2.21', 'src', 'cfe', 'EVOLC');

function secrets(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

function dumpInfoId(root: string, name: string): string {
  const text = fs.readFileSync(path.join(root, 'ConfigDumpInfo.xml'), 'utf-8');
  const match = new RegExp(`<Metadata name="${name.replace(/\./g, '\\.')}" id="([0-9a-f-]{36})"`).exec(text);
  assert.ok(match, `${name} нет в ConfigDumpInfo.xml`);
  return match[1];
}

interface SpyNotifier extends RepositoryHistoryNotifier {
  readonly messages: { level: 'warning' | 'error'; message: string }[];
}

function spyNotifier(): SpyNotifier {
  const messages: { level: 'warning' | 'error'; message: string }[] = [];
  return {
    messages,
    warning: (message) => messages.push({ level: 'warning', message }),
    error: (message) => messages.push({ level: 'error', message }),
  };
}

suite('RepositoryHistoryCommands — открытие истории хранилища по узлу (#117)', () => {
  let workspaceRoot: string;
  let cf: string;
  let cfe: string;
  let panels: FakeWebviewPanelFactory;
  let history: RepositoryHistoryService;
  let services: RepositoryHistoryCommandServices;
  let notifier: SpyNotifier;
  const disposables: { dispose(): unknown }[] = [];

  suiteSetup(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-history-commands-'));
    cf = path.join(workspaceRoot, 'src', 'cf');
    cfe = path.join(workspaceRoot, 'src', 'cfe', 'EVOLC');
    fs.cpSync(EXAMPLE_CF, cf, { recursive: true });
    fs.cpSync(EXAMPLE_EVOLC, cfe, { recursive: true });
  });
  suiteTeardown(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  setup(() => {
    panels = installFakeWebviewPanels();
    history = new RepositoryHistoryService({
      resolveSession: () => Promise.resolve({ kind: 'disconnected' }),
      onError: (error) => assert.fail(String(error)),
    });
    services = {
      repositoryService: new RepositoryService(workspaceRoot, new ProjectSecretStorage(secrets(), workspaceRoot)),
      repositoryHistoryViewProvider: new RepositoryHistoryViewProvider(vscode.Uri.file(ROOT), history),
    };
    notifier = spyNotifier();
  });
  teardown(() => {
    for (const item of disposables.splice(0)) {
      item.dispose();
    }
    services.repositoryHistoryViewProvider.dispose();
    history.dispose();
    panels.restore();
  });

  const catalog = (): RepositoryNodeRef => ({ nodeKind: 'Catalog', label: 'Контрагенты', xmlPath: path.join(cf, 'Catalogs', 'Контрагенты.xml') });
  const form = (label: string): RepositoryNodeRef => {
    const owner = path.join(cf, 'Catalogs', 'Контрагенты.xml');
    return { nodeKind: 'Form', label, xmlPath: owner, metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: owner } };
  };

  function assertScope(configRoot: string, filter: { objectId: string; title: string } | undefined, title: string): void {
    const scope = history.view.scope;
    assert.ok(scope, 'область не установлена');
    assert.strictEqual(scope.target.configRoot, configRoot);
    assert.deepStrictEqual(scope.filter, filter);
    assert.strictEqual(panels.panels.length, 1);
    assert.strictEqual(panels.panels[0].panel.title, title);
    assert.deepStrictEqual(notifier.messages, []);
  }

  const roots: readonly [string, () => RepositoryNodeRef, () => string][] = [
    ['корень cf', () => ({ nodeKind: 'configuration', xmlPath: path.join(cf, 'Configuration.xml') }), () => cf],
    ['корень EVOLC', () => ({ nodeKind: 'extension', xmlPath: path.join(cfe, 'Configuration.xml') }), () => cfe],
  ];
  for (const mode of ['root', 'object'] as const) {
    for (const [name, node, root] of roots) {
      test(`${mode}: ${name} — вся история цели без фильтра`, () => {
        openRepositoryHistory(node(), mode, services, notifier);
        const target = services.repositoryService.resolveTargetByConfigRoot(root());
        assert.ok(target);
        assertScope(root(), undefined, `История хранилища: ${target.displayName}`);
      });
    }
  }

  test('root от узла-объекта — вся история его цели, без фильтра', () => {
    openRepositoryHistory(form('ФормаЭлемента'), 'root', services, notifier);
    const target = services.repositoryService.resolveTargetByConfigRoot(cf);
    assert.ok(target);
    assertScope(cf, undefined, `История хранилища: ${target.displayName}`);
  });

  test('object: справочник — фильтр по uuid его XML и заголовок с полным именем', () => {
    openRepositoryHistory(catalog(), 'object', services, notifier);
    const target = services.repositoryService.resolveTargetByConfigRoot(cf);
    assert.ok(target);
    assertScope(
      cf,
      { objectId: dumpInfoId(cf, 'Catalog.Контрагенты'), title: 'Справочник.Контрагенты' },
      `История хранилища: ${target.displayName} — Справочник.Контрагенты`,
    );
  });

  test('object: форма справочника — фильтр по uuid дескриптора формы', () => {
    openRepositoryHistory(form('ФормаЭлемента'), 'object', services, notifier);
    const target = services.repositoryService.resolveTargetByConfigRoot(cf);
    assert.ok(target);
    const title = 'Справочник.Контрагенты.Форма.ФормаЭлемента';
    assertScope(cf, { objectId: dumpInfoId(cf, 'Catalog.Контрагенты.Form.ФормаЭлемента'), title }, `История хранилища: ${target.displayName} — ${title}`);
  });

  const refused: readonly [string, 'root' | 'object', () => RepositoryNodeRef | undefined, { level: 'warning' | 'error'; message: string }][] = [
    ['root без узла', 'root', () => undefined, { level: 'error', message: 'Не удалось определить конфигурацию для выбранного узла.' }],
    ['object без узла', 'object', () => undefined, { level: 'error', message: 'Не удалось определить конфигурацию для выбранного узла.' }],
    ['root: узел вне выгрузки', 'root', () => ({ nodeKind: 'Catalog', xmlPath: path.join(workspaceRoot, 'Чужой.xml') }),
      { level: 'error', message: 'Не удалось определить конфигурацию для выбранного узла.' }],
    ['object: узел вне выгрузки', 'object', () => ({ nodeKind: 'Catalog', xmlPath: path.join(workspaceRoot, 'Чужой.xml') }),
      { level: 'error', message: 'Не удалось определить конфигурацию для выбранного узла.' }],
    ['object: реквизит', 'object', () => ({ ...form('ИНН'), nodeKind: 'Attribute' }),
      { level: 'warning', message: 'История в хранилище ведётся по объекту целиком: откройте историю объекта-владельца, его формы или макета.' }],
    ['object: XML формы нет', 'object', () => form('НетТакойФормы'),
      { level: 'error', message: 'Не удалось прочитать идентификатор объекта Справочник.Контрагенты.Форма.НетТакойФормы из его XML в выгрузке.' }],
  ];
  for (const [name, mode, node, message] of refused) {
    test(`${name} — сообщение, панель не открывается`, () => {
      openRepositoryHistory(node(), mode, services, notifier);
      assert.deepStrictEqual(notifier.messages, [message]);
      assert.strictEqual(panels.panels.length, 0);
      assert.strictEqual(history.view.scope, undefined);
    });
  }

  test('регистрация: обе команды выполняются через vscode.commands и объявлены в package.json, в палитре скрыты', async () => {
    const context = { subscriptions: [] as { dispose(): unknown }[] } as unknown as vscode.ExtensionContext;
    registerRepositoryHistoryCommands(context, services);
    disposables.push(...context.subscriptions);
    const registered = await vscode.commands.getCommands(true);
    assert.ok(registered.includes('onecdev.repository.history'));
    assert.ok(registered.includes('onecdev.repository.objectHistory'));

    await vscode.commands.executeCommand('onecdev.repository.objectHistory', catalog());
    assert.strictEqual(history.view.scope?.filter?.title, 'Справочник.Контрагенты');
    await vscode.commands.executeCommand('onecdev.repository.history', catalog());
    const rootScope = history.view.scope;
    assert.ok(rootScope);
    assert.strictEqual(rootScope.target.configRoot, cf);
    assert.strictEqual(rootScope.filter, undefined);
    assert.strictEqual(panels.panels.length, 1);

    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
      contributes: { commands: { command: string }[]; menus: { commandPalette: { command: string; when?: string }[] } };
    };
    assert.deepStrictEqual(
      manifest.contributes.commands.filter((item) => item.command.startsWith('onecdev.repository.') && item.command.endsWith('istory')),
      [
        { command: 'onecdev.repository.history', title: 'История хранилища', icon: '$(history)' },
        { command: 'onecdev.repository.objectHistory', title: 'История в хранилище', icon: '$(history)' },
      ],
    );
    for (const command of ['onecdev.repository.history', 'onecdev.repository.objectHistory']) {
      assert.deepStrictEqual(manifest.contributes.menus.commandPalette.filter((item) => item.command === command), [{ command, when: 'false' }]);
    }
  });
});
