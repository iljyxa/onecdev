import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { CrsAddressError } from '../../infra/repository/crs/CrsAddress';
import { CrsCallError, type CrsCallErrorKind } from '../../infra/repository/crs/CrsErrors';
import { crsPasswordHash } from '../../infra/repository/crs/CrsSecrets';
import { devObjectsStatistic } from '../../infra/repository/crs/CrsStatistic';
import { CrsTransportError, type CrsTransportErrorKind } from '../../infra/repository/crs/CrsTransport';
import { FileRepositoryLockStatusSource } from '../../infra/repository/FileRepositoryLockStatusSource';
import {
  NetworkRepositoryLockStatusSource,
  statisticToLockRecords,
  toRepositoryLockStatusError,
} from '../../infra/repository/NetworkRepositoryLockStatusSource';
import {
  classifyRepositoryLocation,
  RepositoryLockStatusError,
  type RepositoryLocation,
  type RepositoryLockReadContext,
  type RepositoryLockStatusErrorCode,
  type RepositoryLockStatusSource,
  type RepositoryServerLockRecord,
} from '../../infra/repository/RepositoryLockStatusSource';
import { readFixture } from './support/crsFixtures';
import { recordedClient } from './support/crsMethods';
import {
  findClosedPort,
  listenLoopback,
  lockFixturePath,
  NETWORK_FIXTURE_VERSIONS,
  readHttpExchange,
  readRun,
  readTcpExchange,
  REPOSITORY_TLS_DIR,
  requestVersion,
  startHttpReplayServer,
  startTcpReplayServer,
  tcpRequestBody,
  type CrsExchangeName,
  type LoopbackServer,
} from './support/repositoryLockFixtures';

/**
 * Сетевой источник на loopback-замене crserver (ответы — снятые байты). Главный оракул —
 * совпадение с файловым источником на ТОМ ЖЕ хранилище: 1CD фикстуры скопирован из
 * каталога данных того crserver, с которого сняты обмены. Отказы сети (молчание, обрыв,
 * чужие байты, превышение размера) создаёт тестовый сервер — это эмуляция внешней системы.
 */

function sortRecords(records: readonly RepositoryServerLockRecord[]): RepositoryServerLockRecord[] {
  return [...records].sort((left, right) => left.objectId.localeCompare(right.objectId));
}

const context = (platformVersionHint: string, user = 'Admin', password = ''): RepositoryLockReadContext =>
  ({ user, password, platformVersionHint });

function serverLocation(repoPath: string): RepositoryLocation {
  const location = classifyRepositoryLocation(repoPath, os.tmpdir());
  assert.strictEqual(location.kind, 'server', repoPath);
  return location;
}

async function statusError(promise: Promise<unknown>, code: RepositoryLockStatusErrorCode): Promise<RepositoryLockStatusError> {
  const error = await promise.then(
    () => assert.fail(`ожидался отказ ${code}`),
    (e: unknown) => e,
  );
  assert.ok(error instanceof RepositoryLockStatusError, String(error));
  assert.strictEqual(error.code, code, error.message);
  return error;
}

async function fileRecords(version: (typeof NETWORK_FIXTURE_VERSIONS)[number]): Promise<RepositoryServerLockRecord[]> {
  const file: RepositoryLockStatusSource = new FileRepositoryLockStatusSource();
  return sortRecords((await file.readLocks(classifyRepositoryLocation(lockFixturePath(version), os.tmpdir()), context(''))).records);
}

