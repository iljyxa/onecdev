import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildHashSnapshot,
  buildScopeKey,
  resolveHashCacheFileStem,
  saveHashCache,
  walkSupportedFilesAsync,
} from '../../infra/cache/HashCache';
import {
  buildHashSnapshotWithStatIndex,
  buildHashSnapshotWithStatIndexAsync,
  createEmptyFileStatIndex,
  loadFileStatIndex,
} from '../../infra/cache/FileStatIndex';
import { UnloadedChangesScanner } from '../../infra/cache/UnloadedChangesScanner';
import { CONFIGURATION_ROOT_LOCK_NAME } from '../../infra/repository/RepositoryObjectNames';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import { WorkingSetIndex } from '../../infra/repository/WorkingSetIndex';

/**
 * #189, infra фильтра «изменённые и захваченные»: незагруженные в базу изменения по хеш-кэшу
 * (временная копия `example/2.21/src/cf`) и сведение изменений и захватов к единицам хранилища.
 */

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');

interface Workspace {
  readonly projectRoot: string;
  readonly configRoot: string;
  dispose(): void;
}

function createWorkspace(): Workspace {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-working-set-')));
  const configRoot = path.join(projectRoot, 'src', 'cf');
  fs.cpSync(EXAMPLE_CF, configRoot, { recursive: true });
  return { projectRoot, configRoot, dispose: () => fs.rmSync(projectRoot, { recursive: true, force: true }) };
}

/** Фиксирует текущее состояние выгрузки как загруженное в базу — так делает операция с базой. */
function saveBaseline(ws: Workspace): void {
  const scopeKey = buildScopeKey('cf', ws.configRoot);
  saveHashCache(ws.projectRoot, buildHashSnapshot(scopeKey, ws.configRoot));
}

function appendLine(filePath: string): void {
  fs.appendFileSync(filePath, '\n// правка\n');
}

const TARGET: RepositoryTarget = {
  configRoot: path.resolve('/ws/src/cf'),
  configKind: 'cf',
  displayName: 'ТорговыйУчет',
};

function inRoot(...segments: string[]): string {
  return path.join(TARGET.configRoot, ...segments);
}

