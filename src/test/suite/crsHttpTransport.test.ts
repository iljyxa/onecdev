import * as assert from 'assert';
import * as fs from 'fs';
import * as https from 'https';
import type * as net from 'net';
import * as path from 'path';
import type { CrsHttpEndpoint } from '../../infra/repository/crs/CrsHttpFraming';
import { CrsHttpTransport } from '../../infra/repository/crs/CrsHttpTransport';
import { CrsTransportError, type CrsTransportErrorKind } from '../../infra/repository/crs/CrsTransport';
import {
  expectedHttpRequest,
  httpCorpusMessages,
  httpRawProbe,
  httpRawProbeBodies,
  readFixture,
  splitMessage,
} from './support/crsFixtures';
import { httpReplayOf, ReplayServer, type ReplayStep } from './support/crsReplayServer';
import { findClosedPort, listenLoopback, type LoopbackServer, readHttpExchange, REPOSITORY_TLS_DIR } from './support/repositoryLockFixtures';

const PATH = '/repo/repo.1ccr';
const MISSING_PATH = '/repo/missing.1ccr';
const valid = httpRawProbeBodies('probe-valid');
const wrongPath = httpRawProbe('probe-wrong-path');
const wrongPathBody = readFixture('http', 'probe-wrong-path', 'response.xml');
const wrongPathHeadLength = wrongPath.response.indexOf('\r\n\r\n') + 4;

function endpoint(port: number, scheme: 'http' | 'https' = 'http', path = PATH): CrsHttpEndpoint {
  return { scheme, host: '127.0.0.1', port, path };
}

async function rejection(promise: Promise<unknown>, kind: CrsTransportErrorKind, address: string): Promise<CrsTransportError> {
  const error = await promise.then(
    () => assert.fail(`ожидался отказ ${kind}`),
    (e: unknown) => e,
  );
  assert.ok(error instanceof CrsTransportError, String(error));
  assert.strictEqual(error.kind, kind, error.message);
  assert.strictEqual(error.details.endpoint, address);
  assert.ok(error.message.startsWith(`${address}: `), error.message);
  assert.ok(!error.message.includes('crs:'), error.message);
  return error;
}

