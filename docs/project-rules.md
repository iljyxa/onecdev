# Правила проекта — полная версия

Развёрнутые формулировки правил, которые в корневом [`CLAUDE.md`](../CLAUDE.md) даны одной строкой.
`CLAUDE.md` загружается в каждый ход каждого агента, поэтому там — только краткий контракт; сюда
обращаются, когда задача касается соответствующей области (заведение issue, окружение тестов, MCP,
архитектурные контракты, TDD-гейт). Нумерация запретов совпадает с `CLAUDE.md`.

## Issues

- Задачи ведутся в issues `iljyxa/onecdev`. `gh` без `-R` в клоне с несколькими remote может выбрать
  чужой репозиторий — **всегда указывать `-R iljyxa/onecdev`**; ссылки `#N` в коммитах и ветках
  относятся к нему.
- **Читать issue/PR только через `--json`**: `gh issue view N -R iljyxa/onecdev --json
  title,body,labels,milestone,comments`. Обычный `gh issue view` запрашивает поле `projectCards`
  устаревших Projects (classic) и падает с `Projects (classic) is being deprecated` — это не ошибка прав,
  повторять тот же вызов бесполезно. Правка issue — `gh issue edit` или `gh api`.
- **Новое issue — сразу с лейблами и milestone:** тип (`bug` / `enhancement` / `refactor` /
  `documentation`) плюс один или несколько `subsystem: …` (`repository`, `support`, `mcp`, `dcs`,
  `xml-generator`, `tests`, `ui`, `extension` — расширения CFE и заимствование, `environment`, `core`,
  `project` и др.). Milestone — подходящий открытый из `gh api repos/iljyxa/onecdev/milestones`; если
  ни один не подходит — без milestone, не останавливаясь на вопросе. Актуальные лейблы —
  `gh label list -R iljyxa/onecdev`.
- **`subsystem:` — подсистема, где лежит основная работа**, а не ближайший общий лейбл: `ui` — только
  когда работа в webview/панели/дереве (наличие панели у фичи не повод); `extension` — механизм
  платформы «расширения конфигурации» (CFE), включая заимствование, а не само VS Code-расширение;
  `environment` — платформа, реестр ИБ, запуск базы/Конфигуратора; `core` — активация, `Container`,
  служебный каталог расширения. Подходящего нет — завести новый:
  `gh label create -R iljyxa/onecdev "subsystem: <имя>" --description "<на русском>"`.
- **Попутно найденный дефект вне объёма задачи** не чинится вскользь — заводится отдельным issue.
  Оформление (на русском): «Проблема» (файл, функция, механизм дефекта), «Воспроизведение» (реальная
  фикстура из `example/` и конкретный вызов), «Что сделать» (ожидаемое поведение и тесты); в конце —
  «Найдено при работе над #N». Неподтверждённую серьёзность (например, не проверено на платформе) так и
  указать.

## Команды

```bash
npm run build         # полная сборка: clean + build:node + build:webview (Vite → dist/)
npm run watch         # параллельный watch node + webview (scripts/vite-watch.mjs)
npm run typecheck     # tsc (расширение) + vue-tsc (webview); = npm run compile
npm run lint          # eslint . --max-warnings=0
npm test              # запуск всех тестов через @vscode/test-electron (out/test/runTests.js)
npm run test:fast     # прогон без pretest-пересборки; фильтр: MOCHA_GREP='<regex>' npm run test:fast
npm run coverage:changed # 100% ТОЛЬКО по изменённым production-файлам (гейт задачи; scripts/patch-coverage.mjs)
                       # база — COVERAGE_BASE_REF (синоним COVERAGE_BASE), иначе merge-base с
                       # origin/develop|origin/main; прогон дробится на COVERAGE_SHARDS свежих процессов;
                       # коды 0/1/2 и канарейка деградации — docs/coverage-gate.md
npm run coverage      # c8 с глобальным порогом 100% (аспирационный; сейчас RED из-за легаси-долга — не гейт задачи)
npm run coverage:report  # покрытие без падения по порогу (диагностика)
```