for (const version of NETWORK_FIXTURE_VERSIONS) {
  suite(`NetworkRepositoryLockStatusSource — crserver ${version}`, () => {
    const run = readRun(version);
    const servers: LoopbackServer[] = [];
    const source: RepositoryLockStatusSource = new NetworkRepositoryLockStatusSource({ timeoutMs: 10_000 });

    teardown(async () => {
      await Promise.all(servers.splice(0).map((server) => server.close()));
    });

    /** Ответ по запросу: по умолчанию верная версия — статистика, иная — несоответствие версий. */
    type Responder = (body: Buffer, index: number) => CrsExchangeName;
    const byVersion: Responder = (body) => (requestVersion(body) === run.platform ? 'statistic-admin' : 'version-mismatch');

    async function startServer(transport: 'tcp' | 'http', respond: Responder = byVersion): Promise<{ server: LoopbackServer; repoPath: string }> {
      if (transport === 'tcp') {
        const greeting = readTcpExchange(version, 'statistic-admin').server;
        const server = await startTcpReplayServer(greeting, (client, index) => readTcpExchange(version, respond(tcpRequestBody(client), index)).server);
        servers.push(server);
        return { server, repoPath: `tcp://127.0.0.1:${String(server.port)}/${run.alias}` };
      }
      const server = await startHttpReplayServer((request, index) => ({ status: 200, body: readHttpExchange(version, respond(request.body, index)).response }));
      servers.push(server);
      return { server, repoPath: `http://127.0.0.1:${String(server.port)}/repo/repo.1ccr/${run.alias}` };
    }

    const bodyOf = (transport: 'tcp' | 'http', stream: Buffer): Buffer => (transport === 'tcp' ? tcpRequestBody(stream) : stream);

    for (const transport of ['tcp', 'http'] as const) {
      test(`${transport}: записи равны файловому источнику на том же хранилище, версия сервера возвращается`, async () => {
        const { server, repoPath } = await startServer(transport);
        const location = serverLocation(repoPath);
        assert.strictEqual(source.supports(location), true);
        const result = await source.readLocks(location, context(run.platform));
        assert.deepStrictEqual(sortRecords(result.records), await fileRecords(version));
        assert.strictEqual(result.serverVersion, run.platform);
        assert.strictEqual(server.requests.length, 1);
        // Тело запроса — побайтно то, что принял настоящий crserver.
        assert.deepStrictEqual(bodyOf(transport, server.requests[0]), readHttpExchange(version, 'statistic-admin').request);
      });

      test(`${transport}: подсказка чужой версии → повтор с версией сервера`, async () => {
        const { server, repoPath } = await startServer(transport);
        const result = await source.readLocks(serverLocation(repoPath), context('8.3.0.0'));
        assert.strictEqual(result.serverVersion, run.platform);
        assert.deepStrictEqual(sortRecords(result.records), await fileRecords(version));
        assert.deepStrictEqual(server.requests.map((stream) => requestVersion(bodyOf(transport, stream))), ['8.3.0.0', run.platform]);
      });

      for (const hint of ['8.3.27', '']) {
        test(`${transport}: подсказка «${hint}» не вида N.N.N.N → рукопожатие openDevDepot 0.0.0.0, затем статистика`, async () => {
          const { server, repoPath } = await startServer(transport);
          const result = await source.readLocks(serverLocation(repoPath), context(hint));
          assert.strictEqual(result.serverVersion, run.platform);
          assert.deepStrictEqual(sortRecords(result.records), await fileRecords(version));
          const bodies = server.requests.map((stream) => bodyOf(transport, stream).toString('utf-8'));
          assert.strictEqual(bodies.length, 2);
          assert.match(bodies[0], /name="DevDepotAdmin_openDevDepot" version="0\.0\.0\.0"/);
          assert.match(bodies[1], new RegExp(`name="DevDepot_devObjectsStatistic" version="${run.platform.replace(/\./g, '\\.')}"`));
        });
      }

      test(`${transport}: несоответствие версий и на повторе → version-mismatch с версией повтора, ровно два запроса`, async () => {
        const { server, repoPath } = await startServer(transport, () => 'version-mismatch');
        const error = await statusError(source.readLocks(serverLocation(repoPath), context('8.3.0.0')), 'version-mismatch');
        assert.match(error.message, /^Несоответствие версий/);
        assert.ok(error.message.endsWith(`(повтор с версией сервера ${run.platform} не помог)`), error.message);
        assert.ok(error.cause instanceof CrsCallError);
        assert.strictEqual(server.requests.length, 2);
      });

      test(`${transport}: несоответствие версий, затем ошибка аутентификации → auth-failed`, async () => {
        const { server, repoPath } = await startServer(transport, (_body, index) => (index === 0 ? 'version-mismatch' : 'auth-failed'));
        await statusError(source.readLocks(serverLocation(repoPath), context('8.3.0.0', 'Petrov', 'wrong')), 'auth-failed');
        assert.strictEqual(requestVersion(bodyOf(transport, server.requests[1])), run.platform);
      });

      test(`${transport}: ошибка аутентификации → текст сервера и подсказка, без имени метода и хеша пароля`, async () => {
        const { repoPath } = await startServer(transport, () => 'auth-failed');
        const error = await statusError(source.readLocks(serverLocation(repoPath), context(run.platform, 'Petrov', 'wrong')), 'auth-failed');
        assert.match(error.message, /^Ошибка аутентификации в хранилище конфигурации![\s\S]* Проверьте пользователя и пароль хранилища в «Подключить к хранилищу»\.$/);
        assert.ok(!error.message.includes('DevDepot_'), error.message);
        assert.ok(!error.message.includes(crsPasswordHash('wrong')), error.message);
      });

      test(`${transport}: хранилище не найдено → server-error с текстом сервера`, async () => {
        const { repoPath } = await startServer(transport, () => 'alias-not-found');
        const error = await statusError(source.readLocks(serverLocation(repoPath), context(run.platform)), 'server-error');
        assert.match(error.message, /не обнаружено/);
      });

      test(`${transport}: хранилище не найдено уже на рукопожатии (подсказки нет) → server-error, один запрос`, async () => {
        const { server, repoPath } = await startServer(transport, () => 'alias-not-found');
        await statusError(source.readLocks(serverLocation(repoPath), context('')), 'server-error');
        assert.strictEqual(server.requests.length, 1);
      });
    }

    test('http без alias после .1ccr → сервер получает alias="maincr"', async () => {
      const { server } = await startServer('http');
      await source.readLocks(serverLocation(`http://127.0.0.1:${String(server.port)}/repo/repo.1ccr`), context(run.platform));
      assert.match(server.requests[0].toString('utf-8'), /<crs:call [^>]*alias="maincr"/);
    });

    test('statisticToLockRecords: настоящий ответ — записи файлового источника; незахваченные не попадают', async () => {
      const { client } = recordedClient([readHttpExchange(version, 'statistic-admin').response]);
      const statistic = await devObjectsStatistic(client, { user: 'Admin', passwordHash: crsPasswordHash('') }, { removed: false });
      const records = statisticToLockRecords(statistic);
      assert.deepStrictEqual(sortRecords(records), await fileRecords(version));
      assert.ok(statistic.objects.length > records.length);
      assert.strictEqual(records.length, statistic.objects.filter((object) => object.lock !== undefined).length);
    });

    test('statisticToLockRecords: захват пользователя, которого нет в списке ответа, отбрасывается', async () => {
      const { client } = recordedClient([readHttpExchange(version, 'statistic-admin').response]);
      const statistic = await devObjectsStatistic(client, { user: 'Admin', passwordHash: crsPasswordHash('') }, { removed: false });
      // Копия ответа в памяти без пользователя Petrov: его захваты остаются в statMap, но держатель неизвестен.
      const records = statisticToLockRecords({ ...statistic, users: statistic.users.filter((user) => user.name !== 'Petrov') });
      const expected = (await fileRecords(version)).filter((record) => record.user !== 'Petrov');
      assert.ok(expected.length > 0 && expected.length < (await fileRecords(version)).length);
      assert.deepStrictEqual(sortRecords(records), expected);
    });
  });
}