suite('crs CrsHttpTransport: снятые ответы публикации', () => {
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

  const wrongPathSteps = (port: number): ReplayStep[] =>
    httpReplayOf(expectedHttpRequest(port, valid.request, MISSING_PATH).length, wrongPath.response);

  test('probe-wrong-path: chunked 404 раскодирован в details.body, запрос на путь публикации', async () => {
    const server = await serve(wrongPathSteps);
    const address = `http://127.0.0.1:${String(server.port)}${MISSING_PATH}`;
    const transport = new CrsHttpTransport(endpoint(server.port, 'http', MISSING_PATH));
    const error = await rejection(transport.call(valid.request), 'status', address);
    assert.strictEqual(error.details.status, 404);
    assert.deepStrictEqual(error.details.body, wrongPathBody);
    const wire = await server.connection(0);
    await wire.closed;
    assert.deepStrictEqual(wire.received(), expectedHttpRequest(server.port, valid.request, MISSING_PATH));
  });

  test('обрыв chunked-потока посередине — closed', async () => {
    const cut = wrongPathHeadLength + Math.floor((wrongPath.response.length - wrongPathHeadLength) / 2);
    const server = await serve((port) => [
      { expect: expectedHttpRequest(port, valid.request, MISSING_PATH).length },
      { send: wrongPath.response.subarray(0, cut) },
      { end: true },
    ]);
    const address = `http://127.0.0.1:${String(server.port)}${MISSING_PATH}`;
    await rejection(new CrsHttpTransport(endpoint(server.port, 'http', MISSING_PATH)).call(valid.request), 'closed', address);
  });

  test('chunked-тело: сумма chunk больше лимита — too-large, ровно на лимит — проходит', async () => {
    const server = await serve(wrongPathSteps);
    const address = `http://127.0.0.1:${String(server.port)}${MISSING_PATH}`;
    const limited = (maxResponseBytes: number): CrsHttpTransport =>
      new CrsHttpTransport(endpoint(server.port, 'http', MISSING_PATH), { maxResponseBytes });
    await rejection(limited(wrongPathBody.length - 1).call(valid.request), 'too-large', address);
    const error = await rejection(limited(wrongPathBody.length).call(valid.request), 'status', address);
    assert.deepStrictEqual(error.details.body, wrongPathBody);
  });

  test('объявленный Content-Length больше лимита — too-large до чтения тела', async () => {
    // Сервер отдаёт только заголовки и держит соединение: отказ приходит, не дожидаясь тела.
    const server = await serve((port) => [
      { expect: expectedHttpRequest(port, valid.request).length },
      { send: httpRawProbe('probe-valid').response.subarray(0, valid.response.headLength) },
    ]);
    const address = `http://127.0.0.1:${String(server.port)}${PATH}`;
    const transport = new CrsHttpTransport(endpoint(server.port), { maxResponseBytes: valid.response.contentLength - 1 });
    await rejection(transport.call(valid.request), 'too-large', address);
    await (await server.connection(0)).closed;
  });

  for (const probe of ['probe-valid', 'probe-unknown-method', 'probe-wrong-alias', 'probe-version-zero', 'probe-version-zero-wrong-alias', 'probe-version-other']) {
    test(`проба ${probe}: запрос побайтно как у стенда, тело 200 возвращено как есть`, async () => {
      const { request, response } = httpRawProbeBodies(probe);
      const server = await serve((port) => httpReplayOf(expectedHttpRequest(port, request).length, httpRawProbe(probe).response));
      const body = await new CrsHttpTransport(endpoint(server.port)).call(request);
      assert.deepStrictEqual(body, response.body);
      const wire = await server.connection(0);
      await wire.closed;
      assert.deepStrictEqual(wire.received(), expectedHttpRequest(server.port, request));
    });
  }

  test('probe-unknown-method: тело ответа — три байта BOM; probe-wrong-alias — call_exception', () => {
    assert.deepStrictEqual(httpRawProbeBodies('probe-unknown-method').response.body, Buffer.from('efbbbf', 'hex'));
    assert.match(httpRawProbeBodies('probe-wrong-alias').response.body.toString('utf-8'), /^\uFEFF<\?xml [^>]+\?><crs:call_exception /);
  });

  for (const message of httpCorpusMessages()) {
    test(`обмен Конфигуратора ${message.name}: тело запроса на проводе и тело ответа как в корпусе`, async () => {
      const request = splitMessage(message.request).body;
      const server = await serve((port) => httpReplayOf(expectedHttpRequest(port, request).length, message.response));
      const body = await new CrsHttpTransport(endpoint(server.port)).call(request);
      assert.deepStrictEqual(body, splitMessage(message.response).body);
      const wire = await server.connection(0);
      await wire.closed;
      assert.deepStrictEqual(wire.received(), expectedHttpRequest(server.port, request));
    });
  }

  test('https: порт никто не слушает — unavailable с причиной ECONNREFUSED', async () => {
    const port = await findClosedPort();
    const error = await rejection(
      new CrsHttpTransport(endpoint(port, 'https')).call(valid.request),
      'unavailable',
      `https://127.0.0.1:${String(port)}${PATH}`,
    );
    assert.strictEqual((error.details.cause as NodeJS.ErrnoException).code, 'ECONNREFUSED');
  });

  for (const tls of [undefined, { rejectUnauthorized: false, servername: 'crs.example.org' }]) {
    test(`https поверх незашифрованного ответа — unavailable с ошибкой TLS (tls: ${JSON.stringify(tls)})`, async () => {
      // Сервер отвечает на первый байт ClientHello настоящим ответом публикации по http.
      const server = await serve([{ expect: 1 }, { send: httpRawProbe('probe-valid').response }]);
      const error = await rejection(
        new CrsHttpTransport(endpoint(server.port, 'https'), { tls }).call(valid.request),
        'unavailable',
        `https://127.0.0.1:${String(server.port)}${PATH}`,
      );
      assert.ok(error.details.cause);
      // BoringSSL Electron сообщает сбой рукопожатия TLS кодом EPROTO.
      assert.strictEqual((error.details.cause as NodeJS.ErrnoException).code, 'EPROTO');
      await (await server.connection(0)).closed;
    });
  }
});

