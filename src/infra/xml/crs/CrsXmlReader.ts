// Узкий XML-ридер для тел crserver и веб-публикации. XML там машинный: без DTD, CDATA, комментариев и
// числовых ссылок, из сущностей встречается только &quot;. Поэтому вместо зависимости — свой разбор:
// сущности раскрываются только пять предопределённых (внешние сущности и XXE невозможны), обход
// итеративный — глубина вложенности не упирается в стек вызовов.
import { CrsFormatError } from '../../repository/crs/CrsErrors';

export interface CrsXmlElement {
  /** Имя с префиксом, как в документе: `crs:call_return`. */
  readonly name: string;
  /** Локальное имя без префикса: `call_return`. */
  readonly local: string;
  /** Пространство имён по xmlns в области видимости; не объявлено — undefined. */
  readonly namespace: string | undefined;
  /** Атрибуты в порядке документа, сущности раскрыты, объявления xmlns включены. */
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly CrsXmlElement[];
  /** Собственный текст элемента, сущности раскрыты, переводы строк не нормализуются. */
  readonly text: string;
}

/** Открытый элемент: дети и текст ещё дополняются; область пространств имён — для вложенных. */
interface OpenElement {
  readonly element: CrsXmlElement & { readonly children: CrsXmlElement[]; text: string };
  readonly scope: ReadonlyMap<string, string>;
}

const NO_SCOPE: ReadonlyMap<string, string> = new Map();

const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

// Значение атрибута и текст: & допустим только в составе предопределённой сущности — иначе тело не то,
// что мы умеем читать, и отказ выдаёт общая проверка разметки.
const CHARS = String.raw`(?:[^<&]|&(?:lt|gt|amp|quot|apos);)`;
const NAME = String.raw`[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?`;
const OPEN_TAG = new RegExp(String.raw`<(${NAME})((?:\s+${NAME}="${CHARS.replace('<&', '<&"')}*")*)\s*(/?)>`, 'y');
const ATTRIBUTE = new RegExp(String.raw`(${NAME})="([^"]*)"`, 'g');
const TEXT = new RegExp(`^${CHARS}*$`);
const INSTRUCTION = /<\?[\s\S]*?\?>/y;

function decode(value: string): string {
  return value.replace(/&(lt|gt|amp|quot|apos);/g, (_, name: string) => ENTITIES[name]);
}

function scopeOf(parent: ReadonlyMap<string, string>, attributes: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  let scope = parent;
  for (const [name, value] of attributes) {
    // `xmlns` — пространство по умолчанию (префикс ''), `xmlns:p` — префикс p.
    if (name === 'xmlns' || name.startsWith('xmlns:')) {
      scope = new Map([...scope, [name.slice('xmlns:'.length), value]]);
    }
  }
  return scope;
}

/** Разбирает документ: BOM, декларация и инструкции обработки до корня допускаются; иное — CrsFormatError. */
export function parseCrsXml(source: string): CrsXmlElement {
  const s = source.replace(/^\uFEFF/, '');
  const open: OpenElement[] = [];
  let root: CrsXmlElement | undefined;
  let pos = 0;
  const close = (): void => {
    const [{ element }] = open.splice(-1);
    if (open.length === 0) {
      root = element;
    }
  };
  while (pos < s.length) {
    if (root !== undefined) {
      throw new CrsFormatError('XML: лишнее после корневого элемента', pos);
    }
    const current = open[open.length - 1] as OpenElement | undefined;
    if (s[pos] !== '<') {
      const lt = s.indexOf('<', pos);
      const end = lt < 0 ? s.length : lt;
      const chunk = s.slice(pos, end);
      if (current === undefined || !TEXT.test(chunk)) {
        throw new CrsFormatError('XML: текст вне элемента или недопустимый символ', pos);
      }
      current.element.text += decode(chunk);
      pos = end;
      continue;
    }
    INSTRUCTION.lastIndex = pos;
    if (INSTRUCTION.test(s)) {
      pos = INSTRUCTION.lastIndex;
      continue;
    }
    // Закрывающий тег обязан совпасть с последним открытым — иначе это общая ошибка разметки ниже.
    if (current !== undefined && s.startsWith(`</${current.element.name}>`, pos)) {
      pos += current.element.name.length + 3;
      close();
      continue;
    }
    OPEN_TAG.lastIndex = pos;
    const tag = OPEN_TAG.exec(s);
    if (tag === null) {
      throw new CrsFormatError('XML: неверная или незавершённая разметка', pos);
    }
    pos = OPEN_TAG.lastIndex;
    const [, name, rawAttributes, selfClosing] = tag;
    const attributes = new Map<string, string>();
    for (const [, attribute, value] of rawAttributes.matchAll(ATTRIBUTE)) {
      attributes.set(attribute, decode(value));
    }
    const scope = scopeOf(current?.scope ?? NO_SCOPE, attributes);
    const colon = name.indexOf(':');
    const element = {
      name,
      local: name.slice(colon + 1),
      namespace: scope.get(name.slice(0, Math.max(colon, 0))),
      attributes,
      children: [] as CrsXmlElement[],
      text: '',
    };
    current?.element.children.push(element);
    open.push({ element, scope });
    if (selfClosing === '/') {
      close();
    }
  }
  if (root === undefined) {
    throw new CrsFormatError('XML: документ пуст или не завершён', s.length);
  }
  return root;
}

export function childElement(parent: CrsXmlElement, namespace: string | undefined, local: string): CrsXmlElement | undefined {
  return parent.children.find((child) => child.namespace === namespace && child.local === local);
}

/** Значение атрибута или пустая строка, если его нет: для crserver это равнозначно. */
export function attributeOf(element: CrsXmlElement, name: string): string {
  return element.attributes.get(name) ?? '';
}
