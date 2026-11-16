import * as assert from 'assert';
import { CrsClient } from '../../infra/repository/crs/CrsClient';
import { CrsCallError } from '../../infra/repository/crs/CrsErrors';
import { devDepotVersions } from '../../infra/repository/crs/CrsHistory';
import { normalizeCrsVersionHint, runWithServerVersionRetry } from '../../infra/repository/crs/CrsVersionRetry';
import { tcpBodyProbe, tcpRawProbeBodies } from './support/crsFixtures';
import { callRejection, STAND_VERSION } from './support/crsMethods';
import { RecordedTransport } from './support/crsRecordedTransport';
import { requestVersion } from './support/repositoryLockFixtures';

/**
 * Повтор вызова с версией сервера (#117): общий помощник истории и статусов захвата. Ответы — настоящие
 * тела crserver 8.5.1: чужая версия (tcp-raw/probe-version-other), список версий, неверный пароль.
 */

const AUTH = { user: 'Admin', passwordHash: 'd41d8cd98f00b204e9800998ecf8427e' };
const VERSION_OTHER = tcpRawProbeBodies('probe-version-other').response.body;
const VERSIONS = tcpBodyProbe('probe-history-devdepotversions').response;
const WRONG_PASSWORD = tcpBodyProbe('probe-history-wrong-password').response;
const STALE_HINT = '8.3.0.0';

/** Каждый прогон — свой клиент с переданной версией, как у потребителей помощника; без версии — подсказка стенда. */
function runner(transport: RecordedTransport): (version: string | undefined) => Promise<number> {
  return async (version) => {
    const client = new CrsClient(transport, { alias: 'exp', version: version ?? STALE_HINT });
    return (await devDepotVersions(client, AUTH)).length;
  };
}

suite('CrsVersionRetry (#117)', () => {
  const hints: readonly [string | undefined, string | undefined][] = [
    [undefined, undefined],
    ['', undefined],
    ['8.3.27', undefined],
    ['8.3.27.x', undefined],
    ['8.5.1.1529', '8.5.1.1529'],
  ];
  for (const [hint, expected] of hints) {
    test(`normalizeCrsVersionHint(${JSON.stringify(hint)}) → ${String(expected)}`, () => {
      assert.strictEqual(normalizeCrsVersionHint(hint), expected);
    });
  }

  test('устаревшая подсказка — ровно один повтор с версией из исключения сервера', async () => {
    const transport = new RecordedTransport([VERSION_OTHER, VERSIONS]);
    const retried: string[] = [];
    const count = await runWithServerVersionRetry(STALE_HINT, runner(transport), (v) => retried.push(v));
    assert.ok(count > 0);
    assert.deepStrictEqual(retried, [STAND_VERSION]);
    assert.deepStrictEqual(transport.requests.map((r) => requestVersion(r.body)), [STALE_HINT, STAND_VERSION]);
    assert.ok(transport.exhausted);
  });

  test('повторный отказ по версии пробрасывается, третьего вызова нет', async () => {
    const transport = new RecordedTransport([VERSION_OTHER, VERSION_OTHER]);
    const error = await callRejection(runWithServerVersionRetry(STALE_HINT, runner(transport)));
    assert.strictEqual(error.kind, 'version-mismatch');
    assert.strictEqual(transport.requests.length, 2);
  });

  test('без подсказки повтора нет: версию сообщало рукопожатие', async () => {
    const transport = new RecordedTransport([VERSION_OTHER]);
    const retried: string[] = [];
    const error = await callRejection(runWithServerVersionRetry(undefined, runner(transport), (v) => retried.push(v)));
    assert.strictEqual(error.kind, 'version-mismatch');
    assert.deepStrictEqual(retried, []);
    assert.strictEqual(transport.requests.length, 1);
  });

  test('отказ не по версии пробрасывается без повтора', async () => {
    const transport = new RecordedTransport([WRONG_PASSWORD]);
    const error = await callRejection(runWithServerVersionRetry(STALE_HINT, runner(transport)));
    assert.strictEqual(error.kind, 'auth-failed');
    assert.strictEqual(transport.requests.length, 1);
  });

  test('version-mismatch без версии сервера и посторонняя ошибка — без повтора', async () => {
    const noVersion = new CrsCallError('version-mismatch', 'версия не сообщена', { method: 'DevDepot_devDepotVersions' });
    const other = new Error('сбой');
    for (const thrown of [noVersion, other]) {
      let calls = 0;
      const error = await runWithServerVersionRetry(STALE_HINT, () => {
        calls += 1;
        return Promise.reject(thrown);
      }).then(() => assert.fail('ожидался отказ'), (e: unknown) => e);
      assert.strictEqual(error, thrown);
      assert.strictEqual(calls, 1);
    }
  });
});
