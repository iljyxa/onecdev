import * as assert from 'assert';
import {
  authenticate,
  bind,
  type CrsBinding,
  type CrsDepotInfo,
  type CrsUserInfo,
  depotInfo,
  openDevDepot,
} from '../../infra/repository/crs/CrsDepot';
import { CrsFormatError } from '../../infra/repository/crs/CrsErrors';
import { CrsTransportError } from '../../infra/repository/crs/CrsTransport';
import {
  assertNoHashes,
  attr,
  callRejection,
  inputsOf,
  param,
  recordedClient,
  rejection,
} from './support/crsMethods';
import { corpusExchanges, type CorpusExchange, readFixture, tcpBodyProbe, tcpRawProbeBodies } from './support/crsFixtures';

const AUTH = { user: 'Petrov', passwordHash: '5fa285e1bebe0a6623e33afc04a1fbd5' };

function exchangesOf(method: string, expected: number): CorpusExchange[] {
  const result = corpusExchanges().filter((e) => e.method === method);
  // Сверка с числом снятых вызовов: пересъёмка, потерявшая сценарий, не должна молча сузить проверку.
  assert.strictEqual(result.length, expected, method);
  assert.ok(result.some((e) => e.transport === 'http') && result.some((e) => e.transport === 'tcp'), method);
  return result;
}

function nameOf(e: CorpusExchange): string {
  return `${e.transport}/${e.scenario}/${e.conn}/${e.method}`;
}

/** Оракул ответа openDevDepot и depotInfo — регулярными выражениями по тексту. */
function expectedDepotInfo(response: Buffer): CrsDepotInfo {
  const text = response.toString('utf-8');
  return {
    formatMajor: Number(attr(text, /<crs:major value="(\d+)"/)),
    formatMinor: Number(attr(text, /<crs:minor value="(\d+)"/)),
    depotId: attr(text, /<crs:depotID value="([^"]+)"/),
    rootId: attr(text, /<crs:rootID value="([^"]+)"/),
    mode: Number(attr(text, /<crs:mode value="(\d+)"/)),
    date: attr(text, /<crs:date value="([^"]+)"/),
    isExtension: attr(text, /<crs:isExtension value="(true|false)"/) === 'true',
  };
}

