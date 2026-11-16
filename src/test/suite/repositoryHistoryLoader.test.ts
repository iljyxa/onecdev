import * as assert from 'assert';
import { CrsCallError } from '../../infra/repository/crs/CrsErrors';
import { devDepotReport } from '../../infra/repository/crs/CrsHistory';
import { depotUsers } from '../../infra/repository/crs/CrsUsers';
import {
  loadMoreRepositoryHistory,
  loadRepositoryHistory,
  type RepositoryHistoryPageRequest,
} from '../../infra/repository/history/RepositoryHistoryLoader';
import { buildHistory, type HistoryVersion, type RepositoryHistory } from '../../infra/repository/history/RepositoryHistoryModel';
import { bodyProbe, corpusExchanges, tcpBodyProbe, tcpRawProbeBodies } from './support/crsFixtures';
import { reportVersions } from './support/crsHistoryReport';
import { assertNoHashes, inputsOf, recordedClient, rejection } from './support/crsMethods';

/**
 * Постраничная загрузка истории хранилища (#117): список номеров (devDepotVersions) → страница отчёта по
 * реальным номерам → пользователи. Байты запросов сверяются с пробами стенда (capture-history-probes),
 * ответы — настоящие тела crserver 8.5.1 по tcp и http.
 */

const AUTH = { user: 'Admin', passwordHash: 'd41d8cd98f00b204e9800998ecf8427e' };
/** uuid Справочник.Контрагенты стенда проб: версии с подчинёнными — 1, 2, 3, 6. */
const CONTRACTORS_ID = '3e33ad69-478f-4f02-bad5-751699f70814';
const UNKNOWN_METHOD = tcpRawProbeBodies('probe-unknown-method').response.body;

function corpusResponse(transport: 'tcp' | 'http', scenario: string, method: string): Buffer {
  const found = corpusExchanges().find((e) => e.transport === transport && e.scenario === scenario && e.method === method);
  assert.ok(found, `${transport}/${scenario}/${method}`);
  return found.response;
}

/** Версии одного ответа отчёта с теми же пользователями — независимо от загрузчика. */
async function versionsOf(report: Buffer, users: Buffer): Promise<readonly HistoryVersion[]> {
  const { client } = recordedClient([report, users]);
  return buildHistory(await devDepotReport(client, AUTH), await depotUsers(client, AUTH, { removed: true })).versions;
}

function assertUsersRequest(body: Buffer): void {
  const inputs = inputsOf(body);
  assert.match(body.toString('utf-8'), /name="UserManager_depotUsers"/);
  assert.strictEqual(inputs.params.get('removed'), 'true');
  assert.strictEqual(inputs.bindId, undefined, 'привязка для чтения пользователей не нужна');
  assert.deepStrictEqual(inputs.auth, AUTH);
}

