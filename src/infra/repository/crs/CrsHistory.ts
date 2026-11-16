// DevDepot_devDepotReport — история версий хранилища: версии (автор, дата, комментарий, метка) и
// изменённые в них объекты. Единственный читатель <crs:data> в расширении: здесь это открытый XML
// метаданных версий, а не содержимое объектов. Хеши версий (crs:version), внешние файлы (crs:externals)
// и порядок обработки (crs:processOrder) не читаются — это внутренности платформы для получения
// содержимого, а оно идёт только через Конфигуратор (docs/repository-crs.md, решение 3).
import type { CrsClient } from './CrsClient';
import { CRS_NAMESPACE, type CrsAuth, type CrsElement, crsValue } from '../../xml/crs/CrsEnvelope';
import type { CrsCallOptions } from './CrsTransport';
import { booleanValue, crsChild, crsValues, decodeReturn, integerValue, stringValue } from '../../xml/crs/CrsResponseReaders';
import { childElement, type CrsXmlElement } from '../../xml/crs/CrsXmlReader';

const METHOD = 'DevDepot_devDepotReport';
const VERSIONS_METHOD = 'DevDepot_devDepotVersions';
// Значения «без ограничения» — как в запросе Конфигуратора (tcp/history-all/07).
const NO_DATE = '0001-01-01T00:00:00';
const NO_VERSION = -1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Биты crs:mask — какие части фильтра применять (пробы tcp/probe-history-mask-*).
const MASK_VERSIONS = 1;
const MASK_OBJECTS = 4;

export interface CrsHistoryQuery {
  /** Диапазон номеров версий; нет — без ограничения. Целое ≥ 1 и begin ≤ end, иначе RangeError. */
  readonly beginVerNum?: number;
  readonly endVerNum?: number;
  /** Включать версии с метками; по умолчанию true. */
  readonly labels?: boolean;
  /** Только версии с метками; по умолчанию false. */
  readonly onlyLabels?: boolean;
  /**
   * Объекты (uuid) — только версии, где они изменены; порядок сохраняется в crs:objRefs. Пустой список или
   * не uuid — RangeError.
   */
  readonly objectIds?: readonly string[];
  /** С объектами — и их подчинённые (формы, реквизиты); по умолчанию false. Без objectIds — RangeError. */
  readonly recursive?: boolean;
  /** Привязка (crs:bind). Для истории не нужна: без неё и с чужим bindID ответ тот же (пробы tcp/probe-history-*). */
  readonly bindId?: string;
}

/** Метка версии. Дата — строкой как есть, без пояса. */
export interface CrsHistoryLabel {
  readonly userId: string;
  readonly date: string;
  readonly name: string;
  readonly comment: string;
}

export interface CrsDepotVersion {
  readonly verNum: number;
  readonly versionId: string;
  readonly userId: string;
  readonly date: string;
  /** Версия конфигурации (crs:code). */
  readonly configVersion: string;
  /** Версия платформы, поместившей версию: `8.5.1.1529`. */
  readonly platformVersion: string;
  readonly comment: string;
  readonly label?: CrsHistoryLabel;
}

/** Объект, изменённый в версии verNum. fullName — пары `<classID>.<имя>` от корня, как в ответе. */
export interface CrsChangedObject {
  readonly objectId: string;
  readonly classId: string;
  readonly name: string;
  readonly fullName: string;
  readonly parentId: string;
  readonly verNum: number;
  /** Число сервера без интерпретации: на 8.5.1 — 0 (добавлен) и 5 (изменён). */
  readonly action: number;
  readonly removed: boolean;
}

export interface CrsDepotHistory {
  readonly versions: readonly CrsDepotVersion[];
  readonly changes: readonly CrsChangedObject[];
}

export async function devDepotReport(
  client: CrsClient,
  auth: CrsAuth,
  query: CrsHistoryQuery = {},
  options?: CrsCallOptions,
): Promise<CrsDepotHistory> {
  const filter = historyFilter(query);
  const root = await client.call({ method: METHOD, auth, bindId: query.bindId, params: [filter] }, options);
  return decodeReturn(METHOD, root, decodeHistory);
}

/**
 * DevDepot_devDepotVersions — только версии (без изменённых объектов и без повторов) по тому же фильтру, что у
 * отчёта: лёгкий список номеров для постраничной загрузки истории. Порядок — как в ответе (на 8.5.1 — по
 * возрастанию номера).
 */
export async function devDepotVersions(
  client: CrsClient,
  auth: CrsAuth,
  query: CrsHistoryQuery = {},
  options?: CrsCallOptions,
): Promise<readonly CrsDepotVersion[]> {
  const filter = historyFilter(query);
  const root = await client.call({ method: VERSIONS_METHOD, auth, bindId: query.bindId, params: [filter] }, options);
  return decodeReturn(VERSIONS_METHOD, root, decodeVersions);
}

