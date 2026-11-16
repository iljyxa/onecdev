import * as assert from 'assert';
import { CrsFormatError } from '../../infra/repository/crs/CrsErrors';
import {
  type CrsChangedObject,
  type CrsDepotHistory,
  type CrsDepotVersion,
  type CrsHistoryQuery,
  devDepotReport,
  devDepotVersions,
} from '../../infra/repository/crs/CrsHistory';
import { CrsTransportError } from '../../infra/repository/crs/CrsTransport';
import { assertNoHashes, callRejection, inputsOf, param, recordedClient, rejection } from './support/crsMethods';
import { bodyProbe, corpusExchanges, type CorpusExchange, readFixture, tcpBodyProbe } from './support/crsFixtures';

/** uuid Справочник.Контрагенты тестовой конфигурации стенда, с которой снят корпус example/crs/8.5.1. */
const CONTRACTORS_ID = '3e33ad69-478f-4f02-bad5-751699f70814';

const METHOD = 'DevDepot_devDepotReport';
const AUTH = { user: 'Admin', passwordHash: 'd41d8cd98f00b204e9800998ecf8427e' };
const NO_DATE = '0001-01-01T00:00:00';

// Оракул ответа — регулярными выражениями, независимо от разбора в src/infra/repository/crs/CrsHistory.ts.
const COMMENT = String.raw`(?:<crs:comment>([^<]*)</crs:comment>|<crs:comment/>)`;
const VERSION = new RegExp(
  String.raw`<crs:value><crs:info><crs:verNum value="(\d+)"/><crs:userID value="([^"]+)"/><crs:cvermajor value="\d+"/><crs:cverminor value="\d+"/>` +
    String.raw`<crs:pvermajor value="(\d+)"/><crs:pverminor value="(\d+)"/><crs:pverbuild value="(\d+)"/><crs:pverrevis value="(\d+)"/>` +
    String.raw`<crs:date value="([^"]+)"/><crs:code value="([^"]*)"/>${COMMENT}<crs:versionID value="([^"]+)"/></crs:info>` +
    String.raw`(?:<crs:label><crs:verNum value="\1"/><crs:userID value="([^"]+)"/><crs:date value="([^"]+)"/><crs:name value="([^"]*)"/>${COMMENT}</crs:label>)?</crs:value>`,
  'g',
);
const CHANGE = new RegExp(
  String.raw`<crs:value><crs:info><crs:_super><crs:id value="([^"]+)"/><crs:classID value="([^"]+)"/></crs:_super><crs:name value="([^"]*)"/>` +
    String.raw`<crs:pos value="\d+"/><crs:verNum value="(\d+)"/><crs:selfVerNum value="\d+"/><crs:parentID value="([^"]+)"/><crs:ownerID value="[^"]+"/>` +
    String.raw`<crs:version>.*?</crs:version><crs:removed value="(true|false)"/></crs:info><crs:action value="(\d+)"/>` +
    String.raw`<crs:fullName><crs:fullName value="([^"]*)"/><crs:isDecoded value="false"/></crs:fullName>`,
  'g',
);
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unescape = (s: string | undefined): string => (s ?? '').replace(/&(lt|gt|amp|quot|apos);/g, (_, e: string) => ENTITIES[e]);

function expectedHistory(response: Buffer): CrsDepotHistory {
  const text = response.toString('utf-8');
  const versions = [...text.matchAll(VERSION)].map((m): CrsDepotVersion => {
    const version = {
      verNum: Number(m[1]),
      versionId: m[10],
      userId: m[2],
      date: m[7],
      configVersion: m[8],
      platformVersion: [m[3], m[4], m[5], m[6]].join('.'),
      comment: unescape(m[9]),
    };
    // Группа необязательной метки: без метки в совпадении undefined, хотя тип RegExpMatchArray — string.
    const labelUser = m[11] as string | undefined;
    return labelUser === undefined ? version : { ...version, label: { userId: m[11], date: m[12], name: unescape(m[13]), comment: unescape(m[14]) } };
  });
  const changes = [...text.matchAll(CHANGE)].map(
    (m): CrsChangedObject => ({
      objectId: m[1],
      classId: m[2],
      name: unescape(m[3]),
      fullName: unescape(m[8]),
      parentId: m[5],
      verNum: Number(m[4]),
      action: Number(m[7]),
      removed: m[6] === 'true',
    }),
  );
  const processOrder = /<crs:processOrder>(.*)<\/crs:processOrder>/.exec(text)?.[1] ?? '';
  assert.strictEqual(versions.length + changes.length, processOrder.split('<crs:value ').length - 1, 'оракул пропустил записи');
  // С фильтром объектов сервер повторяет версию для каждого объекта; в модели — первое вхождение.
  const unique = versions.filter((v, i) => versions.findIndex((w) => w.verNum === v.verNum) === i);
  return { versions: unique, changes };
}

