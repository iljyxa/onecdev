import * as assert from 'assert';
import { CRS_DEFAULT_MAX_RESPONSE_BYTES, CrsTransportError, type CrsTransportErrorKind, crsPositiveOption } from '../../infra/repository/crs/CrsTransport';
import { ReplayServer, type ReplayStep } from './support/crsReplayServer';
import { findClosedPort } from './support/repositoryLockFixtures';
import { TRANSPORT_CASES, type TransportCase } from './support/crsTransportCases';

// Малый дедлайн: сервер в этих сценариях заведомо молчит, ждать больше незачем.
const SHORT_TIMEOUT_MS = 150;

async function rejection(c: TransportCase, promise: Promise<unknown>, kind: CrsTransportErrorKind, port: number): Promise<CrsTransportError> {
  const error = await promise.then(
    () => assert.fail(`ожидался отказ ${kind}`),
    (e: unknown) => e,
  );
  assert.ok(error instanceof CrsTransportError, String(error));
  assert.strictEqual(error.kind, kind, error.message);
  assert.strictEqual(error.details.endpoint, c.endpoint(port));
  assert.ok(error.message.startsWith(`${error.details.endpoint}: `), error.message);
  // Тело запроса (в нём хеш пароля) в сообщение не попадает.
  assert.ok(!error.message.includes('crs:'), error.message);
  assert.ok(!error.details.endpoint.includes('crs:'), error.details.endpoint);
  return error;
}

