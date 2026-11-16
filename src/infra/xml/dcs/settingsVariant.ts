import { createHash } from 'crypto';
import type { SkdSettingsVariantDefinition, SkdStructureItemDefinition, SkdVariantInfo } from '../DataCompositionSchemaService';
import { escapeXmlText, findDirectElementEntries, findDirectElementRanges, findNestingAwareElementRange, unescapeXml } from '../XmlUtils';
import { extractBlock, matchBlockRanges, readMlText, readText } from './dcsShared';

/**
 * Вариант настроек СКД в формате платформы (#131): `dcsset:name`/`dcsset:presentation`/
 * `dcsset:settings` с префиксованными секциями. Прежний «плоский» формат (`<settings>`,
 * `<selection>`, `<structure>` без префиксов) платформа не загружала — импорт падал на XDTO.
 *
 * Порядок прямых детей `dcsset:settings` (xs:sequence), снятый с выгрузки 8.5.1: секции,
 * затем элементы структуры. Записанное не на своё место платформа переставляет при выгрузке —
 * лишний diff, поэтому новые секции встают по рангу независимо от порядка операций edit.
 */
export const DCS_SETTINGS_ELEMENT_ORDER = [
  'dcsset:selection',
  'dcsset:filter',
  'dcsset:dataParameters',
  'dcsset:order',
  'dcsset:conditionalAppearance',
  'dcsset:outputParameters',
  'dcsset:item',
  'dcsset:itemsViewMode',
  'dcsset:itemsUserSettingID',
] as const;

export type DcsSettingsSection = 'selection' | 'filter' | 'dataParameters' | 'order' | 'conditionalAppearance' | 'outputParameters';

/** Пространства имён, которые платформа 8.5.1 объявляет на каждом `dcsset:settings`. */
export const DCS_SETTINGS_NAMESPACES = 'xmlns:pal="http://v8.1c.ru/8.1/data/ui/colors/palette" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows"';

/** Элементы параметров (dataParameters/outputParameters) — из пространства core, остальные — settings. */
const SECTION_ITEM_TAG: Record<DcsSettingsSection, string> = {
  selection: 'dcsset:item',
  filter: 'dcsset:item',
  dataParameters: 'dcscor:item',
  order: 'dcsset:item',
  conditionalAppearance: 'dcsset:item',
  outputParameters: 'dcscor:item',
};

const FILTER_OPERATORS: Record<string, string> = {
  '=': 'Equal',
  '<>': 'NotEqual',
  '>': 'Greater',
  '>=': 'GreaterOrEqual',
  '<': 'Less',
  '<=': 'LessOrEqual',
  filled: 'Filled',
  notFilled: 'NotFilled',
};

const EMPTY_DATE = '0001-01-01T00:00:00';

export interface VariantSettingsScope {
  readonly variantName: string;
  /** Содержимое `dcsset:settings` между открывающим и закрывающим тегом. */
  readonly inner: string;
  /** Отступ прямых детей `dcsset:settings`. */
  readonly indent: string;
}

/**
 * `parameterNames` — имена параметров схемы для `dataParameters: 'auto'`. Разбор shorthand
 * параметров остаётся в schemaParse: модуль варианта от него не зависит, иначе импорт
 * schemaParse ↔ settingsVariant становится циклическим.
 */
export function buildVariantXml(variant: SkdSettingsVariantDefinition, parameterNames: readonly string[]): string {
  const indent = '\t\t\t';
  const itemIndent = `${indent}\t`;
  const dataParameters = variant.dataParameters === 'auto' ? parameterNames : (variant.dataParameters ?? []).map(dataParameterName);
  const sections: [DcsSettingsSection, string[]][] = [
    ['selection', (variant.selection ?? []).map((item) => buildSelectionItemXml(item, itemIndent))],
    ['filter', (variant.filter ?? []).map((item) => buildFilterItemXml(item, itemIndent, `${variant.name}/filter`))],
    ['dataParameters', dataParameters.map((name) => buildDataParameterItemXml(name, itemIndent, stableUserSettingId(`${variant.name}/dataParameters/${name}`)))],
    ['order', (variant.order ?? []).map((item) => buildOrderItemXml(item, itemIndent))],
  ];
  return [
    '\t<settingsVariant>',
    `\t\t<dcsset:name>${escapeXmlText(variant.name)}</dcsset:name>`,
    // Заголовок всегда LocalStringType многострочно — так его пишет платформа при выгрузке.
    ...buildLocalString('dcsset:presentation', variant.title ?? variant.name, '\t\t'),
    `\t\t<dcsset:settings ${DCS_SETTINGS_NAMESPACES}>`,
    ...sections.filter(([, items]) => items.length > 0).map(([section, items]) => buildSectionXml(section, items, indent)),
    buildStructureItemsXml(variant.structure ?? 'details', indent),
    '\t\t</dcsset:settings>',
    '\t</settingsVariant>',
  ].join('\n');
}

