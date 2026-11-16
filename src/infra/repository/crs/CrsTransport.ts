// Общий контракт транспорта протокола crs: одно тело запроса туда, одно тело ответа обратно.
// Конверт crs:call и разбор ответа живут выше; транспорт отвечает только за доставку байт,
// дедлайн, лимит размера и закрытие соединения при любом исходе.

/** Дедлайн вызова по умолчанию: покрывает подключение, рукопожатие и ответ целиком. */
export const CRS_DEFAULT_TIMEOUT_MS = 30_000;

/** Лимит тела ответа по умолчанию: история большого хранилища бывает десятками мегабайт. */
export const CRS_DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;

// setTimeout с задержкой больше 2^31−1 мс срабатывает сразу — такой дедлайн недопустим.
export const CRS_MAX_TIMER_MS = 2 ** 31 - 1;

/** Проверка числовой опции транспорта: RangeError вне (0, max]; общая для tcp и http. */
export function crsPositiveOption(name: string, value: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!(value > 0 && value <= max)) {
    throw new RangeError(`${name} должен быть в диапазоне (0, ${String(max)}], получено ${String(value)}`);
  }
  return value;
}

export interface CrsCallOptions {
  /** Отмена вызова; уже отменённый сигнал — отказ без подключения. */
  signal?: AbortSignal;
  /** Переопределяет дедлайн транспорта для одного вызова. */
  timeoutMs?: number;
  /** Переопределяет лимит тела ответа для одного вызова. */
  maxResponseBytes?: number;
}

export interface CrsTransport {
  /** Отправляет тело crs:call и возвращает тело ответа (статус 200) как есть. */
  call(body: Buffer, options?: CrsCallOptions): Promise<Buffer>;
}

/**
 * - `unavailable` — не удалось подключиться или сокет упал (причина в `details.cause`);
 * - `timeout` — дедлайн вызова истёк;
 * - `aborted` — вызов отменён сигналом;
 * - `closed` — сервер закрыл соединение до конца ответа;
 * - `too-large` — ответ больше лимита;
 * - `protocol` — байты не похожи на ответ crserver;
 * - `status` — ответ со статусом не 200 (тело `exception` в `details.body`).
 */
export type CrsTransportErrorKind = 'unavailable' | 'timeout' | 'aborted' | 'closed' | 'too-large' | 'protocol' | 'status';

export interface CrsTransportErrorDetails {
  /** Адрес без учётных данных и alias, например `tcp://127.0.0.1:1542` или `http://127.0.0.1:8080/repo/repo.1ccr`. */
  endpoint: string;
  status?: number;
  body?: Buffer;
  /** Исходная ошибка сокета: lib ES2020 не знает Error.cause, поэтому поле своё. */
  cause?: Error;
}

export class CrsTransportError extends Error {
  constructor(
    readonly kind: CrsTransportErrorKind,
    message: string,
    readonly details: CrsTransportErrorDetails,
  ) {
    super(message);
    this.name = 'CrsTransportError';
  }
}
