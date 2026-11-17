import { SERVICE_DIR_NAME } from '../fs/LegacyServiceDirMigration';

/**
 * Правка `bsl-analyzer.toml` без TOML-библиотеки: файл пишет и пользователь, поэтому нужен не
 * парсер «прочитал → сериализовал» (он теряет комментарии, порядок и форматирование), а сканер
 * записей с точечной заменой текста. Всё, что сканер не понимает уверенно, отдаётся как
 * `unsupported-format` — лучше не тронуть конфиг, чем испортить его.
 *
 * Функции модуля чистые и ожидают текст без BOM с переводами строк LF; BOM/CRLF исходного файла
 * восстанавливает вызывающий сервис (`preserveBomAndEol`).
 */

/** Элемент `[source].exclude`, который расширение поддерживает само. `.v8vscedit` мигрируется до старта и не исключается. */
export const SERVICE_EXCLUDE_ENTRY: string = SERVICE_DIR_NAME;

const SOURCE_HEADER = '[source]';
const ROOT_LINE = 'root = "src/cf"\n';
const SERVICE_ITEM_RAW = `"${SERVICE_EXCLUDE_ENTRY}"`;
const DEFAULT_ITEM_INDENT = '  ';

export interface SourceSectionRange {
  /** Начало строки заголовка `[source]`. */
  readonly start: number;
  /** Начало первой строки после заголовка. */
  readonly bodyStart: number;
  /** Начало следующего заголовка таблицы (включая `[source.*]`) или конец текста. */
  readonly end: number;
}

export interface TomlEntry {
  readonly key: string;
  readonly start: number;
  /** Конец записи, включая завершающий перевод строки (если он есть). */
  readonly end: number;
  /** Значение без хвостового комментария и окружающих пробелов. */
  readonly valueText: string;
}

export interface TomlStringArrayItem {
  readonly raw: string;
  readonly value: string;
}

export interface TomlStringArray {
  readonly items: readonly TomlStringArrayItem[];
  readonly multiline: boolean;
  /** Отступ первого элемента многострочного массива — с ним вставляется новый элемент. */
  readonly itemIndent: string;
}

export type ServiceExcludeMode = 'ensure' | 'remove';

export type ServiceExcludeEdit =
  | { readonly status: 'changed'; readonly content: string }
  | { readonly status: 'unchanged' }
  | { readonly status: 'unsupported-format'; readonly detail: string };

type LineKind = 'blank' | 'comment' | 'header' | 'entry' | 'other';

interface LogicalLine {
  readonly kind: LineKind;
  readonly start: number;
  readonly end: number;
}

interface EntryLine extends LogicalLine {
  readonly kind: 'entry';
  readonly key: string;
  readonly valueStart: number;
  readonly valueEnd: number;
}

interface ArrayItemDetail extends TomlStringArrayItem {
  readonly start: number;
  readonly end: number;
  readonly commaAfter: boolean;
}

interface ArrayDetail {
  readonly items: ArrayItemDetail[];
  readonly close: number;
  readonly multiline: boolean;
}

interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export function findSourceSectionRange(content: string): SourceSectionRange | undefined {
  const lines = scanLogicalLines(content);
  const headerIndex = lines.findIndex((line) => line.kind === 'header' && isSourceHeader(content.slice(line.start, line.end)));
  if (headerIndex < 0) {
    return undefined;
  }
  const header = lines[headerIndex];
  const next = lines.slice(headerIndex + 1).find((line) => line.kind === 'header');
  return { start: header.start, bodyStart: header.end, end: next ? next.start : content.length };
}

export function scanSectionEntries(body: string): TomlEntry[] {
  return scanEntries(body).map((entry) => ({
    key: entry.key,
    start: entry.start,
    end: entry.end,
    valueText: body.slice(entry.valueStart, entry.valueEnd),
  }));
}

export function parseTomlStringArray(valueText: string): TomlStringArray | undefined {
  const detail = parseArrayDetailed(valueText);
  if (!detail) {
    return undefined;
  }
  return {
    items: detail.items.map((item) => ({ raw: item.raw, value: item.value })),
    multiline: detail.multiline,
    itemIndent: detail.multiline ? multilineIndent(valueText, detail) : '',
  };
}

