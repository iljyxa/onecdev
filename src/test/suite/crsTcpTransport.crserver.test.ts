import * as assert from 'assert';
import { CrsTcpTransport } from '../../infra/repository/crs/CrsTcpTransport';
import { readFixture } from './support/crsFixtures';
import { type LocalCrserver, crserverPath, startCrserver } from './support/crsLocalServer';

// Настоящее тело openDevDepot Конфигуратора (alias exp) из снятого трафика.
const OPEN_DEV_DEPOT = readFixture('tcp', 'lock-one', '01-conn-01-c2s-DevDepotAdmin_openDevDepot.xml');

// Без хранилища в каталоге данных crserver отвечает на openDevDepot исключением бизнес-уровня:
// статус 200, тело — crs:call_exception (как неверный пароль в example/crs/8.5.1/tcp/lock-wrong-password).
function assertCallException(body: Buffer): void {
  assert.deepStrictEqual(body.subarray(0, 3), Buffer.from('efbbbf', 'hex'), 'тело начинается с BOM');
  const text = body.toString('utf-8');
  assert.match(text, /^\uFEFF<\?xml version="1\.0" encoding="UTF-8"\?><crs:call_exception[ >]/, text.slice(0, 200));
}

suite('crs CrsTcpTransport: локальный crserver', function () {
  // Запуск и остановка процесса платформы — секунды, а не миллисекунды.
  this.timeout(30_000);
  let crserver: LocalCrserver | undefined;

  suiteSetup(async function () {
    const file = crserverPath();
    if (!file) {
      this.skip();
    }
    crserver = await startCrserver(file);
  });

  suiteTeardown(async () => {
    await crserver?.stop();
  });

  function transport(): CrsTcpTransport {
    assert.ok(crserver);
    return new CrsTcpTransport({ host: '127.0.0.1', port: crserver.port }, { timeoutMs: 10_000 });
  }

  test('три последовательных вызова openDevDepot на одном экземпляре', async () => {
    const t = transport();
    for (let i = 0; i < 3; i += 1) {
      assertCallException(await t.call(OPEN_DEV_DEPOT));
    }
  });

  test('два параллельных вызова openDevDepot на одном экземпляре', async () => {
    const t = transport();
    const bodies = await Promise.all([t.call(OPEN_DEV_DEPOT), t.call(OPEN_DEV_DEPOT)]);
    for (const body of bodies) {
      assertCallException(body);
    }
  });
});