/** Фильтр истории в форме Конфигуратора; неверный диапазон или объекты — RangeError до транспорта. */
function historyFilter(query: CrsHistoryQuery): CrsElement {
  const begin = versionBound('beginVerNum', query.beginVerNum);
  const end = versionBound('endVerNum', query.endVerNum);
  if (begin !== NO_VERSION && end !== NO_VERSION && begin > end) {
    throw new RangeError(`beginVerNum (${String(begin)}) больше endVerNum (${String(end)})`);
  }
  const objectIds = objectRefs(query);
  const ranged = begin !== NO_VERSION || end !== NO_VERSION;
  // Маска — как в снятых запросах, чтобы тело совпадало побайтно: Конфигуратор ставит бит 1 и при диапазоне
  // номеров, и без фильтров вовсе (history-all, history-range); с объектами без диапазона — только бит 4
  // (probe-history-object-*), с диапазоном — 5 (probe-history-object-catalog-range).
  const mask = (objectIds === undefined ? 0 : MASK_OBJECTS) | (ranged || objectIds === undefined ? MASK_VERSIONS : 0);
  const empty = (name: string): CrsElement => ({ name });
  // Порядок и значения элементов фильтра — как у Конфигуратора: сервер сверяет структуру.
  return {
    name: 'filter',
    children: [
      crsValue('mask', mask),
      crsValue('beginDate', NO_DATE),
      crsValue('endDate', NO_DATE),
      crsValue('beginVerNum', begin),
      crsValue('endVerNum', end),
      empty('userIDs'),
      objectIds === undefined ? empty('objRefs') : { name: 'objRefs', children: objectIds.map((id) => crsValue('value', id)) },
      crsValue('recursive', query.recursive ?? false),
      crsValue('labels', query.labels ?? true),
      crsValue('onlyLabels', query.onlyLabels ?? false),
      crsValue('configVersion', ''),
      empty('externals'),
      empty('noExternals'),
    ],
  };
}

function versionBound(name: string, value: number | undefined): number {
  if (value === undefined) {
    return NO_VERSION;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} должен быть целым числом не меньше 1, получено ${String(value)}`);
  }
  return value;
}

/** Объекты фильтра; нет — undefined. Не uuid попал бы в атрибут XML как есть — отсекается до транспорта. */
function objectRefs(query: CrsHistoryQuery): readonly string[] | undefined {
  const ids = query.objectIds;
  if (ids === undefined) {
    if (query.recursive === true) {
      throw new RangeError('recursive без objectIds не имеет смысла');
    }
    return undefined;
  }
  if (ids.length === 0) {
    throw new RangeError('objectIds пуст: для истории без фильтра объектов поле не передаётся');
  }
  const bad = ids.find((id) => !UUID.test(id));
  if (bad !== undefined) {
    throw new RangeError(`objectIds: не uuid ${JSON.stringify(bad)}`);
  }
  return ids;
}

function decodeHistory(root: CrsXmlElement): CrsDepotHistory {
  const data = crsChild(root, 'data');
  // С фильтром объектов сервер повторяет версию для каждого объекта (и подчинённого), где она его изменила
  // (probe-history-object-two, -catalog-recursive): версия одна, остаётся первое вхождение.
  const unique = new Map<number, CrsDepotVersion>();
  for (const version of crsValues(crsChild(data, 'objectVersions')).map(decodeVersion)) {
    if (!unique.has(version.verNum)) {
      unique.set(version.verNum, version);
    }
  }
  const versions = [...unique.values()];
  return {
    versions,
    changes: crsValues(crsChild(data, 'depotVersions')).map(decodeChange),
  };
}

// Пары crs:first/crs:second; номер берётся из info/verNum, как у отчёта, crs:first не читается.
function decodeVersions(root: CrsXmlElement): CrsDepotVersion[] {
  return crsValues(crsChild(root, 'versions')).map((value) => decodeVersion(crsChild(value, 'second')));
}

/** Версия из crs:value отчёта или crs:second списка: внутри — info и необязательная метка. */
function decodeVersion(value: CrsXmlElement): CrsDepotVersion {
  const info = crsChild(value, 'info');
  const part = (name: string): string => String(integerValue(crsChild(info, name)));
  const version: CrsDepotVersion = {
    verNum: integerValue(crsChild(info, 'verNum')),
    versionId: stringValue(crsChild(info, 'versionID')),
    userId: stringValue(crsChild(info, 'userID')),
    date: stringValue(crsChild(info, 'date')),
    configVersion: stringValue(crsChild(info, 'code')),
    platformVersion: ['pvermajor', 'pverminor', 'pverbuild', 'pverrevis'].map(part).join('.'),
    comment: crsChild(info, 'comment').text,
  };
  // Метка необязательна: у версии без метки элемента crs:label нет вовсе.
  const label = childElement(value, CRS_NAMESPACE, 'label');
  return label === undefined ? version : { ...version, label: decodeLabel(label) };
}

function decodeLabel(label: CrsXmlElement): CrsHistoryLabel {
  return {
    userId: stringValue(crsChild(label, 'userID')),
    date: stringValue(crsChild(label, 'date')),
    name: stringValue(crsChild(label, 'name')),
    comment: crsChild(label, 'comment').text,
  };
}

function decodeChange(value: CrsXmlElement): CrsChangedObject {
  const info = crsChild(value, 'info');
  return {
    objectId: stringValue(crsChild(info, '_super', 'id')),
    classId: stringValue(crsChild(info, '_super', 'classID')),
    name: stringValue(crsChild(info, 'name')),
    fullName: stringValue(crsChild(value, 'fullName', 'fullName')),
    parentId: stringValue(crsChild(info, 'parentID')),
    verNum: integerValue(crsChild(info, 'verNum')),
    action: integerValue(crsChild(value, 'action')),
    removed: booleanValue(crsChild(info, 'removed')),
  };
}
