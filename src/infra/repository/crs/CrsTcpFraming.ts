// Кадрирование протокола crs поверх tcp — чистые функции без I/O.
// Факты о байтах — docs/research/crs/08-crs-tcp-framing.md (снятые потоки example/crs/8.5.1/tcp-raw).
import { isIP } from 'net';

/**
 * Приветствие сервера: первые байты соединения, до них клиент ничего не шлёт (08, A4). Снято с 8.5.1;
 * транспорт сверяет только длину — у 8.3.x байты не проверены.
 */
export const CRS_TCP_SERVER_GREETING = Buffer.from('53f5c61a7b', 'hex');
export const CRS_TCP_SERVER_GREETING_LENGTH = 5;
/** Приветствие клиента: сигнатура, за ней 16 байт UUID в раскладке GUID (08, A5). */
export const CRS_TCP_CLIENT_HELLO_PREFIX = Buffer.from('224855b5', 'hex');
/** Стоит после тела кадра в обе стороны и не входит в Content-Length (08, A1). */
export const CRS_TCP_FRAME_TERMINATOR = Buffer.from('6653b2a6', 'hex');
export const CRS_TCP_DEFAULT_MAX_HEADER_BYTES = 16 * 1024;

export interface TcpFrameLimits {
  /** Предел блока заголовков ответа вместе с пустой строкой. */
  maxHeaderBytes: number;
  /** Предел Content-Length ответа. */
  maxResponseBytes: number;
}

export type TcpReadFailureKind = 'protocol' | 'too-large' | 'status';

export type TcpReadResult =
  | { state: 'more' }
  | { state: 'done'; body: Buffer }
  | { state: 'failed'; kind: TcpReadFailureKind; detail: string; status?: number; body?: Buffer };

const UUID = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i;
const HEADER_END = Buffer.from('\r\n\r\n', 'latin1');
const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})(?: |$)/;
const CONTENT_LENGTH = /^content-length:[ \t]*(\d+)[ \t]*$/im;

/** IPv6 в адресе tcp:// — в квадратных скобках, IPv4 и hostname — как есть. */
function tcpHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

/** `tcp://host:port` — для сообщений и details.endpoint; IPv6 в скобках. */
export function formatTcpEndpoint(host: string, port: number): string {
  return `tcp://${tcpHost(host)}:${String(port)}`;
}

/** Первые три поля GUID хранятся little-endian, остальные 8 байт — как в строке. */
function reversedHex(hex: string): Buffer {
  return Buffer.from(hex, 'hex').reverse();
}

/** Приветствие клиента: сигнатура и UUID в раскладке GUID Microsoft. */
export function encodeClientHello(clientId: string): Buffer {
  const m = UUID.exec(clientId);
  if (!m) {
    throw new RangeError('Идентификатор клиента crs должен быть UUID вида xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx');
  }
  return Buffer.concat([
    CRS_TCP_CLIENT_HELLO_PREFIX,
    reversedHex(m[1]),
    reversedHex(m[2]),
    reversedHex(m[3]),
    Buffer.from(m[4] + m[5], 'hex'),
  ]);
}

/** Кадр запроса с заголовками Конфигуратора в его порядке (08, A2) и терминатором. */
export function buildTcpRequestFrame(body: Buffer): Buffer {
  const head =
    'POST  HTTP/1.1\r\n' +
    `Content-Length: ${String(body.length)}\r\n` +
    'Accept: application/xml\r\n' +
    'Content-Type: application/xml\r\n' +
    '\r\n';
  return Buffer.concat([Buffer.from(head, 'latin1'), body, CRS_TCP_FRAME_TERMINATOR]);
}

/**
 * Инкрементальный разбор одного ответа (байты после приветствия сервера).
 * Байты после тела (терминатор, следующий кадр) не читаются: соединение на вызов одно,
 * и после тела клиент его закрывает.
 */
export class TcpFrameReader {
  private head: Buffer = Buffer.alloc(0);
  private status = 0;
  private contentLength = 0;
  private readonly bodyChunks: Buffer[] = [];
  private bodyBytes = 0;
  private headParsed = false;
  private result: TcpReadResult | undefined;

  constructor(private readonly limits: TcpFrameLimits) {}

  push(chunk: Buffer): TcpReadResult {
    if (this.result) {
      return this.result;
    }
    let data = chunk;
    if (!this.headParsed) {
      this.head = Buffer.concat([this.head, chunk]);
      const end = this.head.subarray(0, this.limits.maxHeaderBytes).indexOf(HEADER_END);
      if (end < 0) {
        return this.head.length >= this.limits.maxHeaderBytes
          ? this.fail('protocol', `заголовки ответа длиннее ${String(this.limits.maxHeaderBytes)} байт`)
          : { state: 'more' };
      }
      const failure = this.parseHead(this.head.subarray(0, end).toString('latin1'));
      if (failure) {
        return failure;
      }
      data = this.head.subarray(end + HEADER_END.length);
    }
    this.bodyChunks.push(data);
    this.bodyBytes += data.length;
    if (this.bodyBytes < this.contentLength) {
      return { state: 'more' };
    }
    const body = Buffer.concat(this.bodyChunks).subarray(0, this.contentLength);
    if (this.status !== 200) {
      return this.fail('status', `ответ со статусом ${String(this.status)}`, body);
    }
    this.result = { state: 'done', body };
    return this.result;
  }

  private parseHead(text: string): TcpReadResult | undefined {
    this.headParsed = true;
    const status = STATUS_LINE.exec(text);
    if (!status) {
      return this.fail('protocol', 'ответ не начинается со статусной строки HTTP/1.x');
    }
    const length = CONTENT_LENGTH.exec(text);
    if (!length) {
      return this.fail('protocol', 'в ответе нет Content-Length');
    }
    this.status = Number(status[1]);
    this.contentLength = Number(length[1]);
    // Лимит — до чтения тела, чтобы не копить в памяти заведомо лишнее.
    if (this.contentLength > this.limits.maxResponseBytes) {
      return this.fail(
        'too-large',
        `ответ ${String(this.contentLength)} байт больше лимита ${String(this.limits.maxResponseBytes)}`,
      );
    }
    return undefined;
  }

  private fail(kind: TcpReadFailureKind, detail: string, body?: Buffer): TcpReadResult {
    this.result = { state: 'failed', kind, detail, ...(body ? { status: this.status, body } : {}) };
    return this.result;
  }
}
