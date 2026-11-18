import { META_TYPES, type MetaKind } from '../../../domain/MetaTypes';
import type { FormatRuleset } from '../format/FormatRuleset';
import { DEFAULT_FORMAT_VERSION, resolveFormatRuleset } from '../format/formatRegistry';
import { escapeRegExp, escapeXmlAttribute, extractExplicitStandardAttributeXml } from '../XmlUtils';

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
export function rulesetForObjectXml(objectXml: string): FormatRuleset {
  return resolveFormatRuleset(detectObjectXmlFormatVersion(objectXml) ?? DEFAULT_FORMAT_VERSION);
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