/** Запрос Конфигуратора → входы метода; даты фильтра метод не поддерживает — такие запросы не воспроизводятся. */
function queryOf(request: Buffer): { query: CrsHistoryQuery; reproducible: boolean } {
  const { bindId, params } = inputsOf(request);
  const bound = (name: string): Partial<CrsHistoryQuery> => {
    const value = Number(param(params, name));
    return value === -1 ? {} : { [name]: value };
  };
  const { objRefs } = inputsOf(request);
  const recursive = param(params, 'recursive') === 'true';
  const query: CrsHistoryQuery = {
    ...bound('beginVerNum'),
    ...bound('endVerNum'),
    labels: param(params, 'labels') === 'true',
    onlyLabels: param(params, 'onlyLabels') === 'true',
    ...(objRefs.length === 0 ? {} : { objectIds: objRefs }),
    ...(recursive ? { recursive } : {}),
    ...(bindId === undefined ? {} : { bindId }),
  };
  return { query, reproducible: param(params, 'beginDate') === NO_DATE && param(params, 'endDate') === NO_DATE };
}

function reportExchanges(): CorpusExchange[] {
  const result = corpusExchanges().filter((e) => e.method === METHOD);
  assert.strictEqual(result.length, 21);
  return result;
}

function scenario(name: string): CorpusExchange {
  const found = reportExchanges().find((e) => e.scenario === name);
  assert.ok(found, name);
  return found;
}

async function decoded(name: string): Promise<CrsDepotHistory> {
  const e = scenario(name);
  const { client } = recordedClient([e.response]);
  return devDepotReport(client, AUTH, queryOf(e.request).query);
}

