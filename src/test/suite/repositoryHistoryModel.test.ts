import * as assert from 'assert';
import { devDepotReport, type CrsDepotHistory } from '../../infra/repository/crs/CrsHistory';
import { depotUsers } from '../../infra/repository/crs/CrsUsers';
import { buildHistory, describeChangeKind, type HistoryChangeKind } from '../../infra/repository/history/RepositoryHistoryModel';
import { corpusExchanges, tcpBodyProbe } from './support/crsFixtures';
import { reportTitles, reportVersions } from './support/crsHistoryReport';
import { recordedClient } from './support/crsMethods';

/**
 * Модель истории хранилища (#117): версии по убыванию с авторами по именам и изменёнными объектами.
 * Оракул — report.txt, построенный Конфигуратором по тому же ответу devDepotReport (history-all).
 */

const AUTH = { user: 'Admin', passwordHash: 'd41d8cd98f00b204e9800998ecf8427e' };
const GROUP_KIND: Readonly<Record<string, HistoryChangeKind>> = { Добавлены: 'added', Изменены: 'modified', Удалены: 'removed' };

function corpusResponse(transport: 'tcp' | 'http', scenario: string, method: string): Buffer {
  const found = corpusExchanges().find((e) => e.transport === transport && e.scenario === scenario && e.method === method);
  assert.ok(found, `${transport}/${scenario}/${method}`);
  return found.response;
}

async function rawHistoryAll(transport: 'tcp' | 'http'): Promise<{ raw: CrsDepotHistory; users: Awaited<ReturnType<typeof depotUsers>> }> {
  const { client } = recordedClient([
    corpusResponse(transport, 'history-all', 'DevDepot_devDepotReport'),
    corpusResponse(transport, 'history-all', 'UserManager_depotUsers'),
  ]);
  return { raw: await devDepotReport(client, AUTH), users: await depotUsers(client, AUTH, { removed: true }) };
}

suite('RepositoryHistoryModel (#117)', () => {
  const kinds: readonly [number, boolean, HistoryChangeKind][] = [
    [0, false, 'added'],
    [5, false, 'modified'],
    [7, false, 'modified'],
    [0, true, 'removed'],
  ];
  for (const [action, removed, expected] of kinds) {
    test(`describeChangeKind(${String(action)}, ${String(removed)}) → ${expected}`, () => {
      assert.strictEqual(describeChangeKind(action, removed), expected);
    });
  }

  for (const transport of ['tcp', 'http'] as const) {
    test(`${transport}/history-all: версии, авторы, метки и изменения — как в report.txt`, async () => {
      const { raw, users } = await rawHistoryAll(transport);
      const history = buildHistory(raw, users);
      const report = reportVersions(transport, 'history-all');
      assert.deepStrictEqual(history.pending, []);
      assert.deepStrictEqual(history.versions.map((v) => v.verNum), report.map((r) => r.verNum).sort((a, b) => b - a));
      for (const expected of report) {
        const version = history.versions.find((v) => v.verNum === expected.verNum);
        assert.ok(version, `нет версии ${String(expected.verNum)}`);
        assert.strictEqual(version.author, expected.user);
        assert.strictEqual(version.configVersion, expected.configVersion);
        assert.strictEqual(version.comment.replace(/\r\n/g, '\n'), expected.comment);
        assert.strictEqual(version.label?.name, expected.label?.name);
        assert.strictEqual(version.label?.comment, expected.label?.comment);
        if (version.label) {
          assert.ok(users.some((u) => u.name === version.label?.author), `автор метки ${version.label.author}`);
        }
        const rawVersion = raw.versions.find((v) => v.verNum === expected.verNum);
        assert.strictEqual(version.versionId, rawVersion?.versionId);
        assert.strictEqual(version.authorId, rawVersion?.userId);
        assert.strictEqual(version.date, rawVersion?.date);
        assert.strictEqual(version.platformVersion, rawVersion?.platformVersion);
        // Изменения отсортированы по заголовку — тем же порядком кода символа, что и у оракула.
        assert.deepStrictEqual(version.changes.map((c) => c.title), reportTitles(expected));
        for (const [group, titles] of Object.entries(expected.groups)) {
          for (const title of titles) {
            assert.strictEqual(version.changes.find((c) => c.title === title)?.kind, GROUP_KIND[group], `${title} в группе ${group}`);
          }
        }
      }
    });
  }

  test('автор вне списка пользователей — «Пользователь <8 символов uuid>», и у метки тоже', async () => {
    // Пользователи проб сняты с другого стенда: авторов страницы 2–4 среди них нет.
    const { client } = recordedClient([tcpBodyProbe('probe-history-page-2-4').response, tcpBodyProbe('probe-depot-users-no-bind').response]);
    const raw = await devDepotReport(client, AUTH);
    const users = await depotUsers(client, AUTH, { removed: true });
    const history = buildHistory(raw, users);
    assert.ok(history.versions.length > 0);
    for (const version of history.versions) {
      assert.ok(!users.some((u) => u.id === version.authorId), 'автор нашёлся среди пользователей');
      assert.strictEqual(version.author, `Пользователь ${version.authorId.slice(0, 8)}`);
    }
    const labeled = history.versions.find((v) => v.label !== undefined);
    const rawLabel = raw.versions.find((v) => v.verNum === labeled?.verNum)?.label;
    assert.ok(labeled?.label && rawLabel, 'на странице 2–4 нет версии с меткой');
    assert.strictEqual(labeled.label.author, `Пользователь ${rawLabel.userId.slice(0, 8)}`);
  });

  test('изменение версии вне выборки пропускается', async () => {
    const { raw, users } = await rawHistoryAll('tcp');
    const last = Math.max(...raw.versions.map((v) => v.verNum));
    const history = buildHistory({ versions: raw.versions.filter((v) => v.verNum === last), changes: raw.changes }, users);
    assert.deepStrictEqual(history.versions.map((v) => v.verNum), [last]);
    const expected = raw.changes.filter((c) => c.verNum === last).map((c) => c.objectId);
    assert.ok(expected.length < raw.changes.length);
    assert.deepStrictEqual(history.versions[0].changes.map((c) => c.objectId).sort(), expected.sort());
  });
});
