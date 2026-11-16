// Конверт crs:call: сборка тела запроса и разбор тела ответа, исключение VRS веб-публикации и маскировка
// секретов в телах. Формат повторяет Конфигуратор побайтно (example/crs/8.5.1): BOM, декларация, атрибуты
// корня в его порядке, пустые элементы самозакрывающиеся.
import { CrsFormatError } from '../../repository/crs/CrsErrors';
import { type CrsServerException, decodeCallException } from '../../repository/crs/CrsException';
import { escapeXmlAttribute } from '../XmlUtils';
import { attributeOf, parseCrsXml, type CrsXmlElement } from './CrsXmlReader';

export const CRS_NAMESPACE = 'http://v8.1c.ru/8.2/crs';

const BOM = '\uFEFF';
const DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/** Элемент параметров в пространстве crs; без детей — самозакрывающийся. */
export interface CrsElement {
  /** Локальное имя без `crs:`. */
  readonly name: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly children?: readonly CrsElement[];
}

/** Скалярный параметр: `<crs:name value="…"/>`. */
export function crsValue(name: string, value: string | number | boolean): CrsElement {
  return { name, attributes: { value: String(value) } };
}

export interface CrsAuth {
  readonly user: string;
  /** Хеш пароля (crsPasswordHash), не сам пароль. */
  readonly passwordHash: string;
}

export interface CrsCallSpec {
  readonly alias: string;
  readonly method: string;
  readonly version: string;
  readonly auth?: CrsAuth;
  readonly bindId?: string;
  /** Всегда `<crs:params>`; пустой список — `<crs:params/>`. */
  readonly params?: readonly CrsElement[];
}

function attributesXml(attributes: Readonly<Record<string, string>>): string {
  return Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeXmlAttribute(value)}"`)
    .join('');
}

// Итеративная запись: вложенность параметров задаёт вызывающий, стек вызовов от неё не зависит.
function elementXml(root: CrsElement): string {
  const out: string[] = [];
  const stack: (CrsElement | string)[] = [root];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    const children = item.children ?? [];
    const head = `<crs:${item.name}${attributesXml(item.attributes ?? {})}`;
    if (children.length === 0) {
      out.push(`${head}/>`);
      continue;
    }
    out.push(`${head}>`);
    stack.push(`</crs:${item.name}>`, ...[...children].reverse());
  }
  return out.join('');
}

/** UTF-8 с BOM, декларация, атрибуты корня в порядке xmlns:crs, alias, name, version. */
export function buildCallBody(call: CrsCallSpec): Buffer {
  const parts = [
    BOM,
    DECLARATION,
    `<crs:call${attributesXml({ 'xmlns:crs': CRS_NAMESPACE, alias: call.alias, name: call.method, version: call.version })}>`,
  ];
  if (call.auth !== undefined) {
    parts.push(elementXml({ name: 'auth', attributes: { user: call.auth.user, password: call.auth.passwordHash } }));
  }
  if (call.bindId !== undefined) {
    parts.push(elementXml({ name: 'bind', attributes: { bindID: call.bindId } }));
  }
  parts.push(elementXml({ name: 'params', children: call.params }), '</crs:call>');
  return Buffer.from(parts.join(''), 'utf-8');
}

export type CrsResponse =
  | { readonly kind: 'return'; readonly element: CrsXmlElement }
  | { readonly kind: 'exception'; readonly exception: CrsServerException }
  /** Тело из одного BOM: так crserver отвечает на неизвестный метод. */
  | { readonly kind: 'empty' };

/** Разбирает тело ответа со статусом 200; иное, чем call_return / call_exception / пусто, — CrsFormatError. */
export function parseCallResponse(body: Buffer): CrsResponse {
  const text = body.toString('utf-8');
  if (text.replace(/^\uFEFF/, '') === '') {
    return { kind: 'empty' };
  }
  const root = parseCrsXml(text);
  if (root.namespace === CRS_NAMESPACE && root.local === 'call_return') {
    return { kind: 'return', element: root };
  }
  if (root.namespace === CRS_NAMESPACE && root.local === 'call_exception') {
    return { kind: 'exception', exception: decodeCallException(attributeOf(root, 'clsid'), root.text) };
  }
  throw new CrsFormatError(`ответ crs: неожиданный корневой элемент ${root.name}`);
}

export const VRS_NAMESPACE = 'http://v8.1c.ru/8.2/virtual-resource-system';
const CORE_NAMESPACE = 'http://v8.1c.ru/8.1/data/core';

export interface VrsException {
  readonly clsid: string;
  /** HTTP-статус отказа публикации; у исключения разбора XML его нет. */
  readonly reason: number | undefined;
  readonly description: string;
}

/** Тело исключения VRS (статус не 200); не XML или не исключение VRS — undefined. */
export function parseVrsException(body: Buffer): VrsException | undefined {
  let root: CrsXmlElement;
  try {
    root = parseCrsXml(body.toString('utf-8'));
  } catch {
    return undefined;
  }
  if (root.namespace !== VRS_NAMESPACE || root.local !== 'exception') {
    return undefined;
  }
  const reason = attributeOf(root, 'reason');
  return {
    clsid: attributeOf(root, 'clsid'),
    reason: reason === '' ? undefined : Number(reason),
    description: root.children
      .filter((child) => child.namespace === CORE_NAMESPACE && child.local === 'descr')
      .map((child) => child.text)
      .join('\n'),
  };
}

export const CRS_SECRET_MASK = '***';

// Хеш пароля равнозначен паролю (сервер сверяет именно его), поэтому в логи не попадает ни в запросах, ни
// в ответах: crs:auth password="…" в запросах и <crs:password value="…"/> в authenticate и ответах
// (devObjectsStatistic и depotUsers возвращают хеши всех пользователей хранилища).
const SECRETS = /(<crs:auth\b[^>]*?\spassword="|<crs:password\s+value=")[^"]*"/g;

/** Заменяет хеши паролей маской; повторное применение ничего не меняет. */
export function maskCrsSecrets(text: string): string {
  return text.replace(SECRETS, `$1${CRS_SECRET_MASK}"`);
}
