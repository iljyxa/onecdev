// Методы crs открытия хранилища, входа и привязки. Функции без состояния над CrsClient: порядок вызовов
// и хранение привязки — сценарий потребителя (infra/repository). Хеш пароля считает потребитель (crsPasswordHash),
// в моделях ответа хешей нет: сервер возвращает их в crs:userInfo и списках пользователей.
import type { CrsClient } from './CrsClient';
import { type CrsAuth, crsValue } from '../../xml/crs/CrsEnvelope';
import type { CrsCallOptions } from './CrsTransport';
import { booleanValue, crsChild, decodeReturn, integerValue, stringValue } from '../../xml/crs/CrsResponseReaders';
import type { CrsXmlElement } from '../../xml/crs/CrsXmlReader';

const OPEN_DEV_DEPOT = 'DevDepotAdmin_openDevDepot';
const AUTHENTICATE = 'DevDepot_authenticate';
const DEPOT_INFO = 'DevDepot_depotInfo';
const BIND = 'DevDepot_bind';

/** Сведения о хранилище (openDevDepot, depotInfo). Дата — строкой как есть: пояс сервер не сообщает. */
export interface CrsDepotInfo {
  readonly formatMajor: number;
  readonly formatMinor: number;
  readonly depotId: string;
  readonly rootId: string;
  readonly mode: number;
  readonly date: string;
  readonly isExtension: boolean;
}

/** Пользователь хранилища без хеша пароля. rights — число сервера без интерпретации (на 8.5.1: 0, 3, 65535). */
export interface CrsUserInfo {
  readonly id: string;
  readonly name: string;
  readonly rights: number;
}

export interface CrsBinding {
  readonly userId: string;
  readonly bindId: string;
  readonly bindString: string;
  readonly online: boolean;
}

export interface CrsBindRequest {
  readonly bindId: string;
  /** Как у Конфигуратора: `Computer="…";Config="…";`. */
  readonly bindString: string;
  readonly existing: boolean;
  readonly force: boolean;
}

/** Параметр crs:alias совпадает с alias конверта (tcp/lock-one/01); учётных данных нет. */
export async function openDevDepot(client: CrsClient, options?: CrsCallOptions): Promise<CrsDepotInfo> {
  const params = [crsValue('alias', client.alias), crsValue('convert', false)];
  const root = await client.call({ method: OPEN_DEV_DEPOT, params }, options);
  return decodeReturn(OPEN_DEV_DEPOT, root, decodeDepotInfo);
}

/** Учётные данные — в params, без crs:auth, как у Конфигуратора (tcp/lock-one/03). Неверные — auth-failed. */
export async function authenticate(client: CrsClient, auth: CrsAuth, options?: CrsCallOptions): Promise<CrsUserInfo> {
  const params = [crsValue('user', auth.user), crsValue('password', auth.passwordHash)];
  const root = await client.call({ method: AUTHENTICATE, params }, options);
  return decodeReturn(AUTHENTICATE, root, (r) => decodeUserInfo(crsChild(r, 'userInfo')));
}

export async function depotInfo(client: CrsClient, auth: CrsAuth, options?: CrsCallOptions): Promise<CrsDepotInfo> {
  const root = await client.call({ method: DEPOT_INFO, auth, params: [] }, options);
  return decodeReturn(DEPOT_INFO, root, decodeDepotInfo);
}

/**
 * Привязка базы к хранилищу. Для чтения статусов не нужна (пробы tcp/probe-statistic-*): сервер отдаёт
 * ту же статистику без crs:bind и с чужим bindID. `online` в ответе — состояние на момент ответа: устойчивой
 * пометки вызов не создаёт (docs/repository-crs.md, решение 8). Отказы: незарегистрированный bindID с existing=true — server
 * (код 11), existing=false у пользователя, у которого уже есть привязанная база, без force — server (код 10).
 */
export async function bind(client: CrsClient, auth: CrsAuth, request: CrsBindRequest, options?: CrsCallOptions): Promise<CrsBinding> {
  const params = [
    crsValue('bindID', request.bindId),
    crsValue('bindString', request.bindString),
    crsValue('existing', request.existing),
    crsValue('force', request.force),
  ];
  const root = await client.call({ method: BIND, auth, params }, options);
  return decodeReturn(BIND, root, (r) => decodeBinding(crsChild(r, 'bindInfo')));
}

function decodeDepotInfo(root: CrsXmlElement): CrsDepotInfo {
  const outer = crsChild(root, 'info');
  const info = crsChild(outer, 'info');
  return {
    formatMajor: integerValue(crsChild(info, 'version', 'major')),
    formatMinor: integerValue(crsChild(info, 'version', 'minor')),
    depotId: stringValue(crsChild(info, 'depotID')),
    rootId: stringValue(crsChild(info, 'rootID')),
    mode: integerValue(crsChild(info, 'mode')),
    date: stringValue(crsChild(outer, 'date')),
    isExtension: booleanValue(crsChild(outer, 'isExtension')),
  };
}

/** crs:userInfo и crs:info списка пользователей: id, name, password, rights; password отбрасывается. */
export function decodeUserInfo(element: CrsXmlElement): CrsUserInfo {
  return {
    id: stringValue(crsChild(element, 'id')),
    name: stringValue(crsChild(element, 'name')),
    rights: integerValue(crsChild(element, 'rights')),
  };
}

/** crs:bindInfo ответа bind и элемент crs:bindInfos статистики. */
export function decodeBinding(element: CrsXmlElement): CrsBinding {
  return {
    userId: stringValue(crsChild(element, 'userID')),
    bindId: stringValue(crsChild(element, 'bindID')),
    bindString: stringValue(crsChild(element, 'bindString')),
    online: booleanValue(crsChild(element, 'online')),
  };
}
