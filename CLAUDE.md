# CLAUDE.md

Контракт для Claude Code и любого агента в этом репозитории. Файл загружается в каждый ход каждого агента,
поэтому здесь — только краткие правила. Развёрнутые формулировки, примеры и обоснования —
**[docs/project-rules.md](./docs/project-rules.md)** (нумерация запретов совпадает); читать нужный раздел,
когда задача касается его области.

## О проекте

`onecdev` — hard fork [v8vscedit](https://github.com/Macegor/v8vscedit) с 2026-11-13, репозиторий
`iljyxa/onecdev`, GPL-3.0-only (`LICENSE`, `NOTICE`). Расширение VS Code / Cursor (TypeScript) для выгрузки
конфигураций и расширений 1С: навигатор метаданных из XML (CF и CFE) — дерево, свойства, создание/удаление/
редактирование объектов; синхронизация с базой; хранилище конфигурации; LSP-клиент внешнего `bsl-analyzer`;
локальный MCP-сервер для ИИ-агентов.

Документация — `./docs`: [architecture.md](./docs/architecture.md), [project-layout.md](./docs/project-layout.md)
(раскладка `src/`), [change-recipes.md](./docs/change-recipes.md) (какие файлы трогать — индекс рецептов),
[mcp-paths.md](./docs/mcp-paths.md), [xml-format-rulesets.md](./docs/xml-format-rulesets.md),
[agentic-pipeline.md](./docs/agentic-pipeline.md), [coverage-gate.md](./docs/coverage-gate.md),
[tech-debt.md](./docs/tech-debt.md) и профильные файлы по подсистемам. Читать **разделы**, а не файлы целиком.

## Язык

- Ответы, комментарии и документация в коде, сообщения коммитов — на русском.
- Комментарии объясняют *почему*, а не *что*; без «комментариев-капитанов» и декоративных эмодзи.
- Давать конкретные решения применительно к проекту, а не высокоуровневые советы.

## Git-процесс

- **Коммиты — на русском. Запрещено упоминать Claude/ИИ в любой форме**: никаких `Co-Authored-By: Claude`,
  `Generated with Claude Code` и подобного — ни в коммитах, ни в телах PR.
- **`main` — ствол** (`origin` = `iljyxa/onecdev`). С `Macegor/v8vscedit` синхронизации нет.
- **Ветку задачи создаёт оркестратор** (основной чат) от `origin/main`; субагенты веток не создают. Имена:
  `fix/…`, `feat/…`, `chore/…`; по issue — `fix/issue-<N>-<кратко>`.
- **В `main` — только через PR с merge-коммитом** (`gh pr merge --merge --delete-branch`, тема
  «Влить <ветка>: … (#N)»; merge-коммит — граница задачи, как прежний `--no-ff`). Перед merge — зелёные CI
  (QA-гейт) и ревью CodeRabbit. После merge — `git pull --ff-only` в `main`, локальная ветка удаляется.
  Долгоживущая ветка подтягивает `main` через `git merge main`, не rebase. Порядок — «PR и ревью» в
  [agentic-pipeline.md](./docs/agentic-pipeline.md).
- Ветку задачи пушить можно; **merge PR и любой push в `main` — только с явного подтверждения
  пользователя**; `push --force` в `main` запрещён.

## Issues

- Всегда `-R iljyxa/onecdev`; читать только через `--json` (`gh issue view N -R iljyxa/onecdev --json
  title,body,labels,milestone,comments`) — обычный `gh issue view` падает на Projects (classic).
- Новое issue — сразу с лейблом типа (`bug`/`enhancement`/`refactor`/`documentation`), `subsystem: …` по
  месту основной работы и открытым milestone, если подходит. Попутный дефект вне задачи не чинится вскользь —
  отдельное issue. Правила выбора лейблов и шаблон текста — [project-rules.md](./docs/project-rules.md#issues).

## Конвейер агентной разработки (оркестратор + субагенты)

Полное описание — [agentic-pipeline.md](./docs/agentic-pipeline.md); вход — `/pipeline <задача>`.

- **Одна сессия — одна задача:** от ветки до merge PR. Следующая задача — новая сессия, не продолжение
  этой: каждый ход оплачивает всю историю контекста.
- **SOLO** (по умолчанию): сессия сама делает разведку по рецепту, тесты и код → QA-гейт → PR → CodeRabbit.
- **FULL** (новый тип/слот/тег/схема свойств, центральные контракты `META_TYPES`/`MetaPathResolver`/
  `PropertySchema`/ruleset, MCP-инструмент или канон путей, протокол webview↔расширение, новая подсистема):
  план в plan mode с утверждением пользователя → TDD в той же сессии → гейт → агент `reviewer` → PR →
  CodeRabbit. **LARGE** (не помещается в одну сессию): `architect` пишет план в `docs/plans/` →
  `implementer` по этапам.
- **QA-гейт — скрипт:** `bash .claude/scripts/qa-gate.sh [база=main]` (lint, sanity, один прогон
  `coverage:changed` = регресс + 100% patch coverage; нерантайм-изменения — тесты `N/A`); в фоне, без опроса.
  RED с неочевидной причиной — агент `qa-e2e` по `out/qa-gate.log`.
- **Инвариант: гейт и ревью — на любой задаче** (SOLO — CodeRabbit; FULL/LARGE — ещё и `reviewer`).
- **Гигиена контекста:** файлы — разделами (`grep -n` → `Read` с `offset`/`limit`), символы — `LSP`, вывод
  команд — `| tail`, `CLAUDE.md` не перечитывать; флейк — дефект теста, а не повод для повторов.

## Команды

```bash
npm run build            # clean + build:node + build:webview (Vite → dist/)
npm run typecheck        # tsc + vue-tsc (= npm run compile)
npm run lint             # eslint . --max-warnings=0
npm test                 # все тесты через @vscode/test-electron; pretest пересобирает всё
npm run test:fast        # без pretest; фильтр: MOCHA_GREP='<regex>' (после npm run test:compile)
npm run coverage:changed # 100% patch coverage изменённого — гейт задачи (docs/coverage-gate.md)
```

- Итерация по одному тесту: `npm run test:compile` → `MOCHA_GREP='…' npm run test:fast`; `.only` не нужен.
- Без дисплея — `xvfb-run -a …` (`qa-gate.sh` подставляет сам).
- Зависимости — `npm ci --ignore-scripts` (нативные аддоны `ssh2` ломают extension host).
- Базовое состояние `npm test` — 0 падений: любое падение — регрессия задачи. Pending — корпусные тесты без
  носителей в `example/`.
- Перед коммитом `npm run compile` и `npm run lint` — без ошибок и предупреждений.
- `VSCODE_TEST_VERSION`, порядок чтения окружения раннером, глобальный `coverage` —
  [project-rules.md](./docs/project-rules.md#команды).

Стек: TypeScript ≥ 5.3 strict, ES2020; VS Code API ≥ 1.85; Vite (`vite.node.config.ts` — extension и CLI,
`vite.webview.config.ts` — Vue из `src-ui/`); Mocha + `@vscode/test-electron`, `c8`. Точки входа:
`dist/extension.js`, CLI `dist/cli/onec-tools.js`.

## Архитектура

Слоистая, зависимости однонаправленные. **Одна декларативная таблица `META_TYPES` → один конвейер.**

```
domain ← никто;  infra ← domain;  ui ← domain, infra;  lsp ← infra (+domain);  cli ← domain, infra;  container/ext ← всё
```

- `domain/**` не импортирует `vscode`, `fs`, `path`; `infra/**` — `vscode`; `domain`/`infra` не импортируют `cli/**`.
- `ui/**` — без regex-парсинга XML и вычисления путей, только вызовы `infra/*`.
- Код, нужный и расширению, и CLI, живёт в `infra/<подпапка>/`, `cli/core/*` — тонкий re-export.
- Каталоги: `src/{domain,infra,ui,lsp,cli,test}`, `Container.ts`, `extension.ts`; `src-ui/` — Vue-webview
  (`apps/*`, `shared/protocol` — контракт сообщений, правится с обеих сторон). Подробно —
  [project-layout.md](./docs/project-layout.md).
- **`META_TYPES`** (`domain/MetaTypes.ts`) — единственный источник правды по типам метаданных; новый тип —
  ТОЛЬКО одна запись в нём. **`MetaPathResolver`** — все пути XML и BSL-модулей. **`Container.bootstrap()`** —
  composition root, сервисы создаются только там.
- **Основной UI — webview `UniversalPanelViewProvider`** (`ui/views/universal/`), а не нативный TreeView;
  контекстное меню — `getNodeActions()`/`addModuleActions()` через `MODULE_SLOT_ACTIONS`, не `package.json`.
- Генерация XML привязана к версии формата через ruleset (`infra/xml/format/`, текущий — 2.21).
- Детали контрактов (поля `MetaTypeDef`, порядок bootstrap, webview) —
  [project-rules.md](./docs/project-rules.md#архитектура).

## MCP-сервер

`ui/mcp/V8McpServer.ts` — официальный канал автоматизации, только loopback, SDK `@modelcontextprotocol/sdk` v1.x,
Streamable HTTP. Бизнес-логика — в общих сервисах: UI-команда и MCP-инструмент вызывают один код. Нельзя:
произвольная команда/`executeCommand`/запись XML в обход сервиса. Инструмент записи валидирует вход, возвращает
изменённые файлы и идёт единым post-mutation путём. Пути — только канон
[mcp-paths.md](./docs/mcp-paths.md): коллекции во множественном числе, без английских алиасов, аргумент `path`.
Полные правила — [project-rules.md](./docs/project-rules.md#mcp-сервер-для-ии-агентов); жизненный цикл —
[mcp-server-lifecycle.md](./docs/mcp-server-lifecycle.md).

## Рецепты изменений

Какие файлы трогать по сценарию — индекс [change-recipes.md](./docs/change-recipes.md) → один тематический
файл `docs/recipes/*.md`. Правка сверх рецепта — задача решается в другом слое.

## Запреты и анти-паттерны

1. Никаких regex-парсеров XML вне `infra/xml/`.
2. Нет дублирующих реестров типов (`typeToFolder`, `FOLDER_MAP` и т.п. вне `META_TYPES`).
3. Нет команд в `package.json`, не покрытых `CommandRegistry`.
4. `MetadataTreeProvider` не знает про типы метаданных — делегирует в builder'ы.
5. `TreeNode` не хранит XML-логику.
6. Не импортировать `vscode` в `domain/` и `infra/`.
7. Сервисы не создаются через `new` в командах/builder'ах — только через `Container`.
8. Не использовать `any`; если неизбежно — `// any: <причина>`.
9. Пароли/токены — только SecretStorage, не в файлы проекта.
10. Не создавать файлы при команде «Открыть».
11. Не вешать синхронный I/O на getters, tooltip, decoration и hot path дерева.
12. Не терять формат XML: BOM и EOL исходного файла (`writeTextFilePreservingBomAndEol`, эталон стиля — текст
    ДО замены).
13. Справочники свойств — в `infra/xml/PropertySchema.ts` (или спец-реестре infra), не в UI.
14. Команды контекстного меню не хардкодятся в `UniversalPanelViewProvider` — `MODULE_SLOT_ACTIONS`.
15. Нативный TreeView — не основной UI; не дублировать меню в `package.json`.
16. MCP-инструменты принимают только канон путей.
17. Без God-объектов (~800 строк); дробить по ответственности; XML-генераторы — только с байт-golden-тестом.
18. Внутри аренды `ConfigurationOperationGuard` уведомления — без `await`.

## TDD и покрытие

1. Изменение поведения начинается с теста (красный → код → зелёный); все тесты задачи — за один проход.
2. Покрытие затронутого кода — 100% (`coverage:changed`; код 2 — «перемерь», а не «допиши тест»).
3. Тесты — на реальных фикстурах (`example/2.20/src/cf`, `example/2.21/src/cf`, `example/2.21/src/cfe/EVOLC`),
   временных файлах или реальном процессе; без заглушек ради покрытия; детерминированные.
4. Тест не пишет в `example/` — только во временный каталог (`fs.mkdtempSync`).
5. Логику, недоступную тесту из-за VS Code API, выносить в `domain/`/`infra/`.

Подробности (исключения гейта, `/* c8 ignore */`, легаси-долг глобального покрытия) —
[project-rules.md](./docs/project-rules.md#tdd-и-покрытие).

## Рабочий процесс

- Новый код — только в целевых папках слоёв; новых файлов в корне `src/` и папок
  `handlers|nodes|services|views|language|language-server|formEditor` не создавать; без «v2»-версий
  сервисов; перенос файла — `git mv`.
- Sanity-проверки инвариантов выполняет `qa-gate.sh` (список — [project-rules.md](./docs/project-rules.md#sanity-чек-после-изменений)).
- Известные техдолги — [tech-debt.md](./docs/tech-debt.md).
- `.cursor/`, `.codex/`, `.claude/skills/` (`cf-*`, `meta-*`, `form-*` и т.п.) — доменные 1С-скилы для
  пользователей расширения, справочно; к TypeScript-коду репозитория они не относятся.
