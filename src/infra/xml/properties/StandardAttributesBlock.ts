import { META_TYPES, type MetaKind } from '../../../domain/MetaTypes';
import type { FormatRuleset } from '../format/FormatRuleset';
import { DEFAULT_FORMAT_VERSION, resolveFormatRuleset } from '../format/formatRegistry';
import { extractXmlAttribute } from '../MetadataPropertiesXml';
import {
  collectPropertyBlocks,
  detectEol,
  findPropertiesRange,
  insertBlockInCanonicalPosition,
  isAdoptedObjectBelonging,
  replaceBlock,
  type PropertyBlock,
} from '../typedField/PropertyBlockEditor';
import {
  escapeRegExp,
  escapeXmlAttribute,
  extractExplicitStandardAttributeXml,
  hasRealChange,
  isEmptyPropertyValue,
} from '../XmlUtils';
import { insertPropertyBlockInOrder } from './PropertyInsert';
import { buildPropertyValueBlock, updateLocalizedPropertyContent, type PropertyValueKind } from './PropertyValueBlock';

/**
 * Чтение стандартного реквизита корня объекта БЕЗ записи в файл (#16).
 *
 * У нового объекта платформа блок `<StandardAttributes>` не пишет — у
 * большинства объектов корпуса его нет, и значения реквизитов тогда равны
 * умолчаниям платформы. Их источник — шаблон ruleset вида (снят с платформы),
 * а не материализация в XML объекта: показ свойств не должен менять файл
 * (запреты 10/11 CLAUDE.md).
 */
export interface ResolveStandardAttributeOptions {
  readonly ruleset: FormatRuleset;
  /**
   * Подставлять ли элемент из шаблона вида, если в файле реквизита нет.
   * `false` — для собственного XML заимствованного объекта: значения базовой
   * конфигурации нельзя подменять умолчаниями.
   */
  readonly useDefaults: boolean;
}

const ROOT_RE = /<MetaDataObject\b([^>]*)>\s*<([A-Za-z][A-Za-z0-9]*)\b/;

/** Версия формата из атрибута `version` корня `<MetaDataObject>` или `null`. */
export function detectObjectXmlFormatVersion(objectXml: string): string | null {
  const rootAttributes = ROOT_RE.exec(objectXml)?.[1] ?? '';
  return /\bversion="([^"]+)"/.exec(rootAttributes)?.[1] ?? null;
}

/**
 * Ruleset по версии из корня самого XML объекта. Не `resolveObjectFormatVersion`:
 * тот читает `ConfigDumpInfo.xml`, а это синхронный I/O на пути показа свойств.
 */
export function rulesetForObjectXml(
  objectXml: string,
  options: { readonly warnOnUnknownVersion?: boolean } = {}
): FormatRuleset {
  // На чтении предупреждение о незнакомой версии подавлено: показ свойств
  // разрешает ruleset на каждом узле и засорял бы лог. Предупреждают писатели —
  // там вывод действительно может разойтись с платформой.
  return resolveFormatRuleset(detectObjectXmlFormatVersion(objectXml) ?? DEFAULT_FORMAT_VERSION, {
    warnOnUnknown: options.warnOnUnknownVersion === true,
  });
}

/** Правка одного свойства стандартного реквизита корня объекта. */
export interface StandardAttributePropertyEdit {
  readonly attributeName: string;
  readonly tabularSectionName?: string;
  /** Ключ свойства без префикса `xr:` (`FillChecking`, `ToolTip`). */
  readonly propertyKey: string;
  readonly valueKind: PropertyValueKind;
  readonly value: string | boolean | string[];
}

export type StandardAttributeEditRefusal =
  | 'tabular-section'
  | 'unsupported-value-kind'
  | 'no-root-properties'
  | 'adopted-object'
  | 'no-template-for-kind'
  | 'unknown-attribute'
  | 'unknown-property'
  | 'partial-element'
  | 'unsupported-value-shape';

export type StandardAttributeEditResult =
  | { readonly status: 'changed'; readonly xml: string }
  | { readonly status: 'unchanged' }
  | { readonly status: 'refused'; readonly reason: StandardAttributeEditRefusal; readonly message: string };

/**
 * Правка свойства стандартного реквизита корня — чистая функция над текстом XML.
 *
 * Блока `<StandardAttributes>` у объекта может не быть (платформа у нового
 * объекта его не пишет), тогда он материализуется из шаблона умолчаний вида
 * ровно с одной изменённой строкой — так же выгружает платформа после правки в
 * Конфигураторе. Если блок есть, но реквизита в нём нет, элемент шаблона
 * встаёт в порядке шаблона. Блок, совпавший с шаблоном, не удаляется никогда:
 * платформа сама пишет такие блоки (`ев_РабочийПроцесс` в EVOLC), а у
 * pre-2.20 блок с умолчаниями — норма.
 *
 * Строки собираются с `\n`: EOL файла восстанавливает
 * `writeTextFilePreservingBomAndEol`.
 */
