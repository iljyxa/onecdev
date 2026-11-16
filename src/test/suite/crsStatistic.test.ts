import * as assert from 'assert';
import { CrsFormatError } from '../../infra/repository/crs/CrsErrors';
import {
  type CrsDepotUser,
  type CrsDevObjectsStatistic,
  type CrsObjectStatus,
  type CrsStatisticQuery,
  devObjectsStatistic,
} from '../../infra/repository/crs/CrsStatistic';
import { CrsTransportError } from '../../infra/repository/crs/CrsTransport';
import { assertNoHashes, callRejection, inputsOf, recordedClient, rejection } from './support/crsMethods';
import { corpusExchanges, type CorpusExchange, readFixture, TCP_BODY_PROBES, tcpBodyProbe } from './support/crsFixtures';

const METHOD = 'DevDepot_devObjectsStatistic';
const AUTH = { user: 'Petrov', passwordHash: '5fa285e1bebe0a6623e33afc04a1fbd5' };
const CONTRACTORS = '3e33ad69-478f-4f02-bad5-751699f70814';
const PETROV = 'e9772f67-67fe-408a-a325-b072d940915f';

const STAT = /<crs:value><crs:first value="([^"]+)"\/><crs:second><crs:verNum value="(-?\d+)"\/><crs:revised value="(true|false)"\/><crs:revisorID value="([^"]+)"\/><crs:reviseDate value="([^"]+)"\/><\/crs:second><\/crs:value>/g;
const BINDING = /<crs:value><crs:userID value="([^"]+)"\/><crs:bindID value="([^"]+)"\/><crs:bindString value="([^"]*)"\/><crs:online value="(true|false)"\/><\/crs:value>/g;
const USER = /<crs:value><crs:first value="([^"]+)"\/><crs:second><crs:info><crs:id value="\1"\/><crs:name value="([^"]+)"\/><crs:password value="[0-9a-f]*"\/><crs:rights value="(\d+)"\/><\/crs:info><crs:online value="(true|false)"\/><crs:removed value="(true|false)"\/><\/crs:second><\/crs:value>/g;

/** Оракул ответа — регулярными выражениями; число найденных записей сверяется с числом crs:value. */
function expectedStatistic(response: Buffer): CrsDevObjectsStatistic {
  const text = response.toString('utf-8');
  const objects = [...text.matchAll(STAT)].map((m): CrsObjectStatus => ({
    objectId: m[1],
    version: Number(m[2]),
    ...(m[3] === 'true' ? { lock: { userId: m[4], date: m[5] } } : {}),
  }));
  const bindings = [...text.matchAll(BINDING)].map((m) => ({
    userId: m[1],
    bindId: m[2],
    bindString: m[3].replace(/&quot;/g, '"'),
    online: m[4] === 'true',
  }));
  const users = [...text.matchAll(USER)].map(
    (m): CrsDepotUser => ({ id: m[1], name: m[2], rights: Number(m[3]), online: m[4] === 'true', removed: m[5] === 'true' }),
  );
  assert.strictEqual(objects.length + bindings.length + users.length, text.split('<crs:value>').length - 1, 'оракул пропустил записи');
  return { objects, bindings, users };
}

function queryOf(request: Buffer): { query: CrsStatisticQuery; auth: typeof AUTH } {
  const { auth, bindId, params, objRefs } = inputsOf(request);
  assert.ok(auth);
  const removed = params.get('removed') === 'true';
  return {
    auth,
    query: { removed, ...(objRefs.length > 0 ? { objectIds: objRefs } : {}), ...(bindId === undefined ? {} : { bindId }) },
  };
}

function statisticExchanges(): CorpusExchange[] {
  const result = corpusExchanges().filter((e) => e.method === METHOD);
  assert.strictEqual(result.length, 47);
  return result;
}

function exchange(transport: 'tcp' | 'http', scenario: string, index: number): CorpusExchange {
  const found = statisticExchanges().filter((e) => e.transport === transport && e.scenario === scenario)[index];
  assert.ok(found, `${transport}/${scenario}#${String(index)}`);
  return found;
}

async function decoded(e: CorpusExchange): Promise<CrsDevObjectsStatistic> {
  const { auth, query } = queryOf(e.request);
  const { client } = recordedClient([e.response]);
  return devObjectsStatistic(client, auth, query);
}

suite('crs statistic: devObjectsStatistic на снятых телах', () => {
  test('каждый снятый запрос воспроизводится побайтно, ответ разбирается в модель без хешей (tcp и http)', async () => {
    const seen = { tcp: 0, http: 0, objRefs: 0, full: 0 };
    for (const e of statisticExchanges()) {
      const name = `${e.transport}/${e.scenario}/${e.conn}`;
      const { auth, query } = queryOf(e.request);
      const { client, transport } = recordedClient([e.response]);
      const result = await devObjectsStatistic(client, auth, query);
      assert.deepStrictEqual(transport.requests[0].body, e.request, name);
      assert.deepStrictEqual(result, expectedStatistic(e.response), name);
      assertNoHashes(result, e.request, e.response);
      seen[e.transport] += 1;
      seen[query.objectIds === undefined ? 'full' : 'objRefs'] += 1;
    }
    assert.ok(Object.values(seen).every((n) => n > 0), JSON.stringify(seen));
  });

  test('tcp/lock-one/14: 9 объектов без захвата, 4 пользователя с правами 0/3/3/65535, 4 привязки', async () => {
    const result = await decoded(exchange('tcp', 'lock-one', 0));
    assert.strictEqual(result.objects.length, 9);
    assert.ok(result.objects.every((o) => o.lock === undefined && o.version === 1));
    assert.deepStrictEqual(
      result.users.map((u) => u.rights).sort((a, b) => a - b),
      [0, 3, 3, 65535],
    );
    assert.strictEqual(result.bindings.length, 4);
    assert.ok(result.users.every((u) => !u.removed));
  });

  test('tcp/lock-one/18: Справочник.Контрагенты захвачен Petrov', async () => {
    const result = await decoded(exchange('tcp', 'lock-one', 1));
    assert.deepStrictEqual(result.objects, [{ objectId: CONTRACTORS, version: 1, lock: { userId: PETROV, date: '2026-09-29T16:57:23' } }]);
    assert.deepStrictEqual(
      result.users.find((u) => u.name === 'Petrov'),
      { id: PETROV, name: 'Petrov', rights: 3, online: false, removed: false },
    );
  });

  test('unlock-one/18 (tcp и http): захвата нет', async () => {
    for (const transport of ['tcp', 'http'] as const) {
      const result = await decoded(exchange(transport, 'unlock-one', 1));
      assert.deepStrictEqual(result.objects.map((o) => [o.objectId, o.lock]), [[CONTRACTORS, undefined]], transport);
    }
  });

  test('lock-held-by-other: чужой захват Petrov в первой же статистике Sidorov (tcp и http)', async () => {
    for (const transport of ['tcp', 'http'] as const) {
      const result = await decoded(exchange(transport, 'lock-held-by-other', 0));
      const contractors = result.objects.find((o) => o.objectId === CONTRACTORS);
      const petrov = result.users.find((u) => u.name === 'Petrov');
      assert.ok(contractors?.lock && petrov, transport);
      assert.strictEqual(contractors.lock.userId, petrov.id, transport);
    }
  });

  test('lock-several: objRefs из двух значений; history-all: версии объектов больше 1', async () => {
    const several = exchange('tcp', 'lock-several', 1);
    assert.strictEqual(queryOf(several.request).query.objectIds?.length, 2);
    assert.strictEqual((await decoded(several)).objects.length, 2);
    const history = await decoded(exchange('tcp', 'history-all', 0));
    assert.ok(history.objects.some((o) => o.version > 1), JSON.stringify(history.objects));
  });

  test('пробы: без crs:bind, со случайным bindID и Reader без привязки — тот же ответ, что с привязкой Petrov', async () => {
    const control = tcpBodyProbe('probe-statistic-own-bind');
    const probes = Object.keys(TCP_BODY_PROBES).filter((p) => p.startsWith('probe-statistic-') && TCP_BODY_PROBES[p] === 'return');
    assert.strictEqual(probes.length, 5);
    const expected = expectedStatistic(control.response);
    // Контрольная проба на свежем соединении без openDevDepot и authenticate видит захват Petrov.
    assert.ok(expected.objects.some((o) => o.objectId === CONTRACTORS && o.lock !== undefined));
    for (const probe of probes) {
      const { request, response } = tcpBodyProbe(probe);
      const { auth, query } = queryOf(request);
      assert.strictEqual(query.bindId !== undefined, probe === 'probe-statistic-own-bind' || probe === 'probe-statistic-random-bind', probe);
      const { client, transport } = recordedClient([response]);
      const result = await devObjectsStatistic(client, auth, query);
      assert.deepStrictEqual(transport.requests[0].body, request, probe);
      assert.deepStrictEqual(result, expected, probe);
    }
  });

  test('проба bind existing=false не завела привязку: в bindInfos нет ibProbe', async () => {
    const { request, response } = tcpBodyProbe('probe-statistic-after-bind-new');
    const { auth, query } = queryOf(request);
    const { client } = recordedClient([response]);
    const result = await devObjectsStatistic(client, auth, query);
    assert.strictEqual(result.bindings.length, 4);
    assert.ok(result.bindings.every((b) => !b.bindString.includes('ibProbe')));
  });

  test('неверный пароль без предварительного authenticate — auth-failed без хеша', async () => {
    const { request, response } = tcpBodyProbe('probe-statistic-wrong-password');
    const { auth, query } = queryOf(request);
    const { client, transport } = recordedClient([response]);
    const error = await callRejection(devObjectsStatistic(client, auth, query));
    assert.deepStrictEqual(transport.requests[0].body, request);
    assert.strictEqual(error.kind, 'auth-failed');
    assert.strictEqual(error.details.method, METHOD);
    assertNoHashes(error, request);
  });

  test('ответ другого метода (depotInfo, bind) — malformed-response с причиной CrsFormatError', async () => {
    for (const file of ['12-conn-02-s2c-call_return.xml', '13-conn-02-s2c-call_return.xml']) {
      const { client } = recordedClient([readFixture('tcp', 'lock-one', file)]);
      const error = await callRejection(devObjectsStatistic(client, AUTH, { removed: true }));
      assert.strictEqual(error.kind, 'malformed-response', file);
      assert.strictEqual(error.details.method, METHOD);
      assert.ok(error.details.cause instanceof CrsFormatError, file);
    }
  });

  test('пустой objectIds — полный запрос <crs:objRefs/>, как без objectIds', async () => {
    const e = exchange('tcp', 'lock-one', 0);
    const { auth, query } = queryOf(e.request);
    const { client, transport } = recordedClient([e.response]);
    await devObjectsStatistic(client, auth, { ...query, objectIds: [] });
    assert.deepStrictEqual(transport.requests[0].body, e.request);
  });

  test('CrsTransportError пробрасывается как есть, CrsCallOptions доходят до транспорта', async () => {
    const timeout = new CrsTransportError('timeout', 'дедлайн истёк', { endpoint: 'tcp://127.0.0.1:1542' });
    const options = { timeoutMs: 1234 };
    const { client, transport } = recordedClient([timeout]);
    assert.strictEqual(await rejection(devObjectsStatistic(client, AUTH, { removed: true }, options)), timeout);
    assert.strictEqual(transport.requests[0].options, options);
  });
});