suite('crs CrsHttpTransport: проверка endpoint и tls', () => {
  // Исключение из правила фикстур (CLAUDE.md, «TDD и покрытие», п. 3): пути ниже —
  // недопустимые входы конструктора; он отвергает их до отправки запроса, поэтому запись
  // трафика платформы не воспроизводит эту ситуацию. Это не образцы протокола или файлов 1С.
  const bad: [string, CrsHttpEndpoint, ConstructorParameters<typeof CrsHttpTransport>[1]][] = [
    ['tls при http', endpoint(1), { tls: {} }],
    ['пустой host', { ...endpoint(1), host: '' }, {}],
    ['порт 0', endpoint(0), {}],
    ['порт 70000', endpoint(70000), {}],
    ['порт дробный', endpoint(1.5), {}],
    ['путь без ведущего /', endpoint(1, 'http', 'repo/repo.1ccr'), {}],
    ['путь с пробелом', endpoint(1, 'http', '/repo/мой репозиторий.1ccr'), {}],
    ['путь с кириллицей', endpoint(1, 'http', '/репо/repo.1ccr'), {}],
    ['путь с NUL-байтом', endpoint(1, 'http', '/repo/re\x00po.1ccr'), {}],
    ['путь с символом вне ASCII', endpoint(1, 'http', '/repo/ré.1ccr'), {}],
    ['путь с некорректным percent-escape', endpoint(1, 'http', '/repo/%GG.1ccr'), {}],
    ['путь с LF', endpoint(1, 'http', '/repo/repo.1ccr\n'), {}],
  ];
  for (const [name, target, options] of bad) {
    test(`конструктор отвергает: ${name}`, () => {
      assert.throws(() => new CrsHttpTransport(target, options), RangeError);
    });
  }

  test('https с tls и граничными портами принимается', () => {
    new CrsHttpTransport(endpoint(1, 'https'), { tls: { rejectUnauthorized: false } });
    new CrsHttpTransport(endpoint(65535, 'https'));
    new CrsHttpTransport(endpoint(65535, 'http'), { tls: undefined });
  });

  test('percent-encoded путь с кириллицей принимается', () => {
    new CrsHttpTransport(endpoint(1, 'http', '/%D1%80%D0%B5%D0%BF%D0%BE/repo.1ccr'));
    new CrsHttpTransport(endpoint(1, 'http', '/repo/my%20repo.1ccr'));
  });
});

// Публикация по https: настоящий сервер на loopback с самоподписанным сертификатом localhost
// (example/repository/tls) отдаёт снятый ответ статистики. Проверка сертификата не отключается.
suite('crs CrsHttpTransport: https с самоподписанным сертификатом', () => {
  const exchange = readHttpExchange('8.5.1', 'statistic-admin');
  const cert = fs.readFileSync(path.join(REPOSITORY_TLS_DIR, 'localhost.crt'));
  const key = fs.readFileSync(path.join(REPOSITORY_TLS_DIR, 'localhost.key'));
  const servers: LoopbackServer[] = [];

  teardown(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function startHttps(): Promise<LoopbackServer> {
    const sockets = new Set<net.Socket>();
    const server = https.createServer({ cert, key }, (request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/xml' });
        response.end(exchange.response);
      });
    });
    server.on('connection', (socket: net.Socket) => {
      sockets.add(socket);
    });
    const loopback = await listenLoopback(server, [], sockets);
    servers.push(loopback);
    return loopback;
  }

  test('без доверенного CA — unavailable с кодом ошибки сертификата в cause', async () => {
    const server = await startHttps();
    const transport = new CrsHttpTransport(endpoint(server.port, 'https'));
    const error = await rejection(transport.call(exchange.request), 'unavailable', `https://127.0.0.1:${String(server.port)}${PATH}`);
    const cause: NodeJS.ErrnoException | undefined = error.details.cause;
    assert.strictEqual(cause?.code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  test('с CA тестового сертификата — тело ответа', async () => {
    const server = await startHttps();
    const transport = new CrsHttpTransport(endpoint(server.port, 'https'), { tls: { ca: cert } });
    assert.deepStrictEqual(await transport.call(exchange.request), exchange.response);
  });
});
