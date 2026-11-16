import * as assert from 'assert';
import { parseCrsAddress, type CrsAddress } from '../../infra/repository/crs/CrsAddress';
import { CrsClient } from '../../infra/repository/crs/CrsClient';
import type { CrsConnectOptions } from '../../infra/repository/crs/CrsConnect';
import { devDepotReport } from '../../infra/repository/crs/CrsHistory';
import { CrsTransportError } from '../../infra/repository/crs/CrsTransport';
import { depotUsers } from '../../infra/repository/crs/CrsUsers';
import {
  HISTORY_CALL_TIMEOUT_MS,
  HISTORY_MAX_RESPONSE_BYTES,
} from '../../infra/repository/history/RepositoryHistoryLoader';
import { buildHistory, type HistoryVersion } from '../../infra/repository/history/RepositoryHistoryModel';
import {
  RepositoryHistoryService,
  type RepositoryHistoryScope,
  type RepositoryHistoryState,
} from '../../infra/repository/history/RepositoryHistoryService';
import type { RepositoryHistorySession, RepositoryHistorySessionResolution } from '../../infra/repository/history/RepositoryHistorySession';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import { bodyProbe, tcpBodyProbe, tcpRawProbeBodies } from './support/crsFixtures';
import { GatedTransport } from './support/crsGatedTransport';
import { assertNoHashes, inputsOf, recordedClient, STAND_VERSION } from './support/crsMethods';
import { startHttpReplayServer } from './support/repositoryLockFixtures';

/**
 * Сервис истории хранилища (#117): область, поколения загрузок, отмена, устаревшие данные, повтор по
 * версии сервера и запрос без состояния для MCP. Ответы — настоящие тела crserver 8.5.1 (пробы стенда
 * capture-history-probes); транспорт задерживает их выдачу, чтобы проверять операции «в полёте» без таймингов.
 */

const AUTH = { user: 'Admin', passwordHash: 'd41d8cd98f00b204e9800998ecf8427e' };
const ENDPOINT = { endpoint: 'tcp://127.0.0.1:1542' };
/** uuid Справочник.Контрагенты стенда проб: версии с подчинёнными — 1, 2, 3, 6. */
const CONTRACTORS_ID = '3e33ad69-478f-4f02-bad5-751699f70814';

const LIST_ALL = tcpBodyProbe('probe-history-devdepotversions');
const LIST_CATALOG = tcpBodyProbe('probe-history-devdepotversions-object-catalog-recursive');
const LIST_UNKNOWN = tcpBodyProbe('probe-history-devdepotversions-object-unknown');
const PAGE_5_7 = tcpBodyProbe('probe-history-page-5-7');
const PAGE_2_4 = tcpBodyProbe('probe-history-page-2-4');
const CATALOG_3_6 = tcpBodyProbe('probe-history-page-object-catalog-recursive-3-6');
const USERS = tcpBodyProbe('probe-depot-users-no-bind').response;
const VERSION_OTHER = tcpRawProbeBodies('probe-version-other').response.body;
const STALE_HINT = '8.3.0.0';

const TARGET: RepositoryTarget = { configRoot: '/проект/src/cf', configKind: 'cf', displayName: 'Торговый учёт' };
const OTHER_TARGET: RepositoryTarget = { configRoot: '/проект/src/cfe/EVOLC', configKind: 'cfe', extensionName: 'EVOLC', displayName: 'EVOLC' };
const ROOT_SCOPE: RepositoryHistoryScope = { target: TARGET };
const CATALOG_SCOPE: RepositoryHistoryScope = { target: TARGET, filter: { objectId: CONTRACTORS_ID, title: 'Catalog.Контрагенты' } };

function sessionOf(overrides: Partial<RepositoryHistorySession> = {}): RepositoryHistorySession {
  return {
    key: `${TARGET.configRoot}|tcp://127.0.0.1:1542/exp|Admin`,
    target: TARGET,
    address: parseCrsAddress('tcp://127.0.0.1:1542/exp'),
    auth: AUTH,
    versionHint: STAND_VERSION,
    ...overrides,
  };
}

