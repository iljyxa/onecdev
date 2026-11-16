// Транспорт crs по http(s) через публикацию .1ccr: одно соединение на вызов, как у tcp. Конфигуратор
// переиспользует соединение (07), но пул усложнил бы итог вызова, а закрытие сокета при любом исходе
// гарантирует только соединение на вызов (agent: false, Connection: close, destroy в finish).
// Разбор HTTP — встроенный парсер Node: chunked и TLS штатные, своё кадрирование не нужно.
import * as http from 'http';
import * as https from 'https';
import type { Socket } from 'net';
import {
  CRS_HTTP_DEFAULT_MAX_HEADER_BYTES,
  type CrsHttpEndpoint,
  crsHttpRequestOptions,
  type CrsTlsOptions,
  formatHttpEndpoint,
} from './CrsHttpFraming';
import {
  CRS_DEFAULT_MAX_RESPONSE_BYTES,
  CRS_DEFAULT_TIMEOUT_MS,
  CRS_MAX_TIMER_MS,
  type CrsCallOptions,
  crsPositiveOption,
  type CrsTransport,
  CrsTransportError,
  type CrsTransportErrorDetails,
  type CrsTransportErrorKind,
} from './CrsTransport';

export interface CrsHttpTransportOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxHeaderBytes?: number;
  /** Для scheme 'http' — RangeError. */
  tls?: CrsTlsOptions;
}

const MAX_PORT = 65535;

// Контракт транспорта строже проверки http.request: Node отвергает только символы вне U+0021–U+00FF
// (допуская, например, é), а мы принимаем только ASCII printable без пробела вне %-последовательности
// и корректные percent-escape %XX (ровно две hex-цифры). Это исключает кириллицу, пробелы и битые
// escape вроде %GG до вызова http.request, где они вызвали бы TypeError внутри Promise-исполнителя.
// (?![\s\S]) — абсолютный конец строки: в JS $ совпадает перед финальным LF, что пропустило бы path\n.
const VALID_PATH_RE = /^(?:[\x21-\x24\x26-\x7E]|%[0-9A-Fa-f]{2})+(?![\s\S])/;

export class CrsHttpTransport implements CrsTransport {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxHeaderBytes: number;
  private readonly tls: CrsTlsOptions | undefined;
  private readonly address: string;

  constructor(
    private readonly endpoint: CrsHttpEndpoint,
    options: CrsHttpTransportOptions = {},
  ) {
    if (endpoint.host === '') {
      throw new RangeError('host не должен быть пустым');
    }
    if (!(Number.isInteger(endpoint.port) && endpoint.port >= 1 && endpoint.port <= MAX_PORT)) {
      throw new RangeError(`port должен быть целым в диапазоне [1, ${String(MAX_PORT)}], получено ${String(endpoint.port)}`);
    }
    if (!endpoint.path.startsWith('/')) {
      throw new RangeError('path должен начинаться с «/»');
    }
    if (!VALID_PATH_RE.test(endpoint.path)) {
      throw new RangeError('path содержит недопустимые символы: допустимы только ASCII printable (U+0021–U+007E) и корректные percent-escape %XX');
    }
    // Настройки TLS для незашифрованного соединения — ошибка конфигурации, а не повод их молча забыть.
    if (endpoint.scheme === 'http' && options.tls !== undefined) {
      throw new RangeError('tls задаётся только для https');
    }
    this.timeoutMs = crsPositiveOption('timeoutMs', options.timeoutMs ?? CRS_DEFAULT_TIMEOUT_MS, CRS_MAX_TIMER_MS);
    this.maxResponseBytes = crsPositiveOption('maxResponseBytes', options.maxResponseBytes ?? CRS_DEFAULT_MAX_RESPONSE_BYTES);
    this.maxHeaderBytes = crsPositiveOption('maxHeaderBytes', options.maxHeaderBytes ?? CRS_HTTP_DEFAULT_MAX_HEADER_BYTES);
    this.tls = options.tls;
    this.address = formatHttpEndpoint(endpoint);
  }

