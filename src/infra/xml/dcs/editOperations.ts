import type { SkdEditOperation, SkdEditOptions } from '../DataCompositionSchemaService';
import {
  escapeRegExp,
  escapeXmlText,
  findDirectElementRanges,
  findNestingAwareElementRange,
} from '../XmlUtils';
import {
  countTags,
  editFirstDataSet,
  insertBeforeClose,
  insertIntoSchemaRoot,
  matchBlockRanges,
  matchBlocks,
  readText,
  removeElementByChildText,
  replaceOrInsert,
} from './dcsShared';
import {
  buildCalculatedFieldXml,
  buildDataSetXml,
  buildFieldXml,
  buildParameterXml,
  buildParameterXmlWithAutoDates,
  buildTotalFieldXml,
} from './schemaBuilders';
import { parseField, parseParameter, parseVariant } from './schemaParse';
import {
  appendSectionItem,
  buildConditionalAppearanceItemXml,
  buildDataParameterItemXml,
  buildFilterItemXml,
  buildOrderItemXml,
  buildOutputParameterItemXml,
  buildSelectionItemXml,
  buildStructureItemsXml,
  buildVariantXml,
  editVariantSettings,
  hasSectionItem,
  readDirectChildText,
  removeSection,
  removeSectionItems,
  replaceFirstSectionItem,
  replaceStructureItems,
  stableUserSettingId,
  upsertSectionItem,
} from './settingsVariant';
import type { VariantSettingsScope } from './settingsVariant';

type VariantOperation = Extract<SkdEditOperation,
  | 'add-selection' | 'add-filter' | 'modify-filter' | 'remove-filter' | 'clear-selection' | 'clear-filter' | 'clear-order'
  | 'add-order' | 'add-dataParameter' | 'modify-dataParameter' | 'add-conditionalAppearance' | 'set-outputParameter' | 'set-structure'>;

/**
 * Операции над `dcsset:settings` варианта: таблица вместо ветвей switch — все они идут через
 * один редактор варианта (поиск варианта, предупреждения, вклейка по диапазонам).
 */
const VARIANT_OPERATIONS: Record<VariantOperation, (scope: VariantSettingsScope, value: string, warnings: string[]) => string> = {
  'add-selection': (scope, value) => appendSectionItem(scope, 'selection', buildSelectionItemXml(value, `${scope.indent}\t`)),
  'add-filter': (scope, value) => appendSectionItem(scope, 'filter', buildFilterItemXml(value, `${scope.indent}\t`, `${scope.variantName}/filter`)),
  'modify-filter': (scope, value) => replaceFirstSectionItem(scope, 'filter', buildFilterItemXml(value, `${scope.indent}\t`, `${scope.variantName}/filter`)),
  'remove-filter': (scope, value) => removeSectionItems(scope, 'filter', (item) => readDirectChildText(item, 'dcsset:left') === value.trim()),
  'clear-selection': (scope) => removeSection(scope, 'selection'),
  'clear-filter': (scope) => removeSection(scope, 'filter'),
  'clear-order': (scope) => removeSection(scope, 'order'),
  'add-order': (scope, value) => appendSectionItem(scope, 'order', buildOrderItemXml(value, `${scope.indent}\t`)),
  'add-dataParameter': (scope, value, warnings) => addDataParameter(scope, value, warnings, 'add-dataParameter'),
  'modify-dataParameter': (scope, value, warnings) => addDataParameter(scope, value, warnings, 'modify-dataParameter'),
  'add-conditionalAppearance': (scope, value) => appendSectionItem(scope, 'conditionalAppearance', buildConditionalAppearanceItemXml(value, `${scope.indent}\t`, `${scope.variantName}/conditionalAppearance/filter`)),
  'set-outputParameter': (scope, value) => {
    const name = value.split('=')[0].trim();
    return upsertSectionItem(scope, 'outputParameters', (item) => readText(item, 'dcscor:parameter') === name, buildOutputParameterItemXml(value, `${scope.indent}\t`));
  },
  'set-structure': (scope, value) => replaceStructureItems(scope, buildStructureItemsXml(value, scope.indent)),
};

