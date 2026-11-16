// Разбор адреса хранилища — единая точка для tcp и http(s).
import type { CrsHttpEndpoint } from './CrsHttpFraming';
import type { CrsTcpEndpoint } from './CrsTcpTransport';

export const CRS_TCP_DEFAULT_PORT = 1542;
/** Alias публикации http(s) без хвоста после `.1ccr`. */
export const CRS_DEFAULT_ALIAS = 'maincr';

export type CrsAddress =
  | { readonly transport: 'tcp'; readonly endpoint: CrsTcpEndpoint; readonly alias: string }
  | { readonly transport: 'http'; readonly endpoint: CrsHttpEndpoint; readonly alias: string };

export type CrsAddressErrorReason = 'syntax' | 'scheme' | 'credentials' | 'host' | 'port' | 'path' | 'alias';

export class CrsAddressError extends Error {
  constructor(
    readonly reason: CrsAddressErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'CrsAddressError';
  }
}

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const PUBLICATION = /\.1ccr$/i;
const HTTP_DEFAULT_PORT = { http: 80, https: 443 } as const;

/**
 * `tcp://host[:port]/alias` (alias обязателен) или `http(s)://host[:port]/…/<file>.1ccr[/alias]` (без alias —
 * `maincr`). Адрес с учётными данными, query или fragment отвергается, а не очищается: вырезанный пароль
 * остался бы в настройках пользователя.
 * Исходная строка в сообщение не попадает никогда — в ней может быть пароль.
 */
export function parseCrsAddress(address: string): CrsAddress {
  const text = address.trim();
  const scheme = SCHEME.exec(text)?.[1].toLowerCase();
  if (scheme === undefined) {
    throw new CrsAddressError('syntax', 'адрес хранилища должен начинаться со схемы tcp://, http:// или https://');
  }
  if (scheme !== 'tcp' && scheme !== 'http' && scheme !== 'https') {
    throw new CrsAddressError('scheme', 'адрес хранилища: допустимы только схемы tcp, http и https');
  }
  // В query и fragment бывают токены; для адреса хранилища они не имеют смысла.
  if (!text.slice(scheme.length + 1).startsWith('//') || text.includes('?') || text.includes('#')) {
    throw new CrsAddressError('syntax', 'адрес хранилища должен быть вида схема://сервер/путь без «?» и «#»');
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    // Ошибка URL несёт исходную строку (поле input), поэтому она не пробрасывается и не идёт в cause.
    throw new CrsAddressError('syntax', 'адрес хранилища не разбирается как URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw new CrsAddressError('credentials', 'адрес хранилища не должен содержать имя пользователя и пароль');
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host === '') {
    throw new CrsAddressError('host', 'в адресе хранилища не указан сервер');
  }
  if (url.port === '0') {
    throw new CrsAddressError('port', 'порт в адресе хранилища должен быть от 1 до 65535');
  }
  const segments = pathSegments(url.pathname);
  if (scheme === 'tcp') {
    const port = url.port === '' ? CRS_TCP_DEFAULT_PORT : Number(url.port);
    return { transport: 'tcp', endpoint: { host, port }, alias: aliasOf(segments.map((s) => s.decoded)) };
  }
  const file = segments.findIndex((s) => PUBLICATION.test(s.decoded));
  if (file < 0) {
    throw new CrsAddressError('path', 'в адресе хранилища http нет пути к файлу публикации .1ccr');
  }
  const port = url.port === '' ? HTTP_DEFAULT_PORT[scheme] : Number(url.port);
  const path = `/${segments.slice(0, file + 1).map((s) => s.encoded).join('/')}`;
  // Хвоста после .1ccr нет — хранилище публикации по умолчанию: такие адреса привязок уже сохранены у пользователей.
  const tail = segments.slice(file + 1).map((s) => s.decoded);
  const alias = tail.length === 0 ? CRS_DEFAULT_ALIAS : aliasOf(tail);
  return { transport: 'http', endpoint: { scheme, host, port, path }, alias };
}

/** Сегменты пути без ведущего и одного завершающего «/»: закодированные (для запроса) и раскодированные. */
function pathSegments(pathname: string): { encoded: string; decoded: string }[] {
  const trimmed = pathname.replace(/^\//, '').replace(/\/$/, '');
  if (trimmed === '') {
    return [];
  }
  return trimmed.split('/').map((encoded) => {
    if (encoded === '') {
      throw new CrsAddressError('path', 'в пути адреса хранилища есть пустой сегмент');
    }
    try {
      return { encoded, decoded: decodeURIComponent(encoded) };
    } catch {
      throw new CrsAddressError('path', 'в пути адреса хранилища неверная %-последовательность');
    }
  });
}

function aliasOf(segments: string[]): string {
  if (segments.length === 0) {
    throw new CrsAddressError('alias', 'в адресе хранилища не указано имя хранилища');
  }
  return segments.join('/');
}