export function buildSectionXml(section: DcsSettingsSection, items: readonly string[], indent: string): string {
  return [`${indent}<dcsset:${section}>`, ...items, `${indent}</dcsset:${section}>`].join('\n');
}

export function buildSelectionItemXml(value: string, indent: string): string {
  if (value === 'Auto') {
    return `${indent}<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>`;
  }
  return [
    `${indent}<dcsset:item xsi:type="dcsset:SelectedItemField">`,
    `${indent}\t<dcsset:field>${escapeXmlText(value)}</dcsset:field>`,
    `${indent}</dcsset:item>`,
  ].join('\n');
}

/**
 * Элемент отбора FilterItemComparison. Порядок детей — как в выгрузке платформы: use (только
 * при выключенном) → left → comparisonType → right → userSettingID. userSettingID выводится
 * детерминированно из `${userSettingSeed}/${поле}`: повторная генерация не даёт diff.
 */
export function buildFilterItemXml(value: string, indent: string, userSettingSeed: string): string {
  const filter = parseFilter(value);
  return [
    `${indent}<dcsset:item xsi:type="dcsset:FilterItemComparison">`,
    filter.use ? '' : `${indent}\t<dcsset:use>false</dcsset:use>`,
    `${indent}\t<dcsset:left xsi:type="dcscor:Field">${escapeXmlText(filter.field)}</dcsset:left>`,
    `${indent}\t<dcsset:comparisonType>${filter.comparison}</dcsset:comparisonType>`,
    filter.value ? buildSettingsValueXml('dcsset:right', filter.value, `${indent}\t`, 'xs:string') : '',
    filter.user ? `${indent}\t<dcsset:userSettingID>${stableUserSettingId(`${userSettingSeed}/${filter.field}`)}</dcsset:userSettingID>` : '',
    `${indent}</dcsset:item>`,
  ].filter(Boolean).join('\n');
}

export function buildOrderItemXml(value: string, indent: string): string {
  const trimmed = value.trim();
  if (trimmed === 'Auto') {
    return `${indent}<dcsset:item xsi:type="dcsset:OrderItemAuto"/>`;
  }
  const desc = /\s+desc$/i.test(trimmed);
  return [
    `${indent}<dcsset:item xsi:type="dcsset:OrderItemField">`,
    `${indent}\t<dcsset:field>${escapeXmlText(trimmed.replace(/\s+desc$/i, ''))}</dcsset:field>`,
    `${indent}\t<dcsset:orderType>${desc ? 'Desc' : 'Asc'}</dcsset:orderType>`,
    `${indent}</dcsset:item>`,
  ].join('\n');
}

/** Значение параметра DSL не переносится: тип значения схемой не задан, а неверный тип отбивает импорт. */
export function buildDataParameterItemXml(name: string, indent: string, userSettingId?: string): string {
  return [
    `${indent}<dcscor:item xsi:type="dcsset:SettingsParameterValue">`,
    `${indent}\t<dcscor:parameter>${escapeXmlText(name)}</dcscor:parameter>`,
    // Значение DSL не задаёт; платформа при выгрузке всё равно пишет пустое значение явно —
    // без него первая же выгрузка из Конфигуратора дала бы лишний diff.
    `${indent}\t<dcscor:value xsi:nil="true"/>`,
    userSettingId ? `${indent}\t<dcsset:userSettingID>${userSettingId}</dcsset:userSettingID>` : '',
    `${indent}</dcscor:item>`,
  ].filter(Boolean).join('\n');
}

