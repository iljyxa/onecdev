import * as assert from 'assert';
import { getMetaKindByRepositoryClassId, META_TYPES, type MetaKind } from '../../domain/MetaTypes';
import { devDepotReport, type CrsChangedObject } from '../../infra/repository/crs/CrsHistory';
import { objectTitle } from '../../infra/repository/history/RepositoryHistoryModel';
import { corpusExchanges } from './support/crsFixtures';
import { reportTitles, reportVersions } from './support/crsHistoryReport';
import { recordedClient } from './support/crsMethods';

/**
 * classID протокола хранилища в META_TYPES (#117): сервер называет объекты истории парами
 * `<classID>.<имя>`. Оракул — сценарий tcp/history-full-config: объект каждого вида тестовой
 * конфигурации назван `Тест<EnglishKind>`, а Конфигуратор построил по тому же ответу report.txt.
 */

const AUTH = { user: 'Admin', passwordHash: 'd41d8cd98f00b204e9800998ecf8427e' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function fullConfigChanges(): Promise<readonly CrsChangedObject[]> {
  const report = corpusExchanges().find((e) => e.transport === 'tcp' && e.scenario === 'history-full-config' && e.method === 'DevDepot_devDepotReport');
  assert.ok(report, 'нет devDepotReport в tcp/history-full-config');
  const { client } = recordedClient([report.response]);
  return (await devDepotReport(client, AUTH)).changes;
}

const withClassId = (Object.entries(META_TYPES) as [MetaKind, (typeof META_TYPES)[MetaKind]][])
  .filter(([, def]) => def.repositoryClassId !== undefined);

suite('META_TYPES.repositoryClassId — classID видов в протоколе хранилища (#117)', () => {
  test('classID заданы в нижнем регистре, вид GUID, без повторов', () => {
    const ids = withClassId.map(([, def]) => def.repositoryClassId);
    assert.ok(ids.length > 0);
    for (const id of ids) {
      assert.match(String(id), UUID);
    }
    assert.strictEqual(new Set(ids).size, ids.length, 'classID повторяется');
  });

  test('вид по classID — тот же вид, без учёта регистра; неизвестный — undefined', () => {
    for (const [kind, def] of withClassId) {
      const id = String(def.repositoryClassId);
      assert.strictEqual(getMetaKindByRepositoryClassId(id), kind);
      assert.strictEqual(getMetaKindByRepositoryClassId(id.toUpperCase()), kind);
    }
    assert.strictEqual(getMetaKindByRepositoryClassId('00000000-0000-0000-0000-000000000000'), undefined);
    assert.strictEqual(getMetaKindByRepositoryClassId(''), undefined);
  });

  test('history-full-config: объект «Тест<EnglishKind>» распознаётся видом с этим englishKind', async () => {
    // Корень конфигурации назван «ТестовоеХранилище» — его вид проверяется отдельно.
    const changes = await fullConfigChanges();
    const root = changes.filter((c) => getMetaKindByRepositoryClassId(c.classId) === 'configuration');
    assert.deepStrictEqual(root.map((c) => c.name), ['ТестовоеХранилище']);
    const tests = changes.filter((c) => c.name.startsWith('Тест') && !root.includes(c));
    assert.ok(tests.length >= 40, `объектов Тест*: ${String(tests.length)}`);
    for (const change of tests) {
      const kind = getMetaKindByRepositoryClassId(change.classId);
      assert.ok(kind, `${change.name}: classID ${change.classId} не распознан`);
      assert.strictEqual(META_TYPES[kind].englishKind, change.name.slice('Тест'.length), change.name);
    }
  });

  test('history-full-config: заголовки всех 57 изменений совпадают с report.txt Конфигуратора', async () => {
    const changes = await fullConfigChanges();
    const [version] = reportVersions('tcp', 'history-full-config');
    assert.strictEqual(changes.length, 57);
    const titles = changes.map((c) => objectTitle(c)).sort((a, b) => Number(a > b) - Number(a < b));
    assert.deepStrictEqual(titles, reportTitles(version));
  });

  test('у каждого вида с classID есть русское имя в заголовке', () => {
    for (const [kind, def] of withClassId) {
      const title = objectTitle({ fullName: `${String(def.repositoryClassId)}.Имя`, name: 'Имя' });
      assert.ok(!title.startsWith('Объект ('), `${kind}: ${title}`);
      assert.ok(title.endsWith('.Имя'), `${kind}: ${title}`);
    }
  });
});

suite('objectTitle — граничные формы fullName (#117)', () => {
  const CATALOG = 'cf4abea6-37b2-11d4-940f-008048da11f9';
  const cases: readonly { readonly name: string; readonly fullName: string; readonly objectName: string; readonly expected: string }[] = [
    { name: 'неизвестный classID — начало uuid', fullName: 'ABCDEF12-0000-0000-0000-000000000000.Новый', objectName: 'Новый', expected: 'Объект (abcdef12).Новый' },
    { name: 'classID в верхнем регистре', fullName: `${CATALOG.toUpperCase()}.Контрагенты`, objectName: 'Контрагенты', expected: 'Справочник.Контрагенты' },
    { name: 'пустой fullName — имя объекта (корень)', fullName: '', objectName: 'ТестовоеХранилище', expected: 'ТестовоеХранилище' },
    { name: 'нечётное число сегментов — как есть', fullName: `${CATALOG}.Контрагенты.Лишний`, objectName: 'Лишний', expected: `${CATALOG}.Контрагенты.Лишний` },
    { name: 'не-uuid на месте classID — как есть', fullName: 'Справочник.Контрагенты', objectName: 'Контрагенты', expected: 'Справочник.Контрагенты' },
    { name: 'пустое имя в паре — как есть', fullName: `${CATALOG}.`, objectName: '', expected: `${CATALOG}.` },
  ];
  for (const c of cases) {
    test(c.name, () => {
      assert.strictEqual(objectTitle({ fullName: c.fullName, name: c.objectName }), c.expected);
    });
  }
});
