import * as assert from 'assert';
import * as net from 'net';
import { encodeClientHello } from '../../infra/repository/crs/CrsTcpFraming';
import { CrsTcpTransport } from '../../infra/repository/crs/CrsTcpTransport';
import { CRS_DEFAULT_MAX_RESPONSE_BYTES, CrsTransportError, type CrsTransportErrorKind } from '../../infra/repository/crs/CrsTransport';
import {
  clientIdFromHello,
  httpRawProbe,
  rawConfiguratorConnections,
  requestBodyOf,
  responseFrameOf,
  splitTcpFrame,
  tcpProbe,
  UUID_V4,
} from './support/crsFixtures';
import { ReplayServer, replayOf, type ReplayStep } from './support/crsReplayServer';
import { listenLoopback, type LoopbackServer, readTcpExchange, tcpResponseBody } from './support/repositoryLockFixtures';

// Малый дедлайн: сервер в этих сценариях заведомо молчит, ждать больше незачем.
const SHORT_TIMEOUT_MS = 150;

const connections = rawConfiguratorConnections();
const first = connections[0];
const firstBody = requestBodyOf(first.c2s);
const firstResponse = splitTcpFrame(responseFrameOf(first.s2c));
const firstClientId = clientIdFromHello(first.c2s);
const greeting = first.s2c.subarray(0, 5);

async function rejection(promise: Promise<unknown>, kind: CrsTransportErrorKind, port: number): Promise<CrsTransportError> {
  const error = await promise.then(
    () => assert.fail(`ожидался отказ ${kind}`),
    (e: unknown) => e,
  );
  assert.ok(error instanceof CrsTransportError, String(error));
  assert.strictEqual(error.kind, kind, error.message);
  assert.strictEqual(error.details.endpoint, `tcp://127.0.0.1:${String(port)}`);
  assert.ok(error.message.includes(error.details.endpoint), error.message);
  // Тело запроса (в нём хеш пароля) в сообщение не попадает.
  assert.ok(!error.message.includes('crs:'), error.message);
  return error;
}