suite('#189 WorkingSetIndex — изменения и захваты как единицы хранилища', () => {
  test('изменён модуль объекта: объект отмечен, корень раскрывается до него', () => {
    const index = WorkingSetIndex.build([
      { target: TARGET, changedRelativePaths: ['Catalogs/ПричиныВозврата/Ext/ObjectModule.bsl'], ownLockedFullNames: [] },
    ]);
    assert.strictEqual(index.unitCount, 1);
    assert.strictEqual(index.hasUnits(TARGET.configRoot), true);
    assert.deepStrictEqual(
      index.matchNode(TARGET.configRoot, { nodeKind: 'Catalog', label: 'ПричиныВозврата', xmlPath: inRoot('Catalogs', 'ПричиныВозврата.xml') }),
      { marked: true, hasMarkedDescendants: false }
    );
    assert.deepStrictEqual(
      index.matchNode(TARGET.configRoot, { nodeKind: 'Catalog', label: 'Банки', xmlPath: inRoot('Catalogs', 'Банки.xml') }),
      { marked: false, hasMarkedDescendants: false }
    );
    assert.deepStrictEqual(
      index.matchNode(TARGET.configRoot, { nodeKind: 'configuration', xmlPath: inRoot('Configuration.xml') }),
      { marked: false, hasMarkedDescendants: true }
    );
  });

  test('изменена форма: отмечена форма, владелец — предок; часть владельца и группа своей единицы не имеют', () => {
    const index = WorkingSetIndex.build([
      { target: TARGET, changedRelativePaths: ['Catalogs/Контрагенты/Forms/ФормаЭлемента/Ext/Form.xml'], ownLockedFullNames: [] },
    ]);
    const ownerXml = inRoot('Catalogs', 'Контрагенты.xml');
    assert.deepStrictEqual(
      index.matchNode(TARGET.configRoot, { nodeKind: 'Catalog', label: 'Контрагенты', xmlPath: ownerXml }),
      { marked: false, hasMarkedDescendants: true }
    );
    const formNode = { nodeKind: 'Form', xmlPath: ownerXml, metaContext: { ownerObjectXmlPath: ownerXml } };
    assert.deepStrictEqual(
      index.matchNode(TARGET.configRoot, { ...formNode, label: 'ФормаЭлемента' }),
      { marked: true, hasMarkedDescendants: false }
    );
    assert.deepStrictEqual(
      index.matchNode(TARGET.configRoot, { ...formNode, label: 'ФормаСписка' }),
      { marked: false, hasMarkedDescendants: false }
    );
    assert.strictEqual(index.matchNode(TARGET.configRoot, formNode), undefined, 'форма без имени');
    assert.strictEqual(
      index.matchNode(TARGET.configRoot, { nodeKind: 'Attribute', label: 'ИНН', xmlPath: ownerXml, metaContext: { ownerObjectXmlPath: ownerXml } }),
      undefined
    );
    assert.strictEqual(index.matchNode(TARGET.configRoot, { nodeKind: 'group-type', label: 'Формы' }), undefined);
    assert.strictEqual(
      index.matchNode(TARGET.configRoot, {
        nodeKind: 'Form',
        label: 'Ф',
        metaContext: { ownerObjectXmlPath: inRoot('НеизвестнаяПапка', 'X.xml') },
      }),
      undefined,
      'владелец вне известных папок выгрузки'
    );
  });

  test('файл корня и захват корня отмечают только корень; вложенная подсистема — со своим предком', () => {
    const rootOnly = WorkingSetIndex.build([
      { target: TARGET, changedRelativePaths: ['Configuration.xml'], ownLockedFullNames: [] },
    ]);
    assert.deepStrictEqual(
      rootOnly.matchNode(TARGET.configRoot, { nodeKind: 'configuration', xmlPath: inRoot('Configuration.xml') }),
      { marked: true, hasMarkedDescendants: false }
    );

    const index = WorkingSetIndex.build([
      {
        target: TARGET,
        changedRelativePaths: ['Subsystems/Продажи/Subsystems/Розница.xml'],
        ownLockedFullNames: [CONFIGURATION_ROOT_LOCK_NAME],
      },
    ]);
    assert.strictEqual(index.unitCount, 2);
    assert.deepStrictEqual(
      index.matchNode(TARGET.configRoot, { nodeKind: 'configuration', xmlPath: inRoot('Configuration.xml') }),
      { marked: true, hasMarkedDescendants: true }
    );
    assert.deepStrictEqual(
      index.matchNode(TARGET.configRoot, { nodeKind: 'Subsystem', label: 'Продажи', xmlPath: inRoot('Subsystems', 'Продажи.xml') }),
      { marked: false, hasMarkedDescendants: true }
    );
    assert.deepStrictEqual(
      index.matchNode(TARGET.configRoot, {
        nodeKind: 'Subsystem',
        label: 'Розница',
        xmlPath: inRoot('Subsystems', 'Продажи', 'Subsystems', 'Розница.xml'),
      }),
      { marked: true, hasMarkedDescendants: false }
    );
  });

  test('без изменений и захватов конфигурация в индекс не попадает; служебные файлы не единицы', () => {
    const index = WorkingSetIndex.build([
      { target: TARGET, changedRelativePaths: ['ConfigDumpInfo.xml'], ownLockedFullNames: [] },
    ]);
    assert.strictEqual(index.unitCount, 0);
    assert.strictEqual(index.hasUnits(TARGET.configRoot), false);
    assert.deepStrictEqual(
      index.matchNode(TARGET.configRoot, { nodeKind: 'configuration', xmlPath: inRoot('Configuration.xml') }),
      { marked: false, hasMarkedDescendants: false }
    );
  });
});

