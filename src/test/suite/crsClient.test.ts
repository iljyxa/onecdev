import * as assert from 'assert';
import { CRS_VERSION_PROBE, CrsClient } from '../../infra/repository/crs/CrsClient';
import { crsValue, type CrsElement } from '../../infra/xml/crs/CrsEnvelope';
import { CrsCallError, type CrsCallErrorKind, CrsFormatError } from '../../infra/repository/crs/CrsErrors';
import { CRS_CLSID_DEPOT, VRS_CLSID_XML_PARSE } from '../../infra/repository/crs/CrsException';
import { CrsHttpTransport } from '../../infra/repository/crs/CrsHttpTransport';
import { crsPasswordHash } from '../../infra/repository/crs/CrsSecrets';
import { CrsTcpTransport } from '../../infra/repository/crs/CrsTcpTransport';
import { type CrsCallOptions, CrsTransportError } from '../../infra/repository/crs/CrsTransport';
import {
  clientIdFromHello,
  expectedHttpRequest,
  httpRawProbe,
  httpRawProbeBodies,
  rawConfiguratorConnections,
  readFixture,
  requestBodyOf,
  responseFrameOf,
  splitTcpFrame,
  tcpRawProbeBodies,
} from './support/crsFixtures';
import { RecordedTransport } from './support/crsRecordedTransport';
import { httpReplayOf, ReplayServer, replayOf, type ReplayStep } from './support/crsReplayServer';
import { type RecordedExchange, TRANSPORT_CASES } from './support/crsTransportCases';

const SERVER_VERSION = '8.5.1.1529';
const ENDPOINT = 'tcp://127.0.0.1:1542';
const OPEN_PARAMS: CrsElement[] = [crsValue('alias', 'exp'), crsValue('convert', false)];
const OPEN = { method: 'DevDepotAdmin_openDevDepot', params: OPEN_PARAMS };
// Параметры DevDepot_authenticate Конфигуратора с неверным паролем (tcp-raw/wrong-password, conn-02).
function authenticate(): { method: string; params: CrsElement[] } {
  return { method: 'DevDepot_authenticate', params: [crsValue('user', 'Petrov'), crsValue('password', crsPasswordHash('wrong'))] };
}

const versionZero = tcpRawProbeBodies('probe-version-zero');
const versionOther = tcpRawProbeBodies('probe-version-other');
const open = tcpRawProbeBodies('probe-open');
const wrongAlias = tcpRawProbeBodies('probe-wrong-alias');
const unknownMethod = tcpRawProbeBodies('probe-unknown-method');
const malformed = tcpRawProbeBodies('probe-malformed-body');
const wrongPassword = rawConfiguratorConnections().filter((c) => /^wrong-password(-rerun)?\/conn-02$/.test(c.name));

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => assert.fail('ожидался отказ'),
    (e: unknown) => e,
  );
}

async function callError(promise: Promise<unknown>, kind: CrsCallErrorKind): Promise<CrsCallError> {
  const error = await rejection(promise);
  assert.ok(error instanceof CrsCallError, String(error));
  assert.strictEqual(error.kind, kind, error.message);
  return error;
}

function statusError(status: number, body?: Buffer): CrsTransportError {
  return new CrsTransportError('status', `${ENDPOINT}: статус ${String(status)}`, { endpoint: ENDPOINT, status, ...(body ? { body } : {}) });
}

function known(transport: RecordedTransport): CrsClient {
  return new CrsClient(transport, { alias: 'exp', version: SERVER_VERSION });
}