/** Служебный ли элемент: `./.onecdev`, `.onecdev/` и обратные слэши Windows — та же запись. */
export function isServiceExcludeItem(value: string): boolean {
  return value.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '') === SERVICE_EXCLUDE_ENTRY;
}

export function buildBslAnalyzerSourceConfig(
  extensionPaths: readonly string[],
  options: { serviceExclude?: boolean } = {}
): string {
  let result = `${SOURCE_HEADER}\n${ROOT_LINE}`;
  if (options.serviceExclude) {
    result += serviceExcludeLine();
  }
  if (extensionPaths.length > 0) {
    result += `\n${buildExtensionsEntry(extensionPaths)}`;
  }
  return result;
}

/**
 * Меняет в `[source]` только `root` и `extensions` — каждую запись на её месте; остальные записи
 * (`exclude`, `exclude_globs`, `externals`), комментарии и пустые строки остаются дословно.
 * Недостающий `root` встаёт в начало секции, недостающие `extensions` — сразу после `root`.
 */
export function mergeSourceLayout(content: string, extensionPaths: readonly string[]): string {
  const range = findSourceSectionRange(content);
  if (!range) {
    return appendSection(content, buildBslAnalyzerSourceConfig(extensionPaths));
  }
  const header = content.slice(0, range.bodyStart);
  const body = content.slice(range.bodyStart, range.end);
  const entries = scanEntries(body);
  const root = entries.find((entry) => entry.key === 'root');
  const extensions = entries.find((entry) => entry.key === 'extensions');
  const extensionsText = extensionPaths.length > 0 ? buildExtensionsEntry(extensionPaths) : '';

  const edits: TextEdit[] = [];
  if (root) {
    edits.push({ start: root.start, end: root.end, text: ROOT_LINE });
  } else {
    edits.push({ start: 0, end: 0, text: ROOT_LINE + (!extensions && extensionsText ? `\n${extensionsText}` : '') });
  }
  if (extensions) {
    edits.push(extensionsText
      ? { start: extensions.start, end: extensions.end, text: extensionsText }
      // Пустая строка перед удаляемым блоком — его разделитель (так его пишет генератор);
      // без неё повторные включения/отключения расширений копили бы пустые строки.
      : { start: precedingBlankLineStart(body, extensions.start), end: extensions.end, text: '' });
  } else if (extensionsText && root) {
    edits.push({ start: root.end, end: root.end, text: `\n${extensionsText}` });
  }
  // Заголовок без перевода строки бывает только в конце файла — тогда root вставляется всегда.
  const safeHeader = header.endsWith('\n') ? header : `${header}\n`;
  return safeHeader + applyEdits(body, edits) + content.slice(range.end);
}

/**
 * `ensure` — добавить служебный элемент в `[source].exclude` (только аддитивно), `remove` —
 * убрать только его (пустой массив — вместе с ключом). Пользовательские элементы не трогаются.
 */
