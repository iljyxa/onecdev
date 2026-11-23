import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConfigEntry } from '../../domain/Configuration';
import { MetadataNode } from '../../ui/tree/TreeNode';
import type { NodeKind } from '../../ui/tree/TreeNodeModel';
import { buildNodeMenu, type NodeMenuItemDto } from '../../ui/views/universal/nodeContextMenu';
import { isWebviewCommandAllowed } from '../../ui/views/webview/webviewCommandGuard';
import { createUniversalPanelFixture, flattenMenu, type UniversalPanelFixture } from './support/universalPanelHarness';
import { skipWithoutCorpus } from './support/corpus';

/**
 * Issue #187: контекстное меню узла — группы и подменю вместо плоского списка. Раскладку
 * задаёт `NODE_MENU_LAYOUT` (host), webview только рисует дерево `{group, children}`.
 */

const EXTENSION_ROOT = path.resolve(__dirname, '../../../');
const CF_ROOT = path.join(EXTENSION_ROOT, 'example', '2.20', 'src', 'cf');
const CATALOG_XML = path.join(CF_ROOT, 'Catalogs', 'Валюты.xml');
const ENTRIES: readonly ConfigEntry[] = [
  { kind: 'cf', rootPath: CF_ROOT },
  { kind: 'cfe', rootPath: path.join(EXTENSION_ROOT, 'example', '2.21', 'src', 'cfe', 'EVOLC') },
];

function makeNode(nodeKind: NodeKind, contextValue: string, xmlPath: string | null = CATALOG_XML): MetadataNode {
  const node = new MetadataNode({ label: 'Узел', nodeKind, ...(xmlPath ? { xmlPath } : {}) }, vscode.TreeItemCollapsibleState.None);
  node.contextValue = contextValue;
  return node;
}

function menuOf(node: MetadataNode, entries: readonly ConfigEntry[] = ENTRIES): NodeMenuItemDto[] {
  return buildNodeMenu(node, { getEntries: () => entries });
}

/** Верхний уровень: команда листа или `▸ <подменю>`. */
function topLevel(menu: readonly NodeMenuItemDto[]): string[] {
  return menu.map((item) => (item.children ? `▸ ${item.label}` : item.command));
}

function submenu(menu: readonly NodeMenuItemDto[], label: string): NodeMenuItemDto[] {
  return [...(menu.find((item) => item.children && item.label === label)?.children ?? [])];
}

/** Команды подменю с разделителями «|» там, где меняется группа. */
function withSeparators(items: readonly NodeMenuItemDto[]): string[] {
  const result: string[] = [];
  items.forEach((item, index) => {
    if (index > 0 && items[index - 1].group !== item.group) {result.push('|');}
    result.push(item.command.replace(/^onecdev\./, ''));
  });
  return result;
}

function assertWellFormed(menu: readonly NodeMenuItemDto[]): void {
  const leaves = flattenMenu(menu);
  const commands = leaves.map((item) => item.command);
  assert.deepStrictEqual(commands.filter((command, index) => commands.indexOf(command) !== index), [], 'дубли команд в меню');
  for (const item of menu) {
    assert.ok(item.group, `у пункта ${item.id} нет группы`);
    if (item.children) {
      assert.strictEqual(item.command, '', `подменю ${item.id} не должно исполнять команду`);
      assert.ok(item.id.startsWith('submenu:'), item.id);
      assert.ok(item.children.length > 0, `пустое подменю ${item.id}`);
      assert.ok(item.children.every((child) => !child.children), `вложенное подменю в ${item.id}`);
    }
  }
  for (const leaf of leaves) {
    assert.ok(leaf.command.startsWith('onecdev.') && leaf.id === leaf.command, `лист ${leaf.id} → ${leaf.command}`);
    assert.ok(leaf.label.trim() && leaf.icon, `у ${leaf.command} нет подписи или иконки`);
  }
}