suite('NetworkRepositoryLockStatusSource — отказы транспорта и сервера', () => {
  const run = readRun('8.5.1');
  const statistic = readHttpExchange('8.5.1', 'statistic-admin');
  const greeting = readTcpExchange('8.5.1', 'statistic-admin').server.subarray(0, 5);
  const servers: LoopbackServer[] = [];
  const source = new NetworkRepositoryLockStatusSource({ timeoutMs: 10_000 });

  teardown(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function rawTcp(onConnection: (socket: net.Socket) => void): Promise<LoopbackServer> {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      onConnection(socket);
    });
    const loopback = await listenLoopback(server, [], sockets);
    servers.push(loopback);
    return loopback;
  }

  async function httpAnswer(status: number, body: Buffer, headers: Record<string, string> = {}): Promise<string> {
    const server = await startHttpReplayServer(() => ({ status, headers, body }));
    servers.push(server);
    return `http://127.0.0.1:${String(server.port)}/repo/repo.1ccr/${run.alias}`;
  }

  const tcpPath = (port: number): string => `tcp://127.0.0.1:${String(port)}/${run.alias}`;
  const read = (repoPath: string, reader: RepositoryLockStatusSource = source): Promise<unknown> =>
    reader.readLocks(serverLocation(repoPath), context(run.platform));

  for (const scheme of ['tcp', 'http'] as const) {
    test(`${scheme}: порт закрыт → unavailable`, async () => {
      const port = await findClosedPort();
      const repoPath = scheme === 'tcp' ? tcpPath(port) : `http://127.0.0.1:${String(port)}/repo/repo.1ccr/${run.alias}`;
      const error = await statusError(read(repoPath), 'unavailable');
      assert.ok(error.cause instanceof CrsTransportError);
    });

    test(`${scheme}: сервер молчит → timeout по общему дедлайну`, async () => {
      const server = await rawTcp(() => undefined);
      const repoPath = scheme === 'tcp' ? tcpPath(server.port) : `http://127.0.0.1:${String(server.port)}/repo/repo.1ccr/${run.alias}`;
      await statusError(read(repoPath, new NetworkRepositoryLockStatusSource({ timeoutMs: 100 })), 'timeout');
    });
  }

  test('tcp: ответ http-публикации вместо crserver → protocol на разборе кадра', async () => {
    const server = await rawTcp((socket) => socket.write(readFixture('http-raw', 'probe-valid', 'response.bin')));
    await statusError(read(tcpPath(server.port)), 'protocol');
  });

  test('tcp: обрыв после приветствия → protocol', async () => {
    const server = await rawTcp((socket) => socket.end(greeting));
    await statusError(read(tcpPath(server.port)), 'protocol');
  });

  test('tcp: Content-Length ответа больше лимита → too-large', async () => {
    const exchange = readTcpExchange('8.5.1', 'statistic-admin');
    const server = await startTcpReplayServer(exchange.server, () => exchange.server);
    servers.push(server);
    await statusError(read(tcpPath(server.port), new NetworkRepositoryLockStatusSource({ maxResponseBytes: 100 })), 'too-large');
  });

  test('http: chunked-ответ больше лимита по фактическим байтам → too-large', async () => {
    const sockets = new Set<net.Socket>();
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/xml' });
      response.write(statistic.response.subarray(0, 80));
      response.end(statistic.response.subarray(80, 160));
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
    });
    const loopback = await listenLoopback(server, [], sockets);
    servers.push(loopback);
    const repoPath = `http://127.0.0.1:${String(loopback.port)}/repo/repo.1ccr/${run.alias}`;
    await statusError(read(repoPath, new NetworkRepositoryLockStatusSource({ maxResponseBytes: 100 })), 'too-large');
  });

  const httpFailures: [string, number, Buffer, RepositoryLockStatusErrorCode][] = [
    ['500 с телом не VRS', 500, Buffer.from('<html>oops</html>'), 'server-error'],
    ['VRS 404 публикации (http/probe-wrong-path)', 404, readFixture('http', 'probe-wrong-path', 'response.xml'), 'server-error'],
    ['VRS 400 разбора XML (http/probe-malformed-body)', 400, readFixture('http', 'probe-malformed-body', 'response.xml'), 'protocol'],
    ['200 из одного BOM (http/probe-unknown-method)', 200, readFixture('http', 'probe-unknown-method', 'response.xml'), 'protocol'],
    ['200 с HTML вместо crs', 200, Buffer.from('<html><body><h1>502 Bad Gateway</h1></body></html>'), 'protocol'],
  ];
  for (const [title, status, body, code] of httpFailures) {
    test(`http: ${title} → ${code}`, async () => {
      const error = await statusError(read(await httpAnswer(status, body)), code);
      assert.ok(error.cause instanceof Error);
    });
  }

  suite('https с самоподписанным сертификатом localhost (example/repository/tls)', () => {
    const cert = fs.readFileSync(path.join(REPOSITORY_TLS_DIR, 'localhost.crt'));
    const key = fs.readFileSync(path.join(REPOSITORY_TLS_DIR, 'localhost.key'));

    async function startHttps(): Promise<string> {
      const sockets = new Set<net.Socket>();
      const server = https.createServer({ cert, key }, (request, response) => {
        request.resume();
        request.on('end', () => {
          response.writeHead(200, { 'Content-Type': 'application/xml' });
          response.end(statistic.response);
        });
      });
      server.on('connection', (socket: net.Socket) => {
        sockets.add(socket);
      });
      const loopback = await listenLoopback(server, [], sockets);
      servers.push(loopback);
      return `https://127.0.0.1:${String(loopback.port)}/repo/repo.1ccr/${run.alias}`;
    }

    test('без доверенного CA → tls: проверка сертификата не отключена', async () => {
      await statusError(read(await startHttps()), 'tls');
    });

    test('с CA тестового сертификата → записи файлового источника', async () => {
      const reader = new NetworkRepositoryLockStatusSource({ tls: { ca: cert } });
      const result = await reader.readLocks(serverLocation(await startHttps()), context(run.platform));
      assert.deepStrictEqual(sortRecords(result.records), await fileRecords('8.5.1'));
    });
  });
});

