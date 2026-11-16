import * as assert from 'assert';
import { CrsClient } from '../../infra/repository/crs/CrsClient';
import { authenticate, bind, depotInfo, openDevDepot } from '../../infra/repository/crs/CrsDepot';
import { crsPasswordHash } from '../../infra/repository/crs/CrsSecrets';
import { devObjectsStatistic } from '../../infra/repository/crs/CrsStatistic';
import { CrsTcpTransport } from '../../infra/repository/crs/CrsTcpTransport';
import { type LocalCrserver, crserverPath, startCrserver } from './support/crsLocalServer';
import { callRejection } from './support/crsMethods';

const AUTH = { user: 'Petrov', passwordHash: crsPasswordHash('123') };

suite('crs методы чтения: пустой crserver', function () {
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

  test('после рукопожатия каждый из пяти методов принят сервером и отклонён как depot-not-found', async () => {
    assert.ok(crserver);
    const transport = new CrsTcpTransport({ host: '127.0.0.1', port: crserver.port }, { timeoutMs: 10_000 });
    // Без известной версии: первый вызов делает рукопожатие, остальные идут с версией сервера.
    const client = new CrsClient(transport, { alias: 'exp' });
    const calls: [string, () => Promise<unknown>][] = [
      ['DevDepotAdmin_openDevDepot', () => openDevDepot(client)],
      ['DevDepot_authenticate', () => authenticate(client, AUTH)],
      ['DevDepot_depotInfo', () => depotInfo(client, AUTH)],
      [
        'DevDepot_bind',
        () => bind(client, AUTH, { bindId: '6f1c2d3e-4b5a-4c6d-8e7f-a0b1c2d3e4f5', bindString: 'Computer="crs-test";', existing: true, force: false }),
      ],
      ['DevDepot_devObjectsStatistic', () => devObjectsStatistic(client, AUTH, { removed: true })],
    ];
    for (const [method, call] of calls) {
      const error = await callRejection(call());
      assert.strictEqual(error.kind, 'depot-not-found', `${method}: ${error.message}`);
      assert.strictEqual(error.details.method, method);
    }
  });
});