suite('#189 UnloadedChangesScanner — не загруженные в базу изменения', () => {
  let ws: Workspace;
  setup(() => { ws = createWorkspace(); });
  teardown(() => ws.dispose());

  test('хеш-кэша нет: базовой линии нет, изменения не считаются', async () => {
    const scanner = new UnloadedChangesScanner(ws.projectRoot);
    const result = await scanner.scan({ kind: 'cf', rootPath: ws.configRoot });
    assert.strictEqual(result.hasBaseline, false);
    assert.strictEqual(result.name, 'ТорговыйУчет');
    assert.strictEqual(result.changed.size, 0);
    const modulePath = path.join(ws.configRoot, 'Catalogs', 'ПричиныВозврата', 'Ext', 'ObjectModule.bsl');
    appendLine(modulePath);
    assert.strictEqual(scanner.refreshFiles(result, [modulePath]), result, 'без базовой линии точечный пересчёт ничего не меняет');
  });

  test('правка, добавление и удаление после загрузки; после нового кэша изменения пропадают', async () => {
    saveBaseline(ws);
    // Только что скопированные файлы «ненадёжны» по stat (racy) и в индекс не попадают:
    // часы сканера сдвинуты вперёд, чтобы проверить сохранение индекса.
    const scanner = new UnloadedChangesScanner(ws.projectRoot, () => Date.now() + 60_000);
    appendLine(path.join(ws.configRoot, 'Catalogs', 'ПричиныВозврата', 'Ext', 'ObjectModule.bsl'));
    fs.writeFileSync(path.join(ws.configRoot, 'CommonModules', 'НовыйМодуль.xml'), '<x/>');
    fs.rmSync(path.join(ws.configRoot, 'Catalogs', 'Валюты', 'Ext', 'ManagerModule.bsl'));

    const result = await scanner.scan({ kind: 'cf', rootPath: ws.configRoot });
    assert.strictEqual(result.hasBaseline, true);
    assert.deepStrictEqual(
      [...result.changed].sort(),
      ['Catalogs/ПричиныВозврата/Ext/ObjectModule.bsl', 'CommonModules/НовыйМодуль.xml']
    );
    assert.deepStrictEqual([...result.deleted], ['Catalogs/Валюты/Ext/ManagerModule.bsl']);
    assert.ok(Object.keys(loadFileStatIndex(ws.projectRoot, buildScopeKey('cf', ws.configRoot)).files).length > 0, 'stat-индекс сохранён');

    saveBaseline(ws);
    const clean = await scanner.scan({ kind: 'cf', rootPath: ws.configRoot });
    assert.strictEqual(clean.changed.size, 0);
    assert.strictEqual(clean.deleted.size, 0);
  });

  test('точечный пересчёт: правка, откат правки, удаление; чужие и неподдерживаемые файлы пропускаются', async () => {
    saveBaseline(ws);
    const scanner = new UnloadedChangesScanner(ws.projectRoot);
    const initial = await scanner.scan({ kind: 'cf', rootPath: ws.configRoot });
    const modulePath = path.join(ws.configRoot, 'Catalogs', 'ПричиныВозврата', 'Ext', 'ObjectModule.bsl');
    const original = fs.readFileSync(modulePath);

    appendLine(modulePath);
    const outside = path.join(ws.projectRoot, 'outside.bsl');
    fs.writeFileSync(outside, 'x');
    const unsupported = path.join(ws.configRoot, 'Catalogs', 'notes.txt');
    fs.writeFileSync(unsupported, 'x');
    const edited = scanner.refreshFiles(initial, [modulePath, outside, unsupported]);
    assert.deepStrictEqual([...edited.changed], ['Catalogs/ПричиныВозврата/Ext/ObjectModule.bsl']);

    fs.writeFileSync(modulePath, original);
    const reverted = scanner.refreshFiles(edited, [modulePath]);
    assert.strictEqual(reverted.changed.size, 0, 'откат правки — снова как в базе');

    fs.rmSync(modulePath);
    const created = path.join(ws.configRoot, 'Catalogs', 'Новый.xml');
    const deleted = scanner.refreshFiles(reverted, [modulePath, created]);
    assert.deepStrictEqual([...deleted.deleted], ['Catalogs/ПричиныВозврата/Ext/ObjectModule.bsl']);
    assert.strictEqual(deleted.changed.size, 0, 'событие о файле, которого нет ни на диске, ни в базе, игнорируется');
  });

  test('сбой записи stat-индекса не обрывает подсчёт', async () => {
    saveBaseline(ws);
    // Каталог на месте файла индекса — запись (temp + rename) упадёт.
    fs.mkdirSync(`${resolveHashCacheFileStem(ws.projectRoot, buildScopeKey('cf', ws.configRoot))}.stat.json`, { recursive: true });
    const result = await new UnloadedChangesScanner(ws.projectRoot, () => Date.now() + 60_000).scan({ kind: 'cf', rootPath: ws.configRoot });
    assert.strictEqual(result.hasBaseline, true);
    assert.strictEqual(result.changed.size, 0);
  });
});

suite('#189 асинхронный снапшот хешей через stat-индекс', () => {
  let ws: Workspace;
  setup(() => { ws = createWorkspace(); });
  teardown(() => ws.dispose());

  test('совпадает с синхронным; повтор по индексу ничего не перехеширует', async () => {
    const scopeKey = buildScopeKey('cf', ws.configRoot);
    const longAgo = Date.now() + 60_000;
    const sync = buildHashSnapshotWithStatIndex(scopeKey, ws.configRoot, createEmptyFileStatIndex(scopeKey), longAgo);
    const async = await buildHashSnapshotWithStatIndexAsync(scopeKey, ws.configRoot, createEmptyFileStatIndex(scopeKey), longAgo);
    assert.deepStrictEqual(async.snapshot.files, sync.snapshot.files);
    assert.strictEqual(async.hashedCount, sync.hashedCount);
    assert.deepStrictEqual(async.index.files, sync.index.files);

    const again = await buildHashSnapshotWithStatIndexAsync(scopeKey, ws.configRoot, async.index, longAgo);
    assert.strictEqual(again.hashedCount, 0);
    assert.strictEqual(again.indexChanged, false);
  });

  test('висячая ссылка и отсутствующий корень не ломают обход', async () => {
    const dangling = path.join(ws.configRoot, 'Catalogs', 'Висячая.bsl');
    fs.symlinkSync(path.join(ws.configRoot, 'нет-такого.bsl'), dangling);
    const scopeKey = buildScopeKey('cf', ws.configRoot);
    const built = await buildHashSnapshotWithStatIndexAsync(scopeKey, ws.configRoot, createEmptyFileStatIndex(scopeKey), Date.now());
    assert.strictEqual(built.snapshot.files['Catalogs/Висячая.bsl'], undefined);

    const visited: string[] = [];
    await walkSupportedFilesAsync(path.join(ws.projectRoot, 'нет'), (_full, relative) => {
      visited.push(relative);
      return Promise.resolve();
    });
    assert.deepStrictEqual(visited, []);
  });
});