const SESSION: RepositoryHistorySessionResolution = { kind: 'session', session: sessionOf() };

async function versionsOf(...reports: Buffer[]): Promise<HistoryVersion[]> {
  const result: HistoryVersion[] = [];
  for (const report of reports) {
    const { client } = recordedClient([report, USERS]);
    result.push(...buildHistory(await devDepotReport(client, AUTH), await depotUsers(client, AUTH, { removed: true })).versions);
  }
  return result;
}

interface HarnessOptions {
  readonly resolve?: (target: RepositoryTarget) => Promise<RepositoryHistorySessionResolution>;
  readonly honorAbort?: boolean;
  readonly pageSize?: number;
}

class Harness {
  readonly transports: GatedTransport[] = [];
  readonly clients: { address: CrsAddress; options: CrsConnectOptions }[] = [];
  readonly resolved: RepositoryTarget[] = [];
  readonly errors: unknown[] = [];
  readonly states: RepositoryHistoryState['kind'][] = [];
  readonly service: RepositoryHistoryService;
  resolution: RepositoryHistorySessionResolution = SESSION;
  private readonly clientWaiters: { count: number; resolve: () => void }[] = [];

  constructor(options: HarnessOptions = {}) {
    this.service = new RepositoryHistoryService({
      resolveSession: (target) => {
        this.resolved.push(target);
        return options.resolve ? options.resolve(target) : Promise.resolve(this.resolution);
      },
      createClient: (address, connect) => {
        this.clients.push({ address, options: connect });
        const transport = new GatedTransport(options.honorAbort ?? true);
        this.transports.push(transport);
        for (const waiter of this.clientWaiters.filter((w) => w.count <= this.transports.length)) {
          waiter.resolve();
        }
        return new CrsClient(transport, { alias: address.alias, version: connect.version });
      },
      onError: (e) => this.errors.push(e),
      pageSize: options.pageSize ?? 3,
    });
    this.service.onDidChange(() => this.states.push(this.service.view.state.kind));
  }

  /** Транспорт n-го клиента (с 1), когда сервис его создаст. */
  async client(n: number): Promise<GatedTransport> {
    if (this.transports.length < n) {
      await new Promise<void>((resolve) => this.clientWaiters.push({ count: n, resolve }));
    }
    return this.transports[n - 1];
  }

  /** Отвечает на запросы n-го клиента по порядку: каждый ответ — после прихода своего запроса. */
  async serve(n: number, ...bodies: Buffer[]): Promise<GatedTransport> {
    const transport = await this.client(n);
    for (const [i, body] of bodies.entries()) {
      await transport.whenRequests(i + 1);
      transport.release(i, body);
    }
    return transport;
  }

  async fail(n: number, index: number, error: Error): Promise<void> {
    const transport = await this.client(n);
    await transport.whenRequests(index + 1);
    transport.fail(index, error);
  }

  get state(): RepositoryHistoryState {
    return this.service.view.state;
  }

  /** Готовая первая страница без фильтра: версии 7, 6, 5. */
  async loadFirstPage(scope: RepositoryHistoryScope = ROOT_SCOPE): Promise<void> {
    this.service.setScope(scope);
    const refreshing = this.service.refresh();
    await this.serve(this.transports.length + 1, LIST_ALL.response, PAGE_5_7.response, USERS);
    await refreshing;
    assert.strictEqual(this.state.kind, 'ready');
  }
}

function readyHistory(state: RepositoryHistoryState): { versions: readonly HistoryVersion[]; pending: readonly number[] } {
  assert.strictEqual(state.kind, 'ready', JSON.stringify(state));
  return state.history;
}

/** Вид состояния без сужения типа: геттер меняется между проверками. */
const kindOf = (h: Harness): string => h.state.kind;

