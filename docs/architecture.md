# Архитектура расширения 1С: Редактор конфигураций

## Назначение

VSCode-расширение `onecdev` предоставляет два независимых блока:

1. **[Навигатор метаданных](./metadata-navigator.md)** — дерево объектов конфигураций и расширений из XML-выгрузки.
2. **[Языковая поддержка BSL](./bsl-language-support.md)** — LSP-клиент для внешнего `bsl-analyzer`.

Дополнительно — независимая webview-панель **[«Изменения метаданных»](./git-metadata-changes.md)**
(`onecdevChanges`): `git status` рабочей копии в терминах объектов метаданных, с полноценными
git-операциями (stage/unstage/discard/commit/diff); дерево панели повторяет навигаторную иерархию
основного дерева конфигурации (обрезанную по изменениям), переиспользуя и Vue-компонент отрисовки,
и саму структуру `MetadataTreeProvider`.

Внутри той же панели — второй сворачиваемый блок **[«История»](./git-history-graph.md)**: граф
git-коммитов всего репозитория (свёрнут по умолчанию, грузится лениво при первом раскрытии), где выбор
коммита раскрывает inline изменённые объекты метаданных того же коммита — read-only потребитель движка
панели изменений (`aggregateMetadataChanges`, `changesDtoBuilder`, `changesTreeAssembler`), с собственным
чистым ядром раскладки графа по дорожкам (`infra/git/GitLogReader`, `GitLogParser`, `GitGraphLayout`) и
тонким чистым helper'ом состояния (`ui/views/changes/changesHistorySection.ts`), которым владеет тот же
`MetadataChangesViewProvider` — отдельного webview-провайдера/вкладки/команды для истории нет.

## Структура модулей

```
src/
├── extension.ts                      # тонкий activate/deactivate
├── Container.ts                      # composition root
├── domain/                           # чистый домен без vscode/fs/path
├── infra/                            # файловая система, XML, окружение, хранилище, git/, mcp/
│   ├── repository/                   # RepositoryService (фасад) + RepositoryLockState (state.json),
│   │                                  # RepositoryLockSnapshotStore (снимки/манифест корня),
│   │                                  # RepositoryObjectNames/RepositoryObjectScope (единицы хранилища,
│   │                                  # области файлов), RepositoryDumpPlan/RepositoryDumpRounds (план и
│   │                                  # раунды выгрузки), RepositoryMergePlanner/Applier (трёхстороннее
│   │                                  # слияние), ConfigDumpInfoDiff, ConfigurationChildObjectsSync,
│   │                                  # RepositoryBindingStore — см. docs/repository-file-sync.md;
│   │                                  # crs/ — клиент протокола crserver (tcp/http, XML-слой в
│   │                                  # infra/xml/crs/), см. docs/repository-crs.md
│   ├── fs/AtomicFileWriter.ts        # единственная реализация атомарной записи (temp+rename),
│   │                                  # см. «Атомарная запись файлов выгрузки» ниже
│   ├── mcp/                          # McpServerIdentity/McpStartDecision/McpPortProbe/
│   │                                  # McpConflictPrompt/McpHost — чистая логика жизненного цикла
│   │                                  # встроенного MCP-сервера (без vscode), см.
│   │                                  # docs/mcp-server-lifecycle.md
│   └── git/                          # GitMetadataStatusService (декорации навигатора) +
│                                      # GitPorcelainReader/MetadataChangeResolver/
│                                      # MetadataChangeAggregator/GitBlobReader/GitStatusReader/
│                                      # GitWriteService (движок панели «Изменения метаданных») +
│                                      # GitLogReader/GitLogParser/GitGraphLayout/
│                                      # GitCommitChangesReader (чистое ядро блока «История»,
│                                      # см. docs/git-history-graph.md)
├── ui/                               # команды, дерево, webview, readonly guard
│   ├── views/changes/                # changesDtoBuilder (листья дерева) + changesTreeAssembler
│   │                                  # (сборка навигаторной иерархии секции) + changesHistorySection
│   │                                  # (чистый helper состояния блока «История» поверх
│   │                                  # historyGraphController/historyGraphDtoBuilder) +
│   │                                  # MetadataChangesViewProvider (единственный webview-провайдер
│   │                                  # onecdevChanges — строит цепочки предков через
│   │                                  # treeProvider.getParent на реальном MetadataTreeProvider и
│   │                                  # диспетчеризует команды блока «История»)
│   ├── views/history/                # ТОЛЬКО чистые модули (без vscode): historyGraphDtoBuilder/
│   │                                  # historyGraphController — см. docs/git-history-graph.md
│   └── git/                          # OnecGitContentProvider (схема onec-git для diff HEAD/индекс
│                                      # и произвольного commit-ish для блока «История»)
├── lsp/
│   ├── LspManager.ts                 # запуск и перезапуск bsl-analyzer
│   └── analyzer/
│       ├── BslAnalyzerService.ts     # установка, обновление, путь к бинарнику
│       └── BslAnalyzerStatusBar.ts   # индикатор состояния
└── test/
```

Встроенного LSP-сервера в `src/lsp/server` нет. Языковые возможности
предоставляет только внешний процесс `bsl-analyzer lsp`.

### Декомпозиция God-классов на тонкий фасад + подмодули

Правило зафиксировано в [change-recipes.md](./change-recipes.md) («Декомпозиция God-класса») и
в `CLAUDE.md` (запрет №17): большой класс дробится на тонкий фасад/барель + набор
файлов-подмодулей по ответственности **в подпапке того же слоя**, публичный API и
поведение не меняются байт-в-байт. Для XML-генераторов обязателен предварительный
байт-golden-тест как входное условие рефакторинга.

Реализованные образцы паттерна:

- `ui/mcp/V8McpServer.ts` (фасад, только HTTP-транспорт/сессии/Host-Origin-защита)
  + `ui/mcp/registration/*` — регистрация MCP-инструментов по доменам
  (`McpNavigationTools`, `McpConfigInfoTools`, `McpTemplateTools`,
  `McpExternalObjectTools`, `McpFormTools`, `McpSubsystemTools`, `McpRoleTools`,
  `McpConfigLifecycleTools`, `McpPropertyTools`) + `McpMutationGate` (общий
  post-mutation шлюз и формат-хелперы ответов) + `McpRegistrationDeps` (контракт
  зависимостей, разделяемых всеми доменными модулями).
- `infra/xml/MetadataXmlCreator.ts` (фасад) + `infra/xml/creator/*`
  (`creatorShared`, `rootObjectBuilders`, `auxiliaryFileBuilders`,
  `childElementBuilders`) — построение корневых XML-объектов, вспомогательных
  файлов и дочерних элементов метаданных.
- `infra/xml/ExternalObjectService.ts` (фасад) + `infra/xml/external/*`
  (`externalObjectShared`, `externalObjectXml`, `bspRegistration`,
  `externalObjectFiles`, `externalObjectValidation`) — работа с EPF/ERF.
- `infra/xml/DataCompositionSchemaService.ts` (фасад) + `infra/xml/dcs/*`
  (`dcsShared`, `schemaParse`, `schemaBuilders`, `editOperations`, `settingsVariant`) — СКД.
  `settingsVariant` — вариант настроек в формате платформы (`dcsset:`/`dcscor:`): порядок секций
  `dcsset:settings` (selection, filter, dataParameters, order, conditionalAppearance,
  outputParameters, затем `dcsset:item` структуры) снят с платформы; билдеры варианта/секций/элементов,
  детерминированный `userSettingID` (`stableUserSettingId`, GUID v5 от затравки вариант/секция/имя),
  редактор секций по диапазонам, `parseVariantInfo`, `readDirectChildText`. Каноническая форма
  подтверждена round-trip через 8.5.1/8.3.27: `dataParameters` с `<dcscor:value xsi:nil="true"/>`,
  элемент `conditionalAppearance` всегда с `selection`/`filter` (пустые — самозакрытые). Эталон —
  `src/test/fixtures/dcs-settings-variant/zapasy-variant-roundtrip-8.5.1.xml`. Билдеры и парсер
  правятся вместе; `xmlns:pal` на `dcsset:settings` 8.3.27 при выгрузке не пишет (косметика).
- `infra/xml/form/FormBuilders.ts` (реэкспорт-барель) + `infra/xml/form/builders/*`
  (`formBuilderShared`, `formElements`, `formAttributes`, `formCommands`,
  `formDocument`) — построение XML управляемых форм.
