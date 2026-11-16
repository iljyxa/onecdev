// Запрос crs по http(s) через публикацию .1ccr — чистые функции без I/O: заголовки и опции запроса.
// Факты о публикации — docs/research/crs/07-crs-http.md (снятые пробы example/crs/8.5.1/http и http-raw).
import type { RequestOptions } from 'https';
import { isIP } from 'net';

export const CRS_HTTP_DEFAULT_MAX_HEADER_BYTES = 16 * 1024;

export interface CrsHttpEndpoint {
  readonly scheme: 'http' | 'https';
  /** Без скобок для IPv6. */
  readonly host: string;
  readonly port: number;
  /** Percent-encoded, начинается с '/', оканчивается <file>.1ccr; alias в путь не входит (07). */
  readonly path: string;
}

export interface CrsTlsOptions {
  readonly ca?: string | Buffer | readonly (string | Buffer)[];
  /** По умолчанию true. */
  readonly rejectUnauthorized?: boolean;
  /** По умолчанию host, если он не IP. */
  readonly servername?: string;
}

/** IPv6 в URL и заголовке Host — в квадратных скобках. */
function urlHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

/** `http://host:port/path` — для сообщений и details.endpoint; IPv6 в скобках. */
export function formatHttpEndpoint(endpoint: CrsHttpEndpoint): string {
  return `${endpoint.scheme}://${urlHost(endpoint.host)}:${String(endpoint.port)}${endpoint.path}`;
}

/** Порядок как в http/probe-valid/request.headers.txt: Host, Content-Type, Accept, Content-Length, Connection. */
export function crsHttpHeaders(endpoint: CrsHttpEndpoint, contentLength: number): Record<string, string> {
  // Порт по умолчанию в Host не пишется — так делает Node; Конфигуратор снят только на нестандартном порту.
  const defaultPort = endpoint.scheme === 'https' ? 443 : 80;
  const host = urlHost(endpoint.host) + (endpoint.port === defaultPort ? '' : `:${String(endpoint.port)}`);
  return {
    Host: host,
    'Content-Type': 'application/xml',
    Accept: 'application/xml',
    'Content-Length': String(contentLength),
    // Соединение на вызов: сервер закрывает его сам, клиент — при любом исходе.
    Connection: 'close',
  };
}

/** Опции http(s).request: POST, agent: false, maxHeaderSize; TLS-поля только для https. */
export function crsHttpRequestOptions(
  endpoint: CrsHttpEndpoint,
  contentLength: number,
  maxHeaderBytes: number,
  tls: CrsTlsOptions = {},
): RequestOptions {
  // Все пять заголовков заданы явно, а агента нет: Node не дописывает своих заголовков и не держит пул.
  const options: RequestOptions = {
    host: endpoint.host,
    port: endpoint.port,
    method: 'POST',
    path: endpoint.path,
    headers: crsHttpHeaders(endpoint, contentLength),
    agent: false,
    maxHeaderSize: maxHeaderBytes,
  };
  if (endpoint.scheme === 'http') {
    return options;
  }
  const { ca } = tls;
  if (ca !== undefined) {
    options.ca = typeof ca === 'string' || Buffer.isBuffer(ca) ? ca : [...ca];
  }
  options.rejectUnauthorized = tls.rejectUnauthorized ?? true;
  // SNI по IP-адресу недопустим (RFC 6066), поэтому по умолчанию — только для DNS-имени.
  const servername = tls.servername ?? (isIP(endpoint.host) === 0 ? endpoint.host : undefined);
  if (servername !== undefined) {
    options.servername = servername;
  }
  return options;
}
