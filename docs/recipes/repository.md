# Рецепты: Хранилище конфигурации

Часть справочника [«какие файлы трогать»](../change-recipes.md). Если требуется править сверх списка — задача решается в другом слое.

- **Новая операция хранилища, меняющая файлы проекта** (аналог `repository.lock`/`update`/
  `updateToVersion`/`unlock`/`commit`, см. [repository-file-sync.md](../repository-file-sync.md)): поток в
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
  [repository-file-sync.md](../repository-file-sync.md#временные-файлы-и-очистка). Любое удаление файла/
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
  [repository-file-sync.md](../repository-file-sync.md#шаги-снимков--best-effort-issue-103). Окна сравнения —
  единая конвенция сторон (слева локальное состояние, справа версия хранилища, `MergeDiffPair` +
  `formatMergeDiffTitle` в `RepositoryFileSyncDialogs.ts`); снятие/применение readonly сессии к ресурсу
  файла проекта (в т.ч. когда он открыт только левой стороной diff) — через
  `ui/readonly/sessionReadonly.ts` (`runWithResourceActive`) и `ui/readonly/readonlyTabSelection.ts`
  (`selectReadonlyApplyRoute`), а не напрямую командой `resetActiveEditorReadonlyInSession` — см.
  [repository-file-sync.md](../repository-file-sync.md#readonly).
- **Новый источник статусов захвата хранилища** (аналог файлового `1cv8ddb.1CD`/сетевого crserver, см.
  [repository-file-sync.md](../repository-file-sync.md#статусы-захватов-с-сервера)): реализация в
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
  `onecd/OneCdFile.ts`+`OneCdTable.ts` для 1CD, `crs/CrsClient.ts`+`infra/xml/crs/CrsEnvelope.ts` для
  crserver; общий скобочный разборщик — `OneCBracketText.ts`), а не встроенный парсинг внутри класса источника.
  Для crserver таблицы «вид ошибки протокола → `RepositoryLockStatusErrorCode`» — в
  `NetworkRepositoryLockStatusSource.ts`; новый метод протокола — рецепт ниже. Тест — на реальных байтах/файлах,
  снятых с платформы (генератор `example/tools/build-repository-locks.mjs`), синтетика недопустима —
  формат недокументирован платформой. После `connect`/`create` (без `-NoBind`) опрос вызывается не из
  самой команды, а из `ui/commands/repository/RepositoryBindFlow.ts` (`completeRepositoryBind`) через тот
  же `syncTarget` — новый источник не требует отдельной интеграции для этого пути (issue #106, см.
  [repository-file-sync.md](../repository-file-sync.md#статусы-захватов-с-сервера)).
- **Новый метод протокола crs** (сервер хранилища; устройство — [repository-crs.md](../repository-crs.md)):
  функция в `infra/repository/crs/Crs<Область>.ts` над `CrsClient` без состояния (образец — `CrsStatistic.ts`)
  → параметры запроса только через `crsValue`/`CrsElement` (конверт собирает `CrsEnvelope.ts`, строк XML вручную
  не клеить) → ответ декодируется строгими читателями `CrsResponseReaders.ts` внутри `decodeReturn` (нет
  обязательного элемента = `malformed-response`) → модели без хешей паролей, хешей версий и содержимого
  → новый вид отказа — значение `CrsCallErrorKind` (`CrsErrors.ts`) + строка классификатора в `CrsException.ts`
  со снятой фикстурой + строка таблицы в `NetworkRepositoryLockStatusSource.ts` (если метод идёт через адаптер)
  → `bind` для чтения не вызывать → **тест**: побайтное совпадение построенного запроса с запросом из корпуса
  `example/crs/8.5.1` и разбор настоящего ответа через `src/test/suite/support/crsRecordedTransport.ts`
  (синтетические ответы запрещены; нужного кадра нет — расширить корпус скриптом съёмки
  `example/tools/crs/capture-*.mjs`, порядок и ограничения — `example/crs/README.md`, раздел «Пересборка»).
  **Запрет:** содержимое объектов (`crs:snapshots`, `commitObjects`,
  `updateObjects`, `11223344`) не читать и не писать; `crs:data` и base64 — только в `CrsHistory.ts`
  (sanity-проверки `qa-gate.sh`). Новый кадр в корпусе меняет счётчики в
  `src/test/suite/support/crsFixtures.ts` (`CORPUS_SIZE`, число обменов, тел `call_exception`,
  `HTTP_CORPUS_MESSAGES`) — правятся вместе с корпусом.
- **Интеграционный тест с настоящим crserver** (устройство стенда — [repository-crs.md](../repository-crs.md#стенд-и-интеграционные-тесты)):
  файл `src/test/suite/crs<Область>.crserver.test.ts` поверх support-модулей `crsLocalServer.ts` (пустой
  `crserver`), `crsApache.ts` (публикация http), `crsTestDepot.ts` (хранилище из `example/2.21/src/cf`) →
  pending **только** по отсутствию файлов платформы/apache (сбой сборки при наличии платформы — красный тест) →
  хранилище собирается один раз в родительском suite файла (около 17 с), вложенные suite tcp/http используют его
  → стенд запускается только дочерним процессом, `import()` `stand.mjs` в extension host запрещён → ожидаемый
  состав хранилища считается из `Configuration.xml`/`ConfigDumpInfo.xml` (оракулы `configRootId`/`depotUnitIds`),
  не числами → в `example/` не писать, рабочие каталоги — `mkdtemp`. Конфигурация публикации apache
  (`httpd.conf`) продублирована в `crsApache.ts` и `stand.mjs` (`startApache`) — меняется в обоих местах.
  Новая выгрузка в `example/` попадает в сквозные обходы `EXAMPLE_ROOT` (`formPropertyKeysCorpus.test.ts` —
  опорные числа замера, `formValidateCorpus.test.ts`): их ожидания обновляются в той же задаче.

- **Новая возможность панели «История хранилища»** (отдельная webview в области редактора по протоколу crs, НЕ
  блок «История» git; устройство — [repository-crs.md](../repository-crs.md#сервисная-часть-117), пользовательская
  сторона — [repository-file-sync.md](../repository-file-sync.md#история-хранилища)), по слоям:
  - данные и состояние — `infra/repository/history/`: чистая модель/сборка (`RepositoryHistoryModel.ts`), загрузка
    страниц (`RepositoryHistoryLoader.ts`), состояние и отмена (`RepositoryHistoryService.ts`; фоновая загрузка —
    только через поколения + `AbortSignal`, не `await` в слушателях). Без `vscode`; метод протокола — по рецепту
    «Новый метод протокола crs»;
  - представление — готовые тексты и DTO строит `RepositoryHistoryView.ts` (`buildRepositoryHistoryViewDto`):
    форматирование дат, подсказки, сообщения об отказах, лимит изменений;
  - DTO → зеркало `src-ui/shared/types/repositoryHistory.ts` (обе стороны правятся вместе) →
    `src-ui/apps/repository-history/RepositoryHistoryApp.vue`; **логики во Vue нет** — только отрисовка DTO и
    отправка команд;
  - новая команда webview → расширение — `RepositoryHistoryUiMessage` в зеркале и `repositoryHistoryMessages.ts`
    (`parseRepositoryHistoryUiMessage` принимает `unknown`) → ветка в `RepositoryHistoryViewProvider`;
  - новая точка входа (команда меню) — `ui/commands/repository/RepositoryHistoryCommands.ts` + `package.json`
    (`commandPalette when: false`) + пункт в `UniversalPanelViewProvider`; вход определяет
    `resolveRepositoryHistoryTarget`/`canShowRepositoryHistory` (`RepositoryHistoryTarget.ts`);
  - новый вид метаданных появляется в заголовках изменений одной записью `META_TYPES.repositoryClassId` — отдельной
    таблицы classID заводить нельзя;
  - MCP-вход — `ui/mcp/registration/McpRepositoryTools.ts` через тот же `RepositoryHistoryService` (`query()`).
  Операции только читают: guard и post-mutation путь не нужны. Секреты (хеш пароля, 40-hex хеши версий) в DTO, лог и
  вывод MCP не попадают.
