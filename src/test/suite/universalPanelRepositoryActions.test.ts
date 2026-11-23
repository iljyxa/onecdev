import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import { MetadataNode } from '../../ui/tree/TreeNode';
import type { NodeKind } from '../../ui/tree/TreeNodeModel';
import type { RepositoryLockInfo } from '../../infra/repository/RepositoryLockState';
import { REPOSITORY_FOREIGN_LOCK_ICON, UniversalPanelViewProvider } from '../../ui/views/universal/UniversalPanelViewProvider';
import { collectNodeActions } from '../../ui/views/universal/nodeContextMenu';

/**
 * Issue #61: получение конкретной версии из хранилища — отдельная команда контекстного
 * меню узла, стоящая сразу за обычным «Получить из хранилища», и только у узлов с
 * активным подключением к хранилищу. Состав меню — `collectNodeActions` (`nodeContextMenu.ts`).
 */

const EXTENSION_ROOT = path.resolve(__dirname, '../../../');
const CATALOG_XML = path.join(EXTENSION_ROOT, 'example', '2.21', 'src', 'cf', 'Catalogs', 'Контрагенты.xml');

type UniversalServices = ConstructorParameters<typeof UniversalPanelViewProvider>[1];

/** Пункты меню узла плоским списком — условия появления не зависят от раскладки по подменю. */
function commandsOf(node: MetadataNode): string[] {
  return collectNodeActions(node, { getEntries: () => [] }).map((action) => action.command);
}

function createProvider(): UniversalPanelViewProvider {
  const services = {
    state: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] },
    // Настоящий провайдер без конфигураций: меню спрашивает у него, есть ли расширения.
    treeProvider: new MetadataTreeProvider([], vscode.Uri.file(EXTENSION_ROOT), EXTENSION_ROOT),
    setTreeMessage: () => undefined,
    isProjectInitialized: () => true,
    refreshActionsView: () => undefined,
  } as unknown as UniversalServices;
  return new UniversalPanelViewProvider(vscode.Uri.file(EXTENSION_ROOT), services);
}

function catalogNode(contextValue: string): MetadataNode {
  const node = new MetadataNode({ label: 'Контрагенты', nodeKind: 'Catalog', xmlPath: CATALOG_XML }, vscode.TreeItemCollapsibleState.None);
  node.contextValue = contextValue;
  return node;
}

suite('UniversalPanelViewProvider — команда «Получить версию из хранилища…» (issue #61)', () => {
  test('узел подключён к хранилищу — updateToVersion сразу после repository.update', () => {
    const commands = commandsOf(catalogNode('Catalog-hasXml-repoConnected-repoUnlocked'));

    const updateIndex = commands.indexOf('onecdev.repository.update');
    assert.ok(updateIndex >= 0, commands.join(', '));
    assert.strictEqual(commands[updateIndex + 1], 'onecdev.repository.updateToVersion');
  });

  test('узел без подключения к хранилищу — ни получения, ни получения версии', () => {
    const commands = commandsOf(catalogNode('Catalog-hasXml'));

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
      const commands = commandsOf(node);
      assert.ok(commands.includes('onecdev.repository.refreshLocks'), commands.join(', '));
    });
  }

  const withoutRefresh: [string, MetadataNode][] = [
    ['корень без подключения', rootNode('configuration', 'configuration-hasXml-repoDisconnected')],
    ['объект с подключением', catalogNode('Catalog-hasXml-repoConnected-repoUnlocked')],
  ];
  for (const [title, node] of withoutRefresh) {
    test(`refreshLocks нет: ${title}`, () => {
      const commands = commandsOf(node);
      assert.ok(!commands.includes('onecdev.repository.refreshLocks'), commands.join(', '));
    });
  }

});

/**
 * Issue #186: на узле одна иконка хранилища — замок отвечает «могу ли я править здесь»:
 * закрыт без своего захвата, открыт при своём, у чужого захвата — свой SVG «замок с человеком».
 */