export function applyServiceExclude(content: string, mode: ServiceExcludeMode): ServiceExcludeEdit {
  const range = findSourceSectionRange(content);
  if (!range) {
    const inlineKey = findRootSourceKey(content);
    if (inlineKey) {
      return {
        status: 'unsupported-format',
        detail: `секция source задана ключом «${inlineKey}» без заголовка [source] — такую запись расширение не правит`,
      };
    }
    return mode === 'remove'
      ? { status: 'unchanged' }
      : { status: 'changed', content: appendSection(content, `${SOURCE_HEADER}\n${serviceExcludeLine()}`) };
  }

  const body = content.slice(range.bodyStart, range.end);
  const entries = scanEntries(body);
  const exclude = entries.find((entry) => entry.key === 'exclude');
  if (!exclude) {
    if (mode === 'remove') {
      return { status: 'unchanged' };
    }
    const afterLast = entries.length > 0 ? entries[entries.length - 1].end : 0;
    return { status: 'changed', content: insertLine(content, range.bodyStart + afterLast, serviceExcludeLine()) };
  }

  const valueText = body.slice(exclude.valueStart, exclude.valueEnd);
  const array = parseArrayDetailed(valueText);
  if (!array) {
    return {
      status: 'unsupported-format',
      detail: `[source].exclude не является списком строк без комментариев внутри: ${valueText}`,
    };
  }
  const valueStart = range.bodyStart + exclude.valueStart;
  const replaceValue = (next: string): ServiceExcludeEdit => ({
    status: 'changed',
    content: content.slice(0, valueStart) + next + content.slice(valueStart + valueText.length),
  });
  const hasService = array.items.some((item) => isServiceExcludeItem(item.value));

  if (mode === 'ensure') {
    if (hasService) {
      return { status: 'unchanged' };
    }
    return replaceValue(array.multiline
      ? appendMultilineItem(valueText, array)
      : `[${[...array.items.map((item) => item.raw), SERVICE_ITEM_RAW].join(', ')}]`);
  }

  if (!hasService) {
    return { status: 'unchanged' };
  }
  const remaining = array.items.filter((item) => !isServiceExcludeItem(item.value));
  if (remaining.length === 0) {
    const start = range.bodyStart + exclude.start;
    return { status: 'changed', content: content.slice(0, start) + content.slice(range.bodyStart + exclude.end) };
  }
  return replaceValue(array.multiline
    ? removeMultilineItems(valueText, array)
    : `[${remaining.map((item) => item.raw).join(', ')}]`);
}

function serviceExcludeLine(): string {
  return `exclude = [${SERVICE_ITEM_RAW}]\n`;
}

function buildExtensionsEntry(extensionPaths: readonly string[]): string {
  const items = extensionPaths.map((extensionPath) => `  "${escapeTomlString(extensionPath)}",\n`).join('');
  return `extensions = [\n${items}]\n`;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isSourceHeader(line: string): boolean {
  return /^\s*\[\s*source\s*\]\s*(#.*)?\s*$/.test(line);
}

/** Ключ корневой таблицы, задающий `source` без заголовка: `source.exclude = …` или `source = {…}`. */
function findRootSourceKey(content: string): string | undefined {
  for (const line of scanLogicalLines(content)) {
    if (line.kind === 'header') {
      return undefined;
    }
    if (line.kind === 'entry') {
      const key = (line as EntryLine).key;
      if (key === 'source' || key.startsWith('source.')) {
        return key;
      }
    }
  }
  return undefined;
}

function appendSection(content: string, section: string): string {
  if (content.trim().length === 0) {
    return section;
  }
  let base = content.endsWith('\n') ? content : `${content}\n`;
  if (!base.endsWith('\n\n')) {
    base += '\n';
  }
  return base + section;
}

function insertLine(content: string, at: number, line: string): string {
  const separator = at > 0 && content[at - 1] !== '\n' ? '\n' : '';
  return content.slice(0, at) + separator + line + content.slice(at);
}

function precedingBlankLineStart(text: string, start: number): number {
  if (start === 0) {
    return 0;
  }
  const previousStart = text.lastIndexOf('\n', start - 2) + 1;
  return text.slice(previousStart, start - 1).trim().length === 0 ? previousStart : start;
}

function applyEdits(text: string, edits: readonly TextEdit[]): string {
  // С конца, чтобы позиции ещё не применённых правок не сдвигались; при равном начале сначала
  // удаление, затем вставка — иначе вставленный текст попал бы под удаление.
  return [...edits]
    .sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), text);
}

function appendMultilineItem(valueText: string, array: ArrayDetail): string {
  const indent = multilineIndent(valueText, array);
  const line = `${indent}${SERVICE_ITEM_RAW},\n`;
  const closeLineStart = valueText.lastIndexOf('\n', array.close - 1) + 1;
  let result = valueText.slice(closeLineStart, array.close).trim().length === 0
    ? valueText.slice(0, closeLineStart) + line + valueText.slice(closeLineStart)
    : `${valueText.slice(0, array.close)}\n${line}${valueText.slice(array.close)}`;
  const last = array.items.length > 0 ? array.items[array.items.length - 1] : undefined;
  if (last && !last.commaAfter) {
    // Запятая встаёт раньше любой из вставок выше, поэтому её позиция не сдвинута.
    result = `${result.slice(0, last.end)},${result.slice(last.end)}`;
  }
  return result;
}

