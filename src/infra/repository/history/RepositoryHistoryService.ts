// История хранилища для панели и MCP: загрузка по требованию (команда или показ панели), без таймера.
// Постранично: сначала последние pageSize версий, более ранние — по запросу (loadMore). Одна операция за
// раз; смена области отменяет загрузку и догрузку, а запоздалый результат прошлого поколения
// отбрасывается, даже если транспорт отмену не учёл. Каждый refresh заново разрешает сессию: привязку и
// пароль могли сменить между загрузками. Только чтение — ни записи файлов проекта, ни захвата операций.
import type { CrsAddress } from '../crs/CrsAddress';
import type { CrsClient } from '../crs/CrsClient';
import { createCrsClient, type CrsConnectOptions } from '../crs/CrsConnect';
import type { CrsCallOptions } from '../crs/CrsTransport';
import { runWithServerVersionRetry } from '../crs/CrsVersionRetry';
import type { RepositoryTarget } from '../RepositoryService';
import {
  checkHistoryPageRequest,
  HISTORY_CALL_TIMEOUT_MS,
  HISTORY_MAX_RESPONSE_BYTES,
  HISTORY_PAGE_SIZE,
  loadMoreRepositoryHistory,
  loadRepositoryHistory,
} from './RepositoryHistoryLoader';
import type { RepositoryHistory, RepositoryHistoryObjectFilter } from './RepositoryHistoryModel';
import {
  toRepositoryHistoryFailure,
  type RepositoryHistoryFailure,
  type RepositoryHistorySession,
  type RepositoryHistorySessionResolution,
} from './RepositoryHistorySession';

export interface RepositoryHistoryScope {
  readonly target: RepositoryTarget;
  /** Нет — вся история цели. */
  readonly filter?: RepositoryHistoryObjectFilter;
}

/** Догрузка более ранних версий поверх готовой истории. */
export type HistoryMoreState = { readonly kind: 'loading' } | { readonly kind: 'failed'; readonly failure: RepositoryHistoryFailure };

export type RepositoryHistoryState =
  | { readonly kind: 'no-scope' }
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'file-repository' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly stale?: RepositoryHistory }
  | { readonly kind: 'ready'; readonly history: RepositoryHistory; readonly more?: HistoryMoreState }
  | { readonly kind: 'failed'; readonly failure: RepositoryHistoryFailure; readonly stale?: RepositoryHistory };

export interface RepositoryHistoryViewModel {
  readonly state: RepositoryHistoryState;
  readonly scope?: RepositoryHistoryScope;
  /** Фильтр области; заголовок — из истории, если объект в ней встретился. */
  readonly filter?: RepositoryHistoryObjectFilter;
  /** Что показывать: история (свежая или устаревшая) по текущей области. */
  readonly visible?: RepositoryHistory;
}

export interface RepositoryHistoryServiceDeps {
  resolveSession(target: RepositoryTarget): Promise<RepositoryHistorySessionResolution>;
  readonly createClient?: (address: CrsAddress, options: CrsConnectOptions) => CrsClient;
  /** Версий на страницу; по умолчанию HISTORY_PAGE_SIZE. */
  readonly pageSize?: number;
  readonly onError: (error: unknown) => void;
}

export interface RepositoryHistoryQuery {
  readonly target: RepositoryTarget;
  readonly objectId?: string;
  readonly pageSize?: number;
  readonly beforeVersion?: number;
}

export type RepositoryHistoryQueryResult =
  | { readonly kind: 'ok'; readonly history: RepositoryHistory }
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'file-repository' }
  | { readonly kind: 'failed'; readonly failure: RepositoryHistoryFailure };

const LIMITS = { timeoutMs: HISTORY_CALL_TIMEOUT_MS, maxResponseBytes: HISTORY_MAX_RESPONSE_BYTES } as const;

type Load = (client: CrsClient, options: CrsCallOptions) => Promise<RepositoryHistory>;

/** Итог прогона: история или отказ с версией повтора (она нужна тексту отказа). */
type Fetched = { readonly ok: true; readonly history: RepositoryHistory } | { readonly ok: false; readonly failure: RepositoryHistoryFailure };

function historyOf(state: RepositoryHistoryState): RepositoryHistory | undefined {
  switch (state.kind) {
    case 'ready':
      return state.history;
    case 'loading':
    case 'failed':
      return state.stale;
    default:
      return undefined;
  }
}

function sameSession(a: RepositoryHistorySession | undefined, b: RepositoryHistorySession): boolean {
  // Ключ без хеша пароля; смена пароля — тоже другая сессия: прежняя история могла быть чужой.
  return a?.key === b.key && a.auth.passwordHash === b.auth.passwordHash;
}