suite('crs history: devDepotReport на снятых телах', () => {
  test('каждый снятый ответ разбирается как оракул, запрос без дат воспроизводится побайтно', async () => {
    let reproduced = 0;
    for (const e of reportExchanges()) {
      const { auth } = inputsOf(e.request);
      assert.ok(auth);
      const { query, reproducible } = queryOf(e.request);
      const { client, transport } = recordedClient([e.response]);
      const result = await devDepotReport(client, auth, query);
      assert.deepStrictEqual(result, expectedHistory(e.response), e.scenario);
      if (reproducible) {
        assert.deepStrictEqual(transport.requests[0].body, e.request, e.scenario);
        reproduced += 1;
      }
      assertNoHashes(result, e.request, e.response);
      // В модели нет хешей версий (crs:version, 40 hex) и внешних файлов.
      const json = JSON.stringify(result);
      assert.ok(!/[0-9a-f]{40}/.test(json), e.scenario);
      assert.ok(!/externals|original|"local"/.test(json), e.scenario);
    }
    assert.strictEqual(reproduced, 17);
  });

  test('http (#82): каждый сценарий истории снят и по tcp, и по http; http-ответ разбирается и запрос воспроизводится', async () => {
    const byTransport = (transport: 'tcp' | 'http'): CorpusExchange[] => reportExchanges().filter((e) => e.transport === transport && e.scenario.startsWith('history-') && !e.scenario.startsWith('history-probes'));
    const tcp = byTransport('tcp').map((e) => e.scenario).sort();
    const http = byTransport('http').map((e) => e.scenario).sort();
    assert.ok(tcp.length >= 10, String(tcp.length));
    // history-full-config (#84) снят только по tcp: там нужны лишь classID, а не транспорт.
    assert.deepStrictEqual(tcp.filter((name) => name !== 'history-full-config'), http);
    for (const e of byTransport('http')) {
      const { auth } = inputsOf(e.request);
      assert.ok(auth);
      const { query, reproducible } = queryOf(e.request);
      const { client, transport } = recordedClient([e.response]);
      assert.deepStrictEqual(await devDepotReport(client, auth, query), expectedHistory(e.response), e.scenario);
      if (reproducible) {
        assert.deepStrictEqual(transport.requests[0].body, e.request, e.scenario);
      }
    }
  });

  test('history-all: шесть версий, метки на 2 и 4, двухстрочный комментарий, пустой и со спецсимволами', async () => {
    const { versions, changes } = await decoded('history-all');
    assert.deepStrictEqual(
      versions.map((v) => v.verNum),
      [1, 2, 3, 4, 5, 6],
    );
    assert.deepStrictEqual(
      versions.filter((v) => v.label).map((v) => [v.verNum, v.label?.name, v.label?.comment]),
      [
        [2, 'Релиз 1.0', 'Первый релиз'],
        [4, 'Релиз 1.1', 'Второй релиз'],
      ],
    );
    assert.strictEqual(versions[3].comment, 'Правка от администратора\nвторая строка комментария');
    assert.strictEqual(versions[4].comment, '');
    assert.strictEqual(versions[5].comment, "Спецсимволы: <тег> & 'апостроф' > конец");
    assert.ok(versions.every((v) => v.platformVersion === '8.5.1.1529' && v.configVersion === '1.0.0.1'));
    assert.deepStrictEqual([...new Set(changes.map((c) => c.action))].sort(), [0, 5]);
    assert.ok(changes.every((c) => !c.removed));
  });

  test('history-range, -only-labels, -no-labels, -empty-comment: номера версий по фильтру', async () => {
    const cases: [string, number[]][] = [
      ['history-range', [2, 3]],
      ['history-only-labels', [2, 4]],
      ['history-no-labels', [1, 3, 5, 6]],
      ['history-empty-comment', [5]],
      ['history-special-comment', [6]],
    ];
    for (const [name, numbers] of cases) {
      const { versions, changes } = await decoded(name);
      assert.deepStrictEqual(
        versions.map((v) => v.verNum),
        numbers,
        name,
      );
      assert.ok(
        changes.every((c) => numbers.includes(c.verNum)),
        name,
      );
    }
  });

  test('history-by-date-future: пустая история', async () => {
    assert.deepStrictEqual(await decoded('history-by-date-future'), { versions: [], changes: [] });
  });

  test('без запроса — фильтр без ограничений, как у Конфигуратора в history-all', async () => {
    const e = scenario('history-all');
    const { bindId } = inputsOf(e.request);
    assert.ok(bindId);
    const { client, transport } = recordedClient([e.response]);
    await devDepotReport(client, AUTH, { bindId });
    assert.deepStrictEqual(transport.requests[0].body, e.request);
    const bare = recordedClient([e.response]);
    await devDepotReport(bare.client, AUTH);
    assert.strictEqual(bare.transport.requests[0].body.toString('utf-8'), e.request.toString('utf-8').replace(/<crs:bind bindID="[^"]+"\/>/, ''));
  });

  test('только начало диапазона — конец -1', async () => {
    const e = scenario('history-empty-comment');
    const { client, transport } = recordedClient([e.response]);
    await devDepotReport(client, AUTH, { beginVerNum: 5 });
    const params = inputsOf(transport.requests[0].body).params;
    assert.deepStrictEqual([params.get('beginVerNum'), params.get('endVerNum')], ['5', '-1']);
  });

  test('неверный диапазон — RangeError до вызова транспорта', async () => {
    const bad: CrsHistoryQuery[] = [
      { beginVerNum: 0 },
      { endVerNum: -1 },
      { beginVerNum: 1.5 },
      { endVerNum: Number.NaN },
      { beginVerNum: Number.POSITIVE_INFINITY },
      { beginVerNum: 3, endVerNum: 2 },
    ];
    for (const query of bad) {
      const { client, transport } = recordedClient([]);
      const error = await rejection(devDepotReport(client, AUTH, query));
      assert.ok(error instanceof RangeError, JSON.stringify(query));
      assert.strictEqual(transport.requests.length, 0);
    }
  });

  test('пробы: без crs:bind, с чужим bindID и от Reader (ReadOnly) — одна и та же история', async () => {
    const results: CrsDepotHistory[] = [];
    for (const probe of ['probe-history-no-bind', 'probe-history-random-bind', 'probe-history-reader-no-bind']) {
      const { request, response } = tcpBodyProbe(probe);
      const { auth } = inputsOf(request);
      assert.ok(auth);
      const { query } = queryOf(request);
      assert.strictEqual(query.bindId !== undefined, probe === 'probe-history-random-bind', probe);
      const { client, transport } = recordedClient([response]);
      const result = await devDepotReport(client, auth, query);
      assert.deepStrictEqual(transport.requests[0].body, request, probe);
      assert.deepStrictEqual(result, expectedHistory(response), probe);
      assertNoHashes(result, request, response);
      results.push(result);
    }
    assert.ok(results[0].versions.length > 0);
    assert.deepStrictEqual(results[1], results[0]);
    assert.deepStrictEqual(results[2], results[0]);
  });

  test('неверный пароль без authenticate — auth-failed без хеша', async () => {
    const { request, response } = tcpBodyProbe('probe-history-wrong-password');
    const { auth } = inputsOf(request);
    assert.ok(auth);
    const { client, transport } = recordedClient([response]);
    const error = await callRejection(devDepotReport(client, auth, queryOf(request).query));
    assert.deepStrictEqual(transport.requests[0].body, request);
    assert.strictEqual(error.kind, 'auth-failed');
    assert.strictEqual(error.details.method, METHOD);
    assertNoHashes(error, request);
  });

  test('ответ другого метода (depotInfo, статистика, пользователи) — malformed-response с причиной CrsFormatError', async () => {
    for (const file of ['09-conn-02-s2c-call_return.xml', '11-conn-02-s2c-call_return.xml', '14-conn-03-s2c-call_return.xml']) {
      const { client } = recordedClient([readFixture('tcp', 'history-all', file)]);
      const error = await callRejection(devDepotReport(client, AUTH));
      assert.strictEqual(error.kind, 'malformed-response', file);
      assert.strictEqual(error.details.method, METHOD);
      assert.ok(error.details.cause instanceof CrsFormatError, file);
    }
  });

  test('CrsTransportError (timeout, too-large) пробрасывается как есть, CrsCallOptions доходят до транспорта', async () => {
    for (const kind of ['timeout', 'too-large'] as const) {
      const failure = new CrsTransportError(kind, 'отказ', { endpoint: 'tcp://127.0.0.1:1542' });
      const options = { timeoutMs: 1234, maxResponseBytes: 5678 };
      const { client, transport } = recordedClient([failure]);
      assert.strictEqual(await rejection(devDepotReport(client, AUTH, {}, options)), failure);
      assert.strictEqual(transport.requests[0].options, options);
    }
  });
});

// Пробы фильтра объектов (capture-read-probes.mjs): tcp и http снимались на разных сборках стенда.
const OBJECT_PROBES_BOTH = [
  'probe-history-filter-none',
  'probe-history-object-catalog',
  'probe-history-object-catalog-recursive',
  'probe-history-object-two',
  'probe-history-object-unknown',
];
const OBJECT_PROBES_TCP = [
  'probe-history-object-form',
  'probe-history-object-root',
  'probe-history-object-root-recursive',
  'probe-history-object-catalog-range',
  'probe-history-object-catalog-only-labels',
];
const OBJECT_PROBES: ['tcp' | 'http', string][] = [
  ...(['tcp', 'http'] as const).flatMap((t) => OBJECT_PROBES_BOTH.map((p): ['tcp' | 'http', string] => [t, p])),
  ...OBJECT_PROBES_TCP.map((p): ['tcp' | 'http', string] => ['tcp', p]),
];

interface ProbeSummary {
  readonly versions: number[];
  readonly changes: string[];
}

/** Сводка стенда: номера версий в порядке ответа (с повторами) и изменения «verNum:имя». */
function probeSummary(transport: 'tcp' | 'http', probe: string): ProbeSummary {
  const all = JSON.parse(readFixture(transport, 'history-probes-summary.json').toString('utf-8')) as Record<string, ProbeSummary>;
  const found = all[probe];
  assert.ok(found, `${transport}/${probe}`);
  return found;
}

async function probeResult(transport: 'tcp' | 'http', probe: string): Promise<CrsDepotHistory> {
  const { request, response } = bodyProbe(transport, probe);
  const { client } = recordedClient([response]);
  return devDepotReport(client, AUTH, queryOf(request).query);
}

suite('crs history: фильтр объектов на пробах tcp и http', () => {
  for (const [transport, probe] of OBJECT_PROBES) {
    test(`${transport}/${probe}: запрос побайтно как у пробы, ответ — как оракул и сводка стенда`, async () => {
      const { request, response } = bodyProbe(transport, probe);
      const { auth } = inputsOf(request);
      assert.ok(auth);
      const { client, transport: recorded } = recordedClient([response]);
      const result = await devDepotReport(client, auth, queryOf(request).query);
      assert.deepStrictEqual(recorded.requests[0].body, request);
      assert.deepStrictEqual(result, expectedHistory(response));
      const summary = probeSummary(transport, probe);
      assert.deepStrictEqual(
        result.versions.map((v) => v.verNum),
        [...new Set(summary.versions)],
      );
      assert.deepStrictEqual(
        result.changes.map((c) => `${String(c.verNum)}:${c.name}`),
        summary.changes,
      );
      assertNoHashes(result, request, response);
    });
  }

  for (const transport of ['tcp', 'http'] as const) {
    test(`${transport}: версии уникальны по номеру в порядке первого вхождения, изменения не схлопываются`, async () => {
      const recursive = await probeResult(transport, 'probe-history-object-catalog-recursive');
      assert.deepStrictEqual(
        recursive.versions.map((v) => v.verNum),
        [1, 2, 3, 6],
      );
      assert.deepStrictEqual(
        recursive.changes.map((c) => c.verNum),
        [1, 2, 3, 6, 1, 1],
      );
      assert.strictEqual(recursive.versions.find((v) => v.verNum === 2)?.label?.name, 'Релиз 1.0');
      const two = await probeResult(transport, 'probe-history-object-two');
      assert.deepStrictEqual(
        two.versions.map((v) => v.verNum),
        [1, 3, 4, 5, 2, 6],
      );
      assert.strictEqual(two.changes.length, 8);
      assert.deepStrictEqual(await probeResult(transport, 'probe-history-object-unknown'), { versions: [], changes: [] });
    });
  }

  test('объекты с диапазоном — mask 5, без диапазона — 4, без объектов — 1', async () => {
    const masks: [string, string][] = [
      ['probe-history-object-catalog-range', '5'],
      ['probe-history-object-catalog', '4'],
      ['probe-history-object-catalog-only-labels', '4'],
      ['probe-history-filter-none', '1'],
    ];
    for (const [probe, mask] of masks) {
      const { request, response } = tcpBodyProbe(probe);
      const { client, transport } = recordedClient([response]);
      await devDepotReport(client, AUTH, queryOf(request).query);
      assert.strictEqual(inputsOf(transport.requests[0].body).params.get('mask'), mask, probe);
    }
  });

  test('порядок objectIds сохраняется в crs:objRefs', async () => {
    const { request, response } = tcpBodyProbe('probe-history-object-two');
    const ids = inputsOf(request).objRefs;
    assert.strictEqual(ids.length, 2);
    const reversed = [...ids].reverse();
    const { client, transport } = recordedClient([response]);
    await devDepotReport(client, AUTH, { objectIds: reversed });
    assert.deepStrictEqual(inputsOf(transport.requests[0].body).objRefs, reversed);
    assert.strictEqual(
      transport.requests[0].body.toString('utf-8'),
      request.toString('utf-8').replace(`<crs:value value="${ids[0]}"/><crs:value value="${ids[1]}"/>`, `<crs:value value="${ids[1]}"/><crs:value value="${ids[0]}"/>`),
    );
  });

  test('recursive: false с объектами — то же тело, что без поля', async () => {
    const { request, response } = tcpBodyProbe('probe-history-object-catalog');
    const { client, transport } = recordedClient([response]);
    await devDepotReport(client, AUTH, { objectIds: [CONTRACTORS_ID], recursive: false });
    assert.deepStrictEqual(transport.requests[0].body, request);
  });

  test('неверный фильтр объектов — RangeError до вызова транспорта', async () => {
    const bad: CrsHistoryQuery[] = [
      { objectIds: [] },
      { objectIds: ['x'] },
      { objectIds: [CONTRACTORS_ID, `${CONTRACTORS_ID}"/>`] },
      { recursive: true },
      { objectIds: [], recursive: true },
    ];
    for (const query of bad) {
      const { client, transport } = recordedClient([]);
      const error = await rejection(devDepotReport(client, AUTH, query));
      assert.ok(error instanceof RangeError, JSON.stringify(query));
      assert.strictEqual(transport.requests.length, 0);
    }
  });
});

// Список версий DevDepot_devDepotVersions: пары crs:first (номер) / crs:second (info и метка). Оракул — те же
// регулярные выражения, что у отчёта, во внешней обёртке пары; номер пары сверяется с info/verNum.
const VERSION_PAIR = new RegExp(
  String.raw`<crs:value><crs:first value="(\d+)"/><crs:second><crs:info><crs:verNum value="(\d+)"/><crs:userID value="([^"]+)"/><crs:cvermajor value="\d+"/><crs:cverminor value="\d+"/>` +
    String.raw`<crs:pvermajor value="(\d+)"/><crs:pverminor value="(\d+)"/><crs:pverbuild value="(\d+)"/><crs:pverrevis value="(\d+)"/>` +
    String.raw`<crs:date value="([^"]+)"/><crs:code value="([^"]*)"/>${COMMENT}<crs:versionID value="([^"]+)"/></crs:info>` +
    String.raw`(?:<crs:label><crs:verNum value="\2"/><crs:userID value="([^"]+)"/><crs:date value="([^"]+)"/><crs:name value="([^"]*)"/>${COMMENT}</crs:label>)?</crs:second></crs:value>`,
  'g',
);

function expectedVersions(response: Buffer): CrsDepotVersion[] {
  const text = response.toString('utf-8');
  const versions = [...text.matchAll(VERSION_PAIR)].map((m): CrsDepotVersion => {
    assert.strictEqual(m[1], m[2], 'crs:first не совпал с info/verNum');
    const version = {
      verNum: Number(m[2]),
      versionId: m[11],
      userId: m[3],
      date: m[8],
      configVersion: m[9],
      platformVersion: [m[4], m[5], m[6], m[7]].join('.'),
      comment: unescape(m[10]),
    };
    const labelUser = m[12] as string | undefined;
    return labelUser === undefined ? version : { ...version, label: { userId: m[12], date: m[13], name: unescape(m[14]), comment: unescape(m[15]) } };
  });
  assert.strictEqual(versions.length, text.split('<crs:first ').length - 1, 'оракул пропустил версии');
  return versions;
}

const LIST_PROBES = [
  'probe-history-devdepotversions',
  'probe-history-devdepotversions-object-two',
  'probe-history-devdepotversions-object-catalog-recursive',
  'probe-history-devdepotversions-object-unknown',
  'probe-history-devdepotversions-object-root-recursive',
];

// Страница — отчёт по диапазону номеров: [проба, начало, конец, маска].
const PAGE_PROBES: [string, number, number, string][] = [
  ['probe-history-page-1-7', 1, 7, '1'],
  ['probe-history-page-5-7', 5, 7, '1'],
  ['probe-history-page-2-4', 2, 4, '1'],
  ['probe-history-page-1-1', 1, 1, '1'],
  ['probe-history-page-object-catalog-recursive-3-6', 3, 6, '5'],
  ['probe-history-page-object-catalog-recursive-1-2', 1, 2, '5'],
  ['probe-history-page-object-catalog-recursive-1-6', 1, 6, '5'],
  ['probe-history-page-object-root-recursive-5-7', 5, 7, '5'],
  ['probe-history-page-object-root-recursive-1-7', 1, 7, '5'],
];

async function listResult(transport: 'tcp' | 'http', probe: string): Promise<readonly CrsDepotVersion[]> {
  const { request, response } = bodyProbe(transport, probe);
  const { client } = recordedClient([response]);
  return devDepotVersions(client, AUTH, queryOf(request).query);
}

const byVerNum = (versions: readonly CrsDepotVersion[]): CrsDepotVersion[] => [...versions].sort((a, b) => a.verNum - b.verNum);
const changeKey = (c: CrsChangedObject): string => JSON.stringify(c);

/** История из нескольких страниц как одно целое: версии по номеру, изменения как мультимножество. */
function merged(histories: readonly CrsDepotHistory[]): { versions: CrsDepotVersion[]; changes: string[] } {
  return {
    versions: byVerNum(histories.flatMap((h) => h.versions)),
    changes: histories.flatMap((h) => h.changes.map(changeKey)).sort(),
  };
}

for (const transport of ['tcp', 'http'] as const) {
  suite(`crs history: devDepotVersions и страницы по диапазону на пробах ${transport}`, () => {
    for (const probe of LIST_PROBES) {
      test(`${probe}: запрос побайтно как у пробы, список — как оракул, без хешей`, async () => {
        const { request, response } = bodyProbe(transport, probe);
        const { auth } = inputsOf(request);
        assert.ok(auth);
        const { client, transport: recorded } = recordedClient([response]);
        const result = await devDepotVersions(client, auth, queryOf(request).query);
        assert.deepStrictEqual(recorded.requests[0].body, request);
        assert.deepStrictEqual(result, expectedVersions(response));
        assert.deepStrictEqual(
          result.map((v) => v.verNum),
          probeSummary(transport, probe).versions,
        );
        assertNoHashes(result, request, response);
        assert.ok(!/[0-9a-f]{40}/.test(JSON.stringify(result)), probe);
      });
    }

    test('список без фильтра — те же версии, что в отчёте без фильтра; двух объектов — уникальные версии отчёта', async () => {
      const all = await listResult(transport, 'probe-history-devdepotversions');
      assert.deepStrictEqual(
        all.map((v) => v.verNum),
        [1, 2, 3, 4, 5, 6, 7],
      );
      assert.deepStrictEqual(byVerNum(all), byVerNum((await probeResult(transport, 'probe-history-filter-none')).versions));
      const two = await listResult(transport, 'probe-history-devdepotversions-object-two');
      assert.deepStrictEqual(byVerNum(two), byVerNum((await probeResult(transport, 'probe-history-object-two')).versions));
      assert.deepStrictEqual(
        all.filter((v) => v.label).map((v) => [v.verNum, v.label?.name]),
        [
          [2, 'Релиз 1.0'],
          [4, 'Релиз 1.1'],
        ],
      );
    });

    test('справочник с подчинёнными — разреженный список 1, 2, 3, 6; корень с подчинёнными — все; неизвестный объект — пусто', async () => {
      assert.deepStrictEqual(
        (await listResult(transport, 'probe-history-devdepotversions-object-catalog-recursive')).map((v) => v.verNum),
        [1, 2, 3, 6],
      );
      assert.deepStrictEqual(
        (await listResult(transport, 'probe-history-devdepotversions-object-root-recursive')).map((v) => v.verNum),
        [1, 2, 3, 4, 5, 6, 7],
      );
      assert.deepStrictEqual(await listResult(transport, 'probe-history-devdepotversions-object-unknown'), []);
    });

    for (const [probe, begin, end, mask] of PAGE_PROBES) {
      test(`${probe}: запрос побайтно, маска ${mask}, версии и изменения только из диапазона ${String(begin)}–${String(end)}`, async () => {
        const { request, response } = bodyProbe(transport, probe);
        const { auth } = inputsOf(request);
        assert.ok(auth);
        const { query } = queryOf(request);
        assert.deepStrictEqual([query.beginVerNum, query.endVerNum], [begin, end]);
        const { client, transport: recorded } = recordedClient([response]);
        const result = await devDepotReport(client, auth, query);
        assert.deepStrictEqual(recorded.requests[0].body, request);
        assert.strictEqual(inputsOf(recorded.requests[0].body).params.get('mask'), mask);
        assert.strictEqual(inputsOf(request).objRefs.length > 0, mask === '5');
        assert.deepStrictEqual(result, expectedHistory(response));
        assert.ok(result.versions.length > 0, probe);
        assert.ok(result.versions.every((v) => v.verNum >= begin && v.verNum <= end), probe);
        assert.ok(result.changes.every((c) => c.verNum >= begin && c.verNum <= end), probe);
        assertNoHashes(result, request, response);
      });
    }

    test('страницы 5–7, 2–4, 1–1 и одна страница 1–7 вместе — полная история без фильтра', async () => {
      const full = merged([await probeResult(transport, 'probe-history-filter-none')]);
      const pages = await Promise.all(['probe-history-page-5-7', 'probe-history-page-2-4', 'probe-history-page-1-1'].map((p) => probeResult(transport, p)));
      assert.deepStrictEqual(merged(pages), full);
      assert.deepStrictEqual(merged([await probeResult(transport, 'probe-history-page-1-7')]), full);
    });

    test('страницы справочника 3–6 и 1–2 (и одна 1–6) — история справочника с подчинёнными; корень 5–7 — только версии 5, 6, 7', async () => {
      const recursive = merged([await probeResult(transport, 'probe-history-object-catalog-recursive')]);
      const pages = await Promise.all(
        ['probe-history-page-object-catalog-recursive-3-6', 'probe-history-page-object-catalog-recursive-1-2'].map((p) => probeResult(transport, p)),
      );
      assert.deepStrictEqual(merged(pages), recursive);
      assert.deepStrictEqual(merged([await probeResult(transport, 'probe-history-page-object-catalog-recursive-1-6')]), recursive);
      const root = await probeResult(transport, 'probe-history-page-object-root-recursive-5-7');
      assert.deepStrictEqual(
        root.versions.map((v) => v.verNum),
        [5, 6, 7],
      );
      assert.deepStrictEqual([...new Set(root.changes.map((c) => c.verNum))].sort(), [5, 6, 7]);
      const rootAll = await probeResult(transport, 'probe-history-page-object-root-recursive-1-7');
      assert.deepStrictEqual(byVerNum(rootAll.versions), byVerNum((await probeResult(transport, 'probe-history-filter-none')).versions));
    });
  });
}

suite('crs history: devDepotVersions — отказы и проверка входа', () => {
  const VERSIONS_METHOD = 'DevDepot_devDepotVersions';

  test('запись фильтра crs-api — исключение сервера CrsCallError с методом devDepotVersions', async () => {
    const { response } = tcpBodyProbe('probe-history-devdepotversions-crs-api');
    const { client } = recordedClient([response]);
    const error = await callRejection(devDepotVersions(client, AUTH));
    assert.strictEqual(error.details.method, VERSIONS_METHOD);
  });

  test('неверный пароль — auth-failed без хеша', async () => {
    const { request, response } = tcpBodyProbe('probe-history-wrong-password');
    const { auth } = inputsOf(request);
    assert.ok(auth);
    const { client } = recordedClient([response]);
    const error = await callRejection(devDepotVersions(client, auth));
    assert.strictEqual(error.kind, 'auth-failed');
    assert.strictEqual(error.details.method, VERSIONS_METHOD);
    assertNoHashes(error, request);
  });

  test('ответ другого метода (отчёт истории, depotInfo, статистика, пользователи) — malformed-response с причиной CrsFormatError', async () => {
    const bodies = [
      tcpBodyProbe('probe-history-filter-none').response,
      ...['09-conn-02-s2c-call_return.xml', '11-conn-02-s2c-call_return.xml', '14-conn-03-s2c-call_return.xml'].map((f) => readFixture('tcp', 'history-all', f)),
    ];
    for (const body of bodies) {
      const { client } = recordedClient([body]);
      const error = await callRejection(devDepotVersions(client, AUTH));
      assert.strictEqual(error.kind, 'malformed-response');
      assert.strictEqual(error.details.method, VERSIONS_METHOD);
      assert.ok(error.details.cause instanceof CrsFormatError);
    }
  });

  test('CrsTransportError (timeout, too-large) пробрасывается как есть, CrsCallOptions доходят до транспорта', async () => {
    for (const kind of ['timeout', 'too-large'] as const) {
      const failure = new CrsTransportError(kind, 'отказ', { endpoint: 'tcp://127.0.0.1:1542' });
      const options = { timeoutMs: 1234, maxResponseBytes: 5678 };
      const { client, transport } = recordedClient([failure]);
      assert.strictEqual(await rejection(devDepotVersions(client, AUTH, {}, options)), failure);
      assert.strictEqual(transport.requests[0].options, options);
    }
  });

  test('неверный диапазон или фильтр объектов — RangeError до вызова транспорта у обоих методов', async () => {
    const bad: CrsHistoryQuery[] = [
      { beginVerNum: 0 },
      { endVerNum: -1 },
      { beginVerNum: 1.5 },
      { endVerNum: Number.NaN },
      { beginVerNum: 3, endVerNum: 2 },
      { objectIds: [] },
      { objectIds: ['x'] },
      { recursive: true },
    ];
    for (const method of [devDepotVersions, devDepotReport]) {
      for (const query of bad) {
        const { client, transport } = recordedClient([]);
        const error = await rejection(method(client, AUTH, query));
        assert.ok(error instanceof RangeError, JSON.stringify(query));
        assert.strictEqual(transport.requests.length, 0);
      }
    }
  });
});
