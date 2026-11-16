import type {
  SkdCalculatedFieldDefinition,
  SkdDataSetDefinition,
  SkdDefinition,
  SkdFieldDefinition,
  SkdParameterDefinition,
} from '../DataCompositionSchemaService';
import { escapeXmlText } from '../XmlUtils';
import { buildMlText, buildUseRestriction, emitValueType } from './dcsShared';
import { normalizeCalculated, normalizeField, parseCalculated, parseField, parseParameter } from './schemaParse';
import { buildVariantXml } from './settingsVariant';

export function buildSchemaXml(definition: SkdDefinition): string {
  const dataSources = definition.dataSources?.length ? definition.dataSources : [{ name: 'ИсточникДанных1', type: 'Local' }];
  const defaultSource = dataSources[0].name;
  const dataSets = definition.dataSets?.length ? definition.dataSets : [{ name: 'НаборДанных1', query: 'ВЫБРАТЬ 1 КАК Поле1', fields: ['Поле1: decimal(15,0)'] }];
  const parameters = definition.parameters ?? [];
  const variants = definition.settingsVariants?.length
    ? definition.settingsVariants
    : [{ name: 'Основной', title: 'Основной', selection: ['Auto'], structure: 'details', dataParameters: 'auto' as const }];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<DataCompositionSchema xmlns="http://v8.1c.ru/8.1/data-composition-system/schema"',
    '\txmlns:dcscom="http://v8.1c.ru/8.1/data-composition-system/common"',
    '\txmlns:dcscor="http://v8.1c.ru/8.1/data-composition-system/core"',
    '\txmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings"',
    '\txmlns:v8="http://v8.1c.ru/8.1/data/core"',
    '\txmlns:v8ui="http://v8.1c.ru/8.1/data/ui"',
    '\txmlns:xs="http://www.w3.org/2001/XMLSchema"',
    '\txmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    ...dataSources.map((source) => buildDataSourceXml(source.name, source.type ?? 'Local')),
    ...dataSets.map((dataSet) => buildDataSetXml(dataSet, defaultSource)),
    ...(definition.calculatedFields ?? []).map(buildCalculatedFieldXml),
    ...(definition.totalFields ?? []).map(buildTotalFieldXml),
    ...parameters.flatMap(buildParameterXmlWithAutoDates),
    ...variants.map((variant) => buildVariantXml(variant, parameters.map((parameter) => typeof parameter === 'string' ? parseParameter(parameter).name : parameter.name))),
    '</DataCompositionSchema>',
    '',
  ].join('\n');
}

export function buildDataSourceXml(name: string, type: string): string {
  return ['\t<dataSource>', `\t\t<name>${escapeXmlText(name)}</name>`, `\t\t<dataSourceType>${escapeXmlText(type)}</dataSourceType>`, '\t</dataSource>'].join('\n');
}

export function buildDataSetXml(dataSet: SkdDataSetDefinition, defaultSource: string): string {
  return [
    '\t<dataSet xsi:type="DataSetQuery">',
    `\t\t<name>${escapeXmlText(dataSet.name)}</name>`,
    ...(dataSet.fields ?? []).map((field) => buildFieldXml(field, '\t\t')),
    `\t\t<dataSource>${escapeXmlText(dataSet.source ?? defaultSource)}</dataSource>`,
    `\t\t<query>${escapeXmlText(dataSet.query ?? '')}</query>`,
    '\t</dataSet>',
  ].join('\n');
}

export function buildFieldXml(field: string | SkdFieldDefinition, indent: string): string {
  const parsed = typeof field === 'string' ? parseField(field) : normalizeField(field);
  return [
    `${indent}<field xsi:type="DataSetFieldField">`,
    `${indent}\t<dataPath>${escapeXmlText(parsed.dataPath)}</dataPath>`,
    `${indent}\t<field>${escapeXmlText(parsed.field)}</field>`,
    parsed.title ? buildMlText('title', parsed.title, `${indent}\t`) : '',
    parsed.restrict.length > 0 ? buildUseRestriction(parsed.restrict, `${indent}\t`) : '',
    parsed.role ? `${indent}\t<role><dcscom:${escapeXmlText(parsed.role)}>true</dcscom:${escapeXmlText(parsed.role)}></role>` : '',
    parsed.type ? `${indent}\t<valueType>\n${emitValueType(parsed.type, `${indent}\t\t`)}\n${indent}\t</valueType>` : '',
    `${indent}</field>`,
  ].filter(Boolean).join('\n');
}

export function buildCalculatedFieldXml(field: string | SkdCalculatedFieldDefinition): string {
  const parsed = typeof field === 'string' ? parseCalculated(field) : normalizeCalculated(field);
  return [
    '\t<calculatedField>',
    `\t\t<dataPath>${escapeXmlText(parsed.dataPath)}</dataPath>`,
    `\t\t<expression>${escapeXmlText(parsed.expression)}</expression>`,
    parsed.title ? buildMlText('title', parsed.title, '\t\t') : '',
    parsed.restrict.length > 0 ? buildUseRestriction(parsed.restrict, '\t\t') : '',
    parsed.type ? `\t\t<valueType>\n${emitValueType(parsed.type, '\t\t\t')}\n\t\t</valueType>` : '',
    '\t</calculatedField>',
  ].filter(Boolean).join('\n');
}

export function buildTotalFieldXml(value: string): string {
  // split возвращает string[], но второй элемент может быть undefined.
  const parts = value.split(':');
  const dataPath = parts[0].trim();
  const rawExpression = parts[1] as string | undefined;
  const trimmedExpression = (rawExpression ?? '').trim();
  const expression = trimmedExpression.includes('(') ? trimmedExpression : `${trimmedExpression || 'Сумма'}(${dataPath})`;
  return ['\t<totalField>', `\t\t<dataPath>${escapeXmlText(dataPath)}</dataPath>`, `\t\t<expression>${escapeXmlText(expression)}</expression>`, '\t</totalField>'].join('\n');
}

export function buildParameterXmlWithAutoDates(parameter: string | SkdParameterDefinition): string[] {
  const parsed = typeof parameter === 'string' ? parseParameter(parameter) : parameter;
  const own = buildParameterXml(parsed);
  if (typeof parameter === 'string' && parameter.includes('@autoDates')) {
    return [
      own,
      buildParameterXml({ name: 'НачалоПериода', type: 'dateTime', hidden: true }),
      buildParameterXml({ name: 'КонецПериода', type: 'dateTime', hidden: true }),
    ];
  }
  return [own];
}

export function buildParameterXml(parameter: SkdParameterDefinition): string {
  return [
    '\t<parameter>',
    `\t\t<name>${escapeXmlText(parameter.name)}</name>`,
    parameter.title ? buildMlText('title', parameter.title, '\t\t') : '',
    parameter.type ? `\t\t<valueType>\n${emitValueType(parameter.type, '\t\t\t')}\n\t\t</valueType>` : '',
    parameter.hidden ? '\t\t<availableAsField>false</availableAsField>' : '',
    parameter.valueListAllowed ? '\t\t<valueListAllowed>true</valueListAllowed>' : '',
    parameter.use ? `\t\t<use>${escapeXmlText(parameter.use)}</use>` : '',
    parameter.denyIncompleteValues ? '\t\t<denyIncompleteValues>true</denyIncompleteValues>' : '',
    parameter.value !== undefined ? `\t\t<value>${escapeXmlText(String(parameter.value))}</value>` : '',
    '\t</parameter>',
  ].filter(Boolean).join('\n');
}