suite('crs crsPositiveOption', () => {
  test('RangeError вне (0, max], граница max проходит', () => {
    assert.strictEqual(crsPositiveOption('x', 5, 5), 5);
    assert.strictEqual(crsPositiveOption('x', Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    for (const value of [0, -1, Number.NaN, 6]) {
      assert.throws(() => crsPositiveOption('x', value, 5), RangeError, String(value));
    }
  });
});

for (const c of TRANSPORT_CASES) {
  suite(`crs транспорт ${c.name}: общее поведение на снятых обменах`, () => {
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

    const { ok } = c;
    const halfBody = ok.headLength + Math.floor(ok.contentLength / 2);

    test('успех: байты на проводе как у снятого запроса, тело ответа как есть, одно соединение закрыто клиентом', async () => {
      const server = await serve(ok.steps);
      const body = await c.create(server.port).call(ok.body);
      assert.deepStrictEqual(body, ok.responseBody);
      const wire = await server.connection(0);
      await wire.closed;
      assert.deepStrictEqual(wire.received(), ok.wire(server.port));
      assert.strictEqual(server.connections.length, 1);
    });

    test('молчащий сервер — timeout, сокет закрыт', async () => {
      const server = await serve(c.preamble);
      await rejection(c, c.create(server.port, { timeoutMs: SHORT_TIMEOUT_MS }).call(ok.body), 'timeout', server.port);
      const wire = await server.connection(0);
      await wire.closed;
    });

    test('дедлайн вызова переопределяет дедлайн транспорта', async () => {
      const server = await serve(c.preamble);
      await rejection(c, c.create(server.port).call(ok.body, { timeoutMs: SHORT_TIMEOUT_MS }), 'timeout', server.port);
      await (await server.connection(0)).closed;
    });

    const closedScenarios: [string, (port: number) => ReplayStep[]][] = [
      ['сразу после подключения', () => [{ end: true }]],
      ['после заголовков без тела', (port) => [...c.preamble, { expect: ok.wire(port).length }, { send: ok.response.subarray(0, ok.headLength) }, { end: true }]],
      ['на половине тела', (port) => [...c.preamble, { expect: ok.wire(port).length }, { send: ok.response.subarray(0, halfBody) }, { end: true }]],
    ];
    for (const [name, steps] of closedScenarios) {
      test(`сервер закрыл соединение ${name} — closed`, async () => {
        const server = await serve(steps);
        await rejection(c, c.create(server.port).call(ok.body), 'closed', server.port);
        await (await server.connection(0)).closed;
      });
    }

    test('порт никто не слушает — unavailable с причиной ECONNREFUSED', async () => {
      const port = await findClosedPort();
      const error = await rejection(c, c.create(port).call(ok.body), 'unavailable', port);
      assert.ok(error.details.cause);
      assert.strictEqual((error.details.cause as NodeJS.ErrnoException).code, 'ECONNREFUSED');
    });

    test('лимит тела: транспорта и вызова, ровно на лимит проходит', async () => {
      const server = await serve(ok.steps);
      const limit = ok.contentLength;
      await rejection(c, c.create(server.port, { maxResponseBytes: limit - 1 }).call(ok.body), 'too-large', server.port);
      await rejection(c, c.create(server.port).call(ok.body, { maxResponseBytes: limit - 1 }), 'too-large', server.port);
      const body = await c.create(server.port, { maxResponseBytes: limit - 1 }).call(ok.body, { maxResponseBytes: limit });
      assert.deepStrictEqual(body, ok.responseBody);
      assert.deepStrictEqual(await c.create(server.port, { maxResponseBytes: limit }).call(ok.body), ok.responseBody);
      for (const wire of server.connections) {
        await wire.closed;
      }
      assert.strictEqual(server.connections.length, 4);
    });

    test('переполнение заголовков ответа — protocol', async () => {
      const server = await serve(ok.steps);
      await rejection(c, c.create(server.port, { maxHeaderBytes: 16 }).call(ok.body), 'protocol', server.port);
      await (await server.connection(0)).closed;
    });

    test('байты чужого протокола вместо ответа — protocol', async () => {
      const server = await serve(c.foreign);
      await rejection(c, c.create(server.port).call(ok.body), 'protocol', server.port);
      await (await server.connection(0)).closed;
    });

    test('400 на тело «не xml» — status с телом исключения', async () => {
      const { malformed } = c;
      const server = await serve(malformed.steps);
      const error = await rejection(c, c.create(server.port).call(malformed.body), 'status', server.port);
      assert.strictEqual(error.details.status, malformed.status);
      assert.deepStrictEqual(error.details.body, malformed.responseBody);
      const wire = await server.connection(0);
      await wire.closed;
      assert.deepStrictEqual(wire.received(), malformed.wire(server.port));
    });

    test('уже отменённый сигнал — aborted без подключения', async () => {
      const server = await serve(ok.steps);
      const transport = c.create(server.port);
      const controller = new AbortController();
      controller.abort();
      await rejection(c, transport.call(ok.body, { signal: controller.signal }), 'aborted', server.port);
      // Следующий вызов проходит, и соединение у сервера ровно одно — его.
      assert.deepStrictEqual(await transport.call(ok.body, { signal: new AbortController().signal }), ok.responseBody);
      assert.strictEqual(server.connections.length, 1);
      await server.connections[0].closed;
    });

    test('отмена во время ожидания ответа — aborted, сокет закрыт', async () => {
      const server = await serve(c.preamble);
      const controller = new AbortController();
      const pending = c.create(server.port).call(ok.body, { signal: controller.signal });
      const wire = await server.connection(0);
      assert.ok(await wire.receivedAtLeast(ok.wire(server.port).length));
      controller.abort();
      await rejection(c, pending, 'aborted', server.port);
      await wire.closed;
    });

    test('два параллельных вызова одного экземпляра — два соединения', async () => {
      const server = await serve(ok.steps);
      const transport = c.create(server.port);
      const bodies = await Promise.all([transport.call(ok.body), transport.call(ok.body)]);
      assert.deepStrictEqual(bodies, [ok.responseBody, ok.responseBody]);
      assert.strictEqual(server.connections.length, 2);
      for (const wire of server.connections) {
        await wire.closed;
        assert.deepStrictEqual(wire.received(), ok.wire(server.port));
      }
    });

    test('два последовательных вызова — два соединения', async () => {
      const server = await serve(ok.steps);
      const transport = c.create(server.port);
      assert.deepStrictEqual(await transport.call(ok.body), ok.responseBody);
      assert.deepStrictEqual(await transport.call(ok.body), ok.responseBody);
      assert.strictEqual(server.connections.length, 2);
      for (const wire of server.connections) {
        await wire.closed;
      }
    });
  });

  suite(`crs транспорт ${c.name}: проверка параметров`, () => {
    const badOptions: [string, Parameters<TransportCase['create']>[1]][] = [
      ['timeoutMs = 0', { timeoutMs: 0 }],
      ['timeoutMs < 0', { timeoutMs: -1 }],
      ['timeoutMs = NaN', { timeoutMs: Number.NaN }],
      ['timeoutMs больше предела таймера', { timeoutMs: 2 ** 31 }],
      ['maxResponseBytes = 0', { maxResponseBytes: 0 }],
      ['maxResponseBytes = Infinity', { maxResponseBytes: Number.POSITIVE_INFINITY }],
      ['maxHeaderBytes = 0', { maxHeaderBytes: 0 }],
    ];
    for (const [name, options] of badOptions) {
      test(`конструктор отвергает ${name}`, () => {
        assert.throws(() => c.create(1, options), RangeError);
      });
    }

    test('предельные допустимые значения принимаются', () => {
      c.create(1, { timeoutMs: 2 ** 31 - 1, maxResponseBytes: CRS_DEFAULT_MAX_RESPONSE_BYTES, maxHeaderBytes: 1 });
    });

    for (const [name, options] of [
      ['timeoutMs = 0', { timeoutMs: 0 }],
      ['maxResponseBytes = 0', { maxResponseBytes: 0 }],
    ] as const) {
      test(`вызов отвергает ${name} без подключения`, async () => {
        const server = await ReplayServer.start([]);
        try {
          await assert.rejects(c.create(server.port).call(c.ok.body, options), RangeError);
          assert.strictEqual(server.connections.length, 0);
        } finally {
          await server.close();
        }
      });
    }
  });
}