- **`npm test` требует предварительной сборки.** Скрипт `pretest` делает `typecheck → build:node → build:webview → test:compile` (без `clean` — сборка инкрементальная; компиляция тестов в `out/` через `tsconfig.test.json`). Тестовый runner берётся из `out/`, т.к. Mocha грузит `out/test/suite/*.js`.
- Запуск под конкретной версией VS Code: `VSCODE_TEST_VERSION=1.85.0 npm test`. `takeRunnerSettingsAndSanitize`
  (`src/test/runnerEnv.ts`) читает эту переменную ДО очистки унаследованного от IDE окружения (очистка
  стирает всё с префиксом `VSCODE_`, включая саму `VSCODE_TEST_VERSION`) — порядок чтения важен, не
  переставлять. Если версия ещё не скачана, `@vscode/test-electron` при
  первом запуске сам скачает её в `.vscode-test/` (нужна сеть); повторные запуски используют кэш.
- **Отдельный тест — быстро и без `.only`.** Runner (`src/test/suite/index.ts`) читает `MOCHA_GREP` и применяет `mocha.grep()`. Итерация: правка теста → `npm run test:compile` → `MOCHA_GREP='<regex по имени suite/теста>' npm run test:fast` (`test:fast` НЕ запускает `pretest`, т.е. не пересобирает Vite — на порядок быстрее полного `npm test`). `.only` больше не нужен.
- Перед любым коммитом: `npm run compile` и **`npm run lint`** должны проходить без ошибок и предупреждений.
- **Зависимости ставить `npm ci --ignore-scripts`.** Install-скрипты есть лишь у `ssh2` и `cpu-features`:
  они собирают нативные аддоны под системный Node, а extension host VS Code работает на Node из Electron с
  другим ABI и падает (segfault, код 139) ещё до первого теста. Без аддонов `ssh2` работает на чистом JS.
- **Без дисплея (CI, Linux-сервер, сессия агента)** тесты запускаются через `xvfb-run -a npm test` /
  `xvfb-run -a npm run test:fast`; `qa-gate.sh` подставляет `xvfb-run` сам.
- **Базовое состояние `npm test` — 0 падений.** Унаследованных падений нет: любое падение — регрессия
  задачи, а не «известный шум». Пропуски (pending) — корпусные тесты, носителей которых пока нет в
  `example/`.
- Точки входа: `main` = `./dist/extension.js`; CLI — `dist/cli/onec-tools.js`. Целевая среда — VS Code API ≥ 1.85, TypeScript ≥ 5.3, strict, ES2020.

## Архитектура

Слоистая, с однонаправленными зависимостями. Единый принцип: **одна декларативная таблица типов метаданных (`META_TYPES`) → один конвейер, использующий её везде**. Всё поведение — функции и сервисы поверх таблицы.

```
domain          ←   никто (самый низ)
infra           ←   domain
ui              ←   domain, infra
lsp             ←   infra (на чтение файлов), domain (опционально)
cli             ←   domain, infra (отдельный потребитель, нижние слои от него не зависят)
container/ext   ←   всё
```

Запреты зависимостей:
- `domain/**` не импортирует `vscode`, `fs`, `path`.
- `infra/**` не импортирует `vscode`.
- `domain/**` и `infra/**` не импортируют `cli/**`; CLI всегда потребитель.
- `ui/**` не содержит regex-парсинга XML и вычислений путей — только вызовы `infra/*`.
- LSP-подсистема не содержит встроенного сервера; все языковые возможности — через внешний `bsl-analyzer`.

### Раскладка каталогов (кратко; подробно — [project-layout.md](./project-layout.md))

