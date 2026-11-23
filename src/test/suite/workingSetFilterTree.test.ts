import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildHashSnapshot, buildScopeKey, saveHashCache } from '../../infra/cache/HashCache';
import { UnloadedChangesScanner } from '../../infra/cache/UnloadedChangesScanner';
import { findConfigurations } from '../../infra/fs/ConfigLocator';
import { CONFIGURATION_ROOT_LOCK_NAME } from '../../infra/repository/RepositoryObjectNames';
import { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import type { MetadataNode } from '../../ui/tree/TreeNode';
import { WorkingSetFilterController, type WorkingSetFilterControllerDeps } from '../../ui/tree/WorkingSetFilterController';
import { createLockWorkspace, lockFixturePath, must, type LockWorkspace } from './support/repositoryLockFixtures';
import { createUniversalPanelFixture } from './support/universalPanelHarness';

/**
 * #189: фильтр дерева «изменённые и захваченные» — реальный `MetadataTreeProvider`,
 * `RepositoryService` и сканер хеш-кэша на копии `example/2.21/src/cf` (и EVOLC для расширения).
 * Видимое дерево читается настоящим `getChildren()`.
 */

const EXTENSION_ROOT = path.resolve(__dirname, '../../../');
const EXAMPLE_EVOLC = path.resolve(EXTENSION_ROOT, 'example/2.21/src/cfe/EVOLC');

interface Harness {
  readonly ws: LockWorkspace;
  readonly treeProvider: MetadataTreeProvider;
  readonly controller: WorkingSetFilterController;
  readonly logs: string[];
  dispose(): void;
}

interface HarnessOptions {
  readonly binding?: boolean;
  readonly extension?: boolean;
  readonly repository?: boolean;
  readonly controller?: Partial<WorkingSetFilterControllerDeps>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const ws = await createLockWorkspace(
    options.binding ? { repoPath: lockFixturePath('8.5.1'), repoUser: 'Admin', repoPassword: '' } : undefined
  );
  if (options.extension) {
    fs.cpSync(EXAMPLE_EVOLC, path.join(ws.workspaceRoot, 'src', 'cfe', 'EVOLC'), { recursive: true });
  }
  const repositoryService = options.repository === false ? undefined : ws.service;
  const treeProvider = new MetadataTreeProvider(
    findConfigurations(ws.workspaceRoot),
    vscode.Uri.file(EXTENSION_ROOT),
    ws.workspaceRoot,
    undefined,
    undefined,
    repositoryService
  );
  const logs: string[] = [];
  const controller = new WorkingSetFilterController({
    scanner: new UnloadedChangesScanner(ws.workspaceRoot),
    treeProvider,
    repositoryService,
    onDidChangeStatus: () => undefined,
    log: (message) => logs.push(message),
    ...options.controller,
  });
  return {
    ws,
    treeProvider,
    controller,
    logs,
    dispose: () => {
      controller.dispose();
      treeProvider.dispose();
      ws.dispose();
    },
  };
}

function saveBaseline(harness: Harness): void {
  saveHashCache(harness.ws.workspaceRoot, buildHashSnapshot(buildScopeKey('cf', harness.ws.configRoot), harness.ws.configRoot));
}

function cfFile(harness: Harness, ...segments: string[]): string {
  return path.join(harness.ws.configRoot, ...segments);
}

function edit(filePath: string): void {
  fs.appendFileSync(filePath, '\n// правка\n');
}

function label(node: MetadataNode): string {
  return typeof node.label === 'string' ? node.label : String(node.label?.label);
}

function labels(treeProvider: MetadataTreeProvider, node?: MetadataNode): string[] {
  return treeProvider.getChildren(node).map(label);
}

function child(treeProvider: MetadataTreeProvider, parent: MetadataNode | undefined, wanted: string): MetadataNode {
  const children = treeProvider.getChildren(parent);
  return must(children.find((node) => label(node) === wanted), `${wanted} среди ${children.map(label).join(', ')}`);
}

async function waitFor(probe: () => boolean, failureMessage: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!probe()) {
    if (Date.now() > deadline) {
      throw new Error(failureMessage);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const OBJECT_MODULE = ['Catalogs', 'ПричиныВозврата', 'Ext', 'ObjectModule.bsl'];
const CURRENCY_MANAGER = ['Catalogs', 'Валюты', 'Ext', 'ManagerModule.bsl'];

suite('#189 фильтр дерева «изменённые и захваченные»', () => {
  let harness: Harness | undefined;
  teardown(() => {
    harness?.dispose();
    harness = undefined;
  });

  test('изменён модуль объекта: корень → группа → объект, объект свёрнут со всеми детьми', async () => {
    harness = await createHarness();
    const { treeProvider, controller } = harness;
    saveBaseline(harness);
    edit(cfFile(harness, ...OBJECT_MODULE));

    await controller.toggle();

    assert.deepStrictEqual(controller.getStatus(), {
      active: true,
      pending: false,
      message: 'Фильтр: не загруженные в базу и захваченные (1)',
    });
    assert.deepStrictEqual(labels(treeProvider), ['ТорговыйУчет'], 'пустой узел «Расширения» скрыт');
    const root = child(treeProvider, undefined, 'ТорговыйУчет');
    assert.strictEqual(root.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    assert.deepStrictEqual(labels(treeProvider, root), ['Справочники']);
    const catalogs = child(treeProvider, root, 'Справочники');
    assert.deepStrictEqual(labels(treeProvider, catalogs), ['ПричиныВозврата']);
    const object = child(treeProvider, catalogs, 'ПричиныВозврата');
    assert.strictEqual(object.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.ok(treeProvider.getChildren(object).length > 0, 'дети отмеченного объекта доступны целиком');

    // Пауза и порог пачки по умолчанию: событие ждёт таймера, явный сброс пересчитывает сразу,
    // а dispose гасит оставшийся таймер.
    controller.notifyFileChanged(cfFile(harness, ...CURRENCY_MANAGER));
    edit(cfFile(harness, ...CURRENCY_MANAGER));
    controller.flushFileChanges();
    assert.deepStrictEqual(
      labels(treeProvider, child(treeProvider, child(treeProvider, undefined, 'ТорговыйУчет'), 'Справочники')),
      ['Валюты', 'ПричиныВозврата']
    );
    controller.notifyFileChanged(cfFile(harness, ...CURRENCY_MANAGER));
  });

  test('изменена форма: владелец раскрыт до формы, остальные формы и части скрыты', async () => {
    harness = await createHarness();
    const { treeProvider, controller } = harness;
    saveBaseline(harness);
    edit(cfFile(harness, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext', 'Form.xml'));

    await controller.toggle();

    const catalogs = child(treeProvider, child(treeProvider, undefined, 'ТорговыйУчет'), 'Справочники');
    const owner = child(treeProvider, catalogs, 'Контрагенты');
    assert.strictEqual(owner.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    assert.deepStrictEqual(labels(treeProvider, owner), ['Формы']);
    assert.deepStrictEqual(labels(treeProvider, child(treeProvider, owner, 'Формы')), ['ФормаЭлемента']);
  });

  test('захваты: свой объект без изменений виден, чужой — нет; захват корня показывает только корень', async () => {
    harness = await createHarness({ binding: true });
    const { treeProvider, controller, ws } = harness;
    saveBaseline(harness);
    await controller.toggle();
    assert.deepStrictEqual(labels(treeProvider), [], 'ничего не изменено и не захвачено');

    ws.service.setLocked(ws.target, ['Справочник.Банки', 'Справочник.Валюты'], true);
    ws.service.lockState.applyLockRefusals(ws.target, [{ fullName: 'Справочник.Валюты', user: 'Петров' }], '2026-11-23T10:00:00');
    const catalogs = child(treeProvider, child(treeProvider, undefined, 'ТорговыйУчет'), 'Справочники');
    assert.deepStrictEqual(labels(treeProvider, catalogs), ['Банки']);

    ws.service.setLocked(ws.target, ['Справочник.Банки', 'Справочник.Валюты'], false);
    ws.service.setLocked(ws.target, [CONFIGURATION_ROOT_LOCK_NAME], true);
    const root = child(treeProvider, undefined, 'ТорговыйУчет');
    assert.strictEqual(root.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed, 'захват корня не раскрывает дерево');
    assert.ok(labels(treeProvider, root).includes('Справочники'), 'корень раскрывается вручную целиком');

    // Захват единицы, которой нет в выгрузке: корень — предок, но ветки к ней нет.
    ws.service.setLocked(ws.target, ['Справочник.УжеУдалён'], true);
    const rootWithMissing = child(treeProvider, undefined, 'ТорговыйУчет');
    assert.strictEqual(rootWithMissing.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  });

  test('хеш-кэша нет: сообщение «нет данных о загрузке в базу», фильтр по изменённым не применяется', async () => {
    harness = await createHarness();
    const { treeProvider, controller } = harness;
    edit(cfFile(harness, ...OBJECT_MODULE));

    await controller.toggle();

    assert.strictEqual(
      controller.getStatus().message,
      'Фильтр: не загруженные в базу и захваченные (0); нет данных о загрузке в базу: ТорговыйУчет'
    );
    assert.deepStrictEqual(labels(treeProvider), []);
  });

  test('пересечение с поиском, пересчёт после обновления кэша и выключение', async () => {
    harness = await createHarness();
    const { treeProvider, controller } = harness;
    saveBaseline(harness);
    edit(cfFile(harness, ...OBJECT_MODULE));
    edit(cfFile(harness, ...CURRENCY_MANAGER));
    await controller.toggle();

    treeProvider.setSearchQuery('Валют');
    const catalogs = child(treeProvider, child(treeProvider, undefined, 'ТорговыйУчет'), 'Справочники');
    assert.deepStrictEqual(labels(treeProvider, catalogs), ['Валюты']);
    treeProvider.setSearchQuery('Справочники');
    const group = child(treeProvider, child(treeProvider, undefined, 'ТорговыйУчет'), 'Справочники');
    assert.strictEqual(group.collapsibleState, vscode.TreeItemCollapsibleState.Expanded, 'группа без XML совпала по подписи');
    treeProvider.clearSearchQuery();

    saveBaseline(harness);
    await controller.rescan();
    assert.deepStrictEqual(labels(treeProvider), [], 'загруженное в базу пропадает из фильтра');
    assert.strictEqual(controller.getStatus().message, 'Фильтр: не загруженные в базу и захваченные (0)');

    await controller.toggle();
    assert.deepStrictEqual(controller.getStatus(), { active: false, pending: false });
    assert.deepStrictEqual(labels(treeProvider), ['ТорговыйУчет', 'Расширения']);
    await controller.rescan();
    controller.notifyFileChanged(cfFile(harness, ...OBJECT_MODULE));
    controller.flushFileChanges();
    assert.deepStrictEqual(labels(treeProvider), ['ТорговыйУчет', 'Расширения'], 'выключенный фильтр не пересчитывается');
  });

  test('события файлов: точечный пересчёт после паузы, удалённые в сообщении, большая пачка — полный пересчёт', async () => {
    const current = await createHarness({ controller: { fileDebounceMs: 0, maxIncrementalFiles: 2 } });
    harness = current;
    const { treeProvider, controller, ws } = current;
    saveBaseline(harness);
    await controller.toggle();
    assert.deepStrictEqual(labels(treeProvider), []);

    const modulePath = cfFile(harness, ...OBJECT_MODULE);
    edit(modulePath);
    controller.notifyFileChanged(modulePath);
    controller.notifyFileChanged(path.join(ws.workspaceRoot, 'outside.bsl'));
    await waitFor(() => labels(treeProvider).length > 0, 'изменённый модуль не появился после события файла');

    const currencyManager = cfFile(harness, ...CURRENCY_MANAGER);
    fs.rmSync(currencyManager);
    controller.notifyFileChanged(currencyManager);
    controller.flushFileChanges();
    assert.strictEqual(
      controller.getStatus().message,
      'Фильтр: не загруженные в базу и захваченные (1); + 1 удалённых'
    );

    controller.flushFileChanges();
    const scan = controller.rescan();
    controller.notifyFileChanged(modulePath);
    controller.flushFileChanges();
    assert.strictEqual(controller.getStatus().pending, true, 'во время полного пересчёта события не применяются');
    await scan;

    const files = ['Валюты', 'Банки', 'Склады'].map((name) => cfFile(current, 'Catalogs', `${name}.xml`));
    files.forEach(edit);
    files.forEach((file) => controller.notifyFileChanged(file));
    controller.flushFileChanges();
    await waitFor(() => !controller.getStatus().pending, 'полный пересчёт не завершился');
    const catalogs = child(treeProvider, child(treeProvider, undefined, 'ТорговыйУчет'), 'Справочники');
    assert.deepStrictEqual(labels(treeProvider, catalogs).sort(), ['Банки', 'Валюты', 'ПричиныВозврата', 'Склады']);
  });

  test('расширение без службы хранилища; устаревший пересчёт отбрасывается', async () => {
    harness = await createHarness({ extension: true, repository: false });
    const { treeProvider, controller, ws } = harness;
    const extensionRoot = path.join(ws.workspaceRoot, 'src', 'cfe', 'EVOLC');
    saveHashCache(ws.workspaceRoot, buildHashSnapshot(buildScopeKey('cfe', extensionRoot, 'EVOLC'), extensionRoot));
    saveBaseline(harness);
    edit(path.join(extensionRoot, 'Catalogs', 'ев_РабочийПроцесс', 'Ext', 'ObjectModule.bsl'));

    await controller.toggle();
    const first = controller.rescan();
    await controller.rescan();
    await first;

    assert.deepStrictEqual(labels(treeProvider), ['Расширения']);
    const extension = child(treeProvider, child(treeProvider, undefined, 'Расширения'), 'EVOLC');
    assert.deepStrictEqual(labels(treeProvider, child(treeProvider, extension, 'Справочники')), ['ев_РабочийПроцесс']);

    // Событие файла основной конфигурации не трогает расширение.
    const modulePath = cfFile(harness, ...OBJECT_MODULE);
    edit(modulePath);
    controller.notifyFileChanged(modulePath);
    controller.flushFileChanges();
    assert.deepStrictEqual(labels(treeProvider), ['ТорговыйУчет', 'Расширения']);
  });

  test('сбой подсчёта конфигурации пишется в лог, остальной фильтр работает', async () => {
    harness = await createHarness();
    const { controller, logs, ws } = harness;
    fs.rmSync(path.join(ws.configRoot, 'Configuration.xml'));

    await controller.toggle();

    assert.ok(logs.some((line) => line.includes('Не удалось посчитать изменения')), logs.join('\n'));
    assert.strictEqual(controller.getStatus().message, 'Фильтр: не загруженные в базу и захваченные (0)');
  });
});

interface PanelStateMessage {
  readonly type: 'state';
  readonly state: { readonly workingSetFilter: { readonly active: boolean; readonly pending: boolean; readonly message?: string } };
}

suite('#189 панель навигатора — переключатель фильтра (протокол webview)', () => {
  test('request toggleWorkingSetFilter включает фильтр и публикует его состояние', async () => {
    const fixture = createUniversalPanelFixture();
    try {
      fixture.sendRequest('toggleWorkingSetFilter');
      const states = (): PanelStateMessage[] => fixture.postedMessages.filter(
        (item): item is PanelStateMessage => typeof item === 'object' && item !== null && (item as { type?: string }).type === 'state'
      );
      await waitFor(
        () => states().some((item) => item.state.workingSetFilter.active && !item.state.workingSetFilter.pending),
        'панель не опубликовала состояние включённого фильтра'
      );
      const last = states()[states().length - 1].state.workingSetFilter;
      assert.ok(last.message?.includes('нет данных о загрузке в базу'), last.message);
      assert.ok(states().some((item) => item.state.workingSetFilter.pending), 'пока идёт пересчёт — pending');

      fixture.sendRequest('refreshStandaloneStatus');
      await waitFor(
        () => fixture.postedMessages.some((item) => (item as { type?: string }).type === 'standaloneStatus'),
        'остальные запросы панели обрабатываются как прежде'
      );
    } finally {
      fixture.dispose();
    }
  });
});