- `ui/views/properties/PropertyBuilder.ts` (фасад) + `propertyKeyOrder.ts`
  (порядок ключей свойств корневых объектов; `FORM_PROPERTY_SECTION` — контракт
  с webview) + `propertyExtractors.ts` (XML-экстракторы и форматтеры значений).
  Состав свойств выбора форм по виду — `FORM_PROPERTY_KEYS_BY_KIND` в
  `infra/xml/PropertySchema.ts`, см.
  [metadata-navigator.md](./metadata-navigator.md#панель-свойств-где-живёт-порядок-ключей-и-секция-формы).
- `ui/views/properties/PropertiesViewController.ts` + `propertyEditLock.ts`
  (резолвер блокировки редактирования) + `propertyNodeClassification.ts`
  (классификация и snapshot узлов).
- `infra/xml/TypedFieldPropertyRules.ts` (фасад, 708 → 240 строк) +
  `infra/xml/typedField/TypedFieldOwnerRules.ts` (ДАННЫЕ — двумерная таблица
  правил владелец×роль) + `infra/xml/typedField/PropertyBlockEditor.ts`
  (МЕХАНИКА — точечная splice-правка блоков `<Properties>` без знания самих
  правил). Здесь разрез не «по домену», а по роду знания (данные / механика
  применения) — см. [xml-format-rulesets.md](./xml-format-rulesets.md#состав-свойств-типизированного-поля-по-виду-владельца).

Во всех случаях `switch` по `MetaKind`/виду объекта, где он был, оставлен как есть
(это диспетчер поведения, а не реестр данных) — декомпозиция не подменяла его
таблицей, это отдельная задача при появлении настоящего дублирования данных.

### Паттерн: чтение данных из базы через пакетный Конфигуратор (file-handoff)

Когда UI-команде нужны данные, которых нет в XML-выгрузке, а есть только в самой
базе 1С (пример — список расширений, уже подключённых к базе, для команды
`onecdev.connectExtension`), связка устроена в три слоя:

1. **CLI-команда** (`cli/commands/<name>.ts`, образец — `listDbExtensions.ts`)
   запускает пакетный Конфигуратор с нужным ключом (`/DumpDBCfgList
   -AllExtensions`) и `/Out <tmp>`, затем **только при успешном завершении
   (`exitCode === 0`)** переносит результат во входной `-ResultFile`, который
   передаёт вызывающая сторона. Гейт разбора — **код возврата процесса, а не
   содержимое лога**: при ошибке (платформа старее той, что понимает флаг;
   недоступная база) `-ResultFile` не создаётся, и вызывающая сторона узнаёт о
   сбое по его отсутствию, не пытаясь угадывать причину по тексту вывода.
2. **Чистый парсер** в `infra/` (образец — `infra/environment/ExtensionListParser.ts`)
   без `vscode`/spawn: снимает BOM (байтовый UTF-8/UTF-16LE/UTF-16BE через
   `iconv-lite` + символьный `U+FEFF`, оставшийся после декодирования),
   разбирает строки, при необходимости считает чистую функцию выбора для UI
   (`planExtensionChoices`). Все ветки покрываются 100% здесь, а не в
   оркестраторах.
3. **UI-обёртка** (`ui/commands/.../*CommandRunner.ts`, образец —
   `ExtensionCommandRunner.listConnectedDatabaseExtensions`) спавнит CLI через
   `runInternalCliCommand`, читает `-ResultFile` тем же чистым парсером и
   возвращает `undefined` при любом сбое (нет `env.json`, CLI завершился с
   ошибкой, старая платформа без нужного флага). Ручного fallback-ввода нет:
   при `undefined` вызывающий диалог прекращает операцию явным сообщением
   об ошибке, а не переключается на ручной ввод значения пользователем.

Почему `-ResultFile`, а не marker-блок в stdout: `LineBufferedDecoder`
(`infra/process/OutputDecoder.ts`) буферизует и перекодирует вывод процесса
построчно (OEM-866/Win1251) — это годится для логов, но рискует испортить
произвольные данные внутри маркера при таком роундтрипе. Канал через `/Out
<файл>` уже устоявшийся — его использует каждая из `export-configuration`/
`import-configuration`/`update-configuration`/`repository-*`.

Образец целиком: `onecdev.connectExtension` — список расширений для QuickPick
берётся через `list-db-extensions` (CLI) → `listConnectedDatabaseExtensions`
(UI-обёртка) → `resolveExtensionNameToConnect` (сам диалог, только выбор из
базы, без пункта «Ввести вручную…» и без `showInputBox`):
- `undefined` от UI-обёртки (нет подключения к базе/`env.json`, платформа
  старее 8.3.11 — флаг `-AllExtensions` не поддерживается) →
  `showErrorMessage` с точной причиной и подсказкой минимальной версии
  платформы, операция прекращается;
- в базе нет расширений → `showInformationMessage('В подключённой базе нет
  расширений.')`, операция прекращается;
- все расширения базы уже подключены (`planExtensionChoices(...).allConnected`)
  → `showInformationMessage('Все расширения базы уже подключены.')`, операция
  прекращается;
- иначе — `showQuickPick(plan.selectable, …)` только по вычисленному
  `planExtensionChoices` списку неподключённых расширений базы.

Функций `promptExtensionNameManually`/`validateExtensionName` и типа
`ExtensionPickItem` в коде больше нет — подключение расширения возможно
только выбором из списка базы.

### Паттерн: бинарный обмен CF/CFE через пакетный Конфигуратор (`/DumpCfg`/`/LoadCfg`)

Выгрузка/загрузка конфигурации и расширений в бинарные файлы `.cf`/`.cfe` (в
отличие от паттерна file-handoff выше) не читает данные из базы для UI, а
**меняет** содержимое — либо создаёт файл на диске, либо необратимо заменяет
конфигурацию в базе. Связка: `infra/cfFile/` (чистые данные и guard'ы, без
`vscode`/spawn) → `cli/commands/dumpCfFile.ts`/`loadCfFile.ts` (команды
`dump-cf`/`load-cf`, алиасы `db-dump-cf`/`db-load-cf` — совпадают с именами
существующих 1С-скилов) → `ui/commands/ext/CfFileCommandRunner.ts` (тонкая
обёртка спавна, переиспользует `resolveConnectionFromSettings`/
`runInternalCliCommand` из `ExtensionCommandRunner`, как импорт/обновление) →
`ui/commands/ext/CfFileCommands.ts` (диалоги QuickPick/SaveDialog/OpenDialog) и
`ui/mcp/registration/McpConfigLifecycleTools.ts` (`onecdev_dump_cf`/
`onecdev_load_cf`) — оба вызывают ровно один и тот же `CfFileCommandRunner`.

**Всё поведение платформы ниже снято эмпирически** прогонами на реальном
Конфигураторе 8.3.27.1989 на временных файловых базах (`1cv8 CREATEINFOBASE
"File=<каталог>;"` создаёт базу за секунды, полный круг проверки — минуты;
удобный источник отличающейся конфигурации для сравнения — свой же
`ConfigurationScaffoldService`), а не выведено из документации платформы:

- **`-AllExtensions` у `/DumpCfg`/`/LoadCfg` использовать нельзя.** С каталогом
  в качестве пути — exit 1 «Is a directory»; с файлом — **exit 0, «Сохранение
  конфигурации успешно завершено», и результат байт-в-байт равен обычной
  выгрузке ОСНОВНОЙ конфигурации**, то есть флаг молча делает не то, что от
  него ожидают. Причина глубже одного флага: заведомо не существующий ключ
  `-ЗаведомоНетТакого` тоже даёт exit 0 — **пакетный Конфигуратор вообще не
  диагностирует неизвестные ключи**. Следствие для всего проекта: `exitCode`
  подтверждает только «Конфигуратор не упал на том, что понял», а не
  «выполнено именно то, что просили». Поэтому у `buildCfFileDesignerArgs`
  (`infra/cfFile/CfFileArgs.ts`) нет параметра, из которого мог бы получиться
  `-AllExtensions`, а единственная реальная защита самого вектора аргументов —
  точный регресс-тест (`cfFileArgs.test.ts`), а не проверка кода возврата.
  Сценарий «все расширения» делается циклом по `/DumpDBCfgList -AllExtensions`
  (см. `list-db-extensions` выше), а не этим флагом — реализация в подразделе
  «Пакетный случай» ниже.
- **`/LoadCfg` не обновляет конфигурацию базы данных.** Замер: после загрузки
  основная конфигурация — 75408 байт, конфигурация БД осталась 4973; значения
  совпали только после отдельного `/UpdateDBCfg`. Отсюда — отдельный шаг
  применения (`applyToDatabase` в MCP, вопрос-предложение в UI после загрузки)
  и формулировка сообщения об успехе, которая явно говорит, что база ещё не
  обновлена.
- **Ненулевой код возврата не означает отсутствия побочных эффектов.**
  Неудачная `/LoadCfg -Extension <новое имя>` всё равно регистрирует
  расширение в базе; неудачная `/DumpCfg` всё равно оставляет на диске
  16-байтный файл-мусор. Отсюда — staging-схема выгрузки ниже и запрет на
  формулировки вида «ничего не изменилось» в текстах ошибок.
- **Тестовая установка платформы 8.5.1 идёт без Конфигуратора** (только
  `1cv8c`/`1cv8s`) — проверка поведения на 8.5 не проводилась и заявлять её
  нельзя.

**Staging-схема выгрузки** (`dumpCfFile.ts`): `/DumpCfg` пишет во временный
файл `resolveDumpStagingPath` в ТОМ ЖЕ каталоге, что и целевой (перенос —
атомарное переименование внутри одной ФС), и переносится на целевой путь
только при `exitCode === 0`; staging удаляется в `finally` независимо от
исхода. Проверено вживую: при сбое целевой файл не появляется, а уже
существующий файл не портится. Имя staging-файла оканчивается маркером
`DUMP_STAGING_SUFFIX` (`.onecdev.part`), по которому опознаётся остаток
прерванной выгрузки (см. «Пакетный случай» ниже); перенос и уборка —
`moveStagingToTarget`/`safeRemoveFile` из `cli/core/onecCommon.ts`.

**Общий guard операций** — тот же `ConfigurationOperationGuard`
(`infra/process/`, см. «Сериализация операций Конфигуратора с базой»), что у
импорта/обновления и синхронизации с хранилищем: выгрузка/загрузка CF-файла
работает с той же базой и выгрузкой, поэтому конкурентный запуск любой пары из
них повредил бы данные. `onecdev_dump_cf`/`onecdev_load_cf` берут тот же
guard через `withConfigurationOperationLock` (`runExclusive`) в
`McpConfigLifecycleTools.ts` — MCP-агент и пользователь работают с одной базой,
и разделять guard по источнику вызова нельзя.

**Осознанное отклонение от единого post-mutation пути.** После успешной
`/LoadCfg` НЕ вызываются ни `suppressConfigurationReloadForFiles`/
`markChangedConfigurationByFiles`, ни `markConfigurationsClean`, ни инвалидация
hash-кэша — файлы XML-выгрузки проекта при загрузке CF физически не меняются,
поэтому пометить их «изменёнными» или «чистыми» было бы ложью в любую сторону.
Конкретно: если бы конфигурацию пометили «изменённой относительно базы»,
команда «обновить изменённые конфигурации» залила бы СТАРЫЕ файлы проекта
обратно в базу поверх только что загруженного CF, обнулив результат операции.
Вместо этого пользователю после загрузки явно показывается предупреждение,
что XML-выгрузка проекта больше не соответствует базе, и предлагается импорт
конфигураций (`onecdev.importConfigurations`); MCP возвращает то же самое
через поле `projectSourcesOutdated: true`. **Это правило намеренно нарушает
общий пункт «Единый post-mutation путь» из раздела про MCP-сервер ниже** — при
похожих задачах не «чинить» это обратно без повторного замера платформы.

#### Пакетный случай: все расширения базы одной операцией (`dump-cfe-all`/`load-cfe-all`)

Выгрузка/загрузка ВСЕХ расширений базы построена на тех же примитивах, что
одиночный обмен выше. Связка слоёв:

- `infra/cfFile/` — чистые решения без `vscode`/spawn: `CfeBatchNaming`
  (санитизация имени расширения в имя `.cfe`, `~N` при коллизиях внутри плана,
  `planCfeDumpFiles`), `CfeBatchManifest` (`cfe-dump.json`), `CfeBatchPlan`
  (`validateCfeDumpDirectory`, `planCfeLoad` — предполётные отказы),
  `CfeBatchReport` (машинный отчёт CLI ↔ обёртка);
- `cli/commands/dumpCfeAll.ts`/`loadCfeAll.ts` (алиасы `db-dump-cfe-all`/
  `db-load-cfe-all`) + общий `cfeBatchShared.ts`; отчёт возвращается через
  `-ResultFile` (тот же file-handoff, что у `list-db-extensions`);
- `ui/commands/ext/CfeBatchCommandRunner.ts` (спавн CLI, разбор отчёта) →
  `CfeBatchCommands.ts` (диалоги; команды `onecdev.dumpAllExtensionsToCfe`/
  `onecdev.loadAllExtensionsFromCfe`) и пункты в `getNodeActions` на узле
  `extensions-root` (пакетные операции работают со ВСЕЙ базой — место им на
  контейнере расширений, не на корне конфигурации и не на одном расширении);
- MCP `onecdev_dump_all_cfe`/`onecdev_load_all_cfe`
  (`McpConfigLifecycleTools.ts`) зовут тот же `CfeBatchCommandRunner` под тем
  же `ConfigurationOperationGuard`.

Решения, которые нельзя «починить» обратно:

1. **Механизм — цикл по именам из `/DumpDBCfgList -AllExtensions`, а не флаг.**
   У `/DumpCfg`/`/LoadCfg` ключа `-AllExtensions` нет (см. эмпирику выше): он
   принимается молча и операция идёт над ОСНОВНОЙ конфигурацией, агент получает
   рапорт об успехе и файл не с теми данными. Ключа `-NamesFile` в реализации
   нет; список расширений всегда берётся из базы. Флаг `AllExtensions` на входе
   обеих CLI-команд отвергается guard'ом `assertNoAllExtensionsFlag` до
   `resolveConnection`.
2. **Вектор аргументов — под точной поэлементной сверкой**
   (`cfeBatchCliRun.test.ts`, вектор КАЖДОЙ итерации), включая встречное
   утверждение «`-AllExtensions` есть ровно у `/DumpDBCfgList` и ни у кого
   больше»; `/DumpCfg` — только `-Extension <имя>` и staging рядом с целью,
   `/LoadCfg` — только путь `.cfe` и `-Extension <имя>`, `/UpdateDBCfg` не
   запускается вовсе. Это единственная защита: по `exitCode` и логу ошибку в
   аргументах не видно.
3. **Асимметрия политик отказа.** Dump ПРОДОЛЖАЕТ после сбоя одного расширения:
   базу он не трогает, 14 корректных бэкапов из 15 ценны, каждый стоит минут
   работы платформы. Load ОСТАНАВЛИВАЕТСЯ на первом отказе: остальные получают
   `notAttempted`, сбойный попадает в отдельную категорию `failedAt` со
   `stateUncertain: true` (неудачная `/LoadCfg` нового расширения всё равно
   регистрирует его в базе — «не загружено» утверждать нельзя), а продолжать
   заливку поверх неопределённого состояния нельзя. Все отказы, которые можно
   вычислить заранее (расширение есть в каталоге, но нет в базе без
   `createMissing`; манифест ссылается на отсутствующий файл), отбиваются ДО
   первого `/LoadCfg` и останавливают всё, включая здоровые расширения.
   MCP-контракт зеркально разный: `onecdev_dump_all_cfe` при частичном отказе —
   УСПЕХ со списком `failed`; `onecdev_load_all_cfe` при `failedAt` —
   исключение (база в промежуточном состоянии, штатным итогом это не является).
4. **Маркер принадлежности staging-файла — `DUMP_STAGING_SUFFIX =
   '.onecdev.part'`** (`infra/cfFile/CfFileValidation.ts`, рядом с
   `resolveDumpStagingPath`); правило общее для одиночной и пакетной выгрузки.
   Своим остаток признаёт `isDumpStagingFileName` ТОЛЬКО по маркеру, а не по
   форме уникального суффикса: форм две (`pid-время` у одиночной, `pid-время-
   индекс` у пакетной), правило по форме одну из них не узнавало вовсе, а
   пользовательский файл `.backup.2024-01-15.part` под него подходил и
   удалялся бы молча.
5. **Уборка staging-остатков — в начале прогона** (`removeStagingLeftovers` в
   `dumpCfeAll.ts`), а не увеличением таймаута завершения. Обрыв процесса
   (SIGKILL при отмене из UI через 5 с после SIGTERM, падение, отключение
   питания) `finally` не выполняет; щедрый grace лишь сдвигает границу, за
   которую выгрузка большого расширения всё равно выйдет.
6. **Манифест `cfe-dump.json` описывает ТОЛЬКО текущий прогон, и это
   сознательно.** Санитизация имени необратима (`A:B` и `A/B` → `A_B.cfe`),
   поэтому «файл → имя расширения» хранится в манифесте. Сливать в него записи
   прошлого прогона нельзя: это поставило бы подпись «результат этой выгрузки»
   на файлы, которых она не создавала — смешение поколений с видом
   легитимности. Вместо этого загрузка возвращает `restoredByFileName` — имена
   файлов, расширение для которых восстановлено по имени файла, а не по
   манифесту (каталог собран вручную или содержит остатки прерванной
   выгрузки); сигнал идёт в CLI-журнал, в уведомление UI и агенту через MCP.
   Файлы, помеченные в манифесте `failed`, и пустые `.cfe` в план загрузки не
   берутся (прежний одноимённый файл старше остальных бэкапов набора).
7. **Общая механика staging** — `moveStagingToTarget`/`safeRemoveFile` в
   `cli/core/onecCommon.ts` рядом с `createTempDir`/`safeRemoveDir`; её
   используют и `dump-cf`, и `dump-cfe-all`. Второй копии temp+rename быть не
   должно.
8. **Post-mutation путь для load не вызывается** — то же сознательное
   отклонение и с тем же обоснованием, что у одиночного `onecdev_load_cf`
   (см. выше). `applyToDatabase` делает `/UpdateDBCfg -Extension <имя>` по
   одному на каждое ЗАГРУЖЕННОЕ расширение строго после последнего `/LoadCfg`
   (`/UpdateDBCfg -AllExtensions` применил бы и не загружавшиеся расширения);
   вектор применения живёт в `update-configuration`, `load-cfe-all` его не
   дублирует. Ответ инструмента содержит `projectSourcesOutdated: true`.

**О числе покрытия.** «100%» у `ui/commands/ext/CfeBatchCommands.ts` — это 100%
от ~78 неигнорированных строк из 273: под `c8 ignore` оставлено только то, что
требует пользователя и платформы (диалоги, спавн CLI); цикл проверяется на
POSIX-заглушке Конфигуратора (`cfeBatchCliRun.test.ts`). Читать число как «файл
проверен целиком» нельзя.

Раскладка проекта (`src/cf`, `src/cfe/<имя>`) переехала из `cli/core/
projectLayout.ts` в `infra/fs/ProjectLayout.ts` — она нужна и CLI (для
резолвинга файла настроек подключения), и UI (`CfFileTarget.buildCfApplyTarget`
строит цель `/UpdateDBCfg` после загрузки CF); `cli/core/projectLayout.ts`
остался тонким re-export, чтобы не появилось второго источника знания о
раскладке (запрет №2 CLAUDE.md).

Два новых MCP-инструмента и канон их аргументов — в
[mcp-paths.md](./mcp-paths.md#62-инструменты-обмена-cfcfe-через-пакетный-конфигуратор).

### Атомарная запись файлов выгрузки (`infra/fs/AtomicFileWriter.ts`)

Любая запись файла выгрузки (и служебных кэшей) идёт подменой, а не прямым `fs.writeFileSync`:
обрыв прямой записи на середине оставляет обрезанный XML, а битый XML одного объекта делает
нечитаемой ВСЮ конфигурацию, а не один объект. Модуль даёт две функции:

- `resolveAtomicTempPath(target, uniqueSuffix)` — чистая (ФС не трогает): путь временного файла;
- `writeFileAtomic(target, data)` — запись во временный файл рядом с целью и `rename` поверх неё.

Свойства, которые важно не потерять при правках:

- **Временный путь не оканчивается на `.xml`.** Имя — `.<имя цели>.<pid>.<время>.<счётчик>.tmp`.
  Watcher `src/**/*.xml` (`Container.wireFileWatcher`) иначе видел бы временный `.xml` и поднимал лишний
  reload дерева на каждую запись метаданных. Суффикс ставится ПОСЛЕ исходного расширения.
- **Тот же каталог, что у цели** — `rename` атомарен только в пределах одного тома.
- **Симлинк.** Если цель — символическая ссылка, подменяется файл, на который она указывает, а не сама
  ссылка (иначе выгрузка, подключённая симлинком, молча «отвалилась» бы от источника после первой правки).
- **Права существующего файла переносятся** на временный: `rename` подменяет inode, и без `chmod` файл
  получал бы режим по умолчанию.
- **Отказ громкий.** При любой ошибке временный файл убирается, исходное исключение пробрасывается,
  цель остаётся нетронутой. Тихого отката на прямую запись нет сознательно — он вернул бы ровно тот
  дефект (обрезанный файл), ради которого модуль существует.
- **Граница гарантии: обрыв процесса, но не потеря питания.** `fsync` файла и каталога не делается:
  генерация создаёт десятки файлов за операцию, а защищаемый класс отказа — прерванная запись
  (исключение, kill), а не отказ диска. Не описывать эту защиту как «durable».

Кто пишет через него: `writeTextFilePreservingBomAndEol` (`infra/xml/XmlUtils.ts`) делегирует сюда — то
есть все редакторы существующего XML получили атомарность без правок; `HashCache` и `MetadataCache` лишились
собственных копий temp+rename; `CfeBorrowService` — все создания новых файлов. **Единственная реализация
temp+rename в проекте** — до модуля их было две, и каждая новая запись плодила третью; новый писатель файла
выгрузки обязан идти через `writeFileAtomic`/`writeTextFilePreservingBomAndEol`, а не своим `rename`.

**Почему это не одна механика со staging-схемой выгрузки CF** (см. паттерн `/DumpCfg` выше). Внешне похоже
(временный файл в том же каталоге + перенос), но отличается по сути: в staging-схеме файл пишет ЧУЖОЙ процесс
(Конфигуратор), а решение о переносе принимает политика кода возврата (`exitCode === 0`), а не факт
завершения записи; при сбое платформа всё равно оставляет мусор. `writeFileAtomic` пишет строку из
памяти сам и переносит безусловно, если запись удалась. Обобщение в один примитив скрыло бы это различие и
потянуло бы политику `exitCode` в чистый модуль записи.

`CfeBorrowService` — ловушка «эталон стиля». Три места перезаписи существующего файла переведены на
`writeTextFilePreservingBomAndEol(file, originalXml, nextXml)` (раньше писали `writeFileSync` и теряли
BOM/EOL, запрет №12). Исходное содержимое ОБЯЗАНО запоминаться отдельной константой до `replace`: если
передать писателю уже изменённый текст как «оригинал», BOM и стиль переводов строк «сохраняются» с самого
результата, и сохранение становится пустой операцией.

### Два механизма подавления собственных файловых событий

`Container` игнорирует часть событий `FileSystemWatcher`, спровоцированных им же самим (генерация
XML, импорт/обновление конфигурации в базе). Механизма два, у них разная гранулярность, и они гасят
РАЗНОЕ — путать их нельзя:

- **`suppressedConfigurationReloads`** (`Map<нормализованный путь файла, expiresAt>`, поле
  `Container`) — пофайловый. Гасит только перестройку кэша дерева
  (`scheduleTreeCacheRefresh` → `refreshTreeCacheForFiles`) по конкретным записанным файлам:
  расширение только что сериализовало XML само и знает его новое содержимое, повторный парсинг
  того же файла из события watcher избыточен.
- **`ConfigurationCleanWindow`** (`infra/fs/ConfigurationCleanWindow.ts` — чистый класс без
  `vscode`, источник времени внедряется конструктором ради тестируемости истечения окна без
  реального таймера) — по КОРНЮ конфигурации. Открывается в `Container.markConfigurationsClean`
  сразу после успешного импорта/обновления конфигурации в базе, на
  `ConfigurationCleanWindow.defaultDurationMs` (15 секунд). Пока окно открыто,
  `scheduleChangedConfigurationStateRefresh` игнорирует событие watcher по файлу этого корня
  ЦЕЛИКОМ — ни быстрая пометка «конфигурация изменена» по одному файлу, ни планирование полного
  пересчёта. Причина: `FileSystemWatcher` доставляет события файлов, записанных импортом, уже
  ПОСЛЕ завершения операции — быстрый путь снова помечал только что синхронизированную
  конфигурацию изменённой, и расширение сразу предлагало обновить базу повторно. Полный пересчёт
  (`ConfigurationChangeDetector.detect`) обходит всю выгрузку и хеширует КАЖДЫЙ поддерживаемый
  файл только при первом запуске или при потере/повреждении stat-индекса (замер — около 7 секунд
  на 59 503 файлах); в штатном режиме, когда stat-индекс актуален, detect делает только
  `statSync` по дереву и SHA-1 тех файлов, чей stat разошёлся с индексом (см. «Stat-индекс
  рабочего дерева» ниже) — но даже этот облегчённый проход по-прежнему нельзя гонять на каждое
  из тысяч запоздавших событий watcher. По закрытии окна `markConfigurationsClean` сам ставит
  РОВНО ОДИН авторитетный `refreshChangedConfigurationState()` — так правка, сделанная
  пользователем во время окна, не теряется, а полный пересчёт не дублируется на каждое событие.

Новый код, который сам пишет файлы выгрузки и не должен ложно взводить «конфигурация изменена
относительно базы», использует `cleanWindow` через `markConfigurationsClean`, а не заводит третий
параллельный механизм подавления.

### Stat-индекс рабочего дерева (`FileStatIndex`)

`infra/cache/FileStatIndex.ts` — чистый модуль (функции, без `vscode`), ускоритель построения
`HashCacheSnapshot` в `ConfigurationChangeDetector.buildSnapshot`, а не источник правды: любая
неуверенность в записи индекса разрешается в пользу перехеширования файла, а не в пользу
доверия индексу.

- **Файл** — `.onecdev/cache/<sha1(scopeKey)>.stat.json`, рядом со снапшотом хешей той же
  области (`<sha1(scopeKey)>.json`); оба пути строятся от общего стема
  `HashCache.resolveHashCacheFileStem(projectRoot, scopeKey)`.
- **Критерий переиспользования записи** (`isFileStatEntryReusable`) — текущий `size`/`mtimeMs`/
  `ctimeMs` файла совпадает с записью в индексе; тогда хеш берётся из индекса без чтения
  содержимого файла. `ctime` участвует в критерии наравне с `mtime`, потому что его, в отличие
  от `mtime`, нельзя переставить через `utimes` — откат `mtime` «назад» (checkout, распаковка
  архива) всё равно сдвигает `ctime` и будет замечен.
- **Racy-окно 2 секунды** (`FILE_STAT_RACY_WINDOW_MS`, `isRacyFileStat`) — запись файла, у
  которого `nowMs - max(mtimeMs, ctimeMs) < 2000`, в индекс не попадает, даже если его хеш уже
  вычислен и вошёл в снапшот текущего прохода: гранулярность `mtime` на части файловых систем
  не гарантирует различимую отметку при правке сразу вслед за предыдущей, поэтому «свежий» файл
  перехешируется заново на следующем проходе, пока его stat не «остынет» (тот же приём, что у
  racy-защиты git).
- **Запись на диск только при изменении** — `indexChanged` (сравнение через `hasSameEntries`)
  выставляется, если состав ключей или любое из четырёх полей записи отличается от предыдущего
  индекса; неизменный индекс `ConfigurationChangeDetector` повторно не сохраняет.
- **Сбой записи не бросает.** `ConfigurationChangeDetector.persistStatIndex` перехватывает
  исключение `saveFileStatIndex` (например, каталог на месте `.stat.json`) и глотает его: индекс
  — только ускоритель, а до issue #43 `detect` вообще не писал на диск, поэтому появление
  индекса не должно превращать сбой записи служебного файла в падение `reloadEntries` при
  активации расширения.
- **`HashCacheSnapshot` и его формат не меняются.** `buildHashSnapshotWithStatIndex` строит ТОТ
  ЖЕ `HashCacheSnapshot` (`.onecdev/cache/<sha1>.json`), что и прежний `buildHashSnapshot`, —
  индекс лишь избавляет от чтения содержимого файлов, чей stat не разошёлся. `diffHashSnapshots`,
  `patchHashSnapshot`, CLI (`src/cli/core/hashCache.ts`) и `AgentOperationService` не знают о
  существовании индекса и не меняются.
- **Индекс сознательно не подключён к CLI и `AgentOperationService`.** Там ложное
  переиспользование записи означало бы пропущенный импорт изменений в базу — цена ошибки
  несопоставима с ценой ошибки в UI-детекторе (который в худшем случае лишь на проход позже
  предложит пользователю обновить базу), а выигрыш по времени мал на фоне длительности самого
  Конфигуратора.
- **Асинхронный `detect` — вне рамок.** `buildSnapshot`/`detect` остаются синхронными, как и до
  появления индекса.
- **Атомарная запись** обоих служебных файлов области (снапшота хешей и stat-индекса) — общая
  `infra/fs/AtomicFileWriter.writeFileAtomic` (см. «Атомарная запись файлов выгрузки»); каталог
  кэша создаёт вызывающий (`saveHashCache`/`saveFileStatIndex`) — примитив `mkdir` не делает.

### Замер фаз `reloadEntries` (строки `[perf]`)

Каждый `Container.reloadEntries()` (активация, watcher `Configuration.xml`) пишет в канал
«1С Редактор» длительность синхронных фаз — чтобы решение об асинхронном старте принималось по
цифрам реальной выгрузки, а не на глаз. Формат строки — `infra/support/PerfLog.formatPerfLine`:
`[perf] <фаза>: <мс> мс[ (<детали>)]`, длительность округлена до миллисекунды.

```
[perf] поиск конфигураций: 12 мс (найдено 2)
[perf] хеш-кэш «Бухгалтерия»: 6931 мс (файлов 59503, перехешировано 59503)   ← только первый запуск
[perf] кэш метаданных «Бухгалтерия»: 2105 мс                                   ← только первый запуск
[perf] подготовка кэшей: 9412 мс
[perf] дерево метаданных: 311 мс
[perf] панель изменений: 45 мс
[perf] проверка изменений «Бухгалтерия»: 184 мс (файлов 59503, перехешировано 0)
[perf] перечитывание конфигураций, итого: 9990 мс
```

- Строка пишется по завершении фазы, поэтому вложенные строки (по конфигурациям) идут раньше
  объемлющей, а «итого» — последней.
- «подготовка кэшей» включает и проверку наличия кэшей: `ensureCaches` читает JSON кэша метаданных
  целиком даже тогда, когда ничего не строит.
- «дерево метаданных» — синхронный `MetadataTreeProvider.buildRoots()`: по каждой конфигурации
  чтение `ParentConfigurations.bin` (`supportService.loadConfig`), `parseConfigXml`, разбор JSON кэша
  метаданных и сборка всех узлов сразу, а при отсутствии кэша — ещё и его пересборка; «панель
  изменений» — синхронный `git status` модели панели изменений.
- Замер фазы — `PerfLog.measurePerfPhase` (часы и приёмник строк внедряются); `Container` лишь
  передаёт ему `performance.now()` и `outputChannel`.
- Строки по конфигурациям отдаёт `ConfigurationChangeDetector` через необязательный
  `ChangeDetectorTimingObserver` (третий аргумент конструктора); `formatChangeDetectorTiming`
  превращает их в строку. У наблюдателя свои часы (по умолчанию монотонный `performance.now()`):
  `now` детектора — время по эпохе для racy-окна stat-индекса, а не секундомер.
- «проверка изменений» пишется и при пересчётах вне `reloadEntries` — по debounce watcher'а
  исходников и по закрытии окна тишины (одна строка на конфигурацию за пересчёт).
- Настройки включения нет: строк на один `reloadEntries` — единицы на конфигурацию.

### Сериализация операций Конфигуратора с базой (`ConfigurationOperationGuard`)

`infra/process/ConfigurationOperationGuard.ts` — чистый класс без `vscode`, единая блокировка полного
импорта/обновления/применения конфигурации к базе в пределах одного окна VS Code. До issue #10 занятость
жила модульным флагом `isUpdatingConfigurations` внутри `ExtensionCommands.ts`, и синхронизация с
хранилищем (`RepositoryCommands`) шла мимо него — post-sync после `repository.connect`/`create` мог
запустить свой Конфигуратор параллельно ручному импорту из UI, оба против одной базы.

API:
- `isBusy`/`heldBy` — текущее состояние и заголовок держащей операции.
- `tryAcquire(title) → lease | undefined` — проверка и захват одной синхронной операцией (между ними нет
  `await`), поэтому два вызова, стартовавшие в одном тике, не займут guard оба; `lease.release()`
  идемпотентен и не снимает чужую (уже сменившуюся) аренду — сравнение по внутреннему токену держателя.
  Выражен через `tryAcquireOrHeldBy` (одна точка проверки занятости).
- `tryAcquireOrHeldBy(title) → { acquired: true; lease } | { acquired: false; heldBy }` (issue #39) — тот же
  захват, но при отказе сразу отдаёт держателя одним вызовом: без него вызывающему пришлось бы отдельно
  перечитывать `heldBy` после отказа, что формально могло вернуть `undefined` (аренда снялась между двумя
  вызовами) и требовало обрабатывать невозможную ветку. Используется везде, где отказ должен нести имя
  держателя наружу (`ExtensionCommands.importConfigurations`, MCP-мост).
- `runExclusive(title, op) → { acquired: true, value } | { acquired: false, heldBy }` — нереентерабельная
  обёртка `tryAcquire` + `try/finally { release() }`; исключение `op()` пробрасывается тем же объектом,
  guard освобождается независимо от исхода.
- `onDidChangeBusy(listener)` — событие только на переходах `false→true`/`true→false`; ошибка подписчика
  ловится и уходит в `onListenerError` конструктора, остальные подписчики уведомление всё равно получают.

`Container` создаёт единственный экземпляр в конструкторе (`onListenerError` пишет `[guard][error] …` в
outputChannel) и в `bootstrap()` подписывается на `onDidChangeBusy` в приватном
`wireConfigurationOperationContext()` — это ЕДИНСТВЕННОЕ место, выставляющее контекст enablement
`onecdev.isUpdatingConfigurations` (`package.json → contributes.commands[].enablement`); отказ
`setContext` логируется отдельно (`[guard][error] setContext: …`), т.к. вызов асинхронный и не проходит
через `onListenerError` самого guard'а. Экземпляр публикуется в `CommandServices.configurationOperationGuard`
(и автоматически попадает в `buildMcpCommandServices` — MCP-мост `onecdev_execute_command` синхронизован
с UI-командами через тот же guard).

Обе команды, доступные MCP-мосту (`importConfigurations`, `updateChangedConfigurations`), возвращают
`ConfigurationCommandOutcome` (`ui/commands/ext/configurationCommandOutcome.ts`, без `vscode`) на каждом
пути — `done`/`no-changes`/`no-targets`/`cancelled`/`busy`/`failed` — вместо прежних `boolean`/`undefined`,
которые не различали «занято», «отменено» и «сбой». Мост `onecdev_execute_command`
(`ui/mcp/registration/McpConfigLifecycleTools.ts`) сам guard заранее не опрашивает и не подменяет исход —
он вызывает команду через `vscode.commands.executeCommand` и транслирует её `ConfigurationCommandOutcome`
в ответ как есть (`busy` + `heldBy` при занятости приходят от самой команды). Предпроверка guard'а в мосте
была отвергнута при разработке (issue #39): это второй источник правды о занятости и разрыв TOCTOU — между
проверкой в мосте и фактическим запуском команды есть `await`, за время которого guard мог освободиться
или, наоборот, оказаться занятым другой операцией.

Пользователи:
- `ui/commands/ext/ExtensionCommands.ts` — `importConfigurations` (ранняя проверка `isBusy` до QuickPick,
  затем `tryAcquireOrHeldBy` после него — защита от TOCTOU, пока пользователь выбирал конфигурации; отказ
  в обеих точках возвращает `{ status: 'busy', heldBy }`), `updateChangedConfigurations`,
  `runExclusiveConfigurationOperation`. Занятость сообщается
  `notifyConfigurationOperationBusy` (`ui/commands/ext/configurationOperationBusy.ts`) **без `await`**
  (запрет №18 в `CLAUDE.md`): раньше нотификация await'илась внутри критической секции, и любой
  параллельный вызывающий (`DbCommands`, MCP-мост) висел до закрытия сообщения пользователем, хотя
  фактически в этот момент ничего не выполнялось.
- `ui/commands/repository/RepositoryDatabaseSync.ts` — `runPostRepositorySync` (фоновый, `void`-путь после
  `repository.connect`/`create`: apply → decompile → `markConfigurationsClean` → `reloadEntries` →
  обновление UI, guard держится на всю цепочку целиком; при занятости ничего не запускает, пишет
  `[repository][post-sync][busy]` с именем мешающей операции в outputChannel и уведомляет без `await`) и
  `ensureTargetUpdatedBeforeCommit` (занятость проверяется дважды — до открытия QuickPick подтверждения
  обновления и повторно через `runExclusive` после него, т.к. пока диалог был открыт, guard мог занять
  другой путь). Внешние точки (runner'ы Конфигуратора, сам QuickPick) внедряются через
  `RepositoryDatabaseSyncDeps` — логика захвата тестируется без реального процесса 1С.
- `ui/commands/ext/ExtensionCommands.ts`, `connectExtension` — ранняя проверка `isBusy` до запроса списка
  расширений из базы (сам запрос — отдельный запуск Конфигуратора), каталог `src/cfe/<имя>` создаётся
  только внутри захваченной операции: при отказе в захвате `afterFailure` не вызывается, и созданный
  заранее пустой каталог заблокировал бы повторное подключение того же расширения (issue #38). Запрос
  списка и декомпиляция внедряются через `ExtensionCommandsDeps` (переименован из `ConnectExtensionDeps`
  при issue #39 — тот же deps-объект стал общим для `connectExtension`, `importConfigurations` и
  `updateChangedConfigurations`: поля `decompileExtension`/`decompileMainConfiguration`/
  `updateMainConfiguration`/`updateExtension`/`pickImportTargets`/`pickChangedConfigurations`,
  значение по умолчанию — `DEFAULT_EXTENSION_COMMANDS_DEPS`; необязательный параметр `deps` у
  `registerExtensionCommands`).
- `ui/commands/repository/RepositoryLockSync.ts`/`RepositoryUnlockSync.ts` (issue #1) — `repository.lock`/
  `update`/`updateToVersion`/`unlock`/`commit`: занятость проверяется `ensureRepositoryGuardFree` до первого
  QuickPick, затем ОДНА аренда `runExclusive` на CLI хранилища, изменение состояния захватов и выгрузку во
  временный каталог (все раунды); слияние с проектом, модальные диалоги конфликтов/отката и диффы — строго
  после аренды. Процесс 1С, выгрузка и диалоги внедряются через `RepositoryFileSyncDeps`; диалоги вопросов
  о рекурсии/`-force`/номере версии — `ui/commands/repository/RepositoryCommandDialogs.ts` (issue #61),
  рекурсия спрашивается только когда `RepositoryService.canApplyRecursively(node)` возвращает `true`.
  Подробно — [repository-file-sync.md](./repository-file-sync.md).
- `ui/commands/repository/RepositoryCommands.ts`/`RepositoryCommandRunner.ts` (issue #40) — `repository.connect`/
  `create`/`disconnect`/`addUser`/`copyUsers`/`dump`/`report`/`setLabel`: занятость проверяется
  `requireFreeRootTarget` до форм и диалогов, `runRepositoryCliCommand` держит аренду только на процесс
  Конфигуратора, модальные сообщения об исходе — после неё.

Известные ограничения:
- Guard действует в пределах одного окна VS Code — второе окно и отдельный процесс CLI (`onec-tools`) им
  не сериализуются.

### Режим поддержки поставщика (`ParentConfigurations.bin`)

`infra/support/ParentConfigurationsParser.ts` разбирает `Ext/ParentConfigurations.bin` — список
объектов конфигурации, стоящих на поддержке поставщика. Формат установлен экспериментально (снят с
платформы 8.5.1, см. шапку `example/tools/build-supported-cf.mjs`):

```
{6,<изменения запрещены 1|0>,<число поставщиков>,<uuid>,<копия поставщика совпадает 1|0>,<uuid>,
 "<версия>","<поставщик>","<имя>",<число записей>, a,b,uuid,uuid, …, <хвост>}
```

Тело — последовательность записей `a,b,uuid,uuid` с одинаковыми uuid (режим `a` идёт ПЕРЕД парой
uuid); `b` — смысл не установлен, парсер и `SupportInfoService` его игнорируют. Парсер отдаёт сырые
коды записей (`ParentConfigurationsRecord.code`) и флаг заголовка, не зная их смысла — трактовка кода
и приоритет флага живут в **одном месте**, `SupportInfoService`:

| Код `a` в `.bin` | `SupportMode` | Смысл |
|---|---|---|
| `0` | `Locked` | объект поставщика не редактируется |
| `1` | `Editable` | редактируется с сохранением поддержки |
| `2` | `Removed` | снят с поддержки: объект редактируется свободно, но обновления поставщика на него не приходят |
| любой другой | `Locked` | неизвестный код трактуется как запрет — ошибочно разрешить правку объекта поставщика опаснее, чем ошибочно запретить; событие считается и пишется в лог |

Флаг заголовка «изменения запрещены» (`changesForbidden`) имеет приоритет над кодом записи: если он
взведён, `SupportInfoService.getSupportMode`/`getSupportModeByUuid` сразу возвращают `Locked` для
ЛЮБОГО файла под корнем конфигурации — включая BSL-модуль, для которого не удалось найти XML
владельца (ранний возврат до поиска XML и чтения uuid: дешевле на горячем пути дерева и не оставляет
случайных «дыр» в режиме «только для чтения»).

`SupportInfoService.hasChangesForbidden(filePath)` — отдельный от режима предикат, вернувший этот же
флаг: сам запрет по-прежнему решает `getSupportMode` (он уже дал `Locked`), а этот метод только
уточняет ПРИЧИНУ для UI — закрыта ли правка настройками поддержки всей конфигурации или отдельно
взятый объект поставщика на поддержке без права правки (у них разные способы снять запрет). Новое
значение `SupportMode` под этот случай не заводится, хотя `Removed` — тоже добавленное значение:
разница в природе. `Removed` — атрибут записи `.bin` конкретного объекта (код `2`), а
`changesForbidden` — свойство всей конфигурации, ПЕРЕКРЫВАЮЩЕЕ режим объекта: под флагом
`getSupportMode` сразу возвращает `Locked`, не читая uuid записи (ранний возврат — дешевле на
горячем пути дерева), и объект в режиме `Removed` под флагом неотличим от любого другого —
разбирать его код смысла нет. Причина навешивается поверх режима отдельным маркером:
`MetadataTreeProvider.applySupportDecoration` дописывает к `contextValue` суффикс
`-supportChangesForbidden` ПОВЕРХ `-support2` (числового суффикса `Locked`) при взведённом флаге.
Проверки блокировки по всему коду сравнивают только `=== SupportMode.Locked` — `Removed` их не
затрагивает. Формат суффикса и тексты причины
(подсказка индикатора, фрагмент «изменения конфигурации запрещены в настройках поддержки» для
сообщений об отказе) живут в одном модуле без `vscode` — `ui/support/supportLockReason.ts`
(`SUPPORT_CHANGES_FORBIDDEN_SUFFIX`, `SUPPORT_SUFFIX_RE`, `supportModeSuffix`,
`CHANGES_FORBIDDEN_REASON`, `SUPPORT_REMOVED_TITLE`, `CHANGES_FORBIDDEN_TITLE`, `supportIndicatorOf`,
`supportModeDtoOf`, `supportLockedReasonOf`) — его читают и дерево
(запись суффикса через `supportModeSuffix`), и `UniversalPanelViewProvider` (разбор суффикса в
подсказку и в `SupportModeDto` узла для webview), и сервисы отказа
(`MetadataMutationService`, `McpMutationGate`, UI-удаление `RemoveMetadataCommand`/
`FormToolsCommands` через `supportLockedReasonOf`, панель свойств через `readonlyReason:
'supportChangesForbidden'`), чтобы формулировка причины не разошлась между ними.

Значения `SupportMode` (`None=0`, `Editable=1`, `Locked=2`, `Removed=3`) заморожены — они вшиты в
суффикс `contextValue` вида `-support<n>` (запись — `supportModeSuffix` в `MetadataTreeProvider`,
разбор — там же в `UniversalPanelViewProvider`); менять числа нельзя, только состав таблицы
`BIN_CODE_TO_MODE` и добавлять новые значения следующим свободным числом (`Removed=3` добавлен так
же). `None` теперь означает ровно два неразличимых для UI случая — «объекта нет в поставке» и
«данных поддержки по конфигурации вовсе нет» (нет `.bin`, формат не распознан, флаг заголовка вне
`{0,1}`); отдельного кода `.bin` у `None` нет, это значение по умолчанию.

Нераспознанный формат (нет заголовка, версия ≠ 6, флаг заголовка ∉ `{0,1}`) — не частичный разбор:
`parseParentConfigurations` возвращает `{ ok: false, reason }`, `SupportInfoService.loadConfig`
полностью сбрасывает данные корня и кэш uuid по нему, `hasConfigData` для файлов этого корня
возвращает `false`, эффективный режим — `None`, в лог пишется строка «не распознан (`<reason>`)».
Решение осознанное: новая/неизвестная версия формата не должна блокировать всю конфигурацию как
«только для чтения» — платформа всё равно проверяет правила поддержки при импорте XML в базу.

Импорт XML в основную конфигурацию (`cli/commands/importConfiguration.ts`, не расширения) решает
`infra/support/SupportImportGuard.ts` (`mainConfigurationImportBlockReason`): отказ только при флаге
`changesForbidden=1`. Без флага загрузка передаётся платформе — она сама отбивает объект с кодом 0 и
загружает коды 1 и 2, поэтому отказ по одному наличию `.bin` не давал загрузить даже правку
редактируемых объектов. Здесь, в отличие от навигатора, нераспознанный `.bin` — отказ: загрузка в
базу необратимее подсветки дерева, и разрешать её, не поняв настроек поддержки, опаснее, чем лишний
раз отказать.

Несколько поставщиков (`vendorCount > 1`): записи ищутся регэкспом по форме `a,b,uuid,uuid` по всему
телу файла, а не нарезаются по объявленному числу записей заголовка — раскладка тела для нескольких
поставщиков не сверена с эталоном платформы, но поиск по форме записи от числа поставщиков не
зависит. Дубль uuid (объект встречается у нескольких поставщиков) разрешается в пользу самого строгого
режима (`MODE_STRICTNESS`): порядок строгости — `None (0) < Removed (1) < Editable (2) < Locked (3)`,
он не совпадает с числами `SupportMode` (это ранг, а не значение enum). `Removed` строже `None`, но
мягче `Editable`: если хоть один поставщик из нескольких ещё поддерживает объект (`Editable`/`Locked`),
его обновления придут, и «снят с поддержки» для объекта в целом неверно — побеждает более строгий
режим. Ранг `None` формальный: из `.bin` это значение не получается (см. выше), в дубле участвовать
не может. В лог пишется предупреждение при разрешении дубля, т.к. эталона для этого случая нет.

Фикстуры: `example/{2.20,2.21}/src/cf/Ext/ParentConfigurations.bin` (флаг `changesForbidden=0`, 228
записей) и `example/support/changes-forbidden/ParentConfigurations.bin` (флаг `changesForbidden=1`) —
обе собираются `example/tools/build-supported-cf.mjs` по файлам правил `support-rules.json`/
`support-rules-forbidden.json` (инструкция по пересборке — в шапке скрипта, см. также
`docs/agentic-pipeline.md`).

**Известные ограничения:**
- Причина теперь различается на уровне текста (см. `hasChangesForbidden`/`-supportChangesForbidden`
  выше): при `changesForbidden=1` подсказка индикатора и сообщения об отказе (добавление в UI и MCP,
  MCP-мутации, панель свойств, UI-удаление объекта и формы) называют её отдельно — «изменения
  конфигурации запрещены в настройках поддержки», а не общее «на поддержке, запрещено».
  Индивидуальный код объекта из `.bin` (0/1/2) при этом по-прежнему не проверяется вовсе (ранний
  возврат до поиска XML/uuid) — отдельного индикатора «этот конкретный объект снят с поддержки
  (режим `Removed`, код `2`), но конфигурация целиком запрещена к правке» нет: все объекты под таким
  корнем получают один и тот же замок с причиной «конфигурация», а собственный индикатор `Removed`
  под флагом не показывается ни одному из них.
- Проверку флага делает только полный/частичный импорт `import-configuration`. Другие пути загрузки
  XML в базу (`cli/commands/importGitChanges.ts`, агент Конфигуратора `infra/agent/AgentOperationService.ts`)
  её не делают и полагаются на проверку правил поддержки платформой.

## Граф зависимостей

```
extension.ts
  └── Container
      ├── infra/*
      ├── ui/tree/*
      ├── ui/commands/*
      ├── ui/readonly/BslReadonlyGuard
      └── lsp/LspManager
            ├── analyzer/BslAnalyzerService
            ├── analyzer/BslAnalyzerStatusBar
            └── LanguageClient
                  └── bsl-analyzer lsp
```

## Точка входа

`activate()` создаёт `Container` и делегирует ему регистрацию подсистем.

`Container.bootstrap()`:

1. Создаёт инфраструктурные сервисы.
2. Регистрирует дерево, webview-панели, декорации, watcher-ы и команды.
3. Загружает найденные XML-выгрузки конфигураций.
4. Регистрирует `BslReadonlyGuard`.
5. Запускает `LspManager`.

`deactivate()` останавливает активный LSP-клиент через `client.stop()`.

## Ключевые архитектурные решения

| Решение | Обоснование |
|---|---|
| `META_TYPES` как единый реестр типов | Добавление типа метаданных не требует параллельных словарей |
| `MetaPathResolver` как единый resolver путей | Все XML и BSL-модули резолвятся через один инфраструктурный контракт |
| `bsl-analyzer` как единственный LSP | Нет дублирования возможностей и расхождения диагностики между режимами |
| Прямое открытие BSL через `file://` | Внешний LSP работает с реальными файлами, без виртуальной схемы |
| `BslReadonlyGuard` для BSL | Запрет редактирования не зависит от способа открытия файла |
| Ленивая загрузка дерева | Дочерние узлы строятся при раскрытии, а не при старте расширения |
| God-класс → тонкий фасад + подмодули в подпапке слоя | Убирает файлы 1000+ строк без риска регресса: рефактор косметический, публичный API и поведение неизменны (см. выше) |
| MCP-сервер: одна попытка bind, без авто-инкремента порта; конфликт разрешается зондом `/identity` | Авто-инкремент молча подключал агента не к тому проекту; явное `reuse`/`conflict-foreign`/`conflict-unknown` не даёт агенту работать с чужой конфигурацией (см. [mcp-server-lifecycle.md](./mcp-server-lifecycle.md)) |
| `stop()` MCP-сервера форсирует `closeAllConnections()` до `close()` | Долгоживущие SSE-соединения не давали `httpServer.close()` освободить порт естественным путём (см. [mcp-server-lifecycle.md](./mcp-server-lifecycle.md)) |
| Модель трёх деревьев git (HEAD/индекс/рабочее дерево) в представлении изменений | Единственный способ получить непустой diff для staged-файла — сравнивать HEAD↔индекс, а не индекс↔рабочее дерево (см. [git-metadata-changes.md](./git-metadata-changes.md)) |
| Предки объекта в блоке «История» синтезируются из `META_TYPES`, а не берутся из живого дерева навигатора | Живое дерево отражает только текущую рабочую копию и врало бы для исторического состояния коммита (см. [git-history-graph.md](./git-history-graph.md)) |
| Данные из базы (не из XML-выгрузки) передаются CLI → UI через `-ResultFile`, гейт разбора — `exitCode`, а не текст лога | Построчный перекодировщик вывода процесса (`LineBufferedDecoder`) не гарантирует целостность произвольных данных внутри marker-блока; `/Out`-файл — уже устоявшийся канал `*Configuration`-команд (см. «Паттерн: чтение данных из базы через пакетный Конфигуратор» выше) |
| `ConfigurationCleanWindow`: окно тишины по корню конфигурации после импорта/обновления БД, единственный авторитетный пересчёт по его истечении | События watcher по файлам, записанным импортом, приходят уже после операции; даже облегчённый (по stat-индексу) `ConfigurationChangeDetector.detect` нельзя гонять на каждое из тысяч запоздавших событий, а без индекса полный пересчёт стоит ~7 с на 59 503 файлах (см. «Два механизма подавления собственных файловых событий» выше) |
| `FileStatIndex` рядом со снапшотом хешей: переиспользование хеша по size+mtime+ctime вместо чтения содержимого файла | Повторная активация без правок выгрузки не должна перечитывать и хешировать все поддерживаемые файлы заново — `ctime` в критерии закрывает подмену `mtime` через `utimes`, racy-окно 2 с закрывает гранулярность отметок времени (см. «Stat-индекс рабочего дерева» выше) |
| Файлы проекта — форк хранилища: выгрузка во временный каталог + трёхстороннее слияние (хранилище/локальный/хеш-кэш) вместо частичного импорта поверх проекта | Частичный импорт поверх проекта молча затирал локальные правки и не восстанавливал файлы при отмене захвата; слияние заменяет неизменённое молча, а при конфликте даёт один диалог с бэкапом (см. [repository-file-sync.md](./repository-file-sync.md)) |
| Единица хранилища (подчинённые с собственным XML — формы, макеты, перерасчёты, таблицы/кубы, вложенные подсистемы) как отдельный объект выгрузки, захвата и снимка | Платформа не включает их в частичную выгрузку владельца и захватывает отдельно; без этого формы не обновлялись из хранилища, а перерасчёты/таблицы удалялись как «сироты» (§10.12 плана) |
| `ConfigurationOperationGuard`: единый guard вместо модульного флага под каждым путём импорта/обновления/применения конфигурации к базе, аренда по токену, событие только на переходах | Прежний флаг `isUpdatingConfigurations` жил только в `ExtensionCommands` и не видел синхронизацию с хранилищем — параллельный post-sync и ручной импорт могли одновременно писать в одну базу (см. «Сериализация операций Конфигуратора с базой» выше) |
| `ConfigurationCleanWindow`: окно тишины по корню конфигурации после импорта/обновления БД, единственный авторитетный пересчёт по его истечении | События watcher по файлам, записанным импортом, приходят уже после операции; полный `ConfigurationChangeDetector.detect` слишком дорог (~7 с на 59 503 файлах), чтобы гонять его на каждое из тысяч запоздавших событий (см. «Два механизма подавления собственных файловых событий» выше) |
| `-AllExtensions` у `/DumpCfg`/`/LoadCfg` не поддерживается ни в одном инструменте/команде | Платформа принимает флаг молча (exit 0) и выгружает ОСНОВНУЮ конфигурацию вместо расширений — она вообще не диагностирует неизвестные ключи, поэтому `exitCode` не может служить проверкой корректности вектора аргументов (см. «Паттерн: бинарный обмен CF/CFE» выше) |
| `/LoadCfg` не помечает конфигурацию проекта «изменённой» и не запускает `/UpdateDBCfg` | `/LoadCfg` меняет только основную конфигурацию, не базу; пометка «изменена» дала бы «обновить изменённые конфигурации» залить старые файлы проекта обратно в базу поверх только что загруженного CF (см. «Паттерн: бинарный обмен CF/CFE» выше) |
| Запись файла выгрузки — только через `infra/fs/AtomicFileWriter` (temp+rename), временный путь не `.xml`, `fsync` нет | Обрыв прямой записи оставляет обрезанный XML, а он делает нечитаемой всю конфигурацию; `.xml`-временный файл будил бы watcher; защита — от обрыва процесса, не от потери питания (см. «Атомарная запись файлов выгрузки» выше) |
| Допустимость дочернего тега (`META_TYPES.childTags`) и порядок сериализации (`CHILD_OBJECTS_ORDER`) — две разные оси, валидатор читает только первую | Проверка по оси порядка дала 16 945 ложных предупреждений на 3 660 эталонных файлах (стандартные реквизиты лежат не в `<ChildObjects>`); решение откачено (см. [xml-format-rulesets.md](./xml-format-rulesets.md#две-оси-допустимость-дочернего-тега-и-порядок-сериализации)) |

## Подробная документация

- [Навигатор метаданных](./metadata-navigator.md) — дерево, команды, path resolver.
- [Языковая поддержка BSL](./bsl-language-support.md) — запуск `bsl-analyzer` и настройки.
- [Парсинг XML конфигурации](./metadata-parser.md) — алгоритмы разбора Configuration.xml и объектных XML.
- [Изменения метаданных](./git-metadata-changes.md) — семантический git по объектам 1С, представление `onecdevChanges`.
- [История изменений](./git-history-graph.md) — граф git-коммитов по объектам 1С, сворачиваемый блок панели `onecdevChanges`.
- [Синхронизация с хранилищем](./repository-file-sync.md) — файлы проекта при захвате/получении/отмене захвата/помещении, единицы хранилища, слияние, снимки, readonly.
- [Клиент протокола crs](./repository-crs.md) — сервер хранилища по tcp/http без платформы: модули, решения, адаптации, непроверенное; исследования — `docs/research/crs/`.
- [Жизненный цикл MCP-сервера](./mcp-server-lifecycle.md) — старт/остановка, освобождение порта, обнаружение и разрешение конфликта порта; канон путей MCP-инструментов — отдельно, в [mcp-paths.md](./mcp-paths.md).
