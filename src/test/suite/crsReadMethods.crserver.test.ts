import * as assert from 'assert';
import { CrsClient } from '../../infra/repository/crs/CrsClient';
import { authenticate, depotInfo, openDevDepot } from '../../infra/repository/crs/CrsDepot';
import { devDepotReport, devDepotVersions } from '../../infra/repository/crs/CrsHistory';
import { CrsHttpTransport } from '../../infra/repository/crs/CrsHttpTransport';
import { crsPasswordHash } from '../../infra/repository/crs/CrsSecrets';
import { devObjectsStatistic } from '../../infra/repository/crs/CrsStatistic';
import { CrsTcpTransport } from '../../infra/repository/crs/CrsTcpTransport';
import type { CrsTransport } from '../../infra/repository/crs/CrsTransport';
import { depotUsers } from '../../infra/repository/crs/CrsUsers';
import type { CrsAuth } from '../../infra/xml/crs/CrsEnvelope';
import { apachePaths, type LocalApache, startApache } from './support/crsApache';
import { callRejection } from './support/crsMethods';
import {
  BUILD_DEADLINE_MS,
  configRootId,
  depotUnitIds,
  startTestDepot,
  TEST_DEPOT_CONFIG,
  TEST_DEPOT_USERS,
  type TestDepot,
} from './support/crsTestDepot';

// Оракулы — из самой выгрузки, а не из ответов сервера: корень конфигурации и единицы хранилища
// (объекты, формы, макеты) по ConfigDumpInfo.xml.
const ROOT_ID = configRootId(TEST_DEPOT_CONFIG);
const UNITS = depotUnitIds(TEST_DEPOT_CONFIG);
// uuid, которого нет в хранилище (тот же, что у проб capture-history-probes.mjs).
const UNKNOWN_OBJECT = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';

const auth = (u: { user: string; password: string }): CrsAuth => ({ user: u.user, passwordHash: crsPasswordHash(u.password) });
const ADMIN = auth(TEST_DEPOT_USERS.admin);
const PETROV = auth(TEST_DEPOT_USERS.petrov);
const READER = auth(TEST_DEPOT_USERS.reader);