suite('crs CrsClient: рукопожатие и вызовы на снятых ответах', () => {
  test('рукопожатие: запрос побайтно как проба probe-version-zero, версия из исключения, кэш', async () => {
    const transport = new RecordedTransport([versionZero.response.body, open.response.body]);
    const client = new CrsClient(transport, { alias: 'exp' });
    assert.strictEqual(CRS_VERSION_PROBE, '0.0.0.0');
    assert.strictEqual(await client.serverVersion(), SERVER_VERSION);
    assert.deepStrictEqual(transport.requests[0].body, versionZero.request);
    // Повторно в сеть не идёт, обычный вызов уходит с узнанной версией — тело пробы probe-open.
    assert.strictEqual(await client.serverVersion(), SERVER_VERSION);
    const element = await client.call(OPEN);
    assert.strictEqual(element.name, 'crs:call_return');
    assert.strictEqual(transport.requests.length, 2);
    assert.deepStrictEqual(transport.requests[1].body, open.request);
  });

  test('известная версия — без рукопожатия; версия не вида N.N.N.N — RangeError', async () => {
    const transport = new RecordedTransport([open.response.body]);
    const element = await known(transport).call(OPEN);
    assert.strictEqual(element.local, 'call_return');
    assert.deepStrictEqual(transport.requests.map((r) => r.body), [open.request]);
    for (const version of ['8.5.1', 'abc', '8.5.1.1529 ', '']) {
      assert.throws(() => new CrsClient(transport, { alias: 'exp', version }), RangeError, version);
    }
  });

  test('рукопожатие: сервер принял версию 0.0.0.0 — version-mismatch без версии, неуспех не кэшируется', async () => {
    const transport = new RecordedTransport([open.response.body, versionZero.response.body]);
    const client = new CrsClient(transport, { alias: 'exp' });
    const error = await callError(client.serverVersion(), 'version-mismatch');
    assert.strictEqual(error.details.serverVersion, undefined);
    assert.strictEqual(error.details.method, 'DevDepotAdmin_openDevDepot');
    assert.strictEqual(await client.serverVersion(), SERVER_VERSION);
    assert.strictEqual(transport.requests.length, 2);
  });

  test('рукопожатие: прочие отказы пробрасываются и не кэшируются', async () => {
    const timeout = new CrsTransportError('timeout', `${ENDPOINT}: нет ответа`, { endpoint: ENDPOINT });
    const transport = new RecordedTransport([wrongAlias.response.body, timeout, versionZero.response.body]);
    const client = new CrsClient(transport, { alias: 'exp' });
    await callError(client.serverVersion(), 'depot-not-found');
    assert.strictEqual(await rejection(client.serverVersion()), timeout);
    assert.strictEqual(await client.serverVersion(), SERVER_VERSION);
    assert.strictEqual(transport.requests.length, 3);
  });

  test('вызов: call_return возвращается корнем, CrsCallOptions доходят до транспорта', async () => {
    const transport = new RecordedTransport([versionZero.response.body, open.response.body]);
    const options: CrsCallOptions = { timeoutMs: 1234, maxResponseBytes: 4321 };
    const element = await new CrsClient(transport, { alias: 'exp' }).call(OPEN, options);
    assert.strictEqual(element.children[0].local, 'info');
    assert.deepStrictEqual(
      transport.requests.map((r) => r.options),
      [options, options],
    );
  });

  test('неверный пароль — auth-failed с clsid, кодом и сообщениями, без хеша и тела запроса', async () => {
    const [conn] = wrongPassword;
    const transport = new RecordedTransport([splitTcpFrame(responseFrameOf(conn.s2c)).body]);
    const error = await callError(known(transport).call(authenticate()), 'auth-failed');
    assert.deepStrictEqual(transport.requests[0].body, requestBodyOf(conn.c2s));
    assert.strictEqual(error.details.method, 'DevDepot_authenticate');
    assert.strictEqual(error.details.clsid, CRS_CLSID_DEPOT);
    assert.strictEqual(error.details.code, 4);
    assert.ok(error.details.messages?.[0].startsWith('Ошибка аутентификации в хранилище конфигурации!'));
    assert.ok(error.message.includes('Ошибка аутентификации'), error.message);
    for (const text of [error.message, JSON.stringify(error.details)]) {
      assert.ok(!text.includes(crsPasswordHash('wrong')), text);
      assert.ok(!text.includes('crs:'), text);
    }
  });

  test('пустое тело — unknown-method; обрезанный call_return — malformed-response с причиной', async () => {
    const empty = await callError(known(new RecordedTransport([unknownMethod.response.body])).call(OPEN), 'unknown-method');
    assert.strictEqual(empty.details.method, 'DevDepotAdmin_openDevDepot');
    const truncated = open.response.body.subarray(0, open.response.body.length - 1);
    const malformedResponse = await callError(known(new RecordedTransport([truncated])).call(OPEN), 'malformed-response');
    assert.ok(malformedResponse.details.cause instanceof CrsFormatError);
  });

  test('несовпадение версии на обычном вызове — version-mismatch с версией сервера и новое рукопожатие', async () => {
    const transport = new RecordedTransport([versionOther.response.body, versionZero.response.body, open.response.body]);
    const client = known(transport);
    const error = await callError(client.call(OPEN), 'version-mismatch');
    assert.strictEqual(error.details.serverVersion, SERVER_VERSION);
    assert.strictEqual(error.details.code, 17);
    await client.call(OPEN);
    assert.deepStrictEqual(
      transport.requests.map((r) => r.body),
      [open.request, versionZero.request, open.request],
    );
  });

  test('статус с телом разбора XML — bad-request, исходная ошибка в cause', async () => {
    const cause = statusError(400, malformed.response.body);
    const error = await callError(known(new RecordedTransport([cause])).call(OPEN), 'bad-request');
    assert.strictEqual(error.details.status, 400);
    assert.strictEqual(error.details.cause, cause);
    assert.strictEqual(error.details.clsid, VRS_CLSID_XML_PARSE);
    assert.ok(error.details.messages?.[0].startsWith('Ошибка разбора XML'));
  });

  for (const [probe, status] of [['probe-wrong-path', 404], ['probe-get', 406]] as const) {
    test(`статус ${String(status)} публикации (${probe}) — rejected`, async () => {
      const cause = statusError(status, readFixture('http', probe, 'response.xml'));
      const error = await callError(known(new RecordedTransport([cause])).call(OPEN), 'rejected');
      assert.strictEqual(error.details.status, status);
      assert.strictEqual(error.details.cause, cause);
    });
  }

  test('статус с телом не VRS и без тела, прочие ошибки транспорта — пробрасываются как есть', async () => {
    const outcomes = [
      statusError(500, open.response.body),
      statusError(502),
      new CrsTransportError('closed', `${ENDPOINT}: закрыто`, { endpoint: ENDPOINT }),
    ];
    for (const outcome of outcomes) {
      assert.strictEqual(await rejection(known(new RecordedTransport([outcome])).call(OPEN)), outcome);
    }
  });

  for (const conn of wrongPassword) {
    test(`сквозной: CrsClient + CrsTcpTransport, неверный пароль (${conn.name})`, async () => {
      const server = await ReplayServer.start(replayOf(conn.c2s, conn.s2c));
      try {
        const transport = new CrsTcpTransport({ host: '127.0.0.1', port: server.port }, { clientId: clientIdFromHello(conn.c2s) });
        const client = new CrsClient(transport, { alias: 'exp', version: SERVER_VERSION });
        await callError(client.call(authenticate()), 'auth-failed');
        const wire = await server.connection(0);
        await wire.closed;
        assert.deepStrictEqual(wire.received(), conn.c2s);
      } finally {
        await server.close();
      }
    });
  }
});

