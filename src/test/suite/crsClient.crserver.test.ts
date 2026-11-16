import * as assert from 'assert';
import * as path from 'path';
import type { CrsClient } from '../../infra/repository/crs/CrsClient';
import { createCrsClient } from '../../infra/repository/crs/CrsConnect';
import { CrsCallError, type CrsCallErrorKind } from '../../infra/repository/crs/CrsErrors';
import { crsValue } from '../../infra/xml/crs/CrsEnvelope';
import { apachePaths, type LocalApache, startApache } from './support/crsApache';
import { type LocalCrserver, crserverPath, startCrserver } from './support/crsLocalServer';

const VERSION = /^\d+\.\d+\.\d+\.\d+$/;
const OPEN = { method: 'DevDepotAdmin_openDevDepot', params: [crsValue('alias', 'exp'), crsValue('convert', false)] };

async function callError(promise: Promise<unknown>, kind: CrsCallErrorKind): Promise<CrsCallError> {
  const error = await promise.then(
    () => assert.fail(`ожидался отказ ${kind}`),
    (e: unknown) => e,
  );
  assert.ok(error instanceof CrsCallError, String(error));
  assert.strictEqual(error.kind, kind, error.message);
  return error;
}

for (const transport of ['tcp', 'http'] as const) {
  suite(`crs CrsClient: локальный crserver по ${transport}`, function () {
    // Запуск и остановка процессов платформы и apache — секунды, а не миллисекунды.
    this.timeout(30_000);
    let crserver: LocalCrserver | undefined;
    let apache: LocalApache | undefined;
    let expectedVersion: string | undefined;

    suiteSetup(async function () {
      const file = crserverPath();
      // Для http нужен ещё apache с wsap24.so; без окружения suite pending.
      if (!file || (transport === 'http' && !apachePaths())) {
        this.skip();
      }
      // Каталог платформы назван её версией: /opt/1cv8/x86_64/8.5.1.1529/crserver.
      const dir = path.basename(path.dirname(file));
      expectedVersion = VERSION.test(dir) ? dir : undefined;
      crserver = await startCrserver(file);
      if (transport === 'http') {
        apache = await startApache(crserver.port, 'exp');
      }
    });

    suiteTeardown(async () => {
      await apache?.stop();
      await crserver?.stop();
    });

    function address(publication?: string): string {
      assert.ok(crserver);
      if (transport === 'tcp') {
        return `tcp://127.0.0.1:${String(crserver.port)}/exp`;
      }
      assert.ok(apache);
      return `http://127.0.0.1:${String(apache.port)}${publication ?? apache.path}/exp`;
    }

    function client(version?: string, publication?: string): CrsClient {
      return createCrsClient(address(publication), { timeoutMs: 10_000, ...(version === undefined ? {} : { version }) });
    }

    test('рукопожатие на пустом crserver: версия проверяется раньше alias (probe-version-zero-wrong-alias)', async () => {
      const version = await client().serverVersion();
      assert.match(version, VERSION);
      if (expectedVersion !== undefined) {
        assert.strictEqual(version, expectedVersion);
      }
    });

    test('openDevDepot с верной версией на пустом crserver — depot-not-found', async () => {
      const version = await client().serverVersion();
      const error = await callError(client(version).call(OPEN), 'depot-not-found');
      assert.strictEqual(error.details.code, 1);
    });

    test('другая версия платформы (probe-version-other) — version-mismatch с версией сервера', async () => {
      const version = await client().serverVersion();
      const other = version === '8.3.27.2342' ? '8.5.1.1529' : '8.3.27.2342';
      const error = await callError(client(other).call(OPEN), 'version-mismatch');
      assert.strictEqual(error.details.serverVersion, version);
    });

    if (transport === 'http') {
      test('неверный путь .1ccr (probe-wrong-path) — rejected 404', async () => {
        const error = await callError(client(undefined, '/repo/missing.1ccr').serverVersion(), 'rejected');
        assert.strictEqual(error.details.status, 404);
      });
    }
  });
}
