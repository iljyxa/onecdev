# Рецепты: Свойства объектов

Часть справочника [«какие файлы трогать»](../change-recipes.md). Если требуется править сверх списка — задача решается в другом слое.

- **Новая схема свойств / новый ключ в панели свойств корневого объекта:** порядок и состав ключей задаёт
  `ui/views/properties/propertyKeyOrder.ts` (`getRootPropertyKeyOrder`) → подпись ключа — `PROPERTY_TITLE_RU`,
  enum/boolean/localized-классификация — `ENUM_OPTIONS`/множества тегов в `infra/xml/PropertySchema.ts` → при
  новом `PropertyValueKind` расширить `_types.ts` + `PropertyBuilder.ts`. Свойства выбора форм — отдельная
  таблица `FORM_PROPERTY_KEYS_BY_KIND` (см. следующий пункт) + `FORM_PROPERTY_SECTION`. Регулярки — только в
  `infra/xml/`. **Реестр `PROPERTY_SCHEMAS` (вместе с `COMMON_ROOT_KEYS`/`ENUM_ROOT_KEYS`) НЕ читается
  ничем, кроме собственного определения и `export *`** — правка «объекта-схемы» в нём не даёт никакого
  эффекта в панели; не отправлять агента туда. Его судьба (удалить/оживить) — отдельный пункт бэклога, до
  решения код не удалять и не «чинить» вскользь.
- **Новое свойство-ссылка на форму у вида метаданных** (какие теги `*Form` у вида объекта есть в
  `<Properties>`, см. [xml-format-rulesets.md](../xml-format-rulesets.md#свойства-выбора-форм-по-виду-метаданных)):
  запись в `FORM_PROPERTY_KEYS_BY_KIND` (`infra/xml/PropertySchema.ts`; порядок — по эталону, читается через
  `getFormPropertyKeys`/`isFormPropertyKey`, второй список в UI заводить нельзя — `propertyKeyOrder.ts` берёт
  таблицу спредом) → правило снимается ЭМПИРИЧЕСКИ с `example/` по признаку НАЛИЧИЯ тега, а не
  заполненности значения (пустой `<DefaultForm/>` доказывает существование свойства), «0 примеров» у вида без
  экземпляров в корпусе — вакуумный ноль, не доказательство отсутствия → корпусный гейт обеих осей
  (`formPropertyKeysCorpus.test.ts`: каждый ключ таблицы есть в эталоне и ни один формовый тег эталона не
  потерян; сшивка с `META_TYPES`) → при новом виде проверить обе генерации формата (`example/2.20` и
  `example/2.21`, cf и cfe; ось версии — `Auxiliary*` в 2.20 может отсутствовать) → секция «Формы»
  проставляется через `applyFormPropertySection`, заголовок — только `FORM_PROPERTY_SECTION`
  (`propertyKeyOrder.ts`), литерал `'Формы'` не дублировать (webview сравнивает его в
  `PropertiesView.vue`, страж — `formSectionContract.test.ts`).
- **Новое правило состава свойств типизированного поля** (какие теги `<Properties>` допустимы у
  реквизита/измерения/ресурса/колонки/адресного реквизита конкретного вида объекта-владельца, см.
  [xml-format-rulesets.md](../xml-format-rulesets.md#состав-свойств-типизированного-поля-по-виду-владельца)):
  правило двумерное — **вид объекта-владельца × роль поля**, живёт в
  `OWNER_ROLE_RULES` (`infra/xml/typedField/TypedFieldOwnerRules.ts`, ключи верхнего уровня — `MetaKind`,
  второго — `TypeAwarePropertyOwnerKind`: `Attribute`/`AddressingAttribute`/`Dimension`/`Resource`/
  `Column`/`Constant`/`CommonAttribute`). Регистры (`InformationRegister`/`AccumulationRegister`/
  `AccountingRegister`) — не отдельный механизм, а такие же записи этой таблицы. Новая пара
  владелец×роль добавляется ЯВНОЙ записью в `OWNER_ROLE_RULES` — она НЕ выводится автоматически из
  `META_TYPES` (в отличие от набора самих ролей, который выводится из
  `propertySchema === 'typedField'`), поэтому появление нового вида метаданных с измерением/ресурсом
  само по себе состав не подхватывает. При новом управляемом ключе свойства — добавить его в
  `CONTROLLED_PROPERTY_KEYS` (позиция — по месту в `xs:sequence` схемы 1С, список остаётся единой
  надпоследовательностью всех наблюдаемых в эталонах порядков) → значение по умолчанию в
  `DEFAULT_VALUES` (или в `defaults` конкретной пары, если оно зависит от владельца) → тест на реальном
  объекте из `example/2.20`+`example/2.21` (запись через `normalizeTypedFieldPropertiesAfterTypeChange`
  в `infra/xml/TypedFieldPropertyRules.ts`, панель свойств через `getDisplayTypedFieldPropertyKeys`,
  `validate_metadata` с кодом `property-not-allowed`).
