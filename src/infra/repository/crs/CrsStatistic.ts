// devObjectsStatistic — статусы захвата объектов, привязки и пользователи хранилища. Главный источник
// кэша статусов; ответ пропорционален числу объектов, поэтому результат — массивы, индексы строит
// потребитель.
import type { CrsClient } from './CrsClient';
import { type CrsBinding, type CrsUserInfo, decodeBinding, decodeUserInfo } from './CrsDepot';
import { type CrsAuth, crsValue } from '../../xml/crs/CrsEnvelope';
import type { CrsCallOptions } from './CrsTransport';
import { booleanValue, crsChild, crsValues, decodeReturn, integerValue, stringValue } from '../../xml/crs/CrsResponseReaders';
import type { CrsXmlElement } from '../../xml/crs/CrsXmlReader';

const METHOD = 'DevDepot_devObjectsStatistic';

/** Захват объекта: кто и когда. Дата — строкой как есть, без пояса. */
export interface CrsObjectLock {
  readonly userId: string;
  readonly date: string;
}

/** Класса и имени объекта в ответе нет — только uuid; сопоставление с файлами выгрузки — отдельно. */
export interface CrsObjectStatus {
  readonly objectId: string;
  readonly version: number;
  /** Только при revised=true: reviseDate незахваченного объекта — не дата захвата. */
  readonly lock?: CrsObjectLock;
}

export interface CrsDepotUser extends CrsUserInfo {
  readonly online: boolean;
  readonly removed: boolean;
}

export interface CrsStatisticQuery {
  /** Пусто — все объекты (у Конфигуратора `<crs:objRefs/>`). */
  readonly objectIds?: readonly string[];
  /** Как у Конфигуратора: true в полном запросе, false в запросе по objRefs. */
  readonly removed: boolean;
  /** Привязка (crs:bind). Для чтения не нужна: без неё и с чужим bindID ответ тот же (пробы tcp/probe-statistic-*). */
  readonly bindId?: string;
}

export interface CrsDevObjectsStatistic {
  readonly objects: readonly CrsObjectStatus[];
  readonly bindings: readonly CrsBinding[];
  readonly users: readonly CrsDepotUser[];
}

export async function devObjectsStatistic(
  client: CrsClient,
  auth: CrsAuth,
  query: CrsStatisticQuery,
  options?: CrsCallOptions,
): Promise<CrsDevObjectsStatistic> {
  const objRefs = { name: 'objRefs', children: (query.objectIds ?? []).map((id) => crsValue('value', id)) };
  const params = [objRefs, crsValue('removed', query.removed)];
  const root = await client.call({ method: METHOD, auth, bindId: query.bindId, params }, options);
  return decodeReturn(METHOD, root, decodeStatistic);
}

// Все три раздела обязательны: они есть в каждом снятом ответе, даже по одному объекту.
function decodeStatistic(root: CrsXmlElement): CrsDevObjectsStatistic {
  return {
    objects: crsValues(crsChild(root, 'statMap')).map(decodeObjectStatus),
    bindings: crsValues(crsChild(root, 'bindInfos')).map(decodeBinding),
    users: crsValues(crsChild(root, 'users')).map(decodeDepotUser),
  };
}

function decodeObjectStatus(value: CrsXmlElement): CrsObjectStatus {
  const second = crsChild(value, 'second');
  const status = { objectId: stringValue(crsChild(value, 'first')), version: integerValue(crsChild(second, 'verNum')) };
  if (!booleanValue(crsChild(second, 'revised'))) {
    return status;
  }
  return { ...status, lock: { userId: stringValue(crsChild(second, 'revisorID')), date: stringValue(crsChild(second, 'reviseDate')) } };
}

/** Элемент crs:users статистики и UserManager_depotUsers: first — id, second — сведения без хеша пароля. */
export function decodeDepotUser(value: CrsXmlElement): CrsDepotUser {
  const second = crsChild(value, 'second');
  return {
    ...decodeUserInfo(crsChild(second, 'info')),
    online: booleanValue(crsChild(second, 'online')),
    removed: booleanValue(crsChild(second, 'removed')),
  };
}