suite('crs CrsTcpTransport: воспроизведение снятого crserver', () => {
  const servers: ReplayServer[] = [];
  async function serve(steps: ReplayStep[]): Promise<ReplayServer> {
    const server = await ReplayServer.start(steps);
    servers.push(server);
    return server;
  }
  function transportFor(server: ReplayServer, options: ConstructorParameters<typeof CrsTcpTransport>[1] = {}): CrsTcpTransport {
    return new CrsTcpTransport({ host: '127.0.0.1', port: server.port }, { clientId: firstClientId, ...options });
  }

  teardown(async () => {
    for (const server of servers.splice(0)) {
      await server.close();
    }
  });

  for (const conn of connections) {
    test(`байты на проводе совпадают с Конфигуратором, тело ответа возвращено, сокет закрыт клиентом (${conn.name})`, async () => {
      const server = await serve(replayOf(conn.c2s, conn.s2c));
      const transport = new CrsTcpTransport({ host: '127.0.0.1', port: server.port }, { clientId: clientIdFromHello(conn.c2s) });
      const body = await transport.call(requestBodyOf(conn.c2s));
      assert.deepStrictEqual(body, splitTcpFrame(responseFrameOf(conn.s2c)).body);
      const wire = await server.connection(0);
      await wire.closed;
      assert.deepStrictEqual(wire.received(), conn.c2s);
      assert.strictEqual(server.connections.length, 1);
    });
  }

  for (const probe of ['probe-open', 'probe-unknown-method']) {
    test(`проба ${probe}: запрос побайтно как у стенда, ответ crserver разобран`, async () => {
      const { request, response } = tcpProbe(probe);
      const server = await serve(replayOf(request, response));
      const transport = new CrsTcpTransport({ host: '127.0.0.1', port: server.port }, { clientId: clientIdFromHello(request) });
      const body = await transport.call(requestBodyOf(request));
      assert.deepStrictEqual(body, splitTcpFrame(responseFrameOf(response)).body);
      const wire = await server.connection(0);
      await wire.closed;
      assert.deepStrictEqual(wire.received(), request);
    });
  }

  test('молчащий сервер — timeout, клиент ничего не отправил до приветствия', async () => {
    const server = await serve([]);
    const transport = transportFor(server, { timeoutMs: SHORT_TIMEOUT_MS });
    await rejection(transport.call(firstBody), 'timeout', server.port);
    const wire = await server.connection(0);
    await wire.closed;
    assert.strictEqual(wire.received().length, 0);
  });

  test('приветствие без ответа — timeout, запрос отправлен целиком одной порцией', async () => {
    const server = await serve([{ send: greeting }]);
    const transport = transportFor(server, { timeoutMs: SHORT_TIMEOUT_MS });
    await rejection(transport.call(firstBody), 'timeout', server.port);
    const wire = await server.connection(0);
    await wire.closed;
    assert.deepStrictEqual(wire.received(), first.c2s);
  });

  // Общие для tcp и http отказы (closed, unavailable, лимиты, отмена) — в transport.test.ts.
  test('сервер закрыл соединение после 3 байт приветствия — closed', async () => {
    const server = await serve([{ send: greeting.subarray(0, 3) }, { end: true }]);
    await rejection(transportFor(server).call(firstBody), 'closed', server.port);
  });

  test('лимит заголовков: на байт меньше блока заголовков — protocol', async () => {
    const server = await serve(replayOf(first.c2s, first.s2c));
    const transport = transportFor(server, { maxHeaderBytes: firstResponse.headLength - 1 });
    await rejection(transport.call(firstBody), 'protocol', server.port);
  });

  test('приветствие из других 5 байт и настоящий кадр ответа — успех: содержимое приветствия не сверяется', async () => {
    // Байты приветствия сняты только с 8.5.1; у crserver 8.3.x они могут отличаться. Здесь — 5 настоящих
    // байт потока клиента вместо приветствия, остальной поток сервера — снятый.
    const steps: ReplayStep[] = [{ send: first.c2s.subarray(0, 5) }, { expect: first.c2s.length }, { send: first.s2c.subarray(5) }];
    assert.ok(!first.c2s.subarray(0, 5).equals(greeting));
    const server = await serve(steps);
    assert.deepStrictEqual(await transportFor(server).call(firstBody), firstResponse.body);
    const wire = await server.connection(0);
    await wire.closed;
    assert.deepStrictEqual(wire.received(), first.c2s);
  });

  test('ответ http-публикации вместо crserver — protocol на разборе кадра, а не на приветствии', async () => {
    // Первые 5 байт («HTTP/») принимаются за приветствие, остаток не начинается со статусной строки.
    const server = await serve([{ send: httpRawProbe('probe-valid').response }]);
    const error = await rejection(transportFor(server).call(firstBody), 'protocol', server.port);
    assert.match(error.message, /статусной строки/);
  });

  test('ответ не похож на кадр crserver — protocol', async () => {
    const server = await serve([{ send: greeting }, { expect: first.c2s.length }, { send: first.c2s.subarray(20) }]);
    await rejection(transportFor(server).call(firstBody), 'protocol', server.port);
  });

  test('приветствие и ответ одной порцией — остаток порции идёт в ответ', async () => {
    // Сервер шлёт весь снятый поток сразу, не дожидаясь запроса. Что успело уйти от клиента,
    // здесь не проверяется: ответ готов раньше, чем запрос дошёл, и клиент закрывает сокет сразу.
    const server = await serve([{ send: first.s2c }]);
    assert.deepStrictEqual(await transportFor(server).call(firstBody), firstResponse.body);
    await (await server.connection(0)).closed;
  });

  test('UUID клиента по умолчанию — случайный v4, один на экземпляр', async () => {
    const server = await serve(replayOf(first.c2s, first.s2c));
    const transport = new CrsTcpTransport({ host: '127.0.0.1', port: server.port });
    assert.match(transport.clientId, UUID_V4);
    assert.notStrictEqual(new CrsTcpTransport({ host: '127.0.0.1', port: server.port }).clientId, transport.clientId);
    await transport.call(firstBody);
    await transport.call(firstBody);
    for (const wire of server.connections) {
      await wire.closed;
      assert.deepStrictEqual(wire.received().subarray(0, 20), encodeClientHello(transport.clientId));
      assert.deepStrictEqual(wire.received().subarray(20), first.c2s.subarray(20));
    }
  });
});

