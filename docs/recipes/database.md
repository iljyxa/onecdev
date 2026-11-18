# Рецепты: Операции с базой и Конфигуратором

Часть справочника [«какие файлы трогать»](../change-recipes.md). Если требуется править сверх списка — задача решается в другом слое.

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
  [architecture.md](../architecture.md#паттерн-чтение-данных-из-базы-через-пакетный-конфигуратор-file-handoff).
- **Новая операция обмена с базой через CF/CFE-файл** (бинарная выгрузка/загрузка, не чтение
  списка/состояния — для последнего см. пункт выше): guard'ы и вектор аргументов Конфигуратора — в
  `infra/cfFile/` (`CfFileArgs.buildCfFileDesignerArgs`, `CfFileValidation.validateCfFileRequest` —
  ЕДИНСТВЕННАЯ точка композиции проверок) без `vscode`/spawn → CLI-команда `cli/commands/<name>.ts`
  парсит и ПОЛНОСТЬЮ валидирует аргументы ДО `resolveConnection` (платформа не диагностирует ни
  неверный ключ, ни рассинхрон «суффикс↔расширение», а при сбое всё равно оставляет побочные эффекты —
  см. [architecture.md](../architecture.md#паттерн-бинарный-обмен-cfcfe-через-пакетный-конфигуратор-dumpcfgloadcfg))
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
  обоснования — [architecture.md](../architecture.md#пакетный-случай-все-расширения-базы-одной-операцией-dump-cfe-allload-cfe-all).

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
  `done`/`no-changes`/`no-targets`/`cancelled`/`busy`/`failed`/`invalid-selection`), а при занятости —
  `{ status: 'busy', heldBy }`; мост транслирует этот исход как есть и НЕ опрашивает guard заранее (второй
  источник правды + TOCTOU между проверкой и запуском команды). **Команда с выбором целей** принимает
  `ConfigurationTargetRequest`; при его наличии диалог не открывает, а выбор делает через
  `selectConfigurationTargets` (`ui/commands/ext/configurationTargetSelection.ts`) строго вне аренды guard;
  ошибки по данным — исход `invalid-selection`, ошибки формы входа — `isError` в мосте. Подробности —
  [architecture.md](../architecture.md#сериализация-операций-конфигуратора-с-базой-configurationoperationguard).