export function buildConditionalAppearanceItemXml(value: string, indent: string, userSettingSeed: string): string {
  const match = /^(.+?)\s*=\s*(.+?)(?:\s+when\s+(.+?))?(?:\s+for\s+(.+))?$/.exec(value.trim());
  if (!match) {
    throw new Error('add-conditionalAppearance ожидает формат: Параметр = значение [when условие] [for Поле1, Поле2].');
  }
  // Опциональные группы регулярки фактически могут быть undefined, тип RegExpExecArray этого не отражает.
  const when = match[3] as string | undefined;
  const fields = ((match[4] as string | undefined) ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const inner = `${indent}\t`;
  return [
    `${indent}<dcsset:item>`,
    // Пустые selection/filter платформа выгружает самозакрытыми, а не опускает (снято
    // round-trip через 8.5.1 и 8.3.27) — пишем так же, чтобы выгрузка не давала diff.
    ...(fields.length > 0 ? [
      `${inner}<dcsset:selection>`,
      ...fields.flatMap((field) => [`${inner}\t<dcsset:item>`, `${inner}\t\t<dcsset:field>${escapeXmlText(field)}</dcsset:field>`, `${inner}\t</dcsset:item>`]),
      `${inner}</dcsset:selection>`,
    ] : [`${inner}<dcsset:selection/>`]),
    ...(when
      ? [`${inner}<dcsset:filter>`, buildFilterItemXml(when, `${inner}\t`, userSettingSeed), `${inner}</dcsset:filter>`]
      : [`${inner}<dcsset:filter/>`]),
    `${inner}<dcsset:appearance>`,
    `${inner}\t<dcscor:item xsi:type="dcsset:SettingsParameterValue">`,
    `${inner}\t\t<dcscor:parameter>${escapeXmlText(match[1].trim())}</dcscor:parameter>`,
    buildSettingsValueXml('dcscor:value', match[2].trim(), `${inner}\t\t`, 'xs:string'),
    `${inner}\t</dcscor:item>`,
    `${inner}</dcsset:appearance>`,
    `${indent}</dcsset:item>`,
  ].join('\n');
}

export function buildOutputParameterItemXml(value: string, indent: string): string {
  const [name, rawValue = ''] = value.split(/=(.+)/).map((item) => item.trim());
  return [
    `${indent}<dcscor:item xsi:type="dcsset:SettingsParameterValue">`,
    `${indent}\t<dcscor:parameter>${escapeXmlText(name)}</dcscor:parameter>`,
    // Строковые параметры вывода (Заголовок) платформа хранит как LocalStringType.
    buildSettingsValueXml('dcscor:value', rawValue, `${indent}\t`, 'v8:LocalStringType'),
    `${indent}</dcscor:item>`,
  ].join('\n');
}

/** Группировки структуры — прямые `dcsset:item` того элемента, в который они вставляются. */
export function buildStructureItemsXml(structure: string | readonly SkdStructureItemDefinition[], indent: string): string {
  const items = typeof structure === 'string' ? [parseStructureString(structure)] : structure;
  return items.map((item) => buildStructureItemXml(item, indent)).join('\n');
}

/**
 * Типизированное значение `dcsset:right`/`dcscor:value`. Тип угадывается по тексту DSL:
 * явного типа в нём нет, а платформа хранит xsi:type у каждого значения.
 */
export function buildSettingsValueXml(tag: 'dcsset:right' | 'dcscor:value', raw: string, indent: string, plainStringType: 'xs:string' | 'v8:LocalStringType'): string {
  const xsiType = detectValueType(raw);
  if (xsiType === undefined && plainStringType === 'v8:LocalStringType') {
    return buildLocalString(tag, raw, indent).join('\n');
  }
  return `${indent}<${tag} xsi:type="${xsiType ?? 'xs:string'}">${escapeXmlText(raw)}</${tag}>`;
}

/**
 * userSettingID — GUID; случайный давал бы diff при каждом compile, поэтому он выводится из
 * seed (sha1, версия 5 по RFC 4122): тот же вариант/секция/имя — тот же идентификатор.
 */
export function stableUserSettingId(seed: string): string {
  const hex = createHash('sha1').update(seed, 'utf8').digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const id = hex.join('');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/**
 * Правит `dcsset:settings` варианта (первого или с именем `variantName`) по диапазонам: текст
 * блока может повторяться в другом варианте, поэтому замена подстрокой правила бы не тот.
 * Нет варианта или в нём нет `dcsset:settings` (прежний формат compile) — предупреждение и
 * исходный XML: молчаливый no-op скрывал бы, что правка не применена.
 */
export function editVariantSettings(xml: string, variantName: string | undefined, warnings: string[], editor: (scope: VariantSettingsScope) => string): string {
  const variant = matchBlockRanges(xml, 'settingsVariant').find((range) => !variantName || readText(range.text, 'dcsset:name') === variantName);
  if (!variant) {
    warnings.push(`Вариант настроек не найден: ${variantName ?? 'первый вариант'}.`);
    return xml;
  }
  const settings = findNestingAwareElementRange(variant.text, 'dcsset:settings');
  if (!settings) {
    warnings.push('Вариант настроек без dcsset:settings (формат не платформы) — правка не применена.');
    return xml;
  }
  const before = variant.text.slice(0, settings.start);
  const lineIndent = before.slice(before.replace(/[ \t]+$/, '').length);
  const selfClosing = settings.closeStart === settings.openEnd;
  // Самозакрытый `<dcsset:settings …/>` разворачивается: пустое содержимое — перевод строки
  // и отступ закрывающего тега, чтобы вставка по рангу дала обычную разметку.
  const inner = selfClosing ? `\n${lineIndent}` : variant.text.slice(settings.openEnd, settings.closeStart);
  const nextInner = editor({ variantName: readText(variant.text, 'dcsset:name'), inner, indent: `${lineIndent}\t` });
  if (nextInner === inner) {
    return xml;
  }
  const openTag = variant.text.slice(settings.start, settings.openEnd);
  const nextSettings = selfClosing
    ? `${openTag.replace(/\s*\/>$/, '>')}${nextInner}</dcsset:settings>`
    : `${openTag}${nextInner}${variant.text.slice(settings.closeStart, settings.end)}`;
  const start = variant.start + settings.start;
  return `${xml.slice(0, start)}${nextSettings}${xml.slice(variant.start + settings.end)}`;
}

export function appendSectionItem(scope: VariantSettingsScope, section: DcsSettingsSection, itemXml: string): string {
  const located = findSection(scope.inner, section);
  if (!located) {
    return insertByRank(scope, `dcsset:${section}`, buildSectionXml(section, [itemXml], scope.indent));
  }
  if (located.selfClosing) {
    return splice(scope.inner, located.start, located.end, buildSectionXml(section, [itemXml], scope.indent).trimStart());
  }
  const head = scope.inner.slice(0, located.closeStart).replace(/\s+$/, '');
  return `${head}\n${itemXml}\n${scope.indent}${scope.inner.slice(located.closeStart)}`;
}

export function replaceFirstSectionItem(scope: VariantSettingsScope, section: DcsSettingsSection, itemXml: string): string {
  return upsertSectionItem(scope, section, () => true, itemXml);
}

export function upsertSectionItem(scope: VariantSettingsScope, section: DcsSettingsSection, predicate: (item: string) => boolean, itemXml: string): string {
  const located = findSection(scope.inner, section);
  const item = located?.items.find((range) => predicate(scope.inner.slice(range.start, range.end)));
  // Отступ перед элементом уже стоит в документе — у замены он срезается.
  return item ? splice(scope.inner, item.start, item.end, itemXml.trimStart()) : appendSectionItem(scope, section, itemXml);
}

/** Удаляет подходящие элементы секции; опустевшая секция удаляется целиком. */
export function removeSectionItems(scope: VariantSettingsScope, section: DcsSettingsSection, predicate: (item: string) => boolean): string {
  const located = findSection(scope.inner, section);
  const items = located?.items ?? [];
  const removed = items.filter((range) => predicate(scope.inner.slice(range.start, range.end)));
  if (removed.length === 0) {
    return scope.inner;
  }
  if (removed.length === items.length) {
    return removeSection(scope, section);
  }
  return removed.reduceRight((inner, range) => removeWithLeadingBreak(inner, range.start, range.end), scope.inner);
}

export function removeSection(scope: VariantSettingsScope, section: DcsSettingsSection): string {
  const located = findSection(scope.inner, section);
  return located ? removeWithLeadingBreak(scope.inner, located.start, located.end) : scope.inner;
}

export function hasSectionItem(scope: VariantSettingsScope, section: DcsSettingsSection, predicate: (item: string) => boolean): boolean {
  return (findSection(scope.inner, section)?.items ?? []).some((range) => predicate(scope.inner.slice(range.start, range.end)));
}

/** Заменяет все группировки верхнего уровня: новые встают на место первой прежней. */
export function replaceStructureItems(scope: VariantSettingsScope, itemsXml: string): string {
  const items = findDirectElementRanges(scope.inner, 'dcsset:item');
  if (items.length === 0) {
    return insertByRank(scope, 'dcsset:item', itemsXml);
  }
  const rest = items.slice(1).reduceRight((inner, range) => removeWithLeadingBreak(inner, range.start, range.end), scope.inner);
  return splice(rest, items[0].start, items[0].end, itemsXml.trimStart());
}

/** Есть ли у варианта прямой `dcsset:settings` — без него платформа вариант не загрузит. */
export function hasPlatformSettings(block: string): boolean {
  const inner = block.slice(block.indexOf('>') + 1, block.lastIndexOf('<'));
  return findDirectElementRanges(inner, 'dcsset:settings').length > 0;
}

/**
 * Сводка варианта для info: секции читаются только как прямые дети `dcsset:settings` —
 * одноимённые selection/order группировок и selection внутри conditionalAppearance
 * к варианту не относятся.
 */
export function parseVariantInfo(block: string): SkdVariantInfo {
  const presentation = extractBlock(block, 'dcsset:presentation') ?? '';
  const settings = findNestingAwareElementRange(block, 'dcsset:settings');
  const inner = settings ? block.slice(settings.openEnd, settings.closeStart) : '';
  const texts = (section: DcsSettingsSection, childTag: string): string[] =>
    (findSection(inner, section)?.items ?? []).map((range) => readDirectChildText(inner.slice(range.start, range.end), childTag)).filter(Boolean);
  return {
    name: readText(block, 'dcsset:name'),
    // Заголовок бывает и xs:string (текстом), и LocalStringType (v8:item/v8:content).
    title: presentation.includes('<v8:content>') ? readMlText(block, 'dcsset:presentation') : unescapeXml(presentation.trim()),
    selection: texts('selection', 'dcsset:field'),
    filters: texts('filter', 'dcsset:left'),
    order: texts('order', 'dcsset:field'),
  };
}

/**
 * Текст прямого ребёнка `childTag` элемента секции. Поиск по всему элементу находил бы
 * `dcsset:left` первого вложенного сравнения у FilterItemGroup: remove-filter удалял бы всю
 * группу И(…), а info показывал бы группу под чужим именем. Группы отбора не обходятся —
 * у них нет прямого `dcsset:left`, поэтому они не совпадают ни с одним полем.
 */
export function readDirectChildText(item: string, childTag: string): string {
  const inner = item.slice(item.indexOf('>') + 1, item.lastIndexOf('<'));
  const child = findDirectElementRanges(inner, childTag)[0] as { start: number; end: number } | undefined;
  return child ? readText(inner.slice(child.start, child.end), childTag) : '';
}

interface SectionLocation {
  readonly start: number;
  readonly end: number;
  readonly closeStart: number;
  readonly selfClosing: boolean;
  /** Прямые элементы секции — позиции в том же тексте, что и сама секция. */
  readonly items: readonly { readonly start: number; readonly end: number }[];
}

function findSection(inner: string, section: DcsSettingsSection): SectionLocation | undefined {
  const tag = `dcsset:${section}`;
  const range = findDirectElementRanges(inner, tag)[0] as { start: number; end: number } | undefined;
  if (!range) {
    return undefined;
  }
  const text = inner.slice(range.start, range.end);
  const selfClosing = !text.endsWith(`</${tag}>`);
  const openEnd = range.start + text.indexOf('>') + 1;
  const closeStart = selfClosing ? range.end : range.end - `</${tag}>`.length;
  const items = findDirectElementRanges(inner.slice(openEnd, closeStart), SECTION_ITEM_TAG[section])
    .map((item) => ({ start: openEnd + item.start, end: openEnd + item.end }));
  return { start: range.start, end: range.end, closeStart, selfClosing, items };
}

/**
 * Вставка прямого ребёнка `dcsset:settings` перед первым, кто по {@link DCS_SETTINGS_ELEMENT_ORDER}
 * идёт позже; неизвестные теги при поиске якоря не учитываются. Якоря нет — в конец.
 */
function insertByRank(scope: VariantSettingsScope, tag: typeof DCS_SETTINGS_ELEMENT_ORDER[number], fragment: string): string {
  const rank = DCS_SETTINGS_ELEMENT_ORDER.indexOf(tag);
  const anchor = findDirectElementEntries(scope.inner).find((entry) => (DCS_SETTINGS_ELEMENT_ORDER as readonly string[]).indexOf(entry.tag) > rank);
  if (!anchor) {
    const head = scope.inner.replace(/\s+$/, '');
    return `${head}\n${fragment}${scope.inner.slice(head.length)}`;
  }
  const before = scope.inner.slice(0, anchor.start);
  const indent = before.slice(before.replace(/[ \t]+$/, '').length);
  return `${before}${fragment.trimStart()}\n${indent}${scope.inner.slice(anchor.start)}`;
}

/** Удаляет диапазон вместе с предшествующим переводом строки и отступом — без пустых строк. */
function removeWithLeadingBreak(text: string, start: number, end: number): string {
  const head = text.slice(0, start).replace(/(?:\r?\n)?[ \t]*$/, '');
  return `${head}${text.slice(end)}`;
}

function splice(text: string, start: number, end: number, replacement: string): string {
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

function buildLocalString(tag: string, value: string, indent: string): string[] {
  return [
    `${indent}<${tag} xsi:type="v8:LocalStringType">`,
    `${indent}\t<v8:item>`,
    `${indent}\t\t<v8:lang>ru</v8:lang>`,
    `${indent}\t\t<v8:content>${escapeXmlText(value)}</v8:content>`,
    `${indent}\t</v8:item>`,
    `${indent}</${tag}>`,
  ];
}

function detectValueType(raw: string): string | undefined {
  if (raw === 'true' || raw === 'false') {
    return 'xs:boolean';
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return 'xs:decimal';
  }
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(raw)) {
    return 'xs:dateTime';
  }
  return /^(web|win|style):\S+$/.test(raw) ? 'v8ui:Color' : undefined;
}

function dataParameterName(value: string): string {
  return value.replace(/\s*=.*/, '').trim();
}

function parseFilter(value: string): { field: string; comparison: string; value: string; use: boolean; user: boolean } {
  const clean = value.replace(/\s*@\w+/g, '').trim();
  const match = /^(.+?)\s*(<>|>=|<=|=|>|<|filled|notFilled)\s*(.*)$/.exec(clean);
  const right = match ? match[3].trim() : '';
  return {
    field: match ? match[1].trim() : clean,
    comparison: FILTER_OPERATORS[match ? match[2] : '='],
    // «_» — явное «значение не задано»: отбор без правой части, как его выгружает платформа.
    value: right === '_' ? '' : right,
    use: !value.includes('@off'),
    user: value.includes('@user'),
  };
}

function parseStructureString(structure: string): SkdStructureItemDefinition {
  const parts = structure.split('>').map((part) => part.trim()).filter(Boolean);
  return parts.reduceRight<SkdStructureItemDefinition>((child, part, index) => ({
    groupFields: part === 'details' || part === 'детали' ? [] : [part],
    children: index === parts.length - 1 ? [] : [child],
  }), { groupFields: [] });
}

function buildStructureItemXml(item: SkdStructureItemDefinition, indent: string): string {
  const fields = item.groupFields ?? item.groupBy ?? [];
  const inner = `${indent}\t`;
  return [
    `${indent}<dcsset:item xsi:type="dcsset:StructureItemGroup">`,
    item.name ? `${inner}<dcsset:name>${escapeXmlText(item.name)}</dcsset:name>` : '',
    fields.length > 0 ? [
      `${inner}<dcsset:groupItems>`,
      ...fields.map((field) => [
        `${inner}\t<dcsset:item xsi:type="dcsset:GroupItemField">`,
        `${inner}\t\t<dcsset:field>${escapeXmlText(field)}</dcsset:field>`,
        `${inner}\t\t<dcsset:groupType>Items</dcsset:groupType>`,
        `${inner}\t\t<dcsset:periodAdditionType>None</dcsset:periodAdditionType>`,
        `${inner}\t\t<dcsset:periodAdditionBegin xsi:type="xs:dateTime">${EMPTY_DATE}</dcsset:periodAdditionBegin>`,
        `${inner}\t\t<dcsset:periodAdditionEnd xsi:type="xs:dateTime">${EMPTY_DATE}</dcsset:periodAdditionEnd>`,
        `${inner}\t</dcsset:item>`,
      ].join('\n')),
      `${inner}</dcsset:groupItems>`,
    ].join('\n') : '',
    buildSectionXml('order', [buildOrderItemXml('Auto', `${inner}\t`)], inner),
    buildSectionXml('selection', (item.selection ?? ['Auto']).map((field) => buildSelectionItemXml(field, `${inner}\t`)), inner),
    ...(item.children ?? []).map((child) => buildStructureItemXml(child, inner)),
    `${indent}</dcsset:item>`,
  ].filter(Boolean).join('\n');
}