suite('crs CrsTcpTransport: проверка параметров', () => {
  const endpoint = { host: '127.0.0.1', port: 1 };

  // Числовые опции проверяются общим набором в transport.test.ts.
  test('конструктор отвергает clientId не UUID', () => {
    assert.throws(() => new CrsTcpTransport(endpoint, { clientId: 'not-a-uuid' }), RangeError);
  });

  test('предельные допустимые значения принимаются', () => {
    const transport = new CrsTcpTransport(endpoint, {
      timeoutMs: 2 ** 31 - 1,
      maxResponseBytes: CRS_DEFAULT_MAX_RESPONSE_BYTES,
      maxHeaderBytes: 1,
      clientId: firstClientId,
    });
    assert.strictEqual(transport.clientId, firstClientId);
  });

  test('IPv6-адрес оборачивается в скобки в details.endpoint', () => {
    const transport = new CrsTcpTransport({ host: '::1', port: 1561 }, { clientId: firstClientId });
    // Провоцируем ошибку через aborted signal, чтобы получить details.endpoint без реального соединения.
    const controller = new AbortController();
    controller.abort();
    return transport.call(Buffer.alloc(0), { signal: controller.signal }).then(
      () => assert.fail('ожидался отказ'),
      (e: unknown) => {
        assert.ok(e instanceof CrsTransportError);
        assert.strictEqual(e.details.endpoint, 'tcp://[::1]:1561');
        assert.ok(e.message.includes('tcp://[::1]:1561'));
      },
    );
  });
});

// Обмен статистики фикстуры захватов (example/repository/2.21-locks): тот же crserver 8.5.1, что принимает
// запрос источника статусов. clientId — из снятого приветствия, поэтому поток клиента сверяется побайтно.
suite('crs CrsTcpTransport: обмен статистики example/repository/2.21-locks', () => {
  const exchange = readTcpExchange('8.5.1', 'statistic-admin');
  const clientId = clientIdFromHello(exchange.client);
  const body = requestBodyOf(exchange.client);
  const servers: { close(): Promise<void> }[] = [];

  teardown(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  test('поток клиента равен statistic-admin.client.bin, тело ответа — из потока сервера', async () => {
    const server = await ReplayServer.start(replayOf(exchange.client, exchange.server));
    servers.push(server);
    const transport = new CrsTcpTransport({ host: '127.0.0.1', port: server.port }, { clientId });
    assert.deepStrictEqual(await transport.call(body), tcpResponseBody(exchange.server));
    const wire = await server.connection(0);
    await wire.closed;
    assert.deepStrictEqual(wire.received(), exchange.client);
  });

  test('ответ мелкими порциями (разрывы в приветствии, заголовке, на границе заголовка и в теле) собирается байт-в-байт', async () => {
    const stream = exchange.server;
    const headerEnd = stream.indexOf('\r\n\r\n', 5);
    // Порции по 7 байт плюс разрезы внутри приветствия и точно на границе `\r\n\r\n`.
    const cuts = new Set<number>([2, 5, headerEnd + 2, headerEnd + 4]);
    for (let offset = 7; offset < stream.length; offset += 7) {
      cuts.add(offset);
    }
    const bounds = [0, ...[...cuts].sort((left, right) => left - right), stream.length];
    const portion = (index: number): Buffer => stream.subarray(bounds[index], bounds[index + 1]);
    const received: Buffer[] = [];
    const sockets = new Set<net.Socket>();
    // Каждая порция — отдельная запись с ожиданием callback и без алгоритма Нейгла: разбиение задаёт сервер.
    const write = (socket: net.Socket, part: Buffer): Promise<void> => new Promise((resolve) => socket.write(part, () => resolve()));
    const tcp = net.createServer((socket) => {
      sockets.add(socket);
      socket.setNoDelay(true);
      socket.on('error', () => undefined);
      const greetingParts = bounds.findIndex((bound) => bound === 5);
      void (async () => {
        for (let index = 0; index < greetingParts; index += 1) {
          await write(socket, portion(index));
        }
      })();
      socket.on('data', (chunk: Buffer) => {
        received.push(chunk);
        if (Buffer.concat(received).length < exchange.client.length) {
          return;
        }
        void (async () => {
          for (let index = greetingParts; index + 1 < bounds.length; index += 1) {
            await write(socket, portion(index));
          }
        })();
      });
    });
    const server: LoopbackServer = await listenLoopback(tcp, [], sockets);
    servers.push(server);
    const transport = new CrsTcpTransport({ host: '127.0.0.1', port: server.port }, { clientId });
    assert.deepStrictEqual(await transport.call(body), tcpResponseBody(exchange.server));
    assert.deepStrictEqual(Buffer.concat(received), exchange.client);
  });
});
