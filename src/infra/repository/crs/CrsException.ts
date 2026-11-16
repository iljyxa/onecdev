// Исключения сервера хранилища и веб-публикации: разбор нагрузки и классификация.
// crserver отвечает на отказ телом crs:call_exception (статус 200): атрибут clsid и base64 скобочного
// текста, где второй элемент корня — код ошибки. Публикация и разбор XML отвечают исключением VRS
// (статус не 200; разбор тела — parseVrsException в infra/xml/crs/CrsEnvelope). Вид ошибки определяется
// по clsid и коду, а не по тексту: текст локализован.
import type { VrsException } from '../../xml/crs/CrsEnvelope';
import {
  type BracketFormatError,
  type BracketList,
  bracketScalar,
  type BracketString,
  type BracketValue,
  parseBracketText,
} from '../OneCBracketText';
import { type CrsCallErrorKind, CrsFormatError } from './CrsErrors';

/** clsid исключений хранилища: общий для неверного пароля, отсутствующего хранилища и версии — различает код. */
export const CRS_CLSID_DEPOT = '3ccb2518-9616-4445-aaa7-20048fead174';
/** clsid исключения VRS «ошибка разбора XML» (тело запроса не XML). */
export const VRS_CLSID_XML_PARSE = 'c593fe3b-aeaf-496a-a32e-6b4dc2d13fff';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

// Коды сняты с crserver 8.5.1 (example/crs/8.5.1): 4 — неверные имя или пароль, 1 — нет хранилища
// с таким alias, 17 — версия клиента не совпала с версией сервера (в том числе 8.3.27 против 8.5.1).
const DEPOT_KINDS: ReadonlyMap<string, CrsCallErrorKind> = new Map([
  [`${CRS_CLSID_DEPOT}:4`, 'auth-failed'],
  [`${CRS_CLSID_DEPOT}:1`, 'depot-not-found'],
  [`${CRS_CLSID_DEPOT}:17`, 'version-mismatch'],
]);

export interface CrsServerException {
  readonly clsid: string;
  /** Второй элемент корня скобочного текста; NaN, если там не число. */
  readonly code: number;
  /** Непустые сообщения всех записей `{uuid,"текст",…}` обходом в глубину, сверху вниз. */
  readonly messages: readonly string[];
  /** Версия сервера из записи версии `{9f06d311-…,"",{…},"N.N.N.N"}`; нет записи — поля нет. */
  readonly serverVersion?: string;
}

/** clsid вложенной записи с версией сервера в исключении несоответствия версий (17). */
const VERSION_INFO_CLSID = '9f06d311-1431-4a54-bd6f-fa93c4d4c471';
const VERSION_FORMAT = /^\d+\.\d+\.\d+\.\d+$/;

function isQuoted(value: BracketValue | undefined): value is BracketString {
  return typeof value === 'object' && !Array.isArray(value);
}

function messagesOf(root: BracketList): string[] {
  const messages: string[] = [];
  const stack: BracketList[] = [root];
  for (let list = stack.pop(); list !== undefined; list = stack.pop()) {
    const [head, message] = list;
    if (typeof head === 'string' && UUID.test(head) && isQuoted(message) && message.quoted !== '') {
      messages.push(message.quoted);
    }
    // Детей — в обратном порядке, чтобы первым снять со стека первого.
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const child = list[i];
      if (Array.isArray(child)) {
        stack.push(child as BracketList);
      }
    }
  }
  return messages;
}

/** Разбирает base64 скобочного текста; мусор — CrsFormatError (ошибка формата скобочного разбора внутри). */
export function decodeCallException(clsid: string, base64: string): CrsServerException {
  let root: BracketList;
  try {
    root = parseBracketText(Buffer.from(base64, 'base64').toString('utf-8'));
  } catch (e) {
    // parseBracketText отказывает только BracketFormatError: смещение сохраняется, содержимое — нет.
    const error = e as BracketFormatError;
    throw new CrsFormatError(error.message, error.offset);
  }
  const serverVersion = findStructuredVersion(root);
  return { clsid, code: Number(root[1]), messages: messagesOf(root), ...(serverVersion === undefined ? {} : { serverVersion }) };
}

/**
 * Версия сервера структурно: последний скаляр вида N.N.N.N записи, начинающейся с VERSION_INFO_CLSID
 * (обход в глубину, первая такая запись). Не зависит от языка текста сообщений.
 */
export function findStructuredVersion(root: BracketList): string | undefined {
  const stack: BracketList[] = [root];
  for (let list = stack.pop(); list !== undefined; list = stack.pop()) {
    const last = bracketScalar(list[list.length - 1]);
    if (list[0] === VERSION_INFO_CLSID && last !== undefined && VERSION_FORMAT.test(last)) {
      return last;
    }
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const child = list[i];
      if (Array.isArray(child)) {
        stack.push(child as BracketList);
      }
    }
  }
  return undefined;
}

// Запасной путь, если записи версии нет. Версии клиента и сервера в тексте идут в этом порядке («Версия клиентского приложения: …
// Версия сервера хранилища конфигурации: …»), поэтому берётся последнее совпадение: первое при
// клиенте 8.3.27.2342 оказалось бы версией клиента.
const VERSION = /(?:версия|version)[^\d\n]*(\d+\.\d+\.\d+\.\d+)/giu;

export function extractServerVersion(messages: readonly string[]): string | undefined {
  const found = messages.flatMap((message) => [...message.matchAll(VERSION)].map((m) => m[1]));
  return found[found.length - 1];
}

export function classifyServerException(e: CrsServerException): { kind: CrsCallErrorKind; serverVersion?: string } {
  const kind = DEPOT_KINDS.get(`${e.clsid}:${String(e.code)}`) ?? 'server';
  return kind === 'version-mismatch' ? { kind, serverVersion: e.serverVersion ?? extractServerVersion(e.messages) } : { kind };
}

export function classifyVrsException(e: VrsException): CrsCallErrorKind {
  return e.clsid === VRS_CLSID_XML_PARSE ? 'bad-request' : 'rejected';
}