```
src/
├── extension.ts, Container.ts   # тонкий activate/deactivate; composition root
├── domain/     # чистый домен: META_TYPES, ChildTag, ModuleSlot, MetaObject, CanonicalNames — без vscode/fs/path
├── infra/      # xml/ (ридеры/эдиторы, PropertySchema, format/ ruleset), fs/ (MetaPathResolver), cfe/, support/,
│               # cache/, repository/, git/, environment/, process/ (ConfigurationOperationGuard), mcp/, skills/ — без vscode
├── ui/         # tree/, views/ (universal/ — ОСНОВНОЙ UI, properties/, changes/, history/, …), commands/, git/, mcp/, readonly/
├── lsp/        # LspManager + внешний bsl-analyzer
├── cli/        # отдельный потребитель domain/infra (onec-tools.ts, commands/, core/)
└── test/       # runTests.ts + suite/
src-ui/         # Vue-webview: apps/* (панели), shared/ (protocol/, state/, components/, api/)
```

`cli/` — отдельный потребитель `domain/` и `infra/`. Если код нужен и расширению, и CLI — он живёт в `infra/<подпапка>/`, а `cli/core/*` даёт тонкий re-export.

Вне `src/` — `scripts/patch-coverage.mjs` (тонкий оркестратор гейта `coverage:changed`: git, спавны,
ФС, печать) и `scripts/patch-coverage/` (чистые модули без I/O, покрытые тестами наравне с `src/**`:
`branchFacts.mjs` — детектор ветвлений по TS AST, `diffBase.mjs` — выбор базы диффа, `verdict.mjs` —
разбор `lcov` и вердикт, `shards.mjs` — планирование и сверка порций прогона). Подробности —
[docs/coverage-gate.md](./coverage-gate.md).

### Центральный контракт — `META_TYPES`

Единственный источник правды по типам метаданных: иконки, папки выгрузки, дочерние элементы, слоты модулей, группировка в дереве, схема свойств.

```typescript
// domain/MetaTypes.ts
export interface MetaTypeDef {
  kind: MetaKind;                  // 'Catalog'
  label: string;                   // 'Справочник'
  pluralLabel: string;             // 'Справочники'
  folder?: string;                 // 'Catalogs'
  icon: string;                    // имя SVG без расширения
  group: MetaGroup;                // 'common' | 'top' | 'documents-branch' | 'child' | 'service' | 'root'
  groupOrder: number;
  childTags?: readonly ChildTag[]; // ['Attribute','TabularSection','Form','Command','Template']
  modules?: readonly ModuleSlot[]; // ['Object','Manager']
  propertySchema?: string;         // ключ в PROPERTY_SCHEMAS
  singleClickCommand?: OpenModuleCommandId;
  pathSegment?: string;            // канонический сегмент пути для MCP
  englishKind?: string;            // англ. имя типа (по умолчанию = kind)
  repositoryClassId?: string;      // classID вида в истории хранилища (crs)
}
```

Правила:
- **Добавление нового типа метаданных — ТОЛЬКО одна запись в `META_TYPES`.** Если пришлось править что-то ещё — это утечка знаний из реестра.
- Никаких параллельных словарей `typeToFolder`, `NODE_DESCRIPTORS`, `HANDLER_REGISTRY`, `FOLDER_MAP`.
- `ConfigXmlReader`, `MetaPathResolver`, `MetaObjectBuilder`, `GroupBuilder`, `PropertyBuilder` — все читают данные из `META_TYPES`.

### Центральный контракт — `MetaPathResolver`

Один класс вместо россыпи функций; карта слотов модулей (`Object→Ext/ObjectModule.bsl` и т.п.) — внутри как данные. Все пути (XML и BSL-модули) резолвятся только через него.

### Composition root

`Container.bootstrap()`: создаёт `OutputChannel` и все сервисы → регистрирует `TreeView`/декорации/`FileSystemWatcher` → `CommandRegistry.registerAll(ctx, services)` → `reloadEntries()` → запускает `V8McpServer` (если `onecdev.mcp.enabled`) → стартует `LspManager`. Сервисы не создаются через `new` в командах/builder'ах — только через Container.

### Основной UI — webview, а не TreeView

**`UniversalPanelViewProvider` (`src/ui/views/universal/`) — основной UI навигатора** (HTML/Vue-webview: дерево, поиск, контекстное меню, операции). Нативный `MetadataTreeProvider` (`ui/tree/`) существует только как источник данных (`treeProvider.getChildren()`); сам TreeView-виджет — атавизм и **не основной UI**.