const unavailable = (): CrsTransportError => new CrsTransportError('unavailable', 'tcp://127.0.0.1:1542: соединение отклонено', ENDPOINT);

suite('RepositoryHistoryService (#117)', () => {
  test('без области — no-scope; область — idle; загрузка: loading → ready с первой страницей', async () => {
    const h = new Harness();
    assert.deepStrictEqual(h.service.view, { state: { kind: 'no-scope' } });
    h.service.setScope(ROOT_SCOPE);
    assert.deepStrictEqual(h.service.view, { state: { kind: 'idle' }, scope: ROOT_SCOPE });
    const refreshing = h.service.refresh();
    assert.deepStrictEqual(h.state, { kind: 'loading' });
    const transport = await h.serve(1, LIST_ALL.response, PAGE_5_7.response, USERS);
    await refreshing;
    const history = readyHistory(h.state);
    assert.deepStrictEqual(history.versions, await versionsOf(PAGE_5_7.response));
    assert.deepStrictEqual(history.pending, [4, 3, 2, 1]);
    assert.strictEqual(h.service.view.visible, history);
    assert.deepStrictEqual(h.states, ['idle', 'loading', 'ready']);
    assert.deepStrictEqual(h.resolved, [TARGET]);
    // Лимиты истории — и у фабрики клиента, и в каждом вызове вместе с сигналом отмены.
    assert.deepStrictEqual(h.clients[0].options, { timeoutMs: HISTORY_CALL_TIMEOUT_MS, maxResponseBytes: HISTORY_MAX_RESPONSE_BYTES, version: STAND_VERSION });
    assert.strictEqual(HISTORY_CALL_TIMEOUT_MS, 120_000);
    assert.strictEqual(HISTORY_MAX_RESPONSE_BYTES, 128 * 1024 * 1024);
    for (const options of transport.options) {
      assert.strictEqual(options?.timeoutMs, HISTORY_CALL_TIMEOUT_MS);
      assert.strictEqual(options.maxResponseBytes, HISTORY_MAX_RESPONSE_BYTES);
      assert.ok(options.signal instanceof AbortSignal);
    }
    assert.deepStrictEqual(transport.requests.slice(0, 2), [LIST_ALL.request, PAGE_5_7.request]);
    assert.deepStrictEqual(h.errors, []);
  });

  test('без области refresh/loadMore/ensureLoaded ничего не делают', async () => {
    const h = new Harness();
    await h.service.refresh();
    await h.service.loadMore();
    await h.service.ensureLoaded();
    assert.deepStrictEqual(h.resolved, []);
    assert.strictEqual(kindOf(h), 'no-scope');
  });

  const terminal: readonly ['disconnected' | 'file-repository'][] = [['disconnected'], ['file-repository']];
  for (const [kind] of terminal) {
    test(`${kind}: состояние без сетевых вызовов`, async () => {
      const h = new Harness();
      h.resolution = { kind };
      h.service.setScope(ROOT_SCOPE);
      await h.service.refresh();
      assert.deepStrictEqual(h.state, { kind });
      assert.strictEqual(h.clients.length, 0);
    });
  }

  test('отказ разрешения сессии и исключение резолвера — failed без исключения наружу', async () => {
    const h = new Harness();
    h.resolution = { kind: 'failed', failure: { code: 'invalid-address', message: 'Неверный адрес.' } };
    h.service.setScope(ROOT_SCOPE);
    await h.service.refresh();
    assert.deepStrictEqual(h.state, { kind: 'failed', failure: { code: 'invalid-address', message: 'Неверный адрес.' } });
    const throwing = new Harness({ resolve: () => Promise.reject(new Error('SecretStorage недоступен')) });
    throwing.service.setScope(ROOT_SCOPE);
    await throwing.service.refresh();
    assert.strictEqual(throwing.state.kind, 'failed');
    assert.strictEqual(throwing.clients.length, 0);
  });

  test('повторный refresh и loadMore во время своей операции — тот же промис, второго клиента нет', async () => {
    const h = new Harness();
    h.service.setScope(ROOT_SCOPE);
    const first = h.service.refresh();
    assert.strictEqual(h.service.refresh(), first);
    assert.strictEqual(h.service.ensureLoaded(), first);
    await h.serve(1, LIST_ALL.response, PAGE_5_7.response, USERS);
    await first;
    const more = h.service.loadMore();
    assert.strictEqual(h.service.loadMore(), more);
    assert.deepStrictEqual(h.state, { kind: 'ready', history: readyHistory(h.state), more: { kind: 'loading' } });
    const transport = await h.serve(2, PAGE_2_4.response, USERS);
    await more;
    assert.deepStrictEqual(readyHistory(h.state).versions.map((v) => v.verNum), [7, 6, 5, 4, 3, 2]);
    assert.deepStrictEqual(readyHistory(h.state).pending, [1]);
    assert.strictEqual(h.state.kind === 'ready' ? h.state.more : 'нет', undefined);
    assert.deepStrictEqual(transport.requests[0], PAGE_2_4.request);
    assert.strictEqual(h.clients.length, 2);
    assert.deepStrictEqual(h.resolved, [TARGET], 'догрузка не разрешает сессию заново');
  });

  test('ensureLoaded: idle и failed без stale — загрузка; ready и failed со stale — без вызова', async () => {
    const h = new Harness();
    h.service.setScope(ROOT_SCOPE);
    const loading = h.service.ensureLoaded();
    await h.fail(1, 0, unavailable());
    await loading;
    assert.strictEqual(kindOf(h), 'failed');
    const retry = h.service.ensureLoaded();
    await h.serve(2, LIST_ALL.response, PAGE_5_7.response, USERS);
    await retry;
    assert.strictEqual(kindOf(h), 'ready');
    await h.service.ensureLoaded();
    assert.strictEqual(h.clients.length, 2);
    const failing = h.service.refresh();
    await h.fail(3, 0, unavailable());
    await failing;
    assert.strictEqual(kindOf(h), 'failed');
    await h.service.ensureLoaded();
    assert.strictEqual(h.clients.length, 3, 'устаревшие данные есть — без перезапроса');
  });

  test('ensureLoaded после disconnected/file-repository разрешает сессию заново', async () => {
    const h = new Harness();
    h.resolution = { kind: 'disconnected' };
    h.service.setScope(ROOT_SCOPE);
    await h.service.ensureLoaded();
    assert.strictEqual(kindOf(h), 'disconnected');
    h.resolution = SESSION;
    const loading = h.service.ensureLoaded();
    await h.serve(1, LIST_ALL.response, PAGE_5_7.response, USERS);
    await loading;
    assert.strictEqual(kindOf(h), 'ready');
    assert.strictEqual(h.resolved.length, 2);
  });

  test('смена области во время загрузки отменяет её, поздний ответ не перезаписывает состояние', async () => {
    const h = new Harness({ honorAbort: false });
    h.service.setScope(ROOT_SCOPE);
    const loading = h.service.refresh();
    const transport = await h.client(1);
    await transport.whenRequests(1);
    h.service.setScope(CATALOG_SCOPE);
    assert.ok(transport.options[0]?.signal?.aborted, 'сигнал не отменён');
    assert.deepStrictEqual(h.state, { kind: 'idle' });
    await h.serve(1, LIST_ALL.response, PAGE_5_7.response, USERS);
    await loading;
    assert.deepStrictEqual(h.service.view, { state: { kind: 'idle' }, scope: CATALOG_SCOPE, filter: CATALOG_SCOPE.filter });
  });

  test('смена области во время разрешения сессии — клиент не создаётся, состояние новой области', async () => {
    let release: (resolution: RepositoryHistorySessionResolution) => void = () => assert.fail('резолвер не вызван');
    const h = new Harness({ resolve: () => new Promise((resolve) => { release = resolve; }) });
    h.service.setScope(ROOT_SCOPE);
    const loading = h.service.refresh();
    h.service.setScope(CATALOG_SCOPE);
    release(SESSION);
    await loading;
    assert.deepStrictEqual(h.state, { kind: 'idle' });
    assert.strictEqual(h.clients.length, 0);
  });

  test('другая цель с тем же objectId — тоже новая область', async () => {
    const h = new Harness();
    await h.loadFirstPage();
    h.service.setScope({ target: OTHER_TARGET });
    assert.deepStrictEqual(h.state, { kind: 'idle' });
    h.service.setScope(undefined);
    assert.deepStrictEqual(h.service.view, { state: { kind: 'no-scope' } });
  });

  test('та же область с новым заголовком — только заголовок, загрузка не отменяется', async () => {
    const h = new Harness();
    h.service.setScope(CATALOG_SCOPE);
    const loading = h.service.refresh();
    const transport = await h.client(1);
    await transport.whenRequests(1);
    const renamed = { target: TARGET, filter: { objectId: CONTRACTORS_ID, title: 'Справочник.Контрагенты (выгрузка)' } };
    h.service.setScope(renamed);
    assert.ok(!transport.options[0]?.signal?.aborted);
    assert.deepStrictEqual(h.service.view, { state: { kind: 'loading' }, scope: renamed, filter: renamed.filter });
    await h.serve(1, LIST_UNKNOWN.response);
    await loading;
    // В пустой истории заголовка объекта нет — остаётся заголовок области.
    assert.deepStrictEqual(h.service.view.filter, renamed.filter);
    assert.deepStrictEqual(readyHistory(h.state), { versions: [], pending: [] });
  });

  test('заголовок фильтра заменяется заголовком из истории', async () => {
    const h = new Harness({ pageSize: 2 });
    h.service.setScope(CATALOG_SCOPE);
    const loading = h.service.refresh();
    const transport = await h.serve(1, LIST_CATALOG.response, CATALOG_3_6.response, USERS);
    await loading;
    assert.deepStrictEqual(h.service.view.filter, { objectId: CONTRACTORS_ID, title: 'Справочник.Контрагенты' });
    assert.deepStrictEqual(transport.requests.slice(0, 2), [LIST_CATALOG.request, CATALOG_3_6.request]);
    assert.deepStrictEqual(inputsOf(transport.requests[0]).objRefs, [CONTRACTORS_ID]);
  });

  test('refresh во время loadMore отменяет догрузку и начинает с первой страницы', async () => {
    const h = new Harness({ honorAbort: false });
    await h.loadFirstPage();
    const more = h.service.loadMore();
    const moreTransport = await h.client(2);
    await moreTransport.whenRequests(1);
    const refreshing = h.service.refresh();
    assert.ok(moreTransport.options[0]?.signal?.aborted, 'догрузка не отменена');
    assert.strictEqual(kindOf(h), 'loading');
    await h.serve(2, PAGE_2_4.response, USERS);
    await more;
    assert.strictEqual(kindOf(h), 'loading', 'поздняя догрузка перезаписала состояние');
    await h.serve(3, LIST_ALL.response, PAGE_5_7.response, USERS);
    await refreshing;
    assert.deepStrictEqual(readyHistory(h.state).versions.map((v) => v.verNum), [7, 6, 5]);
  });

  test('dispose во время загрузки: сигнал отменён, поздний ответ и операции после — без эффекта', async () => {
    const h = new Harness({ honorAbort: false });
    h.service.setScope(ROOT_SCOPE);
    const loading = h.service.refresh();
    const transport = await h.client(1);
    await transport.whenRequests(1);
    const before = h.states.length;
    h.service.dispose();
    assert.ok(transport.options[0]?.signal?.aborted);
    await h.serve(1, LIST_ALL.response, PAGE_5_7.response, USERS);
    await loading;
    h.service.setScope(CATALOG_SCOPE);
    await h.service.refresh();
    await h.service.loadMore();
    assert.strictEqual(h.states.length, before, 'после dispose были уведомления');
    assert.strictEqual(h.clients.length, 1);
  });

  test('сбой refresh поверх готовой истории — failed со stale, видна прежняя история', async () => {
    const h = new Harness();
    await h.loadFirstPage();
    const previous = readyHistory(h.state);
    const refreshing = h.service.refresh();
    assert.deepStrictEqual(h.state, { kind: 'loading', stale: previous });
    assert.strictEqual(h.service.view.visible, previous);
    await h.fail(2, 0, unavailable());
    await refreshing;
    assert.strictEqual(kindOf(h), 'failed');
    assert.strictEqual(h.state.kind === 'failed' ? h.state.stale : undefined, previous);
    assert.strictEqual(h.state.kind === 'failed' ? h.state.failure.code : undefined, 'unavailable');
    assert.strictEqual(h.service.view.visible, previous);
  });

  test('сбой loadMore — ready с more.failed, версии остаются; повтор догрузки дописывает страницу', async () => {
    const h = new Harness();
    await h.loadFirstPage();
    const history = readyHistory(h.state);
    const more = h.service.loadMore();
    await h.fail(2, 0, unavailable());
    await more;
    assert.strictEqual(kindOf(h), 'ready');
    assert.strictEqual(h.state.kind === 'ready' ? h.state.history : undefined, history);
    assert.strictEqual(h.state.kind === 'ready' ? h.state.more?.kind : undefined, 'failed');
    const retry = h.service.loadMore();
    await h.serve(3, PAGE_2_4.response, USERS);
    await retry;
    assert.deepStrictEqual(readyHistory(h.state).versions.map((v) => v.verNum), [7, 6, 5, 4, 3, 2]);
  });

  test('loadMore без готовой истории или без pending — без вызовов', async () => {
    const h = new Harness({ pageSize: 100 });
    h.service.setScope(ROOT_SCOPE);
    await h.service.loadMore();
    assert.strictEqual(h.clients.length, 0);
    const loading = h.service.refresh();
    await h.serve(1, LIST_ALL.response, tcpBodyProbe('probe-history-page-1-7').response, USERS);
    await loading;
    assert.deepStrictEqual(readyHistory(h.state).pending, []);
    await h.service.loadMore();
    assert.strictEqual(h.clients.length, 1);
  });

  test('устаревшая подсказка версии — один повтор, найденная версия запоминается для догрузки', async () => {
    const h = new Harness();
    h.resolution = { kind: 'session', session: sessionOf({ versionHint: STALE_HINT }) };
    h.service.setScope(ROOT_SCOPE);
    const loading = h.service.refresh();
    await h.serve(1, VERSION_OTHER);
    await h.serve(2, LIST_ALL.response, PAGE_5_7.response, USERS);
    await loading;
    assert.strictEqual(kindOf(h), 'ready');
    assert.deepStrictEqual(h.clients.map((c) => c.options.version), [STALE_HINT, STAND_VERSION]);
    const more = h.service.loadMore();
    await h.serve(3, PAGE_2_4.response, USERS);
    await more;
    assert.strictEqual(h.clients[2].options.version, STAND_VERSION);
    // Обновление той же сессии тоже идёт сразу с найденной версией.
    const again = h.service.refresh();
    await h.serve(4, LIST_ALL.response, PAGE_5_7.response, USERS);
    await again;
    assert.strictEqual(h.clients[3].options.version, STAND_VERSION);
  });

  test('повторный отказ по версии — failed с упоминанием версии повтора', async () => {
    const h = new Harness();
    h.resolution = { kind: 'session', session: sessionOf({ versionHint: STALE_HINT }) };
    h.service.setScope(ROOT_SCOPE);
    const loading = h.service.refresh();
    await h.serve(1, VERSION_OTHER);
    await h.serve(2, VERSION_OTHER);
    await loading;
    assert.strictEqual(kindOf(h), 'failed');
    const failure = h.state.kind === 'failed' ? h.state.failure : undefined;
    assert.strictEqual(failure?.code, 'version-mismatch');
    assert.ok(failure, 'нет отказа');
    assert.ok(failure.message.includes(`повтор с версией сервера ${STAND_VERSION} не помог`), failure.message);
  });

  test('без подсказки версии клиент создаётся без версии (рукопожатие)', async () => {
    const h = new Harness();
    h.resolution = { kind: 'session', session: sessionOf({ versionHint: undefined }) };
    h.service.setScope(ROOT_SCOPE);
    const loading = h.service.refresh();
    const transport = await h.client(1);
    await transport.whenRequests(1);
    assert.deepStrictEqual(h.clients[0].options, { timeoutMs: HISTORY_CALL_TIMEOUT_MS, maxResponseBytes: HISTORY_MAX_RESPONSE_BYTES });
    transport.fail(0, unavailable());
    await loading;
    assert.strictEqual(kindOf(h), 'failed');
  });

  const sessionChanges: readonly [string, RepositoryHistorySession][] = [
    ['другой пользователь', sessionOf({ key: `${TARGET.configRoot}|tcp://127.0.0.1:1542/exp|Petrov`, auth: { user: 'Petrov', passwordHash: AUTH.passwordHash } })],
    ['другой пароль', sessionOf({ auth: { user: 'Admin', passwordHash: '5fa285e1bebe0a6623e33afc04a1fbd5' } })],
  ];
  for (const [name, changed] of sessionChanges) {
    test(`${name} — устаревшие данные прежней сессии сбрасываются`, async () => {
      const h = new Harness();
      await h.loadFirstPage();
      h.resolution = { kind: 'session', session: changed };
      const refreshing = h.service.refresh();
      const transport = await h.client(2);
      await transport.whenRequests(1);
      assert.deepStrictEqual(h.state, { kind: 'loading' });
      assert.strictEqual(h.service.view.visible, undefined);
      transport.fail(0, unavailable());
      await refreshing;
      assert.strictEqual(kindOf(h), 'failed');
      assert.strictEqual(h.state.kind === 'failed' ? h.state.stale : 'есть', undefined);
    });
  }

  test('исключение слушателя уходит в onError, остальные слушатели вызываются; отписка работает', () => {
    const h = new Harness();
    const thrown = new Error('слушатель упал');
    const calls: string[] = [];
    const failing = h.service.onDidChange(() => {
      throw thrown;
    });
    const second = h.service.onDidChange(() => calls.push(h.service.view.state.kind));
    h.service.setScope(ROOT_SCOPE);
    assert.deepStrictEqual(h.errors, [thrown]);
    assert.deepStrictEqual(calls, ['idle']);
    failing.dispose();
    second.dispose();
    h.service.setScope(undefined);
    assert.deepStrictEqual(h.errors, [thrown]);
    assert.deepStrictEqual(calls, ['idle']);
  });
});

