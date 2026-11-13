# Рецепты изменений — какие файлы трогать

Справочник для `architect`, `reviewer` и `documenter` (и для реализатора — в части, на которую ссылается
план). Раньше это был раздел «Инвариант изменений» корневого `CLAUDE.md`. Его вынесли сюда, потому что
`CLAUDE.md` загружается в каждый ход каждого агента, а рецепты нужны только при проектировании и ревью.
Архитектурные правила, запреты и центральные контракты остаются в [`CLAUDE.md`](../CLAUDE.md).

## Инвариант изменений — как добавлять функциональность

Для каждого сценария указано, какие файлы трогать. Если требуется править сверх списка — задача решается в другом слое.

- **Новый тип метаданных:** запись в `META_TYPES` → при спец-модуле `ModuleSlot` + карта в `MetaPathResolver` → при наборе свойств схема в `PROPERTY_SCHEMAS` → **строка в `ROOT_PROPERTY_ORDER`** (`infra/xml/properties/PropertyOrder.ts`, порядок свойств корня в `<Properties>`; снимается с эталона `example/`). **Без неё деградация МОЛЧАЛИВАЯ:** отсутствующее свойство вставляется в конец `<Properties>` мимо порядка платформы, а корпусный гейт этого не поймает — он сверяет только виды с экземплярами в `example/`, у нового вида экземпляров нет, значит нет и требования строки. Вид без экземпляров в корпусе — вакуумный ноль: строку заводить только по реальному эталону, иначе консервативный фолбэк «в конец» (см. [xml-format-rulesets.md](./xml-format-rulesets.md#порядок-прямых-детей-properties-корневого-объекта-по-виду)) → иконка `src/icons/{light,dark}/<icon>.svg` → при нестандартной сборке узла builder в `ui/tree/nodeBuilders/` → тест `ObjectXmlReader` на пример из `example/`.
- **Новый слот модуля (`ModuleSlot`):** литерал в `domain/ModuleSlot.ts` → путь в карте `MetaPathResolver` → при необходимости `OpenModuleCommandId` + команда → поле `modules` в записях `META_TYPES`.
- **Новый дочерний тег (`ChildTag`):** значение в `domain/ChildTag.ts` + `CHILD_TAG_CONFIG` → при своём контейнере расширить `ObjectXmlReader.parseChildren` → тег в `childTags` нужных `META_TYPES`.
- **Новый контейнерный дочерний тип со своими вложенными листьями** (паттерн ТЧ→Колонка; второй прецедент — HTTPСервис→URLШаблон→Метод, см. [mcp-paths.md](./mcp-paths.md#26-расширенные-примеры-путей) и [metadata-navigator.md](./metadata-navigator.md#контейнерные-дочерние-узлы-тчколонка-и-httpсервисurlшаблонметод)): контейнер и лист — обе отдельные записи `MetaKind`/`META_TYPES`/`ChildTag`; лист парсится в `MetaChild.columns` контейнера через `ObjectXmlReader.toXxxChild` (образец `toTabularSectionChild`) → имя родителя-контейнера пробрасывается ПАРАЛЛЕЛЬНЫМ полем контекста (`tabularSectionName`/`urlTemplateName`), а не переименованием существующего слота и не новым реестром → `domain/CanonicalNames.ts` (`canonicalChildPath`) обобщает контейнерную ветку по этому полю → узел дерева строится симметрично в ДВУХ источниках — `infra/cache/MetadataCache.ts` (webview) и `ui/tree/nodeBuilders/metaObjectTreeBuilder.ts` (нативный TreeView/свойства) → `infra/xml/XmlUtils.ts` получает nesting-aware `findXxxRangeInYyy`/`extractXxxXmlFromYyy` (образец `findColumnRangeInTabularSection`) → MCP add-инструмент для листа получает флаг-аналог `inTabularSection` (например `inUrlTemplate`) в `McpAddToolsRegistration.ts`, владелец — сам контейнер (`allowedOwnerKinds: ['<Контейнер>']`).
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
  `<Properties>`, см. [xml-format-rulesets.md](./xml-format-rulesets.md#свойства-выбора-форм-по-виду-метаданных)):
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
  [xml-format-rulesets.md](./xml-format-rulesets.md#состав-свойств-типизированного-поля-по-виду-владельца)):
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
- **Новое правило пространства нумерации `id` формы** (какие теги делят одно пространство уникальности
  id в `Form.xml`, см. [xml-format-rulesets.md](./xml-format-rulesets.md#пространства-нумерации-id-в-formxml)):
  запись в `ID_SPACE_BY_TAG` (`infra/xml/form/FormIdSpaces.ts`) → тест на эталоне обеих генераций формата
  (`example/2.20` и `example/2.21`, cf и cfe). Правило снимается ЭМПИРИЧЕСКИ с эталона `example/`, а не
  выводится из XSD-схемы формы (её у Form.xml нет в проекте) и не из документации платформы. Белый
  список тегов элементов заводить нельзя — структурный признак («тег несёт `id`, но это не
  Attribute/Column/Command») уже один раз протёк в виде такого списка (`createIdAllocator` до
  исправления, см. xml-format-rulesets.md) и пропустил `ColumnGroup`/`SpreadSheetDocumentField`.
- **Новое правило валидации формата** (проверка в `FormValidateService` и аналогичных валидаторах, см.
  [xml-format-rulesets.md](./xml-format-rulesets.md#formvalidateservice-платформенная-выгрузка-обязана-проходить-чисто)):
  платформенная выгрузка корректна по построению, поэтому любое срабатывание на эталоне `example/` —
  ложное, и прогон по всему корпусу — обязательное условие приёмки правила. Правило снимается с
  эталона, а не из головы; **severity выбирается по числу срабатываний на эталоне**: ошибка — только то,
  чего в корректной выгрузке не бывает ВООБЩЕ (0 срабатываний), иначе предупреждение. Число срабатываний
  заносится в комментарий рядом с правилом (образец — замер «179 команд из 23 417» у `Command` без
  `<Action>`), чтобы следующий агент не ужесточил его обратно. Корпусный тест пиннит ТОЧНОЕ число
  смягчённых предупреждений, а не «нет иных видов»; синтетические тесты правила живут в отдельных сьютах
  без привязки к корпусу (`example/` в `.gitignore`, на чистом клоне корпусные тесты пропускаются) плюс
  гейт «инструмент ловит» на мутации реальной формы. **Версии формата живут в ОДНОМ реестре**
  `infra/xml/format/formatRegistry.ts` (`isKnownFormatVersion`/`KNOWN_FORMAT_VERSIONS`) — второго
  перечня версий в валидаторе или тексте сообщения заводить нельзя (локальный набор уже расходился с
  реестром: не знал `2.18` — версию, которую сам генератор пишет в новую форму).
- **Новое правило порядка дочерних элементов `<ChildObjects>`** (в каком порядке вид объекта-владельца
  сериализует прямых детей — `Attribute`/`TabularSection`/`Form`/`Dimension`/`Resource`/…, см.
  [xml-format-rulesets.md](./xml-format-rulesets.md#порядок-прямых-детей-childobjects-по-виду-владельца)):
  строка в `CHILD_OBJECTS_ORDER` (`infra/xml/childObjects/ChildObjectsOrder.ts`), снятая с эталона
  `example/` СКАНОМ КОНТРПРИМЕРОВ (ноль нарушений на всей выборке корпуса, а не «сто подтверждений») →
  тест двусторонней сшивки с `META_TYPES.childTags` (набор видов/тегов с правилом порядка не расходится
  с набором видов/тегов, которые вид реально может содержать) → тест на обеих генерациях формата
  (`example/2.20` и `example/2.21`, cf и cfe) → механика вставки (`ChildObjectsEditor.resolveInsertOffset`)
  при этом НЕ трогается — она не знает ни одного конкретного вида метаданных, только ранги из таблицы.
  Существующие узлы `<ChildObjects>` НЕ переупорядочиваются никогда — правило применяется исключительно
  к вставке нового элемента, нормализация существующих файлов не делается сознательно (полная
  перезапись объекта в git-диффе на каждую мелкую правку и потеря идемпотентности операции).
  **Не путать с осью допустимости:** `META_TYPES.childTags` — какие теги вид МОЖЕТ содержать (читает
  `validate_metadata`/`disallowed-child`, дерево, `allowedOwnerKinds` MCP add-инструментов),
  `CHILD_OBJECTS_ORDER` — порядок сериализации. Валидатор допустимости на ось порядка переводить нельзя:
  пробовалось и откачено (стандартные реквизиты не лежат в `<ChildObjects>` → 16 945 ложных
  предупреждений на эталоне), см.
  [xml-format-rulesets.md](./xml-format-rulesets.md#две-оси-допустимость-дочернего-тега-и-порядок-сериализации).
  Новый дочерний тег вида метаданных → в `childTags` (допустимость) и, если расширение его вставляет, в
  `CHILD_OBJECTS_ORDER` (порядок); `allowedOwnerKinds` add-инструмента выводится из `childTags` сам.
- **Новое правило порядка свойств `<Properties>` КОРНЕВОГО объекта** (в каком порядке вид сериализует
  прямых детей `<Properties>` — `Name`/`Synonym`/`Comment`/…/`DefaultForm`/…, см.
  [xml-format-rulesets.md](./xml-format-rulesets.md#порядок-прямых-детей-properties-корневого-объекта-по-виду)):
  строка в `ROOT_PROPERTY_ORDER` (`infra/xml/properties/PropertyOrder.ts`), снятая с эталона `example/`
  сканом КОНТРПРИМЕРОВ и проверкой АЦИКЛИЧНОСТИ графа предшествования (не «какой порядок чаще» — частотный
  критерий дал бы ложное «правила нет»: варианты — это разные подмножества необязательных свойств) → три
  корпусных гейта (`propertyOrderCorpus.test.ts`: прямой — нет пары тегов, чей порядок в таблице
  противоречит хоть одному файлу; полноты; обратный — каждый ключ строки подтверждён эталоном; критерий
  НЕ «равно топосортировке») плюс сшивка `propertyOrder.registry.test.ts` → механика вставки
  (`properties/PropertyInsert.ts`) НЕ трогается — она не знает ни одного вида, только ранги. Существующие
  блоки `<Properties>` НЕ переупорядочиваются никогда, только вставка отсутствующего тега; валидацию
  порядка в `validate_metadata` заводить нельзя (0 срабатываний на эталоне, чинить отказались —
  предупреждение неисполнимо). Фолбэки асимметричны намеренно: писатель объектов (`ObjectXmlReader`)
  неизвестный ключ дописывает в конец, писатель корня конфигурации (`ConfigurationXmlEditor`) — отказ
  (опечатка иначе породила бы мусорный тег). **Не сливать четыре разные оси:** `ROOT_PROPERTY_ORDER` —
  порядок СЕРИАЛИЗАЦИИ свойств корня; `ui/views/properties/propertyKeyOrder.ts` — порядок ПОКАЗА в панели
  (у справочника `ObjectPresentation` в файле 36–40-й, в панели 4–8-й; у отчёта `MainDataCompositionSchema`
  в файле между двумя формами, в панели после всех шести); `CONTROLLED_PROPERTY_KEYS` — свойства
  ДОЧЕРНЕГО элемента; `FORM_PROPERTY_KEYS_BY_KIND` — какие ключи вида — ссылки на форму. Вставка `<Type>`
  ищет якорь по разобранным блокам (`collectPropertyBlocks`), а не парной регуляркой `<Comment>…</Comment>`
  — платформа пустой комментарий пишет самозакрытым `<Comment/>`.
- **Новый вспомогательный XML-файл объекта** (`Ext/Flowchart.xml`, дескриптор формы, макет и т.п.):
  корневой элемент и пространство имён берутся с эталона `example/`, а НЕ выводятся по аналогии с соседним
  файлом (`Flowchart.xml` писался как `<Flowchart xmlns=MDClasses/>`, эталон — `<GraphicalSchema
  xmlns=…/xcf/scheme>`) → пространства имён — ПОЛЕМ `FormatRuleset` (образец — `graphicalSchemaXmlns`;
  ось версии: у 2.20 нет `xmlns:pal`), а не литералом в builder'е → общий скелет + профиль различий (образец
  — `buildGraphicalSchemaXml(version, ruleset, grid)`) → golden-фикстура выводится из эталонного файла
  корпуса, а не снимается с вывода генератора (иначе фикстура закрепит ошибку). Не заявлять «снятым
  правилом» то, что в корпусе неоднородно. См.
  [xml-format-rulesets.md](./xml-format-rulesets.md#графическая-схема-flowchartxml-и-макет-графическая-схема).
- **Любой писатель файла выгрузки (и служебного кэша):** только через `infra/fs/AtomicFileWriter`
  (`writeFileAtomic`) либо `writeTextFilePreservingBomAndEol`, который делегирует туда. Собственный
  `fs.writeFileSync`/`rename` для файла выгрузки заводить нельзя — третьей копии temp+rename быть не
  должно. Граница гарантии — обрыв процесса, не потеря питания (`fsync` нет); временный путь не оканчивается
  на `.xml` (watcher `src/**/*.xml`). Почему это не та же механика, что staging-выгрузка CF — в
  [architecture.md](./architecture.md#атомарная-запись-файлов-выгрузки-infrafsatomicfilewriterts).
- **Новая команда:** класс в `ui/commands/...` с `readonly id` → регистрация в `CommandRegistry.registerAll` → `package.json → contributes.commands` → при меню узла `contributes.menus` c `when: viewItem =~ /…/` → при хоткее `contributes.keybindings`.
- **Новый потребитель пути формы** (MCP-инструмент или команда навигатора, которым нужно тело
  `Ext/Form.xml`, дескриптор формы или XML владельца по узлу дерева): только через
  `ui/tree/formNodePaths.ts` (`resolveObjectFormNodeParts`/`resolveFormBodyFromNode`) → арифметика путей —
  в `MetaPathResolver` (`resolveFormXmlByDescriptor`/`resolveChildFormDescriptor`/`resolveChildFormXml`;
  тело считается явно, не через `getObjectLocationFromXml` — его эвристика ломается на форме с именем
  `Forms`) → тело читается через `readFormXml`/`assertFormRootXml` (`infra/xml/form/FormShared.ts`) —
  guard по КОРНЕВОМУ элементу, а не по вхождению `<Form`. **`node.xmlPath` узла формы объекта — XML
  объекта-владельца** (адрес открытия по клику, его же читают панель свойств, гейт блокировок,
  заимствование CFE, декорации), трактовать его как путь формы нельзя: так `edit_form` писал правку поверх
  XML справочника. Тестовые узлы формы строить как продакшн-билдер (с `xmlPath` владельца). См.
  [metadata-navigator.md](./metadata-navigator.md#инвариант-узла-формы-xmlpath-принадлежит-владельцу).
- **Новый builder узла:** `ui/tree/nodeBuilders/<имя>.ts` → регистрация в диспетчере `metaObjectTreeBuilder.ts`. XML — только через `parseObjectXml`/`ObjectXmlReader`.
- **Новая декорация узла:** класс в `ui/tree/decorations/` (реализует `vscode.FileDecorationProvider`) → регистрация в `Container.wireTreeView` → суффикс `contextValue` — только в `TreeNode`.
- **Новый view/webview:** класс в `ui/views/<Имя>ViewProvider.ts` (без XML/FS) → данные готовит отдельный сервис → создание и команда открытия через `Container`.
- **Новый сервис инфры:** класс в `infra/<подпапка>/<Имя>Service.ts` без `vscode`, `Logger` через конструктор → создать в `Container.bootstrap` → тест на пример из `example/`.
- **Новая возможность LSP:** встроенных провайдеров нет; completion/hover/diagnostics добавляются в `bsl-analyzer`, здесь проверяется только интеграция `LspManager`.
- **Новая настройка:** `package.json → contributes.configuration.properties` с префиксом `onecdev.<область>.<ключ>`, `description` на русском → читать только через `vscode.workspace.getConfiguration('onecdev')` в UI/Container → при рантайм-влиянии подписка на `onDidChangeConfiguration`.
- **Новый watcher:** `FileSystemWatcher` — только в `Container` или `ui/support/`; обработчик делегирует в сервис.
- **Внешняя интеграция (vrunner):** запуск процесса в `ui/commands/ext/`; декодирование OEM/Win1251 через `iconv-lite`; прогресс/отмена через `vscode.window.withProgress`.
- **Новая операция чтения данных из базы через пакетный Конфигуратор** (данных, которых нет в
  XML-выгрузке — список/состояние; образец — список подключённых расширений для
  `onecdev.connectExtension`): CLI-команда `cli/commands/<name>.ts` с гейтом по `exitCode` процесса
  (не по тексту лога) и передачей результата через `-ResultFile` (не marker-блок в stdout — избегает
  порчи данных построчным `LineBufferedDecoder`) → чистый парсер в `infra/<область>/<Name>Parser.ts` без
  `vscode`/spawn (снятие BOM, разбор строк, при необходимости — чистая функция выбора для UI) → тонкая
  UI-обёртка `ui/commands/.../*CommandRunner.ts` (спавн CLI + чтение `-ResultFile`, `undefined` при
  недоступности) → диалог без ручного fallback-ввода: при `undefined`/пустом/полностью исчерпанном
  списке — явные `showErrorMessage`/`showInformationMessage` по причине и отмена операции, без
  переключения на ручной ввод значения пользователем. Подробности и обоснование —
  [architecture.md](./architecture.md#паттерн-чтение-данных-из-базы-через-пакетный-конфигуратор-file-handoff).
- **Новая операция обмена с базой через CF/CFE-файл** (бинарная выгрузка/загрузка, не чтение
  списка/состояния — для последнего см. пункт выше): guard'ы и вектор аргументов Конфигуратора — в
  `infra/cfFile/` (`CfFileArgs.buildCfFileDesignerArgs`, `CfFileValidation.validateCfFileRequest` —
  ЕДИНСТВЕННАЯ точка композиции проверок) без `vscode`/spawn → CLI-команда `cli/commands/<name>.ts`
  парсит и ПОЛНОСТЬЮ валидирует аргументы ДО `resolveConnection` (платформа не диагностирует ни
  неверный ключ, ни рассинхрон «суффикс↔расширение», а при сбое всё равно оставляет побочные эффекты —
  см. [architecture.md](./architecture.md#паттерн-бинарный-обмен-cfcfe-через-пакетный-конфигуратор-dumpcfgloadcfg))
  → тонкая UI-обёртка `ui/commands/ext/CfFileCommandRunner.ts` (переиспользует
  `resolveConnectionFromSettings`/`runInternalCliCommand` из `ExtensionCommandRunner`, как импорт/
  обновление) → диалоги в `ui/commands/ext/CfFileCommands.ts` + пункт в `getNodeActions` (не
  `addModuleActions` — это действие корневого узла конфигурации/расширения, а не слот модуля) →
  MCP-инструмент в `McpConfigLifecycleTools.ts`, зовущий ТОТ ЖЕ `CfFileCommandRunner`. Любая мутирующая
  операция такого рода берёт общий `ConfigurationOperationGuard` (`services.configurationOperationGuard`,
  см. рецепт «Новая операция, запускающая Конфигуратор…») — она работает с той же базой, что импорт/обновление конфигураций,
  конкурентный запуск повредил бы данные. **Вектор аргументов Конфигуратора обязан быть под точным
  регресс-тестом** (не полагаться на `exitCode`/лог) — платформа молча принимает и игнорирует
  неизвестные ключи (проверено: заведомо несуществующий ключ даёт exit 0), поэтому единственная
  защита от ошибки в векторе — тест самого набора аргументов, а не поведения процесса. Staging-путь
  для выгрузки — `CfFileValidation.resolveDumpStagingPath` (перенос на целевой путь только при
  `exitCode === 0`), а не прямая запись в целевой файл. Post-mutation путь для `load`-операции —
  СОЗНАТЕЛЬНОЕ отклонение от общего (см. architecture.md выше), не «чинить» его к единому пути без
  повторного замера платформы. **Пакетная версия такой операции («все расширения базы»)** — ЦИКЛ по
  именам из `/DumpDBCfgList -AllExtensions`, а не флаг `/DumpCfg`/`/LoadCfg` (у них ключа нет, платформа
  принимает его молча и работает с ОСНОВНОЙ конфигурацией); вектор КАЖДОЙ итерации сверяется поэлементно,
  включая «`-AllExtensions` есть ровно у `/DumpDBCfgList`». Политики отказа разные намеренно: dump
  продолжается после сбоя одного расширения, load останавливается на первом с `failedAt`/
  `stateUncertain`; манифест `cfe-dump.json` описывает только ТЕКУЩИЙ прогон (не сливать записи прошлых);
  staging-остаток опознаётся по маркеру `DUMP_STAGING_SUFFIX`, а не по форме суффикса; перенос staging —
  `moveStagingToTarget` из `cli/core/onecCommon.ts`, второй копии temp+rename не заводить. Подробности и
  обоснования — [architecture.md](./architecture.md#пакетный-случай-все-расширения-базы-одной-операцией-dump-cfe-allload-cfe-all).
- **Открытие BSL-модулей:** только реальные `file://` документы (виртуальная схема `onec://` удалена).
  Readonly модуля — через `ui/readonly/BslReadonlyGuard.ts`; readonly по захвату хранилища —
  `EditorReadonlyController` (`ui/readonly/EditorReadonlyController.ts`). Обе точки применяют переход к
  уже открытому ресурсу через общий адаптер `ui/readonly/sessionReadonly.ts`
  (`collectOpenTabs`/`runWithResourceActive`) и выбор маршрута `ui/readonly/readonlyTabSelection.ts`
  (`selectReadonlyApplyRoute`) — readonly-команда VS Code действует только на правую (основную) сторону
  активного редактора, поэтому левая file:-сторона diff переключается через временную вкладку.
- **Новая операция хранилища, меняющая файлы проекта** (аналог `repository.lock`/`update`/
  `updateToVersion`/`unlock`/`commit`, см. [repository-file-sync.md](./repository-file-sync.md)): поток в
  `ui/commands/repository/*Sync.ts` с внешними точками через `RepositoryFileSyncDeps` → диалоги (рекурсия,
  `-force`, номер версии) — только через `RepositoryCommandDialogs.ts`, не инлайн в команде → вопрос о
  рекурсии задаётся только когда `RepositoryService.canApplyRecursively(node)` вернул `true` (корень
  конфигурации/расширения и подсистема — всегда, иначе по `<ChildObjects>` XML единицы на предмет тегов из
  `REPOSITORY_SUBORDINATE_TAGS`); не спрошено → `recursive = false`, платформа всё равно довозит новые
  подчинённые (стратегия `new-subordinates`) → занятость guard'а проверяется
  (`ensureRepositoryGuardFree`) до первого диалога → ОДНА аренда `runExclusive` только на CLI хранилища,
  `applyLock`/`applyUnlock` и выгрузку во временный каталог (`runDumpRounds`) → слияние
  (`RepositoryMergePlanner`/`Applier`), модальные диалоги и диффы — после аренды → выгрузка никогда не пишется
  прямо в проект, имена подчинённых объектов в `-listFile` берутся только из источника, соответствующего базе
  (несуществующее имя роняет всю выгрузку) → новый вид подчинённого объекта с собственным XML — запись в
  `SUBORDINATE_OBJECT_FOLDERS` (`infra/fs/SubordinateObjectLayout.ts`, единственный источник подкаталогов
  подчинённых, из него читают и `REPOSITORY_SUBORDINATE_LAYOUT` в `RepositoryObjectNames.ts`, и
  `SupportInfoService`), а не новый словарь → тест на копии реальной фикстуры с имитацией платформы
  `src/test/suite/support/partialDumpFixture.ts`. CLI с `-ObjectsFile` запускать только через
  `runSubjectCli` (удаляет файл в `finally` при любом исходе, включая исключение); аренду guard'а брать
  только через `runRepositoryExclusive` (первым шагом сама подметает хвосты через
  `sweepRepositoryTempArtifacts`/`infra/repository/RepositoryTempCleanup.ts` — отдельно вызывать не
  нужно); ресурсы выгрузки во временный каталог до передачи владения вызывающему оборачивать в
  `disposeOnError`/`disposeOnErrorAsync` (там же), а не голым `try/catch`; каталог выгрузки создавать
  только через `createImportTempDir` (`infra/fs/WorkspaceTempDir.ts`), а сессию выгрузки агента — через
  `buildAgentDumpSessionId`, иначе хвосты после краха не подметёт `sweepStaleOperationTemp` — см.
  [repository-file-sync.md](./repository-file-sync.md#временные-файлы-и-очистка). Любое удаление файла/
  каталога хранилища или временного каталога операции Конфигуратора — только через
  `removePathWithRetries`/`describeFsError` (`infra/fs/PathRemoval.ts`, issue #104 — примитив удаления
  вынесен сюда из `RepositoryTempCleanup.ts`, чтобы им мог пользоваться и код вне хранилища;
  `RepositoryTempCleanup.ts` по-прежнему единственный источник раскладки путей и очистки самого
  хранилища, но саму функцию удаления импортирует оттуда же), никогда голым
  `fs.rmSync`/`fs.rmdirSync` — на Windows временные
  `EPERM`/`EBUSY`/`ENOTEMPTY` при удалении требуют повтора (тем же примитивом закрыт
  `ExtensionCommandRunner.removeTempDir` для импорта cf/cfe). Шаги
  снимков после того, как операция на сервере уже состоялась (захват/получение/отмена/помещение), —
  только через best-effort-обёртки `ui/commands/repository/RepositorySnapshotSteps.ts`
  (`trySnapshotStep`/`captureUnitSnapshotStep`/`captureRootManifestStep` + сводное
  `reportSnapshotFailures`), а не прямым вызовом `RepositoryLockSnapshotStore` — сбой снимка не должен
  рвать уже выполненную операцию хранилища, только логироваться и попадать в одно немодальное
  предупреждение после аренды. См.
  [repository-file-sync.md](./repository-file-sync.md#шаги-снимков--best-effort-issue-103). Окна сравнения —
  единая конвенция сторон (слева локальное состояние, справа версия хранилища, `MergeDiffPair` +
  `formatMergeDiffTitle` в `RepositoryFileSyncDialogs.ts`); снятие/применение readonly сессии к ресурсу
  файла проекта (в т.ч. когда он открыт только левой стороной diff) — через
  `ui/readonly/sessionReadonly.ts` (`runWithResourceActive`) и `ui/readonly/readonlyTabSelection.ts`
  (`selectReadonlyApplyRoute`), а не напрямую командой `resetActiveEditorReadonlyInSession` — см.
  [repository-file-sync.md](./repository-file-sync.md#readonly).
- **Новый источник статусов захвата хранилища** (аналог файлового `1cv8ddb.1CD`/сетевого crserver, см.
  [repository-file-sync.md](./repository-file-sync.md#статусы-захватов-с-сервера)): реализация в
  `infra/repository/<Имя>RepositoryLockStatusSource.ts` — класс без `vscode`, реализующий
  `RepositoryLockStatusSource` (`supports(location)` + `readLocks(location, context)` из
  `RepositoryLockStatusSource.ts`), ошибки — только через `RepositoryLockStatusError` с кодом из
  `RepositoryLockStatusErrorCode`, никогда не бросать наружу произвольное исключение → регистрация ТОЛЬКО
  добавлением в список источников по умолчанию `RepositoryLockStatusService` (конструктор принимает
  `sources?: readonly RepositoryLockStatusSource[]`) → `classifyRepositoryLocation`
  (`RepositoryLockStatusSource.ts`) при новом виде адреса привязки получает новый вариант
  `RepositoryLocation['kind']`. Модель (`RepositoryLockState`, `state.json`), сопоставление uuid→fullName
  (`mapServerLocksToUnits`/`ConfigDumpInfo.xml`) и UI (дерево, меню, команда `refreshLocks`) новый источник
  не трогает — вся зависимость от вида хранилища заперта в самом источнике и в `classifyRepositoryLocation`.
  Разбор бинарного/XML-формата ответа — отдельный чистый модуль без `vscode` (образец —
  `onecd/OneCdFile.ts`+`OneCdTable.ts` для 1CD, `crs/CrsClient.ts`+`infra/xml/CrsMessageXml.ts` для
  crserver), а не встроенный парсинг внутри класса источника. Тест — на реальных байтах/файлах,
  снятых с платформы (генератор `example/tools/build-repository-locks.mjs`), синтетика недопустима —
  формат недокументирован платформой. После `connect`/`create` (без `-NoBind`) опрос вызывается не из
  самой команды, а из `ui/commands/repository/RepositoryBindFlow.ts` (`completeRepositoryBind`) через тот
  же `syncTarget` — новый источник не требует отдельной интеграции для этого пути (issue #106, см.
  [repository-file-sync.md](./repository-file-sync.md#статусы-захватов-с-сервера)).
- **Новая операция, запускающая Конфигуратор для полного импорта/обновления/применения конфигурации к
  базе** (аналог `importConfigurations`/`updateChangedConfigurations`/`runPostRepositorySync`): захват —
  через `services.configurationOperationGuard` (`runExclusive(title, op)` для одной атомарной цепочки
  либо `tryAcquire(title)` + `release()` в `finally`, если между проверкой и запуском есть модальный
  диалог, тогда отказ отдаётся вызовом `tryAcquireOrHeldBy(title)` — единая точка, сразу возвращающая
  `heldBy` держателя) → сообщение о занятости — только `notifyConfigurationOperationBusy`
  (`ui/commands/ext/configurationOperationBusy.ts`), **без `await`** (см. запрет №18) → фоновый (`void`)
  путь без ожидающего пользователя логирует исход в `outputChannel` и уведомляет тем же способом, а не
  падает молча → контекст enablement `onecdev.isUpdatingConfigurations` вручную нигде не выставлять —
  его синхронизирует только `Container.wireConfigurationOperationContext()` подпиской на
  `guard.onDidChangeBusy` → модальные диалоги подтверждения по возможности держать ВНЕ аренды (проверка
  занятости — до диалога, повторный захват — после) → runner'ы Конфигуратора и диалоги внедряются через
  `deps`-объект по умолчанию (образец — `RepositoryDatabaseSync.ts`/`RepositoryDatabaseSyncDeps`), чтобы
  логику захвата можно было протестировать без реального процесса 1С → **если команда доступна MCP-мосту
  `onecdev_execute_command`** (`V8McpServer`/`McpConfigLifecycleTools.ts`), она обязана на КАЖДОМ пути
  возвращать `ConfigurationCommandOutcome` (`ui/commands/ext/configurationCommandOutcome.ts`:
  `done`/`no-changes`/`no-targets`/`cancelled`/`busy`/`failed`), а при занятости — `{ status: 'busy',
  heldBy }`; мост транслирует этот исход как есть и НЕ опрашивает guard заранее (второй источник правды +
  TOCTOU между проверкой и запуском команды). Подробности —
  [architecture.md](./architecture.md#сериализация-операций-конфигуратора-с-базой-configurationoperationguard).
- **Изменение жизненного цикла/безопасности встроенного MCP-сервера** (порт, идентичность процесса,
  graceful shutdown, Host/Origin, отличается от «новый MCP-инструмент» из раздела выше): чистая логика —
  в `infra/mcp/` (`McpServerIdentity`, `McpStartDecision`, `McpPortProbe`, `McpConflictPrompt`, `McpHost`,
  без `vscode`) → тонкий адаптер конкретного эндпоинта/диалога — `ui/mcp/V8McpServer.ts` (HTTP-роутинг,
  служебные `/identity`+`/shutdown` — не MCP-инструменты) и `Container` (чтение настроек `onecdev.mcp.*`,
  показ диалога конфликта порта). См. [mcp-server-lifecycle.md](./mcp-server-lifecycle.md).
- **Новая часть объекта в панели «Изменения метаданных»** (`MetadataPartKind`, см.
  [git-metadata-changes.md](./git-metadata-changes.md)): случай в
  `infra/git/MetadataChangeResolver.ts` (`resolveSubPath`/дизамбигуация слота через
  `META_TYPES[kind].modules`) → при новом варианте схлопывания статуса — `combineStatus` в
  `infra/git/MetadataChangeAggregator.ts` → метка/статус ЛИСТА в
  `ui/views/changes/changesDtoBuilder.ts` (`partLabelOf`/`toGitStatus`, функции `buildObjectNode`/
  `buildPartNode`; навигаторную иерархию НАД листом строит `changesTreeAssembler.ts` +
  `MetadataChangesViewProvider.resolveAncestors`, этот слой не трогается для новой части) → тест на
  реальном временном git-репозитории (образец — `support/changesFixtures.ts`). Каноничный путь владельца
  — только через `domain/CanonicalNames.ts` (`canonicalRootPath`), не новый форматтер.
- **Новая git-мутация над панелью изменений** (аналог stage/unstage/discard/commit): движок — функция
  в `infra/git/GitWriteService.ts` (без `vscode`) → действие подключается веткой в
  `MetadataChangesViewProvider.handleMessage` (значение `command` протокола) → то же значение `command`
  добавляется на стороне ui в `src-ui/apps/changes/ChangesApp.vue` (пункт контекстного меню узла и/или
  кнопка в `ChangesCommitBox.vue`) → узлы для действия строит `changesDtoBuilder` из `ChangesModel`
  (`resolveChangeAddress` — единственное место, расшифровывающее `nodeId` обратно в файлы). Никаких
  команд `package.json → contributes.commands`/меню `view/item/context` для этой панели не заводится —
  весь UI-контракт живёт во внутреннем протоколе webview (см.
  [git-metadata-changes.md](./git-metadata-changes.md#формат-сообщений-протокола)).
- **Новый триггер обновления панели изменений/декораций по git-событию** (аналог Git Extension API):
  чистый селектор репозитория — `infra/git/GitRepositorySelector.ts` (без `vscode`) → тонкий наблюдатель
  поверх события — `ui/git/` (образец `GitStateObserver.ts` + типовой фасад `gitExtensionApi.ts`) →
  подключение в `Container` (образец `wireGitStateWatcher()`), с обязательным fallback fs-вотчером на
  случай недоступности источника → единственный выход обоих триггеров —
  `Container.scheduleDecorationRefresh()` (не заводить параллельный debounce/refresh-путь). См.
  [git-metadata-changes.md](./git-metadata-changes.md#триггеры-обновления-панели-и-декораций-git-extension-api--fallback-fs-вотчер).
- **Новая возможность блока «История»** (граф git-коммитов внутри панели «Изменения метаданных», НЕ
  отдельная вкладка/провайдер, см. [git-history-graph.md](./git-history-graph.md)), в зависимости от
  слоя:
  - новая колонка/поле графа (например автор-аватар, статус CI) — `RawCommit`/`GitLogParser` (если
    берётся из `git log`) → `GraphRowDto` в `ui/views/history/historyGraphDtoBuilder.ts` →
    `src-ui/shared/types/history.ts` (зеркало) → отрисовка в `src-ui/apps/changes/CommitGraph.vue`;
  - новая команда протокола (аналог `selectCommit`/`openCommitDiff`/`historyLoadMore`/`historyRefresh`) —
    `MetadataChangesViewProvider.handleMessage` (ветка `switch (message.command)`) → та же строка
    `command` добавляется в `src-ui/apps/changes/ChangesApp.vue` (`sendCommand`); чистая бизнес-логика
    команды — в `historyGraphController.ts`/`ChangesHistorySection` (`ui/views/changes/
    changesHistorySection.ts`), а не в самом провайдере;
  - изменение алгоритма раскладки дорожек — только `infra/git/GitGraphLayout.ts` (чистая функция без
    `vscode`), тест на реальном временном git-репозитории с ветвлением/merge (образец —
    `support/changesFixtures.ts:buildHistoryRepo`);
  - новое поле/метод состояния графа (пагинация, выбор коммита) — `ChangesHistorySection`
    (`ui/views/changes/changesHistorySection.ts`), а не поля самого `MetadataChangesViewProvider` —
    провайдер остаётся тонким диспетчером команд поверх этого helper'а;
  - новая часть/статус объекта в дереве изменений коммита переиспользует ТОТ ЖЕ путь, что и панель
    изменений (см. пункт выше «Новая часть объекта в панели «Изменения метаданных»»), т.к.
    `buildCommitChangesSection` вызывает те же `buildObjectNode`/`buildPartNode`/`synthesizeAncestors` —
    отдельного реестра для блока истории не заводится.
- **Декомпозиция God-класса (косметика, без изменения поведения):** characterization/байт-golden-тест ДО дробления (фиксирует текущий выход) → вынос по доменам/ответственности в подпапку того же слоя (`ui/mcp/registration/`, `infra/xml/<область>/`) через `git mv`/перенос функций без изменения публичного API фасада → диспетчер-`switch` → таблица (данные в `META_TYPES`/спец-реестр infra, поведение — функции поверх) → эталоны golden при этом НЕ редактируются: их правка означает регресс поведения, а не косметику. Для XML-генераторов (`MetadataXmlCreator`, `FormBuilders`) байт-golden обязателен как входное условие (см. `CLAUDE.md`, запрет №17).

## Перенос новой функции из скилов в расширение

1. Бизнес-логику — в `infra/<область>/<Service>.ts` без `vscode` и shell.
2. Тест на реальных XML-фикстурах или временной структуре выгрузки.
3. Если нужно человеку в UI — команда в `ui/commands/**` + действие в `UniversalPanelViewProvider.getNodeActions()`.
4. Если меняет конфигурацию/расширение — MCP-инструмент в `V8McpServer.registerTools()` + запись в `EXTENSION_MCP_TOOLS`.
5. Обновить кэш/дерево/статус через общий post-mutation путь.
