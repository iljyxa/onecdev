import * as assert from 'assert';
import { CrsFormatError } from '../../infra/repository/crs/CrsErrors';
import type { CrsDepotUser } from '../../infra/repository/crs/CrsStatistic';
import { CrsTransportError } from '../../infra/repository/crs/CrsTransport';
import { depotUsers } from '../../infra/repository/crs/CrsUsers';
import { assertNoHashes, callRejection, inputsOf, param, recordedClient, rejection } from './support/crsMethods';
import { corpusExchanges, readFixture, tcpBodyProbe } from './support/crsFixtures';

const METHOD = 'UserManager_depotUsers';
const AUTH = { user: 'Admin', passwordHash: 'd41d8cd98f00b204e9800998ecf8427e' };

const USER =
  /<crs:value><crs:first value="([^"]+)"\/><crs:second><crs:info><crs:id value="\1"\/><crs:name value="([^"]+)"\/><crs:password value="[0-9a-f]*"\/><crs:rights value="(\d+)"\/><\/crs:info><crs:online value="(true|false)"\/><crs:removed value="(true|false)"\/><\/crs:second><\/crs:value>/g;

/** Оракул ответа — регулярным выражением; число записей сверяется с числом crs:value. */
function expectedUsers(response: Buffer): CrsDepotUser[] {
  const text = response.toString('utf-8');
  const users = [...text.matchAll(USER)].map((m) => ({ id: m[1], name: m[2], rights: Number(m[3]), online: m[4] === 'true', removed: m[5] === 'true' }));
  assert.strictEqual(users.length, text.split('<crs:value>').length - 1, 'оракул пропустил записи');
  return users;
}

function inputs(request: Buffer): { auth: typeof AUTH; query: { removed: boolean; bindId?: string } } {
  const { auth, bindId, params } = inputsOf(request);
  assert.ok(auth);
  return { auth, query: { removed: param(params, 'removed') === 'true', ...(bindId === undefined ? {} : { bindId }) } };
}

suite('crs users: UserManager_depotUsers на снятых телах', () => {
  test('каждый снятый запрос воспроизводится побайтно, ответ разбирается без хешей', async () => {
    const exchanges = corpusExchanges().filter((e) => e.method === METHOD);
    assert.strictEqual(exchanges.length, 21);
    for (const e of exchanges) {
      const { auth, query } = inputs(e.request);
      const { client, transport } = recordedClient([e.response]);
      const result = await depotUsers(client, auth, query);
      assert.deepStrictEqual(transport.requests[0].body, e.request, e.scenario);
      assert.deepStrictEqual(result, expectedUsers(e.response), e.scenario);
      assertNoHashes(result, e.request, e.response);
    }
  });

  test('history-all: Admin (65535) и Petrov (3)', async () => {
    const e = corpusExchanges().find((x) => x.method === METHOD && x.scenario === 'history-all');
    assert.ok(e);
    const { client } = recordedClient([e.response]);
    const users = await depotUsers(client, AUTH, { removed: true });
    assert.deepStrictEqual(users.map((u) => [u.name, u.rights]).sort(), [
      ['Admin', 65535],
      ['Petrov', 3],
    ]);
  });

  test('http (#82): список пользователей истории по .1ccr — Admin и Petrov, запрос воспроизводится побайтно', async () => {
    const http = corpusExchanges().filter((e) => e.method === METHOD && e.transport === 'http' && e.scenario.startsWith('history-'));
    assert.strictEqual(http.length, 10);
    for (const e of http) {
      const { auth, query } = inputs(e.request);
      const { client, transport } = recordedClient([e.response]);
      const users = await depotUsers(client, auth, query);
      assert.deepStrictEqual(transport.requests[0].body, e.request, e.scenario);
      assert.deepStrictEqual(users.map((u) => [u.name, u.rights]).sort(), [['Admin', 65535], ['Petrov', 3]], e.scenario);
    }
  });

  test('пробы: без crs:bind и от Reader (ReadOnly) — один и тот же список, в нём и сам Reader', async () => {
    const results: (readonly CrsDepotUser[])[] = [];
    for (const probe of ['probe-depot-users-no-bind', 'probe-depot-users-reader-no-bind']) {
      const { request, response } = tcpBodyProbe(probe);
      const { auth, query } = inputs(request);
      assert.strictEqual(query.bindId, undefined, probe);
      const { client, transport } = recordedClient([response]);
      const result = await depotUsers(client, auth, query);
      assert.deepStrictEqual(transport.requests[0].body, request, probe);
      assert.deepStrictEqual(result, expectedUsers(response), probe);
      assertNoHashes(result, request, response);
      results.push(result);
    }
    assert.deepStrictEqual(results[1], results[0]);
    assert.deepStrictEqual(results[0].find((u) => u.name === 'Reader')?.rights, 0);
  });

  test('ответ другого метода (depotInfo, история) — malformed-response с причиной CrsFormatError', async () => {
    for (const file of ['09-conn-02-s2c-call_return.xml', '12-conn-02-s2c-call_return.xml']) {
      const { client } = recordedClient([readFixture('tcp', 'history-all', file)]);
      const error = await callRejection(depotUsers(client, AUTH, { removed: true }));
      assert.strictEqual(error.kind, 'malformed-response', file);
      assert.strictEqual(error.details.method, METHOD);
      assert.ok(error.details.cause instanceof CrsFormatError, file);
    }
  });

  test('CrsTransportError пробрасывается как есть, CrsCallOptions доходят до транспорта', async () => {
    const timeout = new CrsTransportError('timeout', 'дедлайн истёк', { endpoint: 'tcp://127.0.0.1:1542' });
    const options = { timeoutMs: 1234 };
    const { client, transport } = recordedClient([timeout]);
    assert.strictEqual(await rejection(depotUsers(client, AUTH, { removed: false }, options)), timeout);
    assert.strictEqual(transport.requests[0].options, options);
    assert.ok(transport.requests[0].body.includes('<crs:removed value="false"/>'));
  });
});