suite('RepositoryHistoryService.query — запрос без состояния для MCP (#117)', () => {
  test('страница по beforeVersion, view не меняется', async () => {
    const h = new Harness();
    h.service.setScope(ROOT_SCOPE);
    const querying = h.service.query({ target: TARGET, pageSize: 3, beforeVersion: 5 });
    const transport = await h.serve(1, LIST_ALL.response, PAGE_2_4.response, USERS);
    const result = await querying;
    assert.strictEqual(result.kind, 'ok');
    assert.deepStrictEqual(result.history.pending, [1]);
    assert.deepStrictEqual(transport.requests[1], PAGE_2_4.request);
    assert.deepStrictEqual(h.states, ['idle']);
    assert.deepStrictEqual(h.service.view, { state: { kind: 'idle' }, scope: ROOT_SCOPE });
  });

  test('история объекта: objRefs, recursive; размер страницы по умолчанию — из сервиса', async () => {
    const h = new Harness({ pageSize: 2 });
    const querying = h.service.query({ target: TARGET, objectId: CONTRACTORS_ID });
    const transport = await h.serve(1, LIST_CATALOG.response, CATALOG_3_6.response, USERS);
    const result = await querying;
    assert.deepStrictEqual(result.kind === 'ok' ? result.history.pending : undefined, [2, 1]);
    assert.deepStrictEqual(transport.requests[1], CATALOG_3_6.request);
  });

  const mapped: readonly RepositoryHistorySessionResolution[] = [
    { kind: 'disconnected' },
    { kind: 'file-repository' },
    { kind: 'failed', failure: { code: 'invalid-address', message: 'Неверный адрес.' } },
  ];
  for (const resolution of mapped) {
    test(`разрешение ${resolution.kind} — тот же результат без сетевых вызовов`, async () => {
      const h = new Harness();
      h.resolution = resolution;
      assert.deepStrictEqual(await h.service.query({ target: TARGET }), resolution);
      assert.strictEqual(h.clients.length, 0);
    });
  }

  test('исключение резолвера и отказ сервера — failed; повтор по версии упомянут; без хешей', async () => {
    const throwing = new Harness({ resolve: () => Promise.reject(new Error('SecretStorage недоступен')) });
    assert.strictEqual((await throwing.service.query({ target: TARGET })).kind, 'failed');
    const h = new Harness();
    h.resolution = { kind: 'session', session: sessionOf({ versionHint: STALE_HINT }) };
    const querying = h.service.query({ target: TARGET });
    await h.serve(1, VERSION_OTHER);
    await h.serve(2, VERSION_OTHER);
    const result = await querying;
    assert.strictEqual(result.kind, 'failed');
    assert.ok(result.failure.message.includes(STAND_VERSION), JSON.stringify(result));
    const wrong = tcpBodyProbe('probe-history-wrong-password');
    const denied = new Harness();
    const deniedQuery = denied.service.query({ target: TARGET });
    await denied.serve(1, wrong.response);
    const deniedResult = await deniedQuery;
    assert.strictEqual(deniedResult.kind === 'failed' ? deniedResult.failure.code : undefined, 'auth-failed');
    assertNoHashes(deniedResult, wrong.request, wrong.response);
  });

  test('неверные pageSize/beforeVersion — RangeError до разрешения сессии', async () => {
    const h = new Harness();
    for (const request of [{ target: TARGET, pageSize: 0 }, { target: TARGET, beforeVersion: 1 }]) {
      const error = await h.service.query(request).then(() => assert.fail('ожидался отказ'), (e: unknown) => e);
      assert.ok(error instanceof RangeError, String(error));
    }
    assert.deepStrictEqual(h.resolved, []);
  });
});

