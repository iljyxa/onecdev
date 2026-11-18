# Рецепты: Панели изменений и истории (git)

Часть справочника [«какие файлы трогать»](../change-recipes.md). Если требуется править сверх списка — задача решается в другом слое.

- **Новая часть объекта в панели «Изменения метаданных»** (`MetadataPartKind`, см.
  [git-metadata-changes.md](../git-metadata-changes.md)): случай в
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
  [git-metadata-changes.md](../git-metadata-changes.md#формат-сообщений-протокола)).
- **Новый триггер обновления панели изменений/декораций по git-событию** (аналог Git Extension API):
  чистый селектор репозитория — `infra/git/GitRepositorySelector.ts` (без `vscode`) → тонкий наблюдатель
  поверх события — `ui/git/` (образец `GitStateObserver.ts` + типовой фасад `gitExtensionApi.ts`) →
  подключение в `Container` (образец `wireGitStateWatcher()`), с обязательным fallback fs-вотчером на
  случай недоступности источника → единственный выход обоих триггеров —
  `Container.scheduleDecorationRefresh()` (не заводить параллельный debounce/refresh-путь). См.
  [git-metadata-changes.md](../git-metadata-changes.md#триггеры-обновления-панели-и-декораций-git-extension-api--fallback-fs-вотчер).
- **Новая возможность блока «История»** (граф git-коммитов внутри панели «Изменения метаданных», НЕ
  отдельная вкладка/провайдер, см. [git-history-graph.md](../git-history-graph.md)), в зависимости от
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