suite('crs depot: openDevDepot, authenticate, depotInfo, bind на снятых телах', () => {
  test('openDevDepot: запрос побайтно как у Конфигуратора, ответ — сведения о хранилище (tcp и http)', async () => {
    for (const e of exchangesOf('DevDepotAdmin_openDevDepot', 43)) {
      const { client, transport } = recordedClient([e.response]);
      const info = await openDevDepot(client);
      assert.deepStrictEqual(transport.requests[0].body, e.request, nameOf(e));
      assert.deepStrictEqual(info, expectedDepotInfo(e.response), nameOf(e));
    }
  });

  test('openDevDepot: значения tcp/lock-one/02', async () => {
    const { client } = recordedClient([readFixture('tcp', 'lock-one', '02-conn-01-s2c-call_return.xml')]);
    assert.deepStrictEqual(await openDevDepot(client), {
      formatMajor: 7,
      formatMinor: 0,
      depotId: 'e377bd3c-bf5d-4422-937d-0552f111b2e0',
      rootId: '2bb900db-6e85-48a9-a049-b7aedbe761cc',
      mode: 80306,
      date: '2026-09-29T16:57:07',
      isExtension: false,
    });
  });

  test('depotInfo: запрос с crs:auth и пустыми params побайтно, ответ как у openDevDepot (tcp и http)', async () => {
    for (const e of exchangesOf('DevDepot_depotInfo', 35)) {
      const { auth } = inputsOf(e.request);
      assert.ok(auth, nameOf(e));
      const { client, transport } = recordedClient([e.response]);
      const info = await depotInfo(client, auth);
      assert.deepStrictEqual(transport.requests[0].body, e.request, nameOf(e));
      assert.deepStrictEqual(info, expectedDepotInfo(e.response), nameOf(e));
    }
  });

  test('authenticate: учётные данные в params побайтно; успех — пользователь без хеша, отказ — auth-failed (tcp и http)', async () => {
    let failed = 0;
    for (const e of exchangesOf('DevDepot_authenticate', 43)) {
      const inputs = inputsOf(e.request);
      assert.strictEqual(inputs.auth, undefined, nameOf(e));
      const auth = { user: param(inputs.params, 'user'), passwordHash: param(inputs.params, 'password') };
      const { client, transport } = recordedClient([e.response]);
      const text = e.response.toString('utf-8');
      if (text.includes('call_exception')) {
        failed += 1;
        const error = await callRejection(authenticate(client, auth));
        assert.strictEqual(error.kind, 'auth-failed', nameOf(e));
        assert.strictEqual(error.details.code, 4, nameOf(e));
        assertNoHashes(error, e.request);
      } else {
        const user = await authenticate(client, auth);
        const expected: CrsUserInfo = {
          id: attr(text, /<crs:id value="([^"]+)"/),
          name: auth.user,
          rights: Number(attr(text, /<crs:rights value="(\d+)"/)),
        };
        assert.deepStrictEqual(user, expected, nameOf(e));
        assertNoHashes(user, e.request, e.response);
      }
      assert.deepStrictEqual(transport.requests[0].body, e.request, nameOf(e));
    }
    // Неверный пароль и неизвестный пользователь, по два соединения на сценарий, tcp и http.
    assert.strictEqual(failed, 8);
  });

  test('authenticate: права Petrov (3) и Reader (0)', async () => {
    const petrov = recordedClient([readFixture('tcp', 'lock-one', '11-conn-02-s2c-call_return.xml')]);
    assert.deepStrictEqual(await authenticate(petrov.client, AUTH), {
      id: 'e9772f67-67fe-408a-a325-b072d940915f',
      name: 'Petrov',
      rights: 3,
    });
    const reader = corpusExchanges().find((e) => e.transport === 'tcp' && e.scenario === 'lock-no-right' && e.method === 'DevDepot_authenticate');
    assert.ok(reader);
    const { client } = recordedClient([reader.response]);
    const user = await authenticate(client, { user: 'Reader', passwordHash: param(inputsOf(reader.request).params, 'password') });
    assert.strictEqual(user.name, 'Reader');
    assert.strictEqual(user.rights, 0);
  });

  test('bind: params bindID, bindString, existing, force побайтно; ответ — привязка (tcp и http)', async () => {
    for (const e of exchangesOf('DevDepot_bind', 35)) {
      const { auth, params } = inputsOf(e.request);
      assert.ok(auth, nameOf(e));
      const request = {
        bindId: param(params, 'bindID'),
        bindString: param(params, 'bindString'),
        existing: params.get('existing') === 'true',
        force: params.get('force') === 'true',
      };
      const { client, transport } = recordedClient([e.response]);
      const binding = await bind(client, auth, request);
      assert.deepStrictEqual(transport.requests[0].body, e.request, nameOf(e));
      const text = e.response.toString('utf-8');
      const expected: CrsBinding = {
        userId: attr(text, /<crs:userID value="([^"]+)"/),
        bindId: request.bindId,
        bindString: request.bindString,
        online: attr(text, /<crs:online value="(true|false)"/) === 'true',
      };
      assert.deepStrictEqual(binding, expected, nameOf(e));
    }
  });

  test('bind: значения tcp/lock-one/13 — привязка из ответа, online на момент ответа', async () => {
    const e = corpusExchanges().find((x) => x.transport === 'tcp' && x.scenario === 'lock-one' && x.method === 'DevDepot_bind');
    assert.ok(e);
    const { client } = recordedClient([e.response]);
    const binding = await bind(client, AUTH, {
      bindId: 'a5384da4-55fc-4e28-9642-1277f4d44c34',
      bindString: 'Computer="crs-stand";Config="/tmp/crs-stand/work/ibPetrov";',
      existing: true,
      force: false,
    });
    assert.deepStrictEqual(binding, {
      userId: 'e9772f67-67fe-408a-a325-b072d940915f',
      bindId: 'a5384da4-55fc-4e28-9642-1277f4d44c34',
      bindString: 'Computer="crs-stand";Config="/tmp/crs-stand/work/ibPetrov";',
      online: true,
    });
  });

  test('bind с незарегистрированным bindID (пробы): existing=true и existing=false — отказ server, запрос побайтно', async () => {
    for (const [probe, code] of [
      ['probe-bind-unknown-existing', 11],
      ['probe-bind-new', 10],
    ] as const) {
      const { request, response } = tcpBodyProbe(probe);
      const { auth, params } = inputsOf(request);
      assert.ok(auth);
      const { client, transport } = recordedClient([response]);
      const error = await callRejection(
        bind(client, auth, {
          bindId: param(params, 'bindID'),
          bindString: param(params, 'bindString'),
          existing: params.get('existing') === 'true',
          force: false,
        }),
      );
      assert.deepStrictEqual(transport.requests[0].body, request, probe);
      assert.strictEqual(error.kind, 'server', probe);
      assert.strictEqual(error.details.code, code, probe);
      assert.strictEqual(error.details.method, 'DevDepot_bind', probe);
      assertNoHashes(error, request);
    }
  });

  test('openDevDepot: неверный alias по tcp и http — depot-not-found', async () => {
    for (const body of [tcpRawProbeBodies('probe-wrong-alias').response.body, readFixture('http', 'probe-wrong-alias', 'response.xml')]) {
      const { client } = recordedClient([body]);
      const error = await callRejection(openDevDepot(client));
      assert.strictEqual(error.kind, 'depot-not-found');
      assert.strictEqual(error.details.method, 'DevDepotAdmin_openDevDepot');
    }
  });

  test('openDevDepot: чужая версия (probe-version-other) — version-mismatch не глотается', async () => {
    const { client } = recordedClient([tcpRawProbeBodies('probe-version-other').response.body]);
    const error = await callRejection(openDevDepot(client));
    assert.strictEqual(error.kind, 'version-mismatch');
    assert.strictEqual(error.details.serverVersion, '8.5.1.1529');
  });

  test('ответ другого метода — malformed-response с причиной CrsFormatError', async () => {
    const response = (file: string): Buffer => readFixture('tcp', 'lock-one', file);
    const bindResponse = response('13-conn-02-s2c-call_return.xml');
    const depotResponse = response('12-conn-02-s2c-call_return.xml');
    const cases: [string, (c: ReturnType<typeof recordedClient>['client']) => Promise<unknown>, Buffer][] = [
      ['DevDepotAdmin_openDevDepot', (c) => openDevDepot(c), bindResponse],
      ['DevDepot_depotInfo', (c) => depotInfo(c, AUTH), bindResponse],
      ['DevDepot_authenticate', (c) => authenticate(c, AUTH), depotResponse],
      [
        'DevDepot_bind',
        (c) => bind(c, AUTH, { bindId: 'a5384da4-55fc-4e28-9642-1277f4d44c34', bindString: '', existing: true, force: false }),
        depotResponse,
      ],
    ];
    for (const [method, call, body] of cases) {
      const { client } = recordedClient([body]);
      const error = await callRejection(call(client));
      assert.strictEqual(error.kind, 'malformed-response', method);
      assert.strictEqual(error.details.method, method);
      assert.ok(error.details.cause instanceof CrsFormatError, method);
    }
  });

  test('CrsTransportError пробрасывается как есть, CrsCallOptions доходят до транспорта', async () => {
    const options = { timeoutMs: 1234, maxResponseBytes: 4096 };
    const calls: [string, (c: ReturnType<typeof recordedClient>['client']) => Promise<unknown>][] = [
      ['openDevDepot', (c) => openDevDepot(c, options)],
      ['depotInfo', (c) => depotInfo(c, AUTH, options)],
      ['authenticate', (c) => authenticate(c, AUTH, options)],
      ['bind', (c) => bind(c, AUTH, { bindId: 'a5384da4-55fc-4e28-9642-1277f4d44c34', bindString: '', existing: true, force: false }, options)],
    ];
    for (const [name, call] of calls) {
      const timeout = new CrsTransportError('timeout', 'дедлайн истёк', { endpoint: 'tcp://127.0.0.1:1542' });
      const { client, transport } = recordedClient([timeout]);
      assert.strictEqual(await rejection(call(client)), timeout, name);
      assert.strictEqual(transport.requests[0].options, options, name);
    }
  });
});