function removeMultilineItems(valueText: string, array: ArrayDetail): string {
  let result = valueText;
  const service = array.items.filter((item) => isServiceExcludeItem(item.value)).reverse();
  for (const item of service) {
    const lineStart = result.lastIndexOf('\n', item.start - 1) + 1;
    // Запятая может отделяться пробелами (`"x" ,`) — снимается вместе с ними, иначе в массиве
    // осталась бы висящая запятая.
    let after = skipInlineSpaces(result, item.end);
    if (result[after] === ',') {
      after = skipInlineSpaces(result, after + 1);
    }
    const aloneOnLine = result.slice(lineStart, item.start).trim().length === 0 && result[after] === '\n';
    result = aloneOnLine
      ? result.slice(0, lineStart) + result.slice(after + 1)
      : result.slice(0, item.start) + result.slice(after);
  }
  return result;
}

function skipInlineSpaces(text: string, from: number): number {
  let position = from;
  while (text[position] === ' ' || text[position] === '\t') {
    position++;
  }
  return position;
}

function multilineIndent(valueText: string, array: ArrayDetail): string {
  if (array.items.length === 0) {
    return DEFAULT_ITEM_INDENT;
  }
  const first = array.items[0];
  const lineStart = valueText.lastIndexOf('\n', first.start - 1) + 1;
  // Первый элемент на строке с `[` — отступа как образца нет.
  return lineStart === 0 ? DEFAULT_ITEM_INDENT : valueText.slice(lineStart, first.start);
}

// ── Сканер логических строк ────────────────────────────────────────────────

function scanLogicalLines(text: string): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let position = 0;
  while (position < text.length) {
    const line = scanLogicalLine(text, position);
    lines.push(line);
    position = line.end;
  }
  return lines;
}

function scanEntries(text: string): EntryLine[] {
  return scanLogicalLines(text).filter((line): line is EntryLine => line.kind === 'entry');
}

function lineEndAfter(text: string, position: number): number {
  const newline = text.indexOf('\n', position);
  return newline < 0 ? text.length : newline + 1;
}

function scanLogicalLine(text: string, start: number): LogicalLine {
  let i = start;
  while (text[i] === ' ' || text[i] === '\t' || text[i] === '\r') {
    i++;
  }
  if (i >= text.length || text[i] === '\n') {
    return { kind: 'blank', start, end: lineEndAfter(text, start) };
  }
  const first = text[i];
  if (first === '#') {
    return { kind: 'comment', start, end: lineEndAfter(text, start) };
  }
  if (first === '[') {
    return { kind: 'header', start, end: lineEndAfter(text, start) };
  }
  const equals = findKeyEquals(text, i);
  if (equals < 0) {
    return { kind: 'other', start, end: lineEndAfter(text, start) };
  }
  return scanEntryValue(text, start, normalizeKey(text.slice(i, equals)), equals + 1);
}

/** Значение может занимать несколько строк: запись кончается переводом строки на нулевой глубине скобок. */
function scanEntryValue(text: string, start: number, key: string, valueFrom: number): EntryLine {
  let depth = 0;
  let valueLimit: number | undefined;
  let j = valueFrom;
  let end = text.length;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '"' || ch === '\'') {
      j = skipString(text, j);
      continue;
    }
    if (ch === '#') {
      if (depth === 0) {
        valueLimit = j;
      }
      j = text.indexOf('\n', j);
      if (j < 0) {
        break;
      }
      continue;
    }
    if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
    } else if (ch === '\n' && depth === 0) {
      end = j + 1;
      break;
    }
    j++;
  }
  const limit = valueLimit ?? (text[end - 1] === '\n' ? end - 1 : end);
  const raw = text.slice(valueFrom, limit);
  const valueStart = valueFrom + (raw.length - raw.trimStart().length);
  return { kind: 'entry', start, end, key, valueStart, valueEnd: valueFrom + raw.trimEnd().length };
}