suite('RepositoryHistoryService по http без подмены клиента (#117)', () => {
  test('фабрика клиента по умолчанию: настоящий http-транспорт до loopback-публикации', async () => {
    const probe = (name: string): { request: Buffer; response: Buffer } => bodyProbe('http', name);
    const list = probe('probe-history-devdepotversions');
    const page = probe('probe-history-page-5-7');
    const bodies = [list.response, page.response, USERS];
    const server = await startHttpReplayServer((_request, index) => ({ status: 200, body: bodies[index] }));
    try {
      const session = sessionOf({ address: parseCrsAddress(`http://127.0.0.1:${String(server.port)}/repo/repo.1ccr/exp`) });
      const service = new RepositoryHistoryService({
        resolveSession: () => Promise.resolve({ kind: 'session', session }),
        pageSize: 3,
        onError: (e) => assert.fail(String(e)),
      });
      service.setScope(ROOT_SCOPE);
      await service.refresh();
      assert.deepStrictEqual(readyHistory(service.view.state).versions.map((v) => v.verNum), [7, 6, 5]);
      assert.deepStrictEqual(server.received.map((r) => r.body).slice(0, 2), [list.request, page.request]);
      assert.ok(server.received.every((r) => r.url === '/repo/repo.1ccr'));
      service.dispose();
    } finally {
      await server.close();
    }
  });
});