export function applyStandardAttributePropertyEdit(
  objectXml: string,
  edit: StandardAttributePropertyEdit,
  ruleset: FormatRuleset
): StandardAttributeEditResult {
  if (edit.tabularSectionName) {
    return refuse(
      'tabular-section',
      'Свойства стандартных реквизитов табличной части пока не редактируются: для них нет шаблона умолчаний платформы.'
    );
  }
  if (edit.valueKind === 'metadataReferenceList' || edit.valueKind === 'metadataFieldList') {
    return refuse('unsupported-value-kind', `Свойство "${edit.propertyKey}" стандартного реквизита не принимает список значений.`);
  }
  const props = findPropertiesRange(objectXml);
  const rootKind = ROOT_RE.exec(objectXml)?.[2];
  if (!props || !rootKind) {
    return refuse('no-root-properties', 'В XML объекта не найден блок свойств корня.');
  }
  const blocks = collectPropertyBlocks(props.inner);
  if (isAdoptedObjectBelonging(blocks)) {
    // Значения заимствованного объекта принадлежат базовой конфигурации, а
    // правка через расширение — отдельный механизм (#146).
    return refuse('adopted-object', 'Стандартные реквизиты заимствованного объекта не редактируются в расширении.');
  }
  const template = Object.prototype.hasOwnProperty.call(META_TYPES, rootKind)
    ? ruleset.standardAttributes(rootKind as MetaKind)
    : '';
  if (!template) {
    return refuse('no-template-for-kind', `Для вида "${rootKind}" нет шаблона стандартных реквизитов; правка не поддерживается.`);
  }
  const templateElement = defaultStandardAttributeElementXml(ruleset, rootKind, edit.attributeName);
  if (!templateElement) {
    return refuse('unknown-attribute', `У вида "${rootKind}" нет стандартного реквизита "${edit.attributeName}".`);
  }

  // Текущий элемент ищется разбором вложенности, а не поиском текста: одинаковые
  // фрагменты (например, элемент, совпавший с шаблоном) не должны подменять друг друга.
  const standardBlock = blocks.find((block) => block.key === 'StandardAttributes');
  const standardInner = standardBlock ? innerRangeOf(standardBlock.xml) : { start: 0, end: 0 };
  const standardInnerStart = standardBlock ? standardBlock.start + standardInner.start : 0;
  const standardInnerXml = standardBlock ? standardBlock.xml.slice(standardInner.start, standardInner.end) : '';
  const elements = collectPropertyBlocks(standardInnerXml).map(
    (block): PropertyBlock => ({ ...block, key: extractXmlAttribute(block.xml, 'name') ?? '' })
  );
  const current = elements.find((block) => block.key === escapeXmlAttribute(edit.attributeName));
  const source = current ? current.xml : templateElement;

  const edited = editElementProperty(source, templateElement, edit);
  if (typeof edited !== 'string') {
    return edited;
  }
  if (!hasRealChange(source, edited)) {
    return { status: 'unchanged' };
  }

  let nextInner: string;
  if (current) {
    const start = standardInnerStart + current.start;
    nextInner = props.inner.slice(0, start) + edited + props.inner.slice(standardInnerStart + current.end);
  } else if (elements.length > 0) {
    // Порядок элементов задаёт шаблон вида (снят с платформы); вставка — общей
    // механикой, второй копии splice-вставки в проекте быть не должно.
    const names = [...template.matchAll(/<xr:StandardAttribute name="([^"]+)">/g)].map((match) => match[1]);
    const rank = new Map(names.map((name, index) => [name, index]));
    const nextStandardInner = insertBlockInCanonicalPosition(
      standardInnerXml,
      elements,
      (name) => rank.get(name),
      names.indexOf(escapeXmlAttribute(edit.attributeName)),
      edited,
      detectEol(standardInnerXml)
    );
    nextInner =
      props.inner.slice(0, standardInnerStart) +
      nextStandardInner +
      props.inner.slice(standardInnerStart + standardInnerXml.length);
  } else {
    // Ведущий отступ первой строки шаблона снимается: его даёт вставка по соседу.
    const block = template.replace(templateElement, () => edited).replace(/^[\t ]+/, '');
    nextInner = standardBlock
      ? replaceBlock(props.inner, standardBlock, block)
      : insertPropertyBlockInOrder(props.inner, rootKind, 'StandardAttributes', block);
  }
  return { status: 'changed', xml: objectXml.slice(0, props.start) + nextInner + objectXml.slice(props.end) };
}

