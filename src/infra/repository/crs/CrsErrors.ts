// Ошибки уровня конверта crs:call. Транспортные отказы остаются CrsTransportError (transport.ts):
// вызывающему важно отличать «не доставили» от «сервер отказал».
import type { CrsTransportError } from './CrsTransport';

/**
 * - `version-mismatch` — версия клиента в конверте не совпала с версией crserver;
 * - `auth-failed` — неверное имя пользователя или пароль;
 * - `depot-not-found` — хранилища с таким alias на сервере нет;
 * - `unknown-method` — сервер ответил пустым телом (так crserver отвечает на неизвестный метод);
 * - `bad-request` — сервер не разобрал тело запроса (исключение VRS разбора XML);
 * - `rejected` — отказ веб-публикации (исключение VRS: не найден ресурс, неверный метод HTTP);
 * - `server` — прочее исключение сервера;
 * - `malformed-response` — тело ответа не похоже на ответ crserver.
 */
export type CrsCallErrorKind =
  | 'version-mismatch'
  | 'auth-failed'
  | 'depot-not-found'
  | 'unknown-method'
  | 'bad-request'
  | 'rejected'
  | 'server'
  | 'malformed-response';

export interface CrsCallErrorDetails {
  readonly method: string;
  readonly clsid?: string;
  readonly code?: number;
  /** Сообщения цепочки исключения сверху вниз; без тела запроса. */
  readonly messages?: readonly string[];
  readonly serverVersion?: string;
  readonly status?: number;
  /** Исходная ошибка: lib ES2020 не знает Error.cause, поэтому поле своё, как в CrsTransportError. */
  readonly cause?: Error;
}

export class CrsCallError extends Error {
  constructor(
    readonly kind: CrsCallErrorKind,
    message: string,
    readonly details: CrsCallErrorDetails,
  ) {
    super(message);
    this.name = 'CrsCallError';
  }
}

/** Байты не похожи на ожидаемый XML или скобочный текст; сообщение — причина и смещение, без содержимого. */
export class CrsFormatError extends Error {
  constructor(
    message: string,
    readonly offset?: number,
  ) {
    super(message);
    this.name = 'CrsFormatError';
  }
}

export type CrsError = CrsTransportError | CrsCallError;