suite('UniversalPanelViewProvider — иконка захвата в хранилище (issue #186)', () => {
  /** Webview с тождественным asWebviewUri — чтобы увидеть, какую пару SVG выбрал провайдер. */
  function provider(): StateIconsApi {
    const instance = createProvider() as unknown as StateIconsApi & { view: unknown };
    instance.view = { webview: { asWebviewUri: (uri: vscode.Uri) => uri } };
    return instance;
  }

  function svg(theme: 'light' | 'dark'): string {
    return vscode.Uri.joinPath(vscode.Uri.file(EXTENSION_ROOT), 'src', 'icons', theme, `${REPOSITORY_FOREIGN_LOCK_ICON}.svg`).toString();
  }

  const owner = { rootMetaKind: 'Catalog' as NodeKind, ownerObjectXmlPath: CATALOG_XML };
  const units: readonly [string, () => MetadataNode][] = [
    ['объект', () => catalogNode('Catalog-hasXml')],
    ['форма', () => new MetadataNode({ label: 'ФормаЭлемента', nodeKind: 'Form', xmlPath: CATALOG_XML, metaContext: owner }, vscode.TreeItemCollapsibleState.None)],
    ['корень', () => rootNode('configuration', 'configuration-hasXml')],
  ];
  const states: readonly [RepositoryLockInfo, string, string, unknown][] = [
    [{ state: 'free' }, '-repoEditRestricted-repoUnlocked', 'Не захвачено в хранилище — захватите, чтобы редактировать', { kind: 'codicon', name: 'lock' }],
    [{ state: 'own', user: 'Admin', lockedAt: '2026-09-27T10:00:00', confirmed: true, syncedAt: '2026-09-27T10:00:00' },
      '-repoEditAllowed-repoLocked', 'Захвачено: Admin, 27.09.2026 10:00:00', { kind: 'codicon', name: 'unlock' }],
    [{ state: 'own-elsewhere', user: 'Admin', lockedAt: '2026-09-27T10:00:00' }, '-repoEditRestricted-repoUnlocked',
      'Захвачено вашим пользователем Admin вне проекта, 27.09.2026 10:00:00 — захватите объект, чтобы редактировать', { kind: 'codicon', name: 'lock' }],
    [{ state: 'foreign', user: 'Petrov', lockedAt: '2026-09-27T10:00:00' }, '-repoEditRestricted-repoUnlocked-repoForeignLocked',
      'Захвачено: Petrov, 27.09.2026 10:00:00', 'foreign'],
    [{ state: 'foreign', user: 'Petrov', observedAt: '2026-09-27T10:00:00' }, '-repoEditRestricted-repoUnlocked-repoForeignLocked',
      'Захвачено: Petrov (по отказу захвата 27.09.2026 10:00:00)', 'foreign'],
  ];
  for (const [unit, make] of units) {
    for (const [lock, suffix, title, icon] of states) {
      test(`${unit}, ${lock.state}${'observedAt' in lock ? ' по отказу' : ''} → одна иконка «${title}»`, () => {
        const node = make();
        node.contextValue = `${String(node.contextValue)}-repoConnected${suffix}`;
        node.repositoryLock = lock;
        const expected = icon === 'foreign' ? { kind: 'asset', lightUri: svg('light'), darkUri: svg('dark') } : icon;
        assert.deepStrictEqual(provider().buildStateIcons(node), [{ title, icon: expected }]);
      });
    }
  }

  test('пара SVG «захвачено другим» есть в обеих темах', () => {
    for (const theme of ['light', 'dark'] as const) {
      assert.ok(fs.existsSync(vscode.Uri.parse(svg(theme)).fsPath), theme);
    }
  });

  test('без webview SVG «захвачено другим» не строится — иконка без изображения, подсказка остаётся', () => {
    const node = catalogNode('Catalog-hasXml-repoConnected-repoEditRestricted-repoUnlocked-repoForeignLocked');
    node.repositoryLock = { state: 'foreign', user: 'Petrov' };
    assert.deepStrictEqual((createProvider() as unknown as StateIconsApi).buildStateIcons(node), [{ title: 'Захвачено: Petrov', icon: { kind: 'none' } }]);
  });

  const withoutLock: readonly [string, () => MetadataNode, string][] = [
    ['реквизит', () => new MetadataNode({ label: 'ИНН', nodeKind: 'Attribute', xmlPath: CATALOG_XML, metaContext: owner }, vscode.TreeItemCollapsibleState.None),
      'Attribute-hasXml-repoConnected-repoEditRestricted-repoUnlocked'],
    ['группа «Справочники» (цель добавления в корень)', () => new MetadataNode({ label: 'Справочники', nodeKind: 'Catalog' }, vscode.TreeItemCollapsibleState.None),
      'Catalog-repoConnected-repoEditRestricted-repoUnlocked-repoForeignLocked'],
    ['группа «Реквизиты» (цель добавления в объект)', () => new MetadataNode({ label: 'Реквизиты', nodeKind: 'group-type' }, vscode.TreeItemCollapsibleState.None),
      'group-type-repoConnected-repoEditRestricted'],
  ];
  for (const [name, make, contextValue] of withoutLock) {
    test(`${name}: иконки хранилища нет`, () => {
      const node = make();
      node.contextValue = contextValue;
      assert.deepStrictEqual(provider().buildStateIcons(node), []);
    });
  }

  test('корень подключён, состояния захвата нет — «Подключено к хранилищу»; без подключения — ничего', () => {
    assert.deepStrictEqual(provider().buildStateIcons(rootNode('configuration', 'configuration-hasXml-repoConnected')),
      [{ title: 'Подключено к хранилищу', icon: { kind: 'codicon', name: 'database' } }]);
    assert.deepStrictEqual(provider().buildStateIcons(rootNode('extension', 'extension-hasXml-repoDisconnected')), []);
  });

  // Отображение сменилось, меню — нет: перехватчик (как и заимствование) скрыт по -repoEditRestricted,
  // «Захватить»/«Освободить» — по -repoUnlocked/-repoLocked.
  const menus: readonly [string, string, string[], string[]][] = [
    ['не захвачено', 'Catalog-hasXml-fromCfe-repoConnected-repoEditRestricted-repoUnlocked',
      ['onecdev.repository.lock'], ['onecdev.repository.unlock', 'onecdev.cfe.addMethodInterceptor']],
    ['захвачено мной', 'Catalog-hasXml-fromCfe-repoConnected-repoEditAllowed-repoLocked',
      ['onecdev.repository.unlock', 'onecdev.cfe.addMethodInterceptor'], ['onecdev.repository.lock']],
  ];
  for (const [name, contextValue, present, absent] of menus) {
    test(`меню не меняется: ${name}`, () => {
      const commands = commandsOf(catalogNode(contextValue));
      for (const command of present) {
        assert.ok(commands.includes(command), `${command} нет в ${commands.join(', ')}`);
      }
      for (const command of absent) {
        assert.ok(!commands.includes(command), `${command} есть в ${commands.join(', ')}`);
      }
    });
  }
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
        const commands = commandsOf(node(kind, ctx, metaContext));
        const actual = ['history', 'objectHistory'].filter((c) => commands.includes(`onecdev.repository.${c}`));
        assert.deepStrictEqual(actual, want === 'none' ? [] : [want], commands.join(', '));
      });
    }
  }
});