suite('NetworkRepositoryLockStatusSource — адреса', () => {
  const source: RepositoryLockStatusSource = new NetworkRepositoryLockStatusSource();

  test('файловое хранилище не поддерживается, а переданное напрямую — ошибка адреса', async () => {
    const location = classifyRepositoryLocation(lockFixturePath('8.5.1'), os.tmpdir());
    assert.strictEqual(source.supports(location), false);
    await statusError(source.readLocks(location, context('8.3.27.0')), 'invalid-address');
  });

  // Схема не tcp/http(s) классификатор считает файловым путём, поэтому адрес подаётся сервером напрямую:
  // так проверяется сам разбор адреса источника.
  const invalid = ['tcp://127.0.0.1:1', 'tcp://u:secret@h/a', 'tcp://h/secret?x=1', 'ftp://h/secret.1ccr', 'http://h/secret/'];
  for (const repoPath of invalid) {
    test(`${repoPath} → invalid-address без пароля и исходной строки, до сети`, async () => {
      const location: RepositoryLocation = { kind: 'server', repoPath, transport: 'tcp' };
      const error = await statusError(source.readLocks(location, context('8.3.27.0')), 'invalid-address');
      assert.ok(error.cause instanceof CrsAddressError);
      assert.ok(!error.message.includes('secret') && !error.message.includes(repoPath), error.message);
      assert.doesNotMatch(error.message, /адрес хранилища[\s\S]*адрес хранилища:/i);
    });
  }
});