function sameScope(a: RepositoryHistoryScope | undefined, b: RepositoryHistoryScope | undefined): boolean {
  if (a === undefined || b === undefined) {
    return false;
  }
  return a.target.configRoot === b.target.configRoot && a.filter?.objectId === b.filter?.objectId;
}

export class RepositoryHistoryService {
  private readonly listeners = new Set<() => void>();
  private scope: RepositoryHistoryScope | undefined;
  private state: RepositoryHistoryState = { kind: 'no-scope' };
  private current: RepositoryHistoryViewModel = { state: this.state };
  /** Сессия, по которой загружена текущая история; догрузка идёт по ней же. */
  private session: RepositoryHistorySession | undefined;
  /** Версия сервера, найденная повтором, — для следующих вызовов той же сессии. */
  private learnedVersion: { readonly key: string; readonly version: string } | undefined;
  // Растёт при смене области, обновлении поверх догрузки и dispose: результат прошлого поколения не пишется.
  private generation = 0;
  // Одна операция за раз: загрузка (inflight) или догрузка (moreInflight); controller — у той, что идёт.
  private controller: AbortController | undefined;
  private inflight: Promise<void> | undefined;
  private moreInflight: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly deps: RepositoryHistoryServiceDeps) {}

  /** Готовое представление: пересчитывается при изменениях, а не в геттере. */
  get view(): RepositoryHistoryViewModel {
    return this.current;
  }

  /** Исключение слушателя не прерывает остальных — уходит в onError. */
  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /**
   * Другая цель или объект — другая история: загрузка отменяется, состояние сбрасывается, чтобы не показать
   * историю прежнего объекта под новым заголовком; загрузку запускает ensureLoaded. Та же — только заголовок.
   */
  setScope(scope: RepositoryHistoryScope | undefined): void {
    if (this.disposed) {
      return;
    }
    const same = sameScope(this.scope, scope);
    this.scope = scope;
    if (same) {
      this.publish();
      return;
    }
    this.cancel();
    this.set(scope === undefined ? { kind: 'no-scope' } : { kind: 'idle' });
  }

  /** Загрузка первой страницы заново; во время загрузки возвращает её же. Не бросает: отказ — состояние failed. */
  refresh(): Promise<void> {
    const scope = this.scope;
    if (this.disposed || scope === undefined) {
      return Promise.resolve();
    }
    if (this.inflight !== undefined) {
      return this.inflight;
    }
    // Обновление начинает историю с первой страницы: догрузка к прежней истории больше не нужна.
    if (this.moreInflight !== undefined) {
      this.cancel();
    }
    const controller = new AbortController();
    this.controller = controller;
    const stale = historyOf(this.state);
    this.set(stale === undefined ? { kind: 'loading' } : { kind: 'loading', stale });
    const inflight = this.runRefresh(scope, controller.signal, stale);
    this.inflight = inflight;
    return inflight;
  }

  /**
   * Догрузка следующей страницы более ранних версий; во время догрузки возвращает её же. Не бросает: отказ —
   * ready с more.failed, загруженные версии остаются. Только поверх готовой истории с непустым pending.
   */
  loadMore(): Promise<void> {
    if (this.moreInflight !== undefined) {
      return this.moreInflight;
    }
    const { scope, session, state } = this;
    if (this.disposed || scope === undefined || session === undefined || state.kind !== 'ready' || state.history.pending.length === 0) {
      return Promise.resolve();
    }
    const controller = new AbortController();
    this.controller = controller;
    const history = state.history;
    this.set({ kind: 'ready', history, more: { kind: 'loading' } });
    const generation = this.generation;
    const request = { objectId: scope.filter?.objectId, pageSize: this.pageSize };
    const inflight = this.fetch(session, controller.signal, (client, options) =>
      loadMoreRepositoryHistory(client, session.auth, options, history, request)
    ).then((result) => {
      this.finish(generation, result.ok ? { kind: 'ready', history: result.history } : { kind: 'ready', history, more: { kind: 'failed', failure: result.failure } });
    });
    this.moreInflight = inflight;
    return inflight;
  }

  /**
   * Загрузка, если данных нет и последняя попытка не дала устаревших; иначе — ничего (или идущая загрузка).
   * После «не подключено»/«файловое хранилище» сессия разрешается заново: подключение могли сменить.
   */
  ensureLoaded(): Promise<void> {
    const kind = this.state.kind;
    if (kind === 'idle' || kind === 'disconnected' || kind === 'file-repository' || (this.state.kind === 'failed' && this.state.stale === undefined)) {
      return this.refresh();
    }
    return this.inflight ?? Promise.resolve();
  }

  /**
   * Страница истории без состояния сервиса (MCP): тот же код загрузки, что у панели, но view не меняется.
   * Неверный размер страницы или курсор — RangeError (ошибка вызывающего); прочие отказы — результат failed.
   */
  async query(request: RepositoryHistoryQuery): Promise<RepositoryHistoryQueryResult> {
    const page = { objectId: request.objectId, pageSize: request.pageSize ?? this.pageSize, beforeVersion: request.beforeVersion };
    checkHistoryPageRequest(page);
    const resolution = await this.resolve(request.target);
    if (resolution.kind !== 'session') {
      return resolution;
    }
    const session = resolution.session;
    const result = await this.fetch(session, undefined, (client, options) => loadRepositoryHistory(client, session.auth, options, page));
    return result.ok ? { kind: 'ok', history: result.history } : { kind: 'failed', failure: result.failure };
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.listeners.clear();
  }

  private get pageSize(): number {
    return this.deps.pageSize ?? HISTORY_PAGE_SIZE;
  }

  private async runRefresh(scope: RepositoryHistoryScope, signal: AbortSignal, stale: RepositoryHistory | undefined): Promise<void> {
    const generation = this.generation;
    const resolution = await this.resolve(scope.target);
    if (generation !== this.generation) {
      return;
    }
    if (resolution.kind !== 'session') {
      this.session = undefined;
      this.finish(generation, resolution.kind === 'failed' ? withStale({ kind: 'failed', failure: resolution.failure }, stale) : { kind: resolution.kind });
      return;
    }
    const session = resolution.session;
    // История другого хранилища или пользователя устаревшими данными этой не считается.
    const kept = sameSession(this.session, session) ? stale : undefined;
    if (kept !== stale) {
      this.set({ kind: 'loading' });
    }
    this.session = session;
    const request = { objectId: scope.filter?.objectId, pageSize: this.pageSize };
    const result = await this.fetch(session, signal, (client, options) => loadRepositoryHistory(client, session.auth, options, request));
    this.finish(generation, result.ok ? { kind: 'ready', history: result.history } : withStale({ kind: 'failed', failure: result.failure }, kept));
  }

  private async resolve(target: RepositoryTarget): Promise<RepositoryHistorySessionResolution> {
    try {
      return await this.deps.resolveSession(target);
    } catch (error) {
      return { kind: 'failed', failure: toRepositoryHistoryFailure(error) };
    }
  }

  /** Загрузка на свежем клиенте с повтором по версии сервера; не бросает. */
  private async fetch(session: RepositoryHistorySession, signal: AbortSignal | undefined, load: Load): Promise<Fetched> {
    const learned = this.learnedVersion?.key === session.key ? this.learnedVersion.version : undefined;
    let retried: string | undefined;
    try {
      const history = await runWithServerVersionRetry(learned ?? session.versionHint, (version) => {
        const client = (this.deps.createClient ?? createCrsClient)(session.address, version === undefined ? LIMITS : { ...LIMITS, version });
        return load(client, signal === undefined ? { ...LIMITS } : { ...LIMITS, signal });
      }, (serverVersion) => {
        retried = serverVersion;
        this.learnedVersion = { key: session.key, version: serverVersion };
      });
      return { ok: true, history };
    } catch (error) {
      return { ok: false, failure: toRepositoryHistoryFailure(error, retried) };
    }
  }

  /** Итог операции пишется, только если поколение не сменилось. */
  private finish(generation: number, next: RepositoryHistoryState): void {
    if (generation !== this.generation) {
      return;
    }
    this.controller = undefined;
    this.inflight = undefined;
    this.moreInflight = undefined;
    this.set(next);
  }

  private cancel(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
    this.inflight = undefined;
    this.moreInflight = undefined;
  }

  private set(state: RepositoryHistoryState): void {
    this.state = state;
    this.publish();
  }

  private publish(): void {
    this.current = this.compute();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.deps.onError(error);
      }
    }
  }

  private compute(): RepositoryHistoryViewModel {
    const { state, scope } = this;
    const history = historyOf(state);
    const filter = scope?.filter;
    // Заголовок из истории точнее заголовка выгрузки: так объект назван в отчёте Конфигуратора.
    const known = filter === undefined ? undefined : history?.versions.flatMap((v) => v.changes).find((c) => c.objectId === filter.objectId);
    return {
      state,
      ...(scope === undefined ? {} : { scope }),
      ...(filter === undefined ? {} : { filter: known === undefined ? filter : { objectId: filter.objectId, title: known.title } }),
      ...(history === undefined ? {} : { visible: history }),
    };
  }
}

function withStale(state: { readonly kind: 'failed'; readonly failure: RepositoryHistoryFailure }, stale: RepositoryHistory | undefined): RepositoryHistoryState {
  return stale === undefined ? state : { ...state, stale };
}