for (const transport of ['tcp', 'http'] as const) {
  suite(`RepositoryHistoryLoader по ${transport} (#117)`, () => {
    const probe = (name: string): { request: Buffer; response: Buffer } => bodyProbe(transport, name);
    const users = corpusResponse(transport, 'history-all', 'UserManager_depotUsers');
    const LIST_ALL = probe('probe-history-devdepotversions');

    test('без фильтра, pageSize=3: три страницы 5–7, 2–4, 1–1 побайтно как у стенда; затем pending пуст', async () => {
      const pages = ['5-7', '2-4', '1-1'].map((p) => probe(`probe-history-page-${p}`));
      const { client, transport: recorded } = recordedClient([
        LIST_ALL.response, pages[0].response, users, pages[1].response, users, pages[2].response, users,
      ]);
      const first = await loadRepositoryHistory(client, AUTH, {}, { pageSize: 3 });
      assert.deepStrictEqual(first.versions.map((v) => v.verNum), [7, 6, 5]);
      assert.deepStrictEqual(first.pending, [4, 3, 2, 1]);
      const second = await loadMoreRepositoryHistory(client, AUTH, {}, first, { pageSize: 3 });
      assert.deepStrictEqual(second.versions.map((v) => v.verNum), [7, 6, 5, 4, 3, 2]);
      assert.deepStrictEqual(second.pending, [1]);
      const third = await loadMoreRepositoryHistory(client, AUTH, {}, second, { pageSize: 3 });
      assert.deepStrictEqual(third.pending, []);
      const expected = [
        ...(await versionsOf(pages[0].response, users)),
        ...(await versionsOf(pages[1].response, users)),
        ...(await versionsOf(pages[2].response, users)),
      ];
      assert.deepStrictEqual(third.versions, expected);
      const bodies = recorded.requests.map((r) => r.body);
      assert.deepStrictEqual(bodies[0], LIST_ALL.request);
      assert.deepStrictEqual([bodies[1], bodies[3], bodies[5]], pages.map((p) => p.request));
      [bodies[2], bodies[4], bodies[6]].forEach(assertUsersRequest);
      assert.ok(recorded.exhausted);
      // Полная история: догрузка возвращает тот же объект и не ходит на сервер.
      assert.strictEqual(await loadMoreRepositoryHistory(client, AUTH, {}, third, { pageSize: 3 }), third);
      assert.strictEqual(recorded.requests.length, 7);
    });

    test('догрузка без параметров — страница по умолчанию забирает весь остаток (1–1)', async () => {
      const pages = ['5-7', '2-4', '1-1'].map((p) => probe(`probe-history-page-${p}`));
      const { client, transport: recorded } = recordedClient([
        LIST_ALL.response, pages[0].response, users, pages[1].response, users, pages[2].response, users,
      ]);
      const first = await loadRepositoryHistory(client, AUTH, {}, { pageSize: 3 });
      const second = await loadMoreRepositoryHistory(client, AUTH, {}, first, { pageSize: 3 });
      const rest = await loadMoreRepositoryHistory(client, AUTH, {}, second);
      assert.deepStrictEqual(rest.pending, []);
      assert.deepStrictEqual(rest.versions.map((v) => v.verNum), [7, 6, 5, 4, 3, 2, 1]);
      assert.deepStrictEqual(recorded.requests[5].body, pages[2].request);
      assert.ok(recorded.exhausted);
    });

    test('история справочника с подчинёнными, pageSize=2: страницы 3–6 и 1–2 (objRefs, recursive, mask 4/5)', async () => {
      const list = probe('probe-history-devdepotversions-object-catalog-recursive');
      const page36 = probe('probe-history-page-object-catalog-recursive-3-6');
      const page12 = probe('probe-history-page-object-catalog-recursive-1-2');
      const { client, transport: recorded } = recordedClient([list.response, page36.response, users, page12.response, users]);
      const request = { objectId: CONTRACTORS_ID, pageSize: 2 };
      const first = await loadRepositoryHistory(client, AUTH, {}, request);
      assert.deepStrictEqual(first.versions.map((v) => v.verNum), [6, 3]);
      assert.deepStrictEqual(first.pending, [2, 1]);
      const all = await loadMoreRepositoryHistory(client, AUTH, {}, first, request);
      assert.deepStrictEqual(all.versions.map((v) => v.verNum), [6, 3, 2, 1]);
      assert.deepStrictEqual(all.pending, []);
      const bodies = recorded.requests.map((r) => r.body);
      assert.deepStrictEqual([bodies[0], bodies[1], bodies[3]], [list.request, page36.request, page12.request]);
      assert.strictEqual(inputsOf(bodies[0]).params.get('mask'), '4');
      assert.strictEqual(inputsOf(bodies[1]).params.get('mask'), '5');
      assert.deepStrictEqual(inputsOf(bodies[1]).objRefs, [CONTRACTORS_ID]);
      assert.strictEqual(inputsOf(bodies[1]).params.get('recursive'), 'true');
    });

    test('история справочника, pageSize=100 — одна страница 1–6', async () => {
      const list = probe('probe-history-devdepotversions-object-catalog-recursive');
      const page = probe('probe-history-page-object-catalog-recursive-1-6');
      const { client, transport: recorded } = recordedClient([list.response, page.response, users]);
      const history = await loadRepositoryHistory(client, AUTH, {}, { objectId: CONTRACTORS_ID });
      assert.deepStrictEqual(history.pending, []);
      assert.deepStrictEqual(history.versions, await versionsOf(page.response, users));
      assert.deepStrictEqual(recorded.requests[1].body, page.request);
    });

    test('корень с подчинёнными, pageSize=3 — страница 5–7', async () => {
      const list = probe('probe-history-devdepotversions-object-root-recursive');
      const page = probe('probe-history-page-object-root-recursive-5-7');
      const rootId = inputsOf(list.request).objRefs[0];
      const { client, transport: recorded } = recordedClient([list.response, page.response, users]);
      const history = await loadRepositoryHistory(client, AUTH, {}, { objectId: rootId, pageSize: 3 });
      assert.deepStrictEqual(history.versions.map((v) => v.verNum), [7, 6, 5]);
      assert.deepStrictEqual(history.pending, [4, 3, 2, 1]);
      assert.deepStrictEqual(recorded.requests.map((r) => r.body).slice(0, 2), [list.request, page.request]);
    });

    test('beforeVersion=5, pageSize=3 — версии 2–4, pending [1]', async () => {
      const page = probe('probe-history-page-2-4');
      const { client, transport: recorded } = recordedClient([LIST_ALL.response, page.response, users]);
      const history = await loadRepositoryHistory(client, AUTH, {}, { pageSize: 3, beforeVersion: 5 });
      assert.deepStrictEqual(history.versions.map((v) => v.verNum), [4, 3, 2]);
      assert.deepStrictEqual(history.pending, [1]);
      assert.deepStrictEqual(recorded.requests[1].body, page.request);
    });

    test('пустой список версий объекта — один вызов, пустая история', async () => {
      const list = probe('probe-history-devdepotversions-object-unknown');
      const { client, transport: recorded } = recordedClient([list.response]);
      const history = await loadRepositoryHistory(client, AUTH, {}, { objectId: inputsOf(list.request).objRefs[0] });
      assert.deepStrictEqual(history, { versions: [], pending: [] });
      assert.strictEqual(recorded.requests.length, 1);
      assert.deepStrictEqual(recorded.requests[0].body, list.request);
    });

    test('сервер без devDepotVersions (unknown-method) — один отчёт целиком и пользователи', async () => {
      const report = corpusResponse(transport, 'history-all', 'DevDepot_devDepotReport');
      const { client, transport: recorded } = recordedClient([UNKNOWN_METHOD, report, users]);
      const history = await loadRepositoryHistory(client, AUTH, {}, { pageSize: 2 });
      const expected = reportVersions(transport, 'history-all');
      assert.strictEqual(history.versions.length, 6);
      assert.deepStrictEqual(history.pending, []);
      assert.deepStrictEqual(history.versions.map((v) => v.author), [...expected].sort((a, b) => b.verNum - a.verNum).map((v) => v.user));
      assert.deepStrictEqual(recorded.requests[1].body, tcpBodyProbe('probe-history-filter-none').request);
      assertUsersRequest(recorded.requests[2].body);
    });

    test('unknown-method с beforeVersion — отчёт по endVerNum = beforeVersion − 1', async () => {
      const report = corpusResponse(transport, 'history-all', 'DevDepot_devDepotReport');
      const { client, transport: recorded } = recordedClient([UNKNOWN_METHOD, report, users]);
      await loadRepositoryHistory(client, AUTH, {}, { objectId: CONTRACTORS_ID, beforeVersion: 5 });
      const inputs = inputsOf(recorded.requests[1].body);
      assert.strictEqual(inputs.params.get('endVerNum'), '4');
      assert.strictEqual(inputs.params.get('beginVerNum'), '-1');
      assert.deepStrictEqual(inputs.objRefs, [CONTRACTORS_ID]);
      assert.strictEqual(inputs.params.get('recursive'), 'true');
    });
  });
}