suite('crs CrsClient: сквозной по транспорту на воспроизведении', () => {
  const servers: ReplayServer[] = [];
  async function serve(steps: ReplayStep[] | ((port: number) => ReplayStep[])): Promise<ReplayServer> {
    const server = await ReplayServer.start(steps);
    servers.push(server);
    return server;
  }

  teardown(async () => {
    for (const server of servers.splice(0)) {
      await server.close();
    }
  });

  for (const c of TRANSPORT_CASES) {
    const probeName = (name: string): string => `${c.name === 'tcp' ? 'tcp-raw' : 'http-raw'}/${name}`;

    /** Вызов на воспроизведении снятого обмена: запрос клиента на проводе побайтно как снятый. */
    async function replay<T>(exchange: RecordedExchange, action: (client: CrsClient, versioned: CrsClient) => Promise<T>): Promise<T> {
      const server = await serve(exchange.steps);
      const transport = c.create(server.port);
      const result = await action(new CrsClient(transport, { alias: 'exp' }), new CrsClient(transport, { alias: 'exp', version: SERVER_VERSION }));
      const wire = await server.connection(0);
      await wire.closed;
      assert.deepStrictEqual(wire.received(), exchange.wire(server.port));
      assert.strictEqual(server.connections.length, 1);
      return result;
    }

    test(`${c.name}: неверный пароль Конфигуратора — auth-failed`, async () => {
      const error = await replay(c.authFailed, (_, client) => callError(client.call(authenticate()), 'auth-failed'));
      assert.strictEqual(error.details.code, 4);
    });

    test(`${c.name}: неизвестный метод (${probeName('probe-unknown-method')}) — unknown-method`, async () => {
      await replay(c.probe('probe-unknown-method'), (_, client) =>
        callError(client.call({ method: 'DevDepot_noSuchMethod', params: OPEN_PARAMS }), 'unknown-method'),
      );
    });

    test(`${c.name}: неверный alias (${probeName('probe-wrong-alias')}) — depot-not-found`, async () => {
      const params = [crsValue('alias', 'nosuch'), crsValue('convert', false)];
      await replay(c.probe('probe-wrong-alias'), (_, client) => callError(client.call({ method: OPEN.method, params }), 'depot-not-found'));
    });

    test(`${c.name}: рукопожатие (${probeName('probe-version-zero')}) — версия сервера из исключения`, async () => {
      assert.strictEqual(await replay(c.probe('probe-version-zero'), (client) => client.serverVersion()), SERVER_VERSION);
    });

    test(`${c.name}: чужая версия (${probeName('probe-version-other')}) — version-mismatch с версией сервера`, async () => {
      const exchange = c.probe('probe-version-other');
      const server = await serve(exchange.steps);
      const client = new CrsClient(c.create(server.port), { alias: 'exp', version: '8.3.27.2342' });
      const error = await callError(client.call(OPEN), 'version-mismatch');
      assert.strictEqual(error.details.serverVersion, SERVER_VERSION);
      assert.strictEqual(error.details.code, 17);
      const wire = await server.connection(0);
      await wire.closed;
      assert.deepStrictEqual(wire.received(), exchange.wire(server.port));
    });

    test(`${c.name}: 400 на тело «не xml» (${probeName('probe-malformed-body')}) — bad-request со статусом`, async () => {
      // Ответ снят на тело «не xml», а клиент шлёт openDevDepot: проверяется разбор отказа, а не запрос.
      const open = c.probe(c.name === 'tcp' ? 'probe-open' : 'probe-valid');
      const server = await serve((port) => [...c.preamble, { expect: open.wire(port).length }, { send: c.malformed.response }]);
      const client = new CrsClient(c.create(server.port), { alias: 'exp', version: SERVER_VERSION });
      const error = await callError(client.call(OPEN), 'bad-request');
      assert.strictEqual(error.details.status, 400);
      assert.strictEqual(error.details.clsid, VRS_CLSID_XML_PARSE);
      assert.ok(error.details.cause instanceof CrsTransportError);
      const wire = await server.connection(0);
      await wire.closed;
      assert.deepStrictEqual(wire.received(), open.wire(server.port));
    });
  }

  test('http: неверный путь публикации (http-raw/probe-wrong-path) — rejected 404', async () => {
    const { response } = httpRawProbe('probe-wrong-path');
    // Тело пробы — то же openDevDepot, что у probe-valid; ответ chunked, поэтому по Content-Length не делится.
    const body = httpRawProbeBodies('probe-valid').request;
    assert.deepStrictEqual(httpRawProbe('probe-wrong-path').request.subarray(-body.length), body);
    const server = await serve((port) => httpReplayOf(expectedHttpRequest(port, body, '/repo/missing.1ccr').length, response));
    const transport = new CrsHttpTransport({ scheme: 'http', host: '127.0.0.1', port: server.port, path: '/repo/missing.1ccr' });
    const error = await callError(new CrsClient(transport, { alias: 'exp', version: SERVER_VERSION }).call(OPEN), 'rejected');
    assert.strictEqual(error.details.status, 404);
    const wire = await server.connection(0);
    await wire.closed;
    assert.deepStrictEqual(wire.received(), expectedHttpRequest(server.port, body, '/repo/missing.1ccr'));
  });
});