suite('Контекстное меню узла — группы и подменю (issue #187)', () => {
  test('корень конфигурации, подключён к хранилищу: основное сверху, остальное в подменю', () => {
    const menu = menuOf(makeNode('configuration', 'configuration-hasXml-repoConnected-repoUnlocked'));
    assertWellFormed(menu);
    assert.deepStrictEqual(topLevel(menu), [
      'onecdev.showProperties',
      'onecdev.openXmlFile',
      '▸ База',
      '▸ Файлы',
      '▸ Хранилище',
      '▸ Проверка',
    ]);
    assert.deepStrictEqual(menu.map((item) => item.group), ['open', 'open', 'more', 'more', 'more', 'more']);
    assert.deepStrictEqual(withSeparators(submenu(menu, 'База')), ['importConfigurationFromDb', 'updateConfigurationInDb']);
    assert.deepStrictEqual(withSeparators(submenu(menu, 'Файлы')), ['dumpConfigurationToCf', 'loadConfigurationFromCf']);
    assert.deepStrictEqual(withSeparators(submenu(menu, 'Хранилище')), [
      'repository.lock', 'repository.commit', 'repository.update', 'repository.updateToVersion',
      'repository.refreshLocks', 'repository.history',
      '|', 'repository.setLabel', 'repository.report', 'repository.dump',
      '|', 'repository.addUser', 'repository.copyUsers',
      '|', 'repository.disconnect',
    ]);
    assert.deepStrictEqual(withSeparators(submenu(menu, 'Проверка')), ['configuration.info', 'configuration.validate']);
  });

  test('корень конфигурации: «Команд конфигурации/расширения» в меню нет — их заменяют подменю', () => {
    const commands = flattenMenu(menuOf(makeNode('configuration', 'configuration-hasXml-repoDisconnected'))).map((item) => item.command);
    assert.ok(!commands.includes('onecdev.showConfigActions'), commands.join(', '));
  });

  test('корень не подключён к хранилищу: в «Хранилище» только подключение и создание', () => {
    const menu = menuOf(makeNode('configuration', 'configuration-hasXml-repoDisconnected'));
    assertWellFormed(menu);
    assert.deepStrictEqual(withSeparators(submenu(menu, 'Хранилище')), ['repository.connect', 'repository.create']);
  });

  test('«Создать хранилище» — только у конфигурации без подключения', () => {
    const connected = flattenMenu(menuOf(makeNode('extension', 'extension-hasXml-repoConnected-repoLocked')));
    assert.ok(!connected.some((item) => item.command === 'onecdev.repository.create'));
    const unknown = submenu(menuOf(makeNode('configuration', 'configuration-hasXml')), 'Хранилище');
    assert.deepStrictEqual(withSeparators(unknown), ['repository.create']);
  });

  test('корень расширения: полное обновление — в «База», анализ — в «Проверка»', () => {
    const menu = menuOf(makeNode('extension', 'extension-hasXml-repoConnected-repoLocked'));
    assertWellFormed(menu);
    assert.deepStrictEqual(withSeparators(submenu(menu, 'База')), [
      'importConfigurationFromDb', 'updateConfigurationInDb', 'compileAndUpdateExtensionInDb',
    ]);
    assert.deepStrictEqual(withSeparators(submenu(menu, 'Проверка')), [
      'configuration.info', 'configuration.validate', 'cfe.analyzeExtension',
    ]);
    assert.strictEqual(submenu(menu, 'Хранилище')[0].command, 'onecdev.repository.unlock');
  });

  test('узел «Расширения»: подключение сверху, пакетные выгрузка/загрузка — в «Файлы»', () => {
    const menu = menuOf(makeNode('extensions-root', 'extensions-root-repoConnected', null));
    assertWellFormed(menu);
    assert.deepStrictEqual(topLevel(menu), ['onecdev.connectExtension', '▸ Файлы']);
    assert.deepStrictEqual(withSeparators(submenu(menu, 'Файлы')), ['dumpAllExtensionsToCfe', 'loadAllExtensionsFromCfe']);
  });

  test('справочник: свойства, XML и модули сверху, правка отдельной группой, хранилище и проверка — в подменю', () => {
    const menu = menuOf(makeNode('Catalog', 'Catalog-hasXml-repoConnected-repoUnlocked'));
    assertWellFormed(menu);
    assert.deepStrictEqual(topLevel(menu), [
      'onecdev.showProperties',
      'onecdev.openXmlFile',
      'onecdev.openObjectModule',
      'onecdev.openManagerModule',
      'onecdev.form.add',
      'onecdev.help.add',
      'onecdev.borrowToExtension',
      '▸ Хранилище',
      '▸ Проверка',
    ]);
    assert.deepStrictEqual(withSeparators(submenu(menu, 'Хранилище')), [
      'repository.lock', 'repository.commit', 'repository.update', 'repository.updateToVersion', 'repository.objectHistory',
    ]);
    assert.deepStrictEqual(withSeparators(submenu(menu, 'Проверка')), ['metadata.info', 'metadata.validate']);
  });

  test('без расширений в реестре «Добавить в расширение» нет; без хранилища нет и подменю «Хранилище»', () => {
    const menu = menuOf(makeNode('Catalog', 'Catalog-hasXml'), [{ kind: 'cf', rootPath: CF_ROOT }]);
    assertWellFormed(menu);
    assert.ok(!topLevel(menu).includes('onecdev.borrowToExtension'));
    assert.ok(!topLevel(menu).includes('▸ Хранилище'));
  });

  test('объект расширения: перехватчик в группе правки, заимствования нет', () => {
    const menu = menuOf(makeNode('Catalog', 'Catalog-hasXml-fromCfe-repoConnected-repoEditAllowed-repoLocked'));
    assertWellFormed(menu);
    const edit = menu.filter((item) => item.group === 'edit').map((item) => item.command);
    assert.ok(edit.includes('onecdev.cfe.addMethodInterceptor'), edit.join(', '));
    assert.ok(!edit.includes('onecdev.borrowToExtension'), edit.join(', '));
  });

  const checks: readonly [NodeKind, string[]][] = [
    ['Role', ['metadata.info', 'metadata.validate', 'role.info', 'role.validate']],
    ['Subsystem', ['metadata.info', 'metadata.validate', 'subsystem.info', 'subsystem.validate', 'interface.validate']],
    ['CommonTemplate', ['metadata.info', 'metadata.validate', 'mxl.info', 'mxl.validate', 'skd.info', 'skd.validate']],
    ['CommonForm', ['metadata.info', 'metadata.validate', 'form.info', 'form.validate']],
  ];
  for (const [kind, expected] of checks) {
    test(`${kind}: профильные проверки — в «Проверка»`, () => {
      const menu = menuOf(makeNode(kind, `${kind}-hasXml`));
      assertWellFormed(menu);
      assert.deepStrictEqual(withSeparators(submenu(menu, 'Проверка')), expected);
    });
  }

  test('обработка: БСП-регистрация и команды — в группе правки', () => {
    const edit = menuOf(makeNode('DataProcessor', 'DataProcessor-hasXml')).filter((item) => item.group === 'edit').map((item) => item.command);
    assert.deepStrictEqual(edit, [
      'onecdev.form.add', 'onecdev.help.add', 'onecdev.epf.bspInit', 'onecdev.epf.bspAddCommand', 'onecdev.borrowToExtension',
    ]);
  });

  test('группа «Справочники»: «Добавить» сверху, Свойств и проверок нет', () => {
    const node = new MetadataNode({
      label: 'Справочники',
      nodeKind: 'Catalog',
      addMetadataTarget: { kind: 'root', configRoot: CF_ROOT, configKind: 'cf', targetKind: 'Catalog' },
    }, vscode.TreeItemCollapsibleState.None);
    const menu = menuOf(node);
    assertWellFormed(menu);
    assert.deepStrictEqual(topLevel(menu), ['onecdev.addMetadata']);
  });

  test('пункт-подменю не исполняется из webview: его id не проходит guard команд', () => {
    const menu = menuOf(makeNode('configuration', 'configuration-hasXml-repoConnected-repoUnlocked'));
    const allCommands = flattenMenu(menu).map((item) => item.command);
    for (const item of menu.filter((entry) => entry.children)) {
      assert.strictEqual(isWebviewCommandAllowed(item.id, allCommands), false, item.id);
    }
  });
});

