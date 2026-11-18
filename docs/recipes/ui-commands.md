# Рецепты: UI, команды, LSP, настройки

Часть справочника [«какие файлы трогать»](../change-recipes.md). Если требуется править сверх списка — задача решается в другом слое.

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
  [metadata-navigator.md](../metadata-navigator.md#инвариант-узла-формы-xmlpath-принадлежит-владельцу).
- **Новый builder узла:** `ui/tree/nodeBuilders/<имя>.ts` → регистрация в диспетчере `metaObjectTreeBuilder.ts`. XML — только через `parseObjectXml`/`ObjectXmlReader`.
- **Новая декорация узла:** класс в `ui/tree/decorations/` (реализует `vscode.FileDecorationProvider`) → регистрация в `Container.wireTreeView` → суффикс `contextValue` — только в `TreeNode`.
- **Новый view/webview:** класс в `ui/views/<Имя>ViewProvider.ts` (без XML/FS) → данные готовит отдельный сервис → создание и команда открытия через `Container`.
- **Новый сервис инфры:** класс в `infra/<подпапка>/<Имя>Service.ts` без `vscode`, `Logger` через конструктор → создать в `Container.bootstrap` → тест на пример из `example/`.
- **Новая возможность LSP:** встроенных провайдеров нет; completion/hover/diagnostics добавляются в `bsl-analyzer`, здесь проверяется только интеграция `LspManager`.
- **Новая настройка:** `package.json → contributes.configuration.properties` с префиксом `onecdev.<область>.<ключ>`, `description` на русском → читать только через `vscode.workspace.getConfiguration('onecdev')` в UI/Container → при рантайм-влиянии подписка на `onDidChangeConfiguration`.
- **Новый watcher:** `FileSystemWatcher` — только в `Container` или `ui/support/`; обработчик делегирует в сервис.

- **Открытие BSL-модулей:** только реальные `file://` документы (виртуальная схема `onec://` удалена).
  Readonly модуля — через `ui/readonly/BslReadonlyGuard.ts`; readonly по захвату хранилища —
  `EditorReadonlyController` (`ui/readonly/EditorReadonlyController.ts`). Обе точки применяют переход к
  уже открытому ресурсу через общий адаптер `ui/readonly/sessionReadonly.ts`
  (`collectOpenTabs`/`runWithResourceActive`) и выбор маршрута `ui/readonly/readonlyTabSelection.ts`
  (`selectReadonlyApplyRoute`) — readonly-команда VS Code действует только на правую (основную) сторону
  активного редактора, поэтому левая file:-сторона diff переключается через временную вкладку.