suite('toRepositoryLockStatusError — таблица кодов', () => {
  const transportCodes: [CrsTransportErrorKind, RepositoryLockStatusErrorCode][] = [
    ['unavailable', 'unavailable'],
    ['timeout', 'timeout'],
    ['aborted', 'unavailable'],
    ['closed', 'protocol'],
    ['too-large', 'too-large'],
    ['protocol', 'protocol'],
    ['status', 'server-error'],
  ];
  for (const [kind, code] of transportCodes) {
    test(`CrsTransportError ${kind} → ${code}, текст и причина сохранены`, () => {
      const error = new CrsTransportError(kind, 'tcp://127.0.0.1:1542: причина', { endpoint: 'tcp://127.0.0.1:1542' });
      const mapped = toRepositoryLockStatusError(error);
      assert.deepStrictEqual([mapped.code, mapped.message, mapped.cause], [code, error.message, error]);
    });
  }

  const tlsCodes: [string, RepositoryLockStatusErrorCode][] = [
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls'],
    ['ECONNREFUSED', 'unavailable'],
  ];
  for (const [causeCode, code] of tlsCodes) {
    test(`unavailable с причиной ${causeCode} → ${code}`, () => {
      const cause = Object.assign(new Error(causeCode), { code: causeCode });
      const error = new CrsTransportError('unavailable', 'https://h:443/r.1ccr: ошибка', { endpoint: 'https://h:443/r.1ccr', cause });
      assert.strictEqual(toRepositoryLockStatusError(error).code, code);
    });
  }

  const callCodes: [CrsCallErrorKind, RepositoryLockStatusErrorCode][] = [
    ['version-mismatch', 'version-mismatch'],
    ['auth-failed', 'auth-failed'],
    ['depot-not-found', 'server-error'],
    ['unknown-method', 'protocol'],
    ['bad-request', 'protocol'],
    ['rejected', 'server-error'],
    ['server', 'server-error'],
    ['malformed-response', 'protocol'],
  ];
  for (const [kind, code] of callCodes) {
    test(`CrsCallError ${kind} → ${code}: текст — сообщения сервера без имени метода`, () => {
      const error = new CrsCallError(kind, 'M: первое второе', { method: 'M', messages: ['первое', 'второе'] });
      const mapped = toRepositoryLockStatusError(error);
      assert.strictEqual(mapped.code, code);
      assert.ok(mapped.message.startsWith('первое второе'), mapped.message);
      assert.strictEqual(mapped.cause, error);
    });
  }

  test('сообщений сервера нет или список пуст → текст ошибки клиента', () => {
    const none = new CrsCallError('unknown-method', 'M: пустой ответ', { method: 'M' });
    const empty = new CrsCallError('server', 'M: пусто', { method: 'M', messages: [] });
    assert.strictEqual(toRepositoryLockStatusError(none).message, none.message);
    assert.strictEqual(toRepositoryLockStatusError(empty).message, empty.message);
  });

  test('retriedWithVersion дописывает версию повтора только к несоответствию версий', () => {
    const mismatch = new CrsCallError('version-mismatch', 'M: Несоответствие', { method: 'M', messages: ['Несоответствие'] });
    assert.strictEqual(toRepositoryLockStatusError(mismatch).message, 'Несоответствие');
    assert.strictEqual(toRepositoryLockStatusError(mismatch, '8.5.1.1529').message, 'Несоответствие (повтор с версией сервера 8.5.1.1529 не помог)');
    const server = new CrsCallError('server', 'M: отказ', { method: 'M', messages: ['отказ'] });
    assert.strictEqual(toRepositoryLockStatusError(server, '8.5.1.1529').message, 'отказ');
  });

  test('CrsAddressError и RangeError → invalid-address; RepositoryLockStatusError — тот же объект', () => {
    // Сообщение разбора адреса уже называет адрес — источник его не дублирует, только начинает с заглавной.
    const address = new CrsAddressError('syntax', 'адрес хранилища не разбирается как URL');
    const mappedAddress = toRepositoryLockStatusError(address);
    assert.deepStrictEqual(
      [mappedAddress.code, mappedAddress.cause, mappedAddress.message],
      ['invalid-address', address, 'Адрес хранилища не разбирается как URL.'],
    );
    const range = new RangeError('path должен начинаться с «/»');
    const mappedRange = toRepositoryLockStatusError(range);
    assert.deepStrictEqual(
      [mappedRange.code, mappedRange.cause, mappedRange.message],
      ['invalid-address', range, 'Неверный адрес хранилища: path должен начинаться с «/».'],
    );
    const own = new RepositoryLockStatusError('timeout', 'уже переведено');
    assert.strictEqual(toRepositoryLockStatusError(own), own);
  });

  test('прочее → protocol с причиной', () => {
    const error = new Error('неожиданное');
    const mapped = toRepositoryLockStatusError(error);
    assert.deepStrictEqual([mapped.code, mapped.cause], ['protocol', error]);
    assert.ok(mapped.message.includes('неожиданное'));
    const thrown = toRepositoryLockStatusError('строка');
    assert.deepStrictEqual([thrown.code, thrown.cause], ['protocol', 'строка']);
    assert.ok(thrown.message.includes('строка'));
  });
});