suite('RepositoryHistoryLoader — проверки входа и отказы (#117)', () => {
  const invalid: readonly [string, RepositoryHistoryPageRequest][] = [
    ['pageSize=0', { pageSize: 0 }],
    ['pageSize=1.5', { pageSize: 1.5 }],
    ['pageSize=NaN', { pageSize: Number.NaN }],
    ['beforeVersion=1', { beforeVersion: 1 }],
    ['beforeVersion=2.5', { beforeVersion: 2.5 }],
  ];
  for (const [name, request] of invalid) {
    test(`${name} — RangeError до транспорта`, async () => {
      const { client, transport } = recordedClient([]);
      const error = await rejection(loadRepositoryHistory(client, AUTH, {}, request));
      assert.ok(error instanceof RangeError, String(error));
      assert.strictEqual(transport.requests.length, 0);
    });
  }

  test('догрузка с неверным pageSize — RangeError до транспорта', async () => {
    const { client, transport } = recordedClient([]);
    const history: RepositoryHistory = { versions: [], pending: [3, 2, 1] };
    const error = await rejection(loadMoreRepositoryHistory(client, AUTH, {}, history, { pageSize: 0 }));
    assert.ok(error instanceof RangeError, String(error));
    assert.strictEqual(transport.requests.length, 0);
  });

  test('неверный пароль — auth-failed без хеша в ошибке', async () => {
    const wrong = tcpBodyProbe('probe-history-wrong-password');
    const { client } = recordedClient([wrong.response]);
    const error = await rejection(loadRepositoryHistory(client, AUTH, {}));
    assert.ok(error instanceof CrsCallError && error.kind === 'auth-failed', String(error));
    assertNoHashes(error, wrong.request, wrong.response);
  });

  test('CrsCallOptions доходят до транспорта в каждом вызове', async () => {
    const list = tcpBodyProbe('probe-history-devdepotversions');
    const page = tcpBodyProbe('probe-history-page-5-7');
    const users = tcpBodyProbe('probe-depot-users-no-bind').response;
    const { client, transport } = recordedClient([list.response, page.response, users]);
    const signal = new AbortController().signal;
    const options = { timeoutMs: 1234, maxResponseBytes: 5678, signal };
    await loadRepositoryHistory(client, AUTH, options, { pageSize: 3 });
    assert.strictEqual(transport.requests.length, 3);
    for (const request of transport.requests) {
      assert.deepStrictEqual(request.options, options);
    }
  });
});