function isVariantOperation(operation: SkdEditOperation): operation is VariantOperation {
  return operation in VARIANT_OPERATIONS;
}

/**
 * Значение параметра DSL отбрасывается (тип схемой не задан). Повторный параметр в варианте
 * платформа не примет, поэтому дубль — предупреждение без правки.
 */
function addDataParameter(scope: VariantSettingsScope, value: string, warnings: string[], operation: 'add-dataParameter' | 'modify-dataParameter'): string {
  const name = value.replace(/\s*=.*/, '').trim();
  if (hasSectionItem(scope, 'dataParameters', (item) => readText(item, 'dcscor:parameter') === name)) {
    warnings.push(`${operation}: параметр уже есть в варианте ${scope.variantName}: ${name}.`);
    return scope.inner;
  }
  const userSettingId = operation === 'add-dataParameter' ? stableUserSettingId(`${scope.variantName}/dataParameters/${name}`) : undefined;
  return appendSectionItem(scope, 'dataParameters', buildDataParameterItemXml(name, `${scope.indent}\t`, userSettingId));
}

export function applyEdit(xml: string, operation: SkdEditOperation, value: string, options: SkdEditOptions, warnings: string[]): string {
  if (isVariantOperation(operation)) {
    return editVariantSettings(xml, options.variant, warnings, (scope) => VARIANT_OPERATIONS[operation](scope, value, warnings));
  }
  switch (operation) {
    case 'add-field':
      return editFirstDataSet(xml, options.dataSet, (block) => insertBeforeClose(block, 'dataSet', buildFieldXml(value, '\t\t')));
    case 'add-total':
      return insertIntoSchemaRoot(xml, 'totalField', buildTotalFieldXml(value));
    case 'add-calculated-field':
      return insertIntoSchemaRoot(xml, 'calculatedField', buildCalculatedFieldXml(value));
    case 'add-parameter':
      return insertIntoSchemaRoot(xml, 'parameter', buildParameterXmlWithAutoDates(value).join('\n'));
    case 'add-dataSet': {
      const [name, query] = value.includes(':') ? value.split(/:(.+)/) : [`НаборДанных${String(countTags(xml, 'dataSet') + 1)}`, value];
      return insertIntoSchemaRoot(xml, 'dataSet', buildDataSetXml({ name: name.trim(), query: query.trim(), fields: [] }, readText(matchBlocks(xml, 'dataSource')[0] ?? '', 'name') || 'ИсточникДанных1'));
    }
    case 'add-variant':
      return insertBeforeClose(xml, 'DataCompositionSchema', buildVariantXml(parseVariant(value), []));
    case 'add-dataSetLink':
      return insertIntoSchemaRoot(xml, 'dataSetLink', buildDataSetLinkXml(value));
    case 'set-query':
      return editFirstDataSet(xml, options.dataSet, (block) => replaceOrInsert(block, 'query', escapeXmlText(value), 'dataSet'));
    case 'patch-query':
      return editFirstDataSet(xml, options.dataSet, (block) => block.replace('</query>', `${escapeXmlText(value)}\n</query>`));
    case 'modify-field':
      return editFirstDataSet(xml, options.dataSet, (block) => replaceFieldBlock(block, value, warnings));
    case 'modify-parameter':
      return replaceParameterBlock(xml, value, warnings);
    case 'rename-parameter': {
      const match = /^(.+?)\s*=>\s*(.+)$/.exec(value);
      if (!match) {
        warnings.push('rename-parameter ожидает формат OldName => NewName.');
        return xml;
      }
      return renameParameter(xml, match[1].trim(), match[2].trim());
    }
    case 'remove-field':
      return editFirstDataSet(xml, options.dataSet, (block) => removeElementByChildText(block, 'field', 'dataPath', value.trim()));
    case 'remove-total':
      return removeElementByChildText(xml, 'totalField', 'dataPath', value.trim());
    case 'remove-calculated-field':
      return removeElementByChildText(xml, 'calculatedField', 'dataPath', value.trim());
    case 'remove-parameter':
      return removeElementByChildText(xml, 'parameter', 'name', value.trim());
    case 'reorder-parameters':
      return reorderParameters(xml, value, warnings);
  }
}