suite('Контекстное меню узла на реальном дереве (issue #187)', function () {
  this.timeout(60_000);
  let fixture: UniversalPanelFixture;
  let disposeFixture: (() => void) | undefined;

  suiteSetup(function () {
    skipWithoutCorpus(this);
    fixture = createUniversalPanelFixture();
    disposeFixture = () => fixture.dispose();
  });

  suiteTeardown(() => disposeFixture?.());

  test('корень конфигурации приходит в webview с подменю, листья подменю — прежние команды', () => {
    const configRoot = fixture.rootNodes.find((node) => node.kind === 'configuration');
    assert.ok(configRoot);
    const submenus = configRoot.actions.filter((action) => action.children);
    assert.deepStrictEqual(submenus.map((action) => action.label), ['База', 'Файлы', 'Хранилище', 'Проверка']);
    const fileItems = submenus.find((action) => action.label === 'Файлы')?.children?.map((action) => action.command);
    assert.deepStrictEqual(fileItems, ['onecdev.dumpConfigurationToCf', 'onecdev.loadConfigurationFromCf']);
  });

  test('выбор листа подменю шлёт ту же команду, что и прежний пункт верхнего уровня', async () => {
    const configRoot = fixture.rootNodes.find((node) => node.kind === 'configuration');
    assert.ok(configRoot);
    const leaf = configRoot.actions.find((action) => action.label === 'Проверка')?.children?.[0];
    assert.ok(leaf);
    assert.strictEqual(leaf.id, 'onecdev.configuration.info');

    const executed: unknown[][] = [];
    const original = vscode.commands.executeCommand;
    const registered = await vscode.commands.getCommands(true);
    const probe = registered.includes(leaf.id)
      ? undefined
      : vscode.commands.registerCommand(leaf.id, () => undefined);
    // Перехватываем вызов на границе с VS Code: сама команда (диалоги, CLI) тесту не нужна.
    (vscode.commands as { executeCommand: typeof original }).executeCommand = (async (command: string, ...args: unknown[]) => {
      if (command === leaf.id) {
        executed.push([command, ...args]);
        return undefined;
      }
      return original(command, ...args);
    }) as typeof original;
    try {
      fixture.send({ type: 'command', command: 'executeNodeAction', payload: { nodeId: configRoot.id, actionId: leaf.id } });
      const deadline = Date.now() + 10_000;
      while (executed.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      (vscode.commands as { executeCommand: typeof original }).executeCommand = original;
      probe?.dispose();
    }
    assert.strictEqual(executed.length, 1);
    assert.strictEqual(executed[0][0], 'onecdev.configuration.info');
    assert.ok(executed[0][1] instanceof MetadataNode);
  });
});
