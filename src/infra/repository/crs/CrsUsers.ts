// UserManager_depotUsers — пользователи хранилища: имена авторов версий в истории. Ответ несёт хеши
// паролей (crs:password), в модель они не попадают (decodeDepotUser).
import type { CrsClient } from './CrsClient';
import { type CrsAuth, crsValue } from '../../xml/crs/CrsEnvelope';
import { type CrsDepotUser, decodeDepotUser } from './CrsStatistic';
import type { CrsCallOptions } from './CrsTransport';
import { crsChild, crsValues, decodeReturn } from '../../xml/crs/CrsResponseReaders';

const METHOD = 'UserManager_depotUsers';

export interface CrsDepotUsersQuery {
  /** Включать удалённых пользователей: у Конфигуратора true — авторы старых версий могли быть удалены. */
  readonly removed: boolean;
  /** Привязка не нужна: без неё и от пользователя ReadOnly ответ тот же (пробы tcp/probe-depot-users-*). */
  readonly bindId?: string;
}

export async function depotUsers(client: CrsClient, auth: CrsAuth, query: CrsDepotUsersQuery, options?: CrsCallOptions): Promise<readonly CrsDepotUser[]> {
  const root = await client.call({ method: METHOD, auth, bindId: query.bindId, params: [crsValue('removed', query.removed)] }, options);
  return decodeReturn(METHOD, root, (r) => crsValues(crsChild(r, 'users')).map(decodeDepotUser));
}
