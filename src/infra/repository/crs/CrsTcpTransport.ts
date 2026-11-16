// Транспорт crs по tcp: одно соединение на вызов. Сервер соединение сам не закрывает и готов его
// переиспользовать (08, A3), но отдельное соединение проще: итог вызова однозначен, а сокет
// гарантированно закрывается клиентом при любом исходе.
import { randomUUID } from 'crypto';
import * as net from 'net';
import {
  buildTcpRequestFrame,
  CRS_TCP_DEFAULT_MAX_HEADER_BYTES,
  CRS_TCP_SERVER_GREETING_LENGTH,
  encodeClientHello,
  formatTcpEndpoint,
  TcpFrameReader,
  type TcpFrameLimits,
} from './CrsTcpFraming';
import {
  CRS_DEFAULT_MAX_RESPONSE_BYTES,
  CRS_DEFAULT_TIMEOUT_MS,
  CRS_MAX_TIMER_MS,
  crsPositiveOption,
  type CrsCallOptions,
  type CrsTransport,
  CrsTransportError,
  type CrsTransportErrorDetails,
  type CrsTransportErrorKind,
} from './CrsTransport';

export interface CrsTcpEndpoint {
  host: string;
  port: number;
}

export interface CrsTcpTransportOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxHeaderBytes?: number;
  /** UUID клиента в приветствии; по умолчанию случайный, один на экземпляр (как у процесса 1cv8, 08 A5). */
  clientId?: string;
}

export class CrsTcpTransport implements CrsTransport {
  readonly clientId: string;
  private readonly hello: Buffer;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxHeaderBytes: number;
  private readonly address: string;

  constructor(
    private readonly endpoint: CrsTcpEndpoint,
    options: CrsTcpTransportOptions = {},
  ) {
    this.timeoutMs = crsPositiveOption('timeoutMs', options.timeoutMs ?? CRS_DEFAULT_TIMEOUT_MS, CRS_MAX_TIMER_MS);
    this.maxResponseBytes = crsPositiveOption('maxResponseBytes', options.maxResponseBytes ?? CRS_DEFAULT_MAX_RESPONSE_BYTES);
    this.maxHeaderBytes = crsPositiveOption('maxHeaderBytes', options.maxHeaderBytes ?? CRS_TCP_DEFAULT_MAX_HEADER_BYTES);
    this.clientId = options.clientId ?? randomUUID();
    this.hello = encodeClientHello(this.clientId);
    this.address = formatTcpEndpoint(endpoint.host, endpoint.port);
  }

  async call(body: Buffer, options: CrsCallOptions = {}): Promise<Buffer> {
    const timeoutMs = crsPositiveOption('timeoutMs', options.timeoutMs ?? this.timeoutMs, CRS_MAX_TIMER_MS);
    const limits: TcpFrameLimits = {
      maxHeaderBytes: this.maxHeaderBytes,
      maxResponseBytes: crsPositiveOption('maxResponseBytes', options.maxResponseBytes ?? this.maxResponseBytes),
    };
    if (options.signal?.aborted) {
      throw this.error('aborted', 'вызов отменён');
    }
    // Кадр собирается до подключения, чтобы после приветствия отправить всё одной записью.
    const request = Buffer.concat([this.hello, buildTcpRequestFrame(body)]);
    return this.exchange(request, limits, timeoutMs, options.signal);
  }

  private exchange(request: Buffer, limits: TcpFrameLimits, timeoutMs: number, signal: AbortSignal | undefined): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const socket = net.connect({ host: this.endpoint.host, port: this.endpoint.port });
      const reader = new TcpFrameReader(limits);
      let greeting: Buffer | undefined = Buffer.alloc(0);
      let settled = false;

      // Единственная точка завершения: всё, что пришло после неё (close после destroy,
      // запоздалая ошибка сокета), игнорируется.
      const finish = (outcome: Buffer | CrsTransportError): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        socket.destroy();
        if (outcome instanceof CrsTransportError) {
          reject(outcome);
        } else {
          resolve(outcome);
        }
      };
      const onAbort = (): void => {
        finish(this.error('aborted', 'вызов отменён'));
      };
      const timer = setTimeout(() => {
        finish(this.error('timeout', `нет ответа за ${String(timeoutMs)} мс`));
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });

      const readResponse = (chunk: Buffer): void => {
        const result = reader.push(chunk);
        if (result.state === 'done') {
          finish(result.body);
        } else if (result.state === 'failed') {
          finish(this.error(result.kind, result.detail, { status: result.status, body: result.body }));
        }
      };

      socket.on('data', (chunk: Buffer) => {
        if (!greeting) {
          readResponse(chunk);
          return;
        }
        // Клиент молчит, пока не получит приветствие сервера целиком (08, A4).
        greeting = Buffer.concat([greeting, chunk]);
        if (greeting.length < CRS_TCP_SERVER_GREETING_LENGTH) {
          return;
        }
        // Содержимое приветствия не сверяется: байты сняты только с crserver 8.5.1, а у 8.3.x не проверены —
        // сверка отбила бы рабочий сервер. Не-crserver отбивается разбором кадра ответа (TcpFrameReader).
        const rest = greeting.subarray(CRS_TCP_SERVER_GREETING_LENGTH);
        greeting = undefined;
        socket.write(request);
        readResponse(rest);
      });
      socket.on('error', (cause: Error) => {
        finish(this.error('unavailable', `ошибка соединения: ${cause.message}`, { cause }));
      });
      socket.on('close', () => {
        finish(this.error('closed', 'сервер закрыл соединение до конца ответа'));
      });
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
