import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import { MetadataNode } from '../../ui/tree/TreeNode';
import type { NodeKind } from '../../ui/tree/TreeNodeModel';
import { UniversalPanelViewProvider } from '../../ui/views/universal/UniversalPanelViewProvider';

/**
 * Issue #61: получение конкретной версии из хранилища — отдельная команда контекстного
 * меню узла, стоящая сразу за обычным «Получить из хранилища», и только у узлов с
 * активным подключением к хранилищу. Меню строит приватный `getNodeActions`.
 */

const EXTENSION_ROOT = path.resolve(__dirname, '../../../');
const CATALOG_XML = path.join(EXTENSION_ROOT, 'example', '2.21', 'src', 'cf', 'Catalogs', 'Контрагенты.xml');

type UniversalServices = ConstructorParameters<typeof UniversalPanelViewProvider>[1];

interface NodeActionsApi {
  getNodeActions(node: MetadataNode): readonly { command: string }[];
}

function createProvider(): NodeActionsApi {
  const services = {
    state: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] },
    // Настоящий провайдер без конфигураций: getNodeActions спрашивает у него, есть ли расширения.
    treeProvider: new MetadataTreeProvider([], vscode.Uri.file(EXTENSION_ROOT), EXTENSION_ROOT),
    setTreeMessage: () => undefined,
    isProjectInitialized: () => true,
    refreshActionsView: () => undefined,
  } as unknown as UniversalServices;
  return new UniversalPanelViewProvider(vscode.Uri.file(EXTENSION_ROOT), services) as unknown as NodeActionsApi;
}

function catalogNode(contextValue: string): MetadataNode {
  const node = new MetadataNode({ label: 'Контрагенты', nodeKind: 'Catalog', xmlPath: CATALOG_XML }, vscode.TreeItemCollapsibleState.None);
  node.contextValue = contextValue;
  return node;
}

suite('UniversalPanelViewProvider — команда «Получить версию из хранилища…» (issue #61)', () => {
  test('узел подключён к хранилищу — updateToVersion сразу после repository.update', () => {
    const commands = createProvider().getNodeActions(catalogNode('Catalog-hasXml-repoConnected-repoUnlocked')).map((action) => action.command);

    const updateIndex = commands.indexOf('onecdev.repository.update');
    assert.ok(updateIndex >= 0, commands.join(', '));
    assert.strictEqual(commands[updateIndex + 1], 'onecdev.repository.updateToVersion');
  });

  test('узел без подключения к хранилищу — ни получения, ни получения версии', () => {
    const commands = createProvider().getNodeActions(catalogNode('Catalog-hasXml')).map((action) => action.command);

    assert.ok(!commands.includes('onecdev.repository.update'), commands.join(', '));
    assert.ok(!commands.includes('onecdev.repository.updateToVersion'), commands.join(', '));
  });
});

interface StateIconsApi {
  buildStateIcons(node: MetadataNode): readonly { title: string; icon: unknown }[];
}

function rootNode(kind: 'configuration' | 'extension', contextValue: string): MetadataNode {
  const node = new MetadataNode({ label: 'ТорговыйУчет', nodeKind: kind, xmlPath: CATALOG_XML }, vscode.TreeItemCollapsibleState.None);
  node.contextValue = contextValue;
  return node;
}