export function buildDataSetLinkXml(value: string): string {
  const match = /^(.+?)\s*>\s*(.+?)\s+on\s+(.+?)\s*=\s*(.+?)(?:\s*\[param\s+([^\]]+)])?$/.exec(value.trim());
  if (!match) {
    throw new Error('add-dataSetLink ожидает формат: Источник > Приёмник on Поле1 = Поле2 [param Имя].');
  }
  return [
    '\t<dataSetLink>',
    `\t\t<sourceDataSet>${escapeXmlText(match[1].trim())}</sourceDataSet>`,
    `\t\t<destinationDataSet>${escapeXmlText(match[2].trim())}</destinationDataSet>`,
    // Выражения и параметр — прямые дети dataSetLink: обёртку <field> платформа не знает и
    // отбивает импорт всей конфигурации ошибкой XDTO (#33).
    `\t\t<sourceExpression>${escapeXmlText(match[3].trim())}</sourceExpression>`,
    `\t\t<destinationExpression>${escapeXmlText(match[4].trim())}</destinationExpression>`,
    match[5] ? `\t\t<parameter>${escapeXmlText(match[5].trim())}</parameter>` : '',
    '\t</dataSetLink>',
  ].filter(Boolean).join('\n');
}

export function replaceFieldBlock(xml: string, value: string, warnings: string[]): string {
  const field = parseField(value);
  if (!field.dataPath) {
    warnings.push('modify-field ожидает shorthand поля с именем.');
    return xml;
  }
  const range = matchBlockRanges(xml, 'field').find((item) => readText(item.text, 'dataPath') === field.dataPath);
  if (range) {
    // Блок начинается с <field: отступ строки уже стоит в документе.
    return `${xml.slice(0, range.start)}${buildFieldXml(value, '\t\t').trimStart()}${xml.slice(range.end)}`;
  }
  warnings.push(`Поле не найдено, добавлено новое: ${field.dataPath}.`);
  return insertBeforeClose(xml, 'dataSet', buildFieldXml(value, '\t\t'));
}

export function replaceParameterBlock(xml: string, value: string, warnings: string[]): string {
  const parsed = parseParameter(value);
  if (!parsed.name) {
    warnings.push('modify-parameter ожидает имя параметра.');
    return xml;
  }
  const replacement = buildParameterXml(parsed);
  // Только прямые <parameter> корня: регулярка по всему документу начинала блок с
  // самозакрывающегося вложенного <parameter/> (например, в dataSetLink) и тянула его до
  // </parameter> следующего параметра схемы — замена съедала закрывающий тег связи.
  const rootRange = findNestingAwareElementRange(xml, 'DataCompositionSchema');
  if (!rootRange) {
    warnings.push('modify-parameter: не найден корень DataCompositionSchema.');
    return xml;
  }
  const rootInner = xml.slice(rootRange.openEnd, rootRange.closeStart);
  for (const range of findDirectElementRanges(rootInner, 'parameter')) {
    if (readText(rootInner.slice(range.start, range.end), 'name') === parsed.name) {
      // Отступ перед блоком остаётся из исходника, поэтому у замены он срезается.
      const start = rootRange.openEnd + range.start;
      return xml.slice(0, start) + replacement.trimStart() + xml.slice(rootRange.openEnd + range.end);
    }
  }
  warnings.push(`Параметр не найден, добавлен новый: ${parsed.name}.`);
  return insertIntoSchemaRoot(xml, 'parameter', replacement);
}

/**
 * Переставляет параметры схемы на их собственных местах: i-й по позиции прямой
 * `<parameter>` корня заменяется i-м блоком в новом порядке. Разделители между блоками и
 * место параметров относительно `settingsVariant` сохраняются (порядок элементов корня —
 * xs:sequence схемы СКД), а перестановка в текущем порядке возвращает исходный текст.
 * Вложенные `<parameter>` (например, в `dataSetLink`) параметрами схемы не являются.
 */
