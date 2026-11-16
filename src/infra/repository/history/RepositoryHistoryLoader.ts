// Постраничная загрузка истории хранилища: сначала лёгкий список номеров версий по фильтру
// (devDepotVersions — без изменённых объектов), затем отчёт по диапазону реальных номеров страницы и
// имена авторов. С objectId — только версии объекта и его подчинённых: сервер фильтрует сам, история не
// отбирается из полной. Привязка (crs:bind) не передаётся: для чтения истории и пользователей она не
// нужна (пробы tcp/probe-history-*, tcp/probe-depot-users-*), а заводить её ради чтения — менять
// состояние сервера.
import type { CrsClient } from '../crs/CrsClient';
import { CrsCallError } from '../crs/CrsErrors';
import { devDepotReport, devDepotVersions, type CrsHistoryQuery } from '../crs/CrsHistory';
import type { CrsCallOptions } from '../crs/CrsTransport';
import { depotUsers } from '../crs/CrsUsers';
import type { CrsAuth } from '../../xml/crs/CrsEnvelope';
import { buildHistory, type RepositoryHistory } from './RepositoryHistoryModel';

/** Дедлайн одного вызова истории: ответ пропорционален числу версий и объектов. */
export const HISTORY_CALL_TIMEOUT_MS = 120_000;
/** Предел ответа истории; больше — отказ too-large, а не зависание разбора. */
export const HISTORY_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
/** Версий на страницу истории. */
export const HISTORY_PAGE_SIZE = 100;

export interface RepositoryHistoryPageRequest {
  /** uuid объекта: только версии, где изменён он или его подчинённые. */
  readonly objectId?: string;
  /** Целое ≥ 1; по умолчанию HISTORY_PAGE_SIZE. */
  readonly pageSize?: number;
  /** Курсор листания (MCP): только версии с номером меньше; целое ≥ 2. */
  readonly beforeVersion?: number;
}

/** Неверный размер страницы или курсор — RangeError до транспорта. */
export function checkHistoryPageRequest(request: RepositoryHistoryPageRequest): void {
  const { pageSize, beforeVersion } = request;
  if (pageSize !== undefined && !(Number.isInteger(pageSize) && pageSize >= 1)) {
    throw new RangeError(`размер страницы истории должен быть целым числом не меньше 1, получено ${String(pageSize)}`);
  }
  if (beforeVersion !== undefined && !(Number.isInteger(beforeVersion) && beforeVersion >= 2)) {
    throw new RangeError(`beforeVersion должен быть целым числом не меньше 2, получено ${String(beforeVersion)}`);
  }
}

/**
 * Первая страница истории (или страница перед beforeVersion). Сервер без devDepotVersions
 * (unknown-method) — один отчёт целиком (до beforeVersion − 1), без постраничности.
 */
export async function loadRepositoryHistory(
  client: CrsClient,
  auth: CrsAuth,
  options: CrsCallOptions,
  request: RepositoryHistoryPageRequest = {},
): Promise<RepositoryHistory> {
  checkHistoryPageRequest(request);
  const query = objectQuery(request.objectId);
  const before = request.beforeVersion;
  let numbers: number[];
  try {
    numbers = (await devDepotVersions(client, auth, query, options)).map((v) => v.verNum).sort((a, b) => b - a);
  } catch (error) {
    if (!(error instanceof CrsCallError && error.kind === 'unknown-method')) {
      throw error;
    }
    const report = await devDepotReport(client, auth, before === undefined ? query : { ...query, endVerNum: before - 1 }, options);
    return buildHistory(report, await depotUsers(client, auth, { removed: true }, options));
  }
  const pending = before === undefined ? numbers : numbers.filter((n) => n < before);
  if (pending.length === 0) {
    return { versions: [], pending: [] };
  }
  return loadPage(client, auth, options, query, { versions: [], pending }, request.pageSize ?? HISTORY_PAGE_SIZE);
}

/** Следующие pageSize версий из pending: страница отчёта и авторы, версии дописываются в конец. */
export async function loadMoreRepositoryHistory(
  client: CrsClient,
  auth: CrsAuth,
  options: CrsCallOptions,
  history: RepositoryHistory,
  request: Omit<RepositoryHistoryPageRequest, 'beforeVersion'> = {},
): Promise<RepositoryHistory> {
  checkHistoryPageRequest(request);
  if (history.pending.length === 0) {
    return history;
  }
  return loadPage(client, auth, options, objectQuery(request.objectId), history, request.pageSize ?? HISTORY_PAGE_SIZE);
}

function objectQuery(objectId: string | undefined): CrsHistoryQuery {
  return objectId === undefined ? {} : { objectIds: [objectId], recursive: true };
}

async function loadPage(
  client: CrsClient,
  auth: CrsAuth,
  options: CrsCallOptions,
  query: CrsHistoryQuery,
  history: RepositoryHistory,
  pageSize: number,
): Promise<RepositoryHistory> {
  // Номера объекта разрежены (справочник: 1, 2, 3, 6), поэтому границы — реальные номера из списка, а не
  // арифметика: страница из двух — 3..6, и в ней ровно две версии объекта.
  const numbers = history.pending.slice(0, pageSize);
  const range = { ...query, beginVerNum: numbers[numbers.length - 1], endVerNum: numbers[0] };
  const report = await devDepotReport(client, auth, range, options);
  const users = await depotUsers(client, auth, { removed: true }, options);
  return { versions: [...history.versions, ...buildHistory(report, users).versions], pending: history.pending.slice(numbers.length) };
}