suite('crs методы чтения: crserver с хранилищем из example/2.21/src/cf', function () {
  // Сборка хранилища платформой (BUILD_DEADLINE_MS) плюс запуск apache и остановка процессов.
  this.timeout(BUILD_DEADLINE_MS + 60_000);
  // Хранилище одно на файл: сборка — десятки секунд, tcp и http читают одно и то же.
  let depot: TestDepot | undefined;

  suiteSetup(async function () {
    depot = await startTestDepot(TEST_DEPOT_CONFIG);
    if (!depot) {
      this.skip();
    }
  });

  suiteTeardown(async () => {
    await depot?.stop();
  });

  for (const transportName of ['tcp', 'http'] as const) {
    suite(`по ${transportName}`, function () {
      let apache: LocalApache | undefined;

      if (transportName === 'http') {
        suiteSetup(async function () {
          if (!apachePaths()) {
            this.skip();
          }
          assert.ok(depot);
          apache = await startApache(depot.port, depot.alias);
        });

        suiteTeardown(async () => {
          await apache?.stop();
        });
      }

      function client(): CrsClient {
        assert.ok(depot);
        let transport: CrsTransport = new CrsTcpTransport({ host: '127.0.0.1', port: depot.port }, { timeoutMs: 20_000 });
        if (transportName === 'http') {
          assert.ok(apache);
          transport = new CrsHttpTransport({ scheme: 'http', host: '127.0.0.1', port: apache.port, path: apache.path }, { timeoutMs: 20_000 });
        }
        // Без известной версии: первый вызов делает рукопожатие.
        return new CrsClient(transport, { alias: depot.alias });
      }

      async function adminId(): Promise<string | undefined> {
        const users = await depotUsers(client(), ADMIN, { removed: true });
        return users.find((u) => u.name === 'Admin')?.id;
      }

      test('openDevDepot и depotInfo: корень хранилища — uuid корня конфигурации, не расширение', async () => {
        const opened = await openDevDepot(client());
        assert.strictEqual(opened.rootId, ROOT_ID);
        assert.strictEqual(opened.isExtension, false);
        assert.deepStrictEqual(await depotInfo(client(), ADMIN), opened);
      });

      test('authenticate: права Admin, Petrov и Reader; неверный пароль и неизвестный пользователь — auth-failed', async () => {
        const rights = async (a: CrsAuth): Promise<[string, number]> => {
          const user = await authenticate(client(), a);
          return [user.name, user.rights];
        };
        assert.deepStrictEqual(await rights(ADMIN), ['Admin', 65535]);
        assert.deepStrictEqual(await rights(PETROV), ['Petrov', 3]);
        assert.deepStrictEqual(await rights(READER), ['Reader', 0]);
        for (const wrong of [{ ...PETROV, passwordHash: crsPasswordHash('wrong') }, { user: 'Nobody', passwordHash: crsPasswordHash('000') }]) {
          const error = await callRejection(authenticate(client(), wrong));
          assert.strictEqual(error.kind, 'auth-failed', `${wrong.user}: ${error.message}`);
        }
      });

      test('devObjectsStatistic: единицы хранилища — записи ConfigDumpInfo.xml с версией, никто не захвачен', async () => {
        const statistic = await devObjectsStatistic(client(), PETROV, { removed: true });
        assert.deepStrictEqual(new Set(statistic.objects.map((o) => o.objectId)), UNITS);
        assert.deepStrictEqual(
          statistic.objects.filter((o) => o.lock !== undefined || o.version !== 1),
          [],
          'захваты или версии не 1',
        );
        assert.ok(UNITS.has(ROOT_ID), 'корень конфигурации — единица хранилища');
        assert.deepStrictEqual(statistic.users.map((u) => u.name).sort(), ['Admin', 'Petrov', 'Reader']);
      });

      test('devDepotReport: одна версия (создание хранилища от Admin) со всеми единицами; пользователи хранилища', async () => {
        const history = await devDepotReport(client(), ADMIN);
        assert.deepStrictEqual(history.versions.map((v) => v.verNum), [1]);
        assert.deepStrictEqual(new Set(history.changes.map((c) => c.objectId)), UNITS);
        assert.deepStrictEqual(
          history.changes.filter((c) => c.verNum !== 1 || c.removed),
          [],
          'изменения не версии 1 или удалённые',
        );
        const users = await depotUsers(client(), ADMIN, { removed: true });
        assert.deepStrictEqual(users.map((u) => [u.name, u.rights]).sort(), [['Admin', 65535], ['Petrov', 3], ['Reader', 0]]);
        assert.strictEqual(history.versions[0].userId, await adminId());
      });

      test('devDepotVersions: одна версия от Admin, как в отчёте; страница 1–1 — та же история; неизвестный объект — пустой список', async () => {
        const versions = await devDepotVersions(client(), ADMIN);
        assert.deepStrictEqual(versions.map((v) => v.verNum), [1]);
        assert.strictEqual(versions[0].userId, await adminId());
        const history = await devDepotReport(client(), ADMIN);
        assert.deepStrictEqual(versions, history.versions);
        assert.deepStrictEqual(await devDepotReport(client(), ADMIN, { beginVerNum: 1, endVerNum: 1 }), history);
        assert.deepStrictEqual(await devDepotVersions(client(), ADMIN, { objectIds: [UNKNOWN_OBJECT], recursive: true }), []);
      });

      test('devObjectsStatistic: по одной привязке на пользователя; с привязкой, без неё и от Reader — те же объекты', async () => {
        const statistic = await devObjectsStatistic(client(), PETROV, { removed: true });
        const byId = new Map(statistic.users.map((u) => [u.id, u.name]));
        assert.deepStrictEqual(statistic.bindings.map((b) => byId.get(b.userId)).sort(), ['Admin', 'Petrov', 'Reader']);
        const petrovBinding = statistic.bindings.find((b) => byId.get(b.userId) === 'Petrov');
        assert.ok(petrovBinding);
        const withBind = await devObjectsStatistic(client(), PETROV, { removed: true, bindId: petrovBinding.bindId });
        assert.deepStrictEqual(withBind.objects, statistic.objects);
        assert.deepStrictEqual((await devObjectsStatistic(client(), READER, { removed: true })).objects, statistic.objects);
      });
    });
  }
});
