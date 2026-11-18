import { BASELINE_RULESET } from './baselineRuleset';
import { FORMAT_2_20_RULESET } from './format2_20Ruleset';
import type { FormatRuleset } from './FormatRuleset';

/**
 * Ruleset версий формата до 2.20 (2.17–2.19) — гибрид по осям.
 *
 * Корни `MetaDataObject`, графические схемы, generatedTypes и прочие данные
 * объектов остаются baseline: так эти версии генерировались всегда, и на этом
 * выводе держатся эталоны scaffold (2.17) и `DEFAULT_FORMAT_VERSION` (2.18).
 *
 * Ось формы (корень `Form.xml`, написание значений свойств формы,
 * `UseInInterfaceCompatibilityMode` в дескрипторе) берётся у 2.20: старая
 * платформа не знает ни префикса `pal` в форме, ни значения `LockOwner`, а
 * baseline выдал бы именно их.
 *
 * Блоки стандартных реквизитов пишутся (`emitDefaultStandardBlocks: true`) —
 * статус-кво: доноров 2.17–2.19 нет, и проверить, пишет ли их старая платформа,
 * не на чем; на этом выводе держатся те же эталоны scaffold и 2.18.
 */
export const FORMAT_PRE_2_20_RULESET: FormatRuleset = {
  ...BASELINE_RULESET,
  id: 'format-pre-2.20',
  managedFormXmlns: FORMAT_2_20_RULESET.managedFormXmlns,
  managedFormPropertyValueAliases: FORMAT_2_20_RULESET.managedFormPropertyValueAliases,
  includeFormUseInInterfaceCompatibilityMode: FORMAT_2_20_RULESET.includeFormUseInInterfaceCompatibilityMode,
  emitDefaultStandardBlocks: true,
};