  async call(body: Buffer, options: CrsCallOptions = {}): Promise<Buffer> {
    const timeoutMs = crsPositiveOption('timeoutMs', options.timeoutMs ?? this.timeoutMs, CRS_MAX_TIMER_MS);
    const maxResponseBytes = crsPositiveOption('maxResponseBytes', options.maxResponseBytes ?? this.maxResponseBytes);
    if (options.signal?.aborted) {
      throw this.error('aborted', 'вызов отменён');
    }
    return this.exchange(body, maxResponseBytes, timeoutMs, options.signal);
  }

  private exchange(body: Buffer, maxResponseBytes: number, timeoutMs: number, signal: AbortSignal | undefined): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const requestOptions = crsHttpRequestOptions(this.endpoint, body.length, this.maxHeaderBytes, this.tls);
      const req = this.endpoint.scheme === 'https' ? https.request(requestOptions) : http.request(requestOptions);
      let settled = false;
      let serverEnded = false;

      // Единственная точка завершения: всё, что пришло после неё (ошибки после destroy), игнорируется.
      const finish = (outcome: Buffer | CrsTransportError): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        req.destroy();
        if (outcome instanceof CrsTransportError) {
          reject(outcome);
        } else {
          resolve(outcome);
        }
      };
      const onAbort = (): void => {
        finish(this.error('aborted', 'вызов отменён'));
      };
      // Общий дедлайн, а не req.setTimeout: тот считает только простой сокета, а не DNS, подключение и ответ.
      const timer = setTimeout(() => {
        finish(this.error('timeout', `нет ответа за ${String(timeoutMs)} мс`));
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });

      // Закрытие сервером до ответа Node сообщает как ECONNRESET «socket hang up» — так же, как сброс.
      // Текст ошибки не разбирается: транспорт сам отмечает конец потока от сервера. prependListener —
      // потому что обработчик Node на 'end' сокета выдаёт ошибку запроса синхронно, раньше наших.
      req.on('socket', (socket: Socket) => {
        socket.prependListener('end', () => {
          serverEnded = true;
        });
      });
      req.on('error', (cause: NodeJS.ErrnoException) => {
        if (cause.code?.startsWith('HPE_')) {
          finish(this.error('protocol', `ответ не похож на ответ HTTP (${cause.code})`));
        } else if (serverEnded) {
          finish(this.error('closed', 'сервер закрыл соединение до конца ответа'));
        } else {
          finish(this.error('unavailable', `ошибка соединения: ${cause.message}`, { cause }));
        }
      });
      req.on('response', (res: http.IncomingMessage) => {
        // У ответа клиента statusCode задан всегда.
        const status = Number(res.statusCode);
        // Объявленную длину сверяем до чтения тела; chunked-тело — по накоплению.
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > maxResponseBytes) {
          finish(this.error('too-large', `ответ ${String(declared)} Б больше лимита ${String(maxResponseBytes)} Б`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxResponseBytes) {
            finish(this.error('too-large', `ответ больше лимита ${String(maxResponseBytes)} Б`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const data = Buffer.concat(chunks);
          finish(status === 200 ? data : this.error('status', `статус ${String(status)}`, { status, body: data }));
        });
        // Обрыв на середине тела: 'end' не будет, ответ закрывается незавершённым (с ошибкой «aborted»
        // или без неё); после 'end' или finish закрытие ничего не меняет.
        const onClosed = (): void => {
          finish(this.error('closed', 'сервер закрыл соединение до конца ответа'));
        };
        res.on('error', onClosed);
        res.on('close', onClosed);
      });
      req.end(body);
    });
  }

  private error(
    kind: CrsTransportErrorKind,
    detail: string,
    extra: Omit<CrsTransportErrorDetails, 'endpoint'> = {},
  ): CrsTransportError {
    // В сообщении — только адрес и причина: тело запроса несёт хеш пароля.
    return new CrsTransportError(kind, `${this.address}: ${detail}`, { endpoint: this.address, ...extra });
  }
}
