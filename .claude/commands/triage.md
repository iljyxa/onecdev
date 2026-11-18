---
description: Только триаж — определить трек SOLO / FULL / LARGE для задачи по критериям docs/agentic-pipeline.md и объяснить почему. Ничего не меняет, кода не пишет.
argument-hint: [описание задачи]
allowed-tools: Read, Glob, Grep
---

Определи трек для задачи:

$ARGUMENTS

1. Прочитай раздел «Триаж» `docs/agentic-pipeline.md` и таблицу индекса `docs/change-recipes.md` (сами
   рецепты — только файл подходящего сценария в `docs/recipes/`).
2. Проверь критерии FULL: новый тип метаданных/слот/тег/схема свойств, правка центральных контрактов
   (`META_TYPES`, `MetaPathResolver`, `PropertySchema`, `TypedFieldPropertyRules`, ruleset формата),
   MCP-инструмент или канон путей, протокол webview↔расширение, новая подсистема или новая зависимость между
   слоями. Число затронутых файлов само по себе FULL не делает.
3. Да — **FULL** (план в plan mode → TDD в сессии → гейт → `reviewer` → PR + CodeRabbit); не помещается в одну
   сессию — **LARGE** (`architect` → `implementer` по этапам → гейт → `reviewer` → `documenter`); иначе —
   **SOLO** (сессия сама → гейт → PR + CodeRabbit). Сомнение между SOLO и FULL — FULL.

Верни: трек, обоснование по пунктам критериев, предполагаемые файлы/слои и рецепт. Ничего не редактируй и не
запускай.