Следствия:
- Контекстное меню узлов формируется в `ui/views/universal/nodeContextMenu.ts`, **а не** через `package.json → contributes.menus`: `collectNodeActions()` решает, какие пункты есть у узла, и относит каждый к секции; `NODE_MENU_LAYOUT` — единственная таблица порядка групп и подменю («База», «Файлы», «Хранилище», «Проверка»). Webview (`AppContextMenu.vue`) только рисует готовое дерево `{group, children}` из `TreeNodeActionDto`.
- Новый пункт меню узла — `add(<секция>, …)` в `collectNodeActions`; новая группа или подменю — запись в `NODE_MENU_LAYOUT`, не правка шаблона webview.
- Источник правды для команд узла — `META_TYPES.modules`, читаемый через `MODULE_SLOT_ACTIONS`.
- Новая команда узла: добавить в `MODULE_SLOT_ACTIONS` (в `nodeContextMenu.ts`) + зарегистрировать в `CommandRegistry`. Правка `package.json → menus` — опциональна (для нативного TreeView).

### Webview (`src-ui/`)

Vue-приложения (сборка `vite.webview.config.ts`, проверка типов `vue-tsc`/`tsconfig.ui.json`): `src-ui/apps/*` — отдельные панели, `src-ui/shared/` — общий код (`protocol/` — контракт сообщений webview ↔ расширение, `state/`, `components/` в т.ч. общее дерево `UniversalTree*.vue`, `api/`). Состав панелей — [project-layout.md](./project-layout.md#webview-src-ui). При изменении взаимодействия панели и расширения правьте обе стороны протокола.

## MCP-сервер для ИИ-агентов

`src/ui/mcp/V8McpServer.ts` — локальный MCP-сервер, официальный канал автоматизации. Запускается только после `reloadEntries()`, слушает loopback, не даёт агенту прямой доступ к shell/произвольным путям/произвольным VS Code командам. Старт/остановка, гарантированное освобождение порта и разрешение конфликта порта с другим инстансом/проектом — отдельный слой `infra/mcp/`, см. [mcp-server-lifecycle.md](./mcp-server-lifecycle.md) (не путать с каноном путей инструментов ниже).

Правила:
- SDK: production-ветка `@modelcontextprotocol/sdk` v1.x. Транспорт: Streamable HTTP на `127.0.0.1`/`localhost`/`::1`; удалённый bind запрещён.
- Инструменты регистрируются в `V8McpServer.ts`, но бизнес-логика живёт в общих сервисах (`infra/*`, `ui/commands/*/*Service.ts`). UI-команда и MCP-инструмент для одного действия вызывают **один и тот же код**.
- Для команд, меняющих конфигурацию/базу (импорт, обновление, создание/удаление/редактирование метаданных), добавлять MCP-инструмент или явно документировать, почему нельзя.
- Нельзя делать инструмент, исполняющий произвольную строку команды, произвольный `vscode.commands.executeCommand` или пишущий XML в обход существующего сервиса.
- Любой инструмент записи сначала валидирует вход и права, возвращает список изменённых файлов и маркирует конфигурацию изменённой тем же механизмом, что UI. Единый post-mutation путь: `suppressConfigurationReloadForFiles(changedFiles)` → `markChangedConfigurationByFiles(changedFiles)` → `treeProvider.refresh()` → `refreshActionsView()`.
- Путь файловой системы, по которому инструмент создаёт или пишет файлы (`outputDir`, `outputFile`, `objectPath` внешнего объекта, `extensionRoot` и т.п.), принимается только внутри папки workspace: `gate.resolveWorkspaceWritePath()` → `infra/fs/WorkspaceWritePath.ts` (относительный путь — от корня workspace, сравнение по реальным путям, симлинк наружу отклоняется). UI-команды с путём из диалога пользователя эту проверку не проходят — ограничение касается только недоверенного клиента MCP (#174).
- Значения enum, boolean/localized-классификация и схемы свойств живут в `infra/xml/PropertySchema.ts` (или спец-реестре infra), MCP только публикует контракт.

### Канон именования путей MCP

Полный справочник — [mcp-paths.md](./mcp-paths.md). Ключевое:
- Корни-коллекции — **только множественное число** (`Справочники.Контрагенты`, `РегистрыСведений.КурсыВалют`). Единственное — только для `Подсистема`, `Конфигурация`, `Расширение`.
- Реквизиты/ТЧ — прямые сегменты без роли-префикса (`Справочники.Контрагенты.ИНН`; внутри ТЧ — `…ТабличнаяЧасть.Имя.Реквизит.Имя`).
- Английских алиасов (`Catalog.X`) и legacy-форм нет; любая такая форма отбивается с подсказкой канона.
- У инструментов, работающих с одним узлом, аргумент называется `path`; парные `compile_*` принимают `parentPath`. Никаких `objectPath`/`formPath`/`modulePath` и т.п.
- Контракт `resolveFormXmlByCanonical` (`ui/mcp/McpPathResolvers.ts`) — путь к **ТЕЛУ** формы (`…/Ext/Form.xml`), не к дескриптору и не к XML объекта: `Справочники.X.Форма.Y` → `Catalogs/X/Forms/Y/Ext/Form.xml`, `ОбщиеФормы.X` → `CommonForms/X/Ext/Form.xml`. См. [mcp-paths.md](./mcp-paths.md#формы-тело-и-дескриптор).

## Технологический стек

- TypeScript ≥ 5.3, target ES2020, strict. VS Code API ≥ 1.85, `vscode-languageclient`.
- **Vite** (сборка в `dist/`). Два конфига: `vite.node.config.ts` (Node-таргет: `extension`, CLI) и `vite.webview.config.ts` (Vue-webview из `src-ui/`). Встроенного `server`-entry нет — LSP внешний (`bsl-analyzer`).
- `iconv-lite` — декодирование OEM-866/Win1251 вывода vrunner.
- Тесты — Mocha через `@vscode/test-electron`, покрытие — `c8`.

## Ключевые принципы

- Один декларативный реестр `META_TYPES` → один конвейер. Поведение — функции/сервисы поверх таблицы, без дублирующих словарей.
- Все пути (XML и BSL-модули) резолвятся только через `MetaPathResolver`.
- `bsl-analyzer` — единственный LSP; BSL-файлы открываются напрямую через `file://`.
- Ленивая загрузка дерева: дочерние узлы строятся при раскрытии.
- **Генерация XML привязана к версии формата через ruleset** (`infra/xml/format/`, текущий — 2.21). См. `docs/xml-format-rulesets.md`.

## Известные технические долги

Перечень — [tech-debt.md](./tech-debt.md). Сверяться при планировании задач в затронутых областях (`CommandRegistry`, `TreeNode`, XML-парсинг на регулярках, панель «Изменения метаданных», блок «История», хранилище).

## Запреты и анти-паттерны

1. **Никаких regex-парсеров XML вне `infra/xml/`.**
2. **Нет дублирующих реестров типов.** `Record<string,string>` с `Catalog:'Catalogs'` вне `META_TYPES` — баг архитектуры.
3. **Нет команд в `package.json`, не покрытых `CommandRegistry`.**
4. **`MetadataTreeProvider` не знает про типы метаданных** — делегирует в builder'ы.
5. **`TreeNode` не хранит XML-логику** — только отображение + ссылка на `TreeNodeModel`.
6. **Не импортировать `vscode` в `domain/` и `infra/`.**
7. **Сервисы не создаются через `new` в командах/builder'ах** — только через `Container`.
8. **Не использовать `any`.** Если неизбежно — комментарий `// any: <причина>`.
9. **Не сохранять пароли/токены в файлы проекта.** Секреты — через VS Code SecretStorage.
10. **Не создавать файлы при команде «Открыть».** Создание — только явным командам добавления/генерации.
11. **Не вешать синхронный I/O на getters, tooltip, decoration и hot path дерева.**
12. **Не терять формат XML.** Любой редактор существующего XML сохраняет BOM и стиль переводов строк исходного файла (`writeTextFilePreservingBomAndEol`). **Ловушка:** в `originalContent` передаётся текст, прочитанный ДО замены (отдельная константа перед `replace`), а не уже изменённый — иначе эталон стиля берётся с результата, и сохранение BOM/EOL становится пустой операцией (прецедент — `CfeBorrowService`). Новый файл выгрузки пишется через `writeNewExportFile` (`infra/fs/NewExportFile.ts`) в формате платформы — BOM + CRLF, у XML без завершающего EOL (#165).
13. **Справочники свойств не живут в UI** — только в `infra/xml/PropertySchema.ts` (или спец-реестре infra); UI рендерит готовое.
14. **Команды контекстного меню не хардкодятся в `UniversalPanelViewProvider`** — `addModuleActions` читает `META_TYPES[kind].modules` через `MODULE_SLOT_ACTIONS`.
15. **Нативный TreeView — не основной UI**; не дублировать логику меню в `package.json`, если она есть в `addModuleActions`.
16. **MCP-инструменты принимают только канон** (см. [mcp-paths.md](./mcp-paths.md)).
17. **God-объектов быть не должно.** Порог-ориентир — **~800 строк** на файл производственного кода; превышение требует либо явного обоснования, либо декомпозиции. Дробить **по ответственности/домену, а не механически по строкам**. Каноничные приёмы: регистрация MCP-инструментов дробится по доменам (`src/ui/mcp/registration/*`, образец — `McpAddToolsRegistration`); диспетчер `switch (kind)` заменяется **таблицей** `Record<MetaKind, …>` — данные типа в `META_TYPES`, XML-литералы формата в спец-реестре `infra/` (параллельные словари вне `META_TYPES` запрещены, см. п.2); класс-фасад остаётся тонким, логика — в module-level функциях/подмодулях того же слоя. **Любое дробление XML-генератора обязано сохранять байт-в-байт выход** (BOM/EOL/порядок атрибутов/самозакрытие, см. п.12) и предваряться байт-golden-тестом; декомпозиция `MetadataXmlCreator`/`FormBuilders` без такого эталона — запрещена (идёт вслепую).
18. **Внутри аренды `ConfigurationOperationGuard` (или любой другой эксклюзивной операции) уведомления показываются без `await`.** `await vscode.window.showInformationMessage(...)`/`showWarningMessage(...)` до `release()` держит guard занятым до закрытия нотификации пользователем — любая параллельная операция всё это время отбивается сообщением «уже выполняется», хотя фактически ничего не выполняется.

## TDD и покрытие

1. **Любое изменение поведения начинается с теста** (красный → код → зелёный).
2. **Покрытие кода, ЗАТРОНУТОГО изменением, — 100%** по строкам, веткам, функциям, операторам. Гейт — `npm run coverage:changed` (patch coverage: новые файлы целиком, изменённые — только строки диффа; прогон дробится на свежие процессы `COVERAGE_SHARDS`, иначе V8 теряет поблочную детализацию), в конвейере — через `.claude/scripts/qa-gate.sh`, который всегда передаёт базу (`COVERAGE_BASE_REF`, синоним `COVERAGE_BASE`). Вердикт, коды возврата и канарейка деградации — [docs/coverage-gate.md](./coverage-gate.md); **код 2 — «данным нельзя верить, перемерь», не «допиши тест»**. Глобальный `npm run coverage --100` красный из-за легаси-долга (`ui/tree/nodeBuilders/*`, `ExtensionCommandRunner`, `RepositoryCommandRunner`, `InitializeProjectCommand`, `infra/xml/form/*` и др.) — **известное состояние, не предмет задачи**; не доказывать это заново через stash/baseline. `Container.ts`/`extension.ts` c8 не инструментирует — они покрываются интеграционно и исключены из гейта
(тот же список исключений `NOT_INSTRUMENTED` в `scripts/patch-coverage.mjs` включает и
`src/ui/commands/CommandRegistry.ts` — реестр вызовов `register*Commands`, исполняется только при
активации из `Container`, сами регистраторы проверяются тестами напрямую).
3. **Заглушки/фиктивные ассёрты/тесты ради покрытия запрещены.** Тест проверяет реальное поведение на настоящих XML-фикстурах (`example/2.20/src/cf`, `example/2.21/src/cf`, `example/2.21/src/cfe/EVOLC`), реальных временных файлах или реальном процессе; mock/stub — только для недоступной внешней системы с обоснованием. Тесты **детерминированы** — без гонок/угадывания таймингов; учитывай фоновое поведение SDK/клиентов.
4. **Тест не пишет в `example/`.** Мутационные сьюты копируют нужное во временный каталог (`fs.mkdtempSync`) и работают там; резервирование в `setup` с восстановлением в `teardown` защитой не является — обрыв прогона между ними оставляет корпус испорченным.
5. Непокрываемую из-за VS Code API логику выносить в `domain/`/`infra/` и покрывать unit-тестом; тонкий UI-адаптер — интеграционным тестом. Осознанно недостижимую защитную ветку — `/* c8 ignore */` с обоснованием.
6. **Все тесты задачи — за один проход** (ветки заранее: ошибки, таймауты, guard'ы, граничные входы; параметризация по конечным множествам — enum/настройки, напр. `host ∈ {127.0.0.1, localhost, ::1}`), чтобы не гонять ре-цикл через гейт.
7. Перед завершением задачи QA-гейт — GREEN. Если его нельзя выполнить локально — зафиксировать причину, задачу не считать завершённой.

## Рабочий процесс и отладка

- Запуск: `npm ci --ignore-scripts` → `npm run watch` → `F5` (Extension Development Host), `Ctrl+Shift+F5` — перезапуск.
- Каналы вывода: «BSL LSP Trace» (JSON-RPC), «1С Редактор» (лог расширения), «BSL Analyzer» (stdout/stderr сервера).
- Инкрементальность: менять не более одного слоя за коммит; после каждого коммита проходят `npm run compile` и `npm run lint`.
- Новый код — только в целевых папках. Создание новых файлов в корне `src/` запрещено (кроме `Container.ts`, `extension.ts`). Папки `src/handlers|nodes|services|views|language|language-server|formEditor` не существуют — не создавать.
- Не создавать параллельные версии сервисов («v2»). При переносе файла — `git mv` + обновить импорты + `compile`/`lint`.

### Sanity-чек после изменений

1. `npm run compile` — 0 ошибок.
2. `npm run lint` — 0 ошибок и предупреждений.
3. `npm run build` — Vite собирается.
4. `rg "typeToFolder\s*:" src` — 0.
5. `rg "import .* from 'vscode'" src/domain src/infra` — 0.
6. `rg "from ['\"].*cli|from ['\"].*/cli" src/domain src/infra` — 0.
7. `rg "require\(|readFileSync" src/domain` — 0.
8. `rg "FOLDER_MAP|FOLDER_RU" src` — 0.
9. `rg "crs:snapshots|commitObjects|updateObjects|11223344" src --glob '!src/test/**'` — 0 (протокол crs не читает содержимое объектов, [repository-crs.md](./repository-crs.md)).
10. `rg "crs:data" src --glob '!src/test/**' --glob '!src/infra/repository/crs/CrsHistory.ts'` — 0.
11. `rg "base64|atob\(" src/infra/repository/crs/CrsHistory.ts` — 0.

## 1С-скилы и ИИ-роли пользователей

Каталогов `.cursor/`, `.codex/` и `.claude/skills/` со скилами 1С (`cf-*`, `cfe-*`, `form-*`, `meta-*`, `skd-*`
и т.п.) в репозитории нет. Часть логики расширения портирована из Python-скриптов этих скилов
(`form-compile`, `form-validate`, `cfe-borrow`, `cf-init` и др.) — упоминания в комментариях кода описывают
происхождение, паритет с исходными скриптами не поддерживается. Пользователям расширение ставит проектные ИИ-роли
(`src/infra/skills/AiSkillsInstaller.ts`): роли генерируются из кода, скриптов не содержат и направляют агента к
MCP-инструментам расширения. К разработке самого расширения эти роли не относятся — для неё действует этот файл.