function findKeyEquals(text: string, from: number): number {
  let k = from;
  while (k < text.length && text[k] !== '\n') {
    const ch = text[k];
    if (ch === '"' || ch === '\'') {
      k = skipString(text, k);
      continue;
    }
    if (ch === '=') {
      return k;
    }
    k++;
  }
  return -1;
}

function normalizeKey(raw: string): string {
  return raw
    .split('.')
    .map((part) => part.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
    .join('.');
}

/** Позиция сразу за строкой, начинающейся в `start`; незакрытая однострочная строка обрывается на переводе строки. */
function skipString(text: string, start: number): number {
  const quote = text[start];
  const triple = quote.repeat(3);
  if (text.startsWith(triple, start)) {
    let k = start + 3;
    while (k < text.length) {
      if (quote === '"' && text[k] === '\\') {
        k += 2;
      } else if (text.startsWith(triple, k)) {
        return k + 3;
      } else {
        k++;
      }
    }
    return text.length;
  }
  let k = start + 1;
  while (k < text.length) {
    const ch = text[k];
    if (ch === '\n') {
      return k;
    }
    if (quote === '"' && ch === '\\') {
      k += 2;
      continue;
    }
    if (ch === quote) {
      return k + 1;
    }
    k++;
  }
  return text.length;
}

// ── Разбор массива строк ───────────────────────────────────────────────────

function parseArrayDetailed(text: string): ArrayDetail | undefined {
  if (!text.startsWith('[')) {
    return undefined;
  }
  const items: ArrayItemDetail[] = [];
  let expectItem = true;
  let i = 1;
  for (;;) {
    while (i < text.length && ' \t\r\n'.includes(text[i])) {
      i++;
    }
    if (i >= text.length) {
      return undefined;
    }
    const ch = text[i];
    if (ch === ']') {
      return text.slice(i + 1).trim().length === 0
        ? { items, close: i, multiline: text.includes('\n') }
        : undefined;
    }
    if (ch === ',') {
      if (expectItem) {
        return undefined;
      }
      items[items.length - 1] = { ...items[items.length - 1], commaAfter: true };
      expectItem = true;
      i++;
      continue;
    }
    if ((ch !== '"' && ch !== '\'') || !expectItem) {
      return undefined;
    }
    const parsed = ch === '"' ? parseBasicString(text, i) : parseLiteralString(text, i);
    if (!parsed) {
      return undefined;
    }
    items.push({ raw: text.slice(i, parsed.end), value: parsed.value, start: i, end: parsed.end, commaAfter: false });
    expectItem = false;
    i = parsed.end;
  }
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  'n': '\n', 't': '\t', 'r': '\r', 'b': '\b', 'f': '\f', '"': '"', '\\': '\\',
};

function parseBasicString(text: string, start: number): { value: string; end: number } | undefined {
  if (text.startsWith('"""', start)) {
    return undefined;
  }
  let value = '';
  let k = start + 1;
  while (k < text.length && text[k] !== '\n') {
    const ch = text[k];
    if (ch === '"') {
      return { value, end: k + 1 };
    }
    if (ch !== '\\') {
      value += ch;
      k++;
      continue;
    }
    const escape = text[k + 1];
    const hexLength = escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
    if (hexLength > 0) {
      const hex = text.slice(k + 2, k + 2 + hexLength);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== hexLength) {
        return undefined;
      }
      value += String.fromCodePoint(parseInt(hex, 16));
      k += 2 + hexLength;
      continue;
    }
    // Неизвестное экранирование TOML запрещает; здесь оно сохраняется как есть: значение нужно
    // только для сравнения со служебным элементом, а сырой текст элемента переносится дословно.
    value += SIMPLE_ESCAPES[escape] ?? `\\${escape}`;
    k += 2;
  }
  return undefined;
}

function parseLiteralString(text: string, start: number): { value: string; end: number } | undefined {
  if (text.startsWith('\'\'\'', start)) {
    return undefined;
  }
  const close = text.indexOf('\'', start + 1);
  const newline = text.indexOf('\n', start + 1);
  if (close < 0 || (newline >= 0 && newline < close)) {
    return undefined;
  }
  return { value: text.slice(start + 1, close), end: close + 1 };
}