/** Issue #6: «Обновить статусы захватов» у корня и иконки чужого/своего захвата. */
suite('UniversalPanelViewProvider — статусы захватов (issue #6)', () => {
  const withRefresh: [string, MetadataNode][] = [
    ['корень конфигурации с подключением', rootNode('configuration', 'configuration-hasXml-repoConnected-repoUnlocked')],
    ['корень расширения с подключением', rootNode('extension', 'extension-hasXml-repoConnected-repoLocked')],
  ];
  for (const [title, node] of withRefresh) {
    test(`refreshLocks есть: ${title}`, () => {
      const commands = createProvider().getNodeActions(node).map((action) => action.command);
      assert.ok(commands.includes('onecdev.repository.refreshLocks'), commands.join(', '));
    });
  }

  const withoutRefresh: [string, MetadataNode][] = [
    ['корень без подключения', rootNode('configuration', 'configuration-hasXml-repoDisconnected')],
    ['объект с подключением', catalogNode('Catalog-hasXml-repoConnected-repoUnlocked')],
  ];
  for (const [title, node] of withoutRefresh) {
    test(`refreshLocks нет: ${title}`, () => {
      const commands = createProvider().getNodeActions(node).map((action) => action.command);
      assert.ok(!commands.includes('onecdev.repository.refreshLocks'), commands.join(', '));
    });
  }

  function icons(contextValue: string, title?: string): { title: string; icon: unknown }[] {
    const node = catalogNode(contextValue);
    node.repositoryLockTitle = title;
    return [...(createProvider() as unknown as StateIconsApi).buildStateIcons(node)];
  }

  test('чужой захват: иконка account и подсказка держателя; без подсказки — общий текст', () => {
    const foreign = icons('Catalog-hasXml-repoConnected-repoEditRestricted-repoUnlocked-repoForeignLocked', 'Захвачено: Petrov, 27.09.2026 10:00:00')[0];
    assert.deepStrictEqual(foreign, { title: 'Захвачено: Petrov, 27.09.2026 10:00:00', icon: { kind: 'codicon', name: 'account' } });
    assert.strictEqual(icons('Catalog-hasXml-repoConnected-repoUnlocked-repoForeignLocked')[0].title, 'Захвачено другим пользователем');
  });

  test('свой захват: подсказка с датой; без подсказки — прежний текст', () => {
    assert.deepStrictEqual(icons('Catalog-hasXml-repoConnected-repoLocked', 'Захвачено: Admin, 27.09.2026 10:00:00')[0],
      { title: 'Захвачено: Admin, 27.09.2026 10:00:00', icon: { kind: 'codicon', name: 'lock' } });
    assert.strictEqual(icons('Catalog-hasXml-repoConnected-repoLocked')[0].title, 'Захвачено в хранилище');
  });

  test('не захвачено: подсказка «вне проекта»; без подсказки — прежний текст', () => {
    const title = 'Захвачено вашим пользователем Admin вне проекта — захватите объект, чтобы редактировать';
    assert.deepStrictEqual(icons('Catalog-hasXml-repoConnected-repoUnlocked', title)[0], { title, icon: { kind: 'codicon', name: 'unlock' } });
    assert.strictEqual(icons('Catalog-hasXml-repoConnected-repoUnlocked')[0].title, 'Не захвачено в хранилище');
  });
});

/**
 * Issue #117: «История хранилища» у корня cf/cfe и «История в хранилище» у самостоятельных единиц
 * хранилища (объект, форма) — только при подключении; у реквизита, групп и узла расширений — нет.
 */
suite('UniversalPanelViewProvider — история хранилища (issue #117)', () => {
  const owner = { rootMetaKind: 'Catalog' as NodeKind, ownerObjectXmlPath: CATALOG_XML };
  function node(nodeKind: NodeKind, contextValue: string, metaContext?: typeof owner): MetadataNode {
    const item = new MetadataNode({ label: 'Узел', nodeKind, xmlPath: CATALOG_XML, ...(metaContext ? { metaContext } : {}) }, vscode.TreeItemCollapsibleState.None);
    item.contextValue = contextValue;
    return item;
  }

  type Expected = 'history' | 'objectHistory' | 'none';
  const cases: readonly [string, NodeKind, string, typeof owner | undefined, Expected][] = [
    ['корень cf', 'configuration', 'configuration-hasXml', undefined, 'history'],
    ['корень cfe', 'extension', 'extension-hasXml', undefined, 'history'],
    ['справочник', 'Catalog', 'Catalog-hasXml', undefined, 'objectHistory'],
    ['форма справочника', 'Form', 'Form-hasXml', owner, 'objectHistory'],
    ['реквизит', 'Attribute', 'Attribute-hasXml', owner, 'none'],
    ['группа «Общие»', 'group-common', 'group-common', undefined, 'none'],
    ['узел расширений', 'extensions-root', 'extensions-root', undefined, 'none'],
  ];
  for (const [name, kind, base, metaContext, expected] of cases) {
    for (const connected of [true, false]) {
      const want = connected ? expected : 'none';
      test(`${name}, ${connected ? 'подключено' : 'не подключено'} → ${want}`, () => {
        const ctx = connected ? `${base}-repoConnected-repoUnlocked` : `${base}-repoDisconnected`;
        const commands = createProvider().getNodeActions(node(kind, ctx, metaContext)).map((action) => action.command);
        const actual = ['history', 'objectHistory'].filter((c) => commands.includes(`onecdev.repository.${c}`));
        assert.deepStrictEqual(actual, want === 'none' ? [] : [want], commands.join(', '));
      });
    }
  }
});