export function reorderParameters(xml: string, value: string, warnings: string[]): string {
  const order = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (order.length === 0) {
    warnings.push('reorder-parameters получил пустой список.');
    return xml;
  }
  const rootRange = findNestingAwareElementRange(xml, 'DataCompositionSchema');
  if (!rootRange) {
    warnings.push('reorder-parameters: не найден корень DataCompositionSchema.');
    return xml;
  }
  const rootInner = xml.slice(rootRange.openEnd, rootRange.closeStart);
  const ranges = findDirectElementRanges(rootInner, 'parameter');
  const remaining = ranges.map((range) => {
    const block = rootInner.slice(range.start, range.end);
    return { name: readText(block, 'name'), block };
  });
  const sorted: string[] = [];
  for (const name of order) {
    const index = remaining.findIndex((item) => item.name === name);
    if (index === -1) {
      const repeated = sorted.some((block) => readText(block, 'name') === name);
      warnings.push(`reorder-parameters: ${repeated ? 'параметр указан повторно' : 'параметр не найден'}: ${name}.`);
      continue;
    }
    sorted.push(remaining.splice(index, 1)[0].block);
  }
  sorted.push(...remaining.map((item) => item.block));
  let inner = rootInner;
  // С конца, чтобы подстановка не смещала ещё не обработанные диапазоны.
  for (let i = ranges.length - 1; i >= 0; i--) {
    inner = inner.slice(0, ranges[i].start) + sorted[i] + inner.slice(ranges[i].end);
  }
  return xml.slice(0, rootRange.openEnd) + inner + xml.slice(rootRange.closeStart);
}

/**
 * Прицельно переименовывает параметр СКД: меняет ТОЛЬКО `<name>` в целевом
 * `<parameter>`-блоке и текстовые ссылки на параметр (`&amp;Имя` в запросах/выражениях).
 * НЕ трогает `<dataPath>`/`<field>` набора данных и значения фильтров, даже если их
 * текст совпадает с именем параметра (это ссылки на поля результата, а не на параметр).
 */
export function renameParameter(xml: string, oldName: string, newName: string): string {
  const escapedNew = escapeXmlText(newName);
  // Параметры лежат прямыми детьми <DataCompositionSchema>. Ищем диапазон корня,
  // затем прямые <parameter> внутри него: это отсекает вложенные <parameter>
  // из dataSetLink/filter, которые не являются определением параметра схемы.
  const rootRange = findNestingAwareElementRange(xml, 'DataCompositionSchema');
  if (!rootRange) {
    return xml;
  }
  const rootInner = xml.slice(rootRange.openEnd, rootRange.closeStart);
  const paramRanges = findDirectElementRanges(rootInner, 'parameter');
  let inner = rootInner;
  // Идём с конца, чтобы подстановка не смещала ранее вычисленные диапазоны.
  for (let i = paramRanges.length - 1; i >= 0; i--) {
    const range = paramRanges[i];
    const block = inner.slice(range.start, range.end);
    const nameRange = findNestingAwareElementRange(block, 'name');
    if (!nameRange) {
      continue;
    }
    if (block.slice(nameRange.openEnd, nameRange.closeStart).trim() !== oldName) {
      continue;
    }
    const nextBlock =
      block.slice(0, nameRange.openEnd) + escapedNew + block.slice(nameRange.closeStart);
    inner = inner.slice(0, range.start) + nextBlock + inner.slice(range.end);
  }
  const result = xml.slice(0, rootRange.openEnd) + inner + xml.slice(rootRange.closeStart);
  // Ссылки на параметр в запросах/выражениях: маркер `&` (в XML — `&amp;`).
  // Границу имени задаём Unicode-aware lookahead'ом: JS `\b` работает по [A-Za-z0-9_]
  // и НЕ распознаёт конец кириллического имени (доминирующий случай 1С), поэтому
  // `&Товар` иначе не переименовывался бы. `(?![\p{L}\p{N}_])` совпадает, когда
  // следующий символ не является буквой/цифрой/подчёркиванием любого алфавита —
  // это не даёт задеть `&ТоварДва` при переименовании `&Товар`.
  return result.replace(
    new RegExp(`&amp;${escapeRegExp(oldName)}(?![\\p{L}\\p{N}_])`, 'gu'),
    () => `&amp;${escapedNew}`
  );
}