function refuse(reason: StandardAttributeEditRefusal, message: string): StandardAttributeEditResult {
  return { status: 'refused', reason, message };
}

/** Границы содержимого элемента внутри его XML (у самозакрытого — пустые). */
function innerRangeOf(elementXml: string): { start: number; end: number } {
  const openEnd = elementXml.indexOf('>') + 1;
  return elementXml[openEnd - 2] === '/'
    ? { start: openEnd, end: openEnd }
    : { start: openEnd, end: elementXml.lastIndexOf('</') };
}

/**
 * Новый XML элемента реквизита с изменённым свойством или отказ. Отсутствующее
 * свойство не дописывается: у шаблонного элемента его нет вовсе (`Name`,
 * `Indexing`), а у явного — элемент записан не полностью, и место в
 * последовательности свойств пришлось бы угадывать.
 */
function editElementProperty(
  elementXml: string,
  templateElement: string,
  edit: StandardAttributePropertyEdit
): string | StandardAttributeEditResult {
  const key = `xr:${edit.propertyKey}`;
  const inner = innerRangeOf(elementXml);
  const property = collectPropertyBlocks(elementXml.slice(inner.start, inner.end)).find((block) => block.key === key);
  if (!property) {
    const templateInner = innerRangeOf(templateElement);
    return collectPropertyBlocks(templateElement.slice(templateInner.start, templateInner.end)).some((block) => block.key === key)
      ? refuse('partial-element', `Элемент "${edit.attributeName}" записан в файле не полностью; выгрузите объект платформой заново.`)
      : refuse('unknown-property', `У стандартного реквизита нет свойства "${edit.propertyKey}".`);
  }
  // Атрибуты (`xsi:nil`, `xsi:type` у MinValue/MaxValue/FillValue) и вложенные
  // элементы (ChoiceParameters) — типизированное значение: запись строкой его
  // испортила бы. Исключение — `v8:item` локализованной строки.
  const valueRange = innerRangeOf(property.xml);
  const children = collectPropertyBlocks(property.xml.slice(valueRange.start, valueRange.end));
  const hasAttributes = /^<[^\s/>]+\s/.test(property.xml);
  if (hasAttributes || children.some((child) => edit.valueKind !== 'localizedString' || child.key !== 'v8:item')) {
    return refuse('unsupported-value-shape', `Свойство "${edit.propertyKey}" хранит составное значение; запись простой строкой не поддерживается.`);
  }
  const next = edit.valueKind === 'localizedString' && children.length > 0 && !isEmptyPropertyValue(edit.value)
    ? updateLocalizedPropertyContent(property.xml, edit.value)
    : buildPropertyValueBlock(key, edit.valueKind, edit.value, property.indent);
  const start = inner.start + property.start;
  return elementXml.slice(0, start) + next + elementXml.slice(inner.start + property.end);
}

/** Элемент `<xr:StandardAttribute>` из шаблона ruleset вида или `null`. */
export function defaultStandardAttributeElementXml(
  ruleset: FormatRuleset,
  rootKind: string,
  attributeName: string
): string | null {
  // Корневой тег приходит из XML строкой; собственное свойство META_TYPES отсекает
  // и чужие теги, и унаследованные имена (`toString`).
  if (!Object.prototype.hasOwnProperty.call(META_TYPES, rootKind)) {
    return null;
  }
  const block = ruleset.standardAttributes(rootKind as MetaKind);
  const re = new RegExp(
    `<xr:StandardAttribute name="${escapeRegExp(escapeXmlAttribute(attributeName))}">[\\s\\S]*?</xr:StandardAttribute>`
  );
  return re.exec(block)?.[0] ?? null;
}

/**
 * XML стандартного реквизита корня объекта: явный элемент файла → (при
 * `useDefaults`) элемент шаблона вида → голый `<xr:StandardAttribute name="X"/>`.
 */
export function resolveStandardAttributeXml(
  objectXml: string,
  attributeName: string,
  options: ResolveStandardAttributeOptions
): string {
  const explicit = extractExplicitStandardAttributeXml(objectXml, attributeName);
  if (explicit) {
    return explicit;
  }
  const rootKind = ROOT_RE.exec(objectXml)?.[2];
  const fromTemplate =
    options.useDefaults && rootKind
      ? defaultStandardAttributeElementXml(options.ruleset, rootKind, attributeName)
      : null;
  return fromTemplate ?? `<xr:StandardAttribute name="${escapeXmlAttribute(attributeName)}"/>`;
}
