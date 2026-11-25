import * as path from 'path';
import { META_TYPES } from '../../../domain/MetaTypes';
import type { ConfigEntry } from '../../../domain/Configuration';
import { canShowRepositoryHistory } from '../../../infra/repository/history/RepositoryHistoryTarget';
import type { MetadataNode } from '../../tree/TreeNode';

/**
 * Контекстное меню узла универсальной панели (#187): какие пункты есть у узла и как они
 * разложены по группам и подменю. Условия появления пунктов — `collectNodeActions`,
 * раскладка — единственная таблица `NODE_MENU_LAYOUT`; webview только рисует готовое дерево.
 */

export interface MenuIconDto {
  readonly kind: 'codicon' | 'metadata' | 'asset' | 'none';
  readonly name?: string;
  readonly lightUri?: string;
  readonly darkUri?: string;
}

/**
 * Пункт меню в протоколе webview. `group` — соседние пункты с разной группой разделяются
 * линией; `children` — подменю, у такого пункта `command` пустой и не исполняется.
 */
export interface NodeMenuItemDto {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly icon?: MenuIconDto;
  readonly group?: string;
  readonly children?: NodeMenuItemDto[];
}

export type NodeMenuSection =
  | 'open'
  | 'edit'
  | 'db'
  | 'file'
  | 'repo.work'
  | 'repo.admin'
  | 'repo.users'
  | 'repo.connection'
  | 'check';

export interface NodeMenuAction {
  readonly command: string;
  readonly title: string;
  readonly icon: MenuIconDto;
  readonly section: NodeMenuSection;
}

export interface NodeMenuContext {
  /** Реестр конфигураций: нужен заимствованию (есть ли расширения, из основной ли конфигурации узел). */
  readonly getEntries: () => readonly ConfigEntry[];
}

interface MenuGroupLayout {
  readonly group: string;
  readonly section: NodeMenuSection;
}

interface MenuSubmenuLayout {
  readonly group: string;
  readonly submenu: { readonly key: string; readonly label: string; readonly icon: string; readonly sections: readonly NodeMenuSection[] };
}

/**
 * Порядок меню сверху вниз. Частое (открыть, править) — на верхнем уровне, редкое — в подменю;
 * внутри подменю секции разделяются линией. Пустая секция и пустое подменю не выводятся.
 */
export const NODE_MENU_LAYOUT: readonly (MenuGroupLayout | MenuSubmenuLayout)[] = [
  { group: 'open', section: 'open' },
  { group: 'edit', section: 'edit' },
  { group: 'more', submenu: { key: 'db', label: 'База', icon: 'database', sections: ['db'] } },
  { group: 'more', submenu: { key: 'file', label: 'Файлы', icon: 'file-binary', sections: ['file'] } },
  {
    group: 'more',
    submenu: {
      key: 'repository',
      label: 'Хранилище',
      icon: 'repo',
      sections: ['repo.work', 'repo.admin', 'repo.users', 'repo.connection'],
    },
  },
  { group: 'more', submenu: { key: 'check', label: 'Проверка', icon: 'checklist', sections: ['check'] } },
];

export const MODULE_SLOT_ACTIONS: Partial<Record<string, { command: string; title: string; icon: MenuIconDto }>> = {
  Object:       { command: 'onecdev.openObjectModule',    title: 'Открыть модуль объекта',   icon: codicon('code') },
  Manager:      { command: 'onecdev.openManagerModule',   title: 'Открыть модуль менеджера', icon: codicon('code') },
  ValueManager: { command: 'onecdev.openConstantModule',  title: 'Открыть модуль константы', icon: codicon('code') },
  RecordSet:    { command: 'onecdev.openRecordSetModule', title: 'Открыть модуль записи',    icon: codicon('code') },
  Service:      { command: 'onecdev.openServiceModule',   title: 'Открыть модуль сервиса',   icon: codicon('code') },
  CommonModule: { command: 'onecdev.openCommonModuleCode', title: 'Открыть модуль',          icon: codicon('code') },
  CommonCommand:{ command: 'onecdev.openCommandModule',   title: 'Открыть модуль команды',   icon: codicon('code') },
  CommonForm:   { command: 'onecdev.openFormModule',      title: 'Открыть модуль формы',     icon: codicon('code') },
  ChildForm:    { command: 'onecdev.openFormModule',      title: 'Открыть модуль формы',     icon: codicon('code') },
  ChildCommand: { command: 'onecdev.openCommandModule',   title: 'Открыть модуль команды',   icon: codicon('code') },
};

const ROOT_WITH_XML = /^(configuration|extension)-hasXml/;

type AddAction = (section: NodeMenuSection, command: string, title: string, icon: MenuIconDto) => void;

/** Плоский список пунктов узла с секциями; порядок внутри секции — порядок в меню. */
export function collectNodeActions(node: MetadataNode, ctx: NodeMenuContext): NodeMenuAction[] {
  const ctxValue = node.contextValue ?? '';
  const actions: NodeMenuAction[] = [];
  const add: AddAction = (section, command, title, icon) => {
    if (!actions.some((a) => a.command === command)) {actions.push({ command, title, icon, section });}
  };
  const isRoot = Boolean(node.xmlPath) && ROOT_WITH_XML.test(ctxValue);

  addOpenActions(node, isRoot, add);
  addEditActions(node, ctxValue, ctx, add);

  if (isRoot) {
    add('db', 'onecdev.importConfigurationFromDb', 'Импортировать из базы', codicon('cloud-download'));
    add('db', 'onecdev.updateConfigurationInDb', 'Обновить в базе', codicon('sync'));
    add('file', 'onecdev.dumpConfigurationToCf', 'Выгрузить в файл', codicon('package'));
    add('file', 'onecdev.loadConfigurationFromCf', 'Загрузить из файла', codicon('folder-opened'));
  }
  if (ctxValue.startsWith('extension-hasXml')) {
    add('db', 'onecdev.compileAndUpdateExtensionInDb', 'Полное обновление расширения в БД', codicon('cloud-upload'));
  }
  if (ctxValue.startsWith('extensions-root')) {
    // Пакетные операции работают со ВСЕЙ базой, поэтому их место — узел-контейнер
    // расширений, а не корень конфигурации и не конкретное расширение.
    add('file', 'onecdev.dumpAllExtensionsToCfe', 'Выгрузить все расширения в файлы', codicon('archive'));
    add('file', 'onecdev.loadAllExtensionsFromCfe', 'Загрузить все расширения из файлов', codicon('cloud-upload'));
  }

  addRepositoryActions(node, ctxValue, isRoot, add);
  addCheckActions(node, ctxValue, isRoot, add);
  return actions;
}

/** Готовое дерево меню узла по `NODE_MENU_LAYOUT`. */
export function buildNodeMenu(node: MetadataNode, ctx: NodeMenuContext): NodeMenuItemDto[] {
  const actions = collectNodeActions(node, ctx);
  const itemsOf = (section: NodeMenuSection, group: string): NodeMenuItemDto[] =>
    actions
      .filter((action) => action.section === section)
      .map((action) => ({ id: action.command, label: action.title, command: action.command, icon: action.icon, group }));

  const menu: NodeMenuItemDto[] = [];
  for (const entry of NODE_MENU_LAYOUT) {
    if ('section' in entry) {
      menu.push(...itemsOf(entry.section, entry.group));
      continue;
    }
    const { key, label, icon, sections } = entry.submenu;
    const children = sections.flatMap((section) => itemsOf(section, section));
    if (children.length > 0) {
      menu.push({ id: `submenu:${key}`, label, command: '', icon: codicon(icon), group: entry.group, children });
    }
  }
  return menu;
}

function addOpenActions(node: MetadataNode, isRoot: boolean, add: AddAction): void {
  if (!node.xmlPath) {return;}
  if (isRoot) {
    addPropertiesAction(node, 'open', add);
  }
  const def = (META_TYPES as Record<string, { modules?: readonly string[] } | undefined>)[node.nodeKind];
  for (const slot of def?.modules ?? []) {
    const action = MODULE_SLOT_ACTIONS[slot];
    if (action) {add('open', action.command, action.title, action.icon);}
  }
  add('open', 'onecdev.openXmlFile', 'Открыть XML', codicon('file-code'));
  if (node.command?.command) {
    add('open', node.command.command, node.command.title, codicon('code'));
  }
}

function addPropertiesAction(node: MetadataNode, section: 'open' | 'check', add: AddAction): void {
  if (!node.hidePropertiesCommand) {
    add(section, 'onecdev.showProperties', 'Свойства', codicon('list-unordered'));
  }
}

function addEditActions(node: MetadataNode, ctxValue: string, ctx: NodeMenuContext, add: AddAction): void {
  if (node.addMetadataTarget) {
    add('edit', 'onecdev.addMetadata', 'Добавить', codicon('add'));
  }
  if (ctxValue.startsWith('extensions-root')) {
    add('edit', 'onecdev.connectExtension', 'Подключить расширение', codicon('plug'));
  }
  if (node.xmlPath) {
    if (node.nodeKind !== 'Form' && node.nodeKind !== 'CommonForm' && canAddForm(node)) {
      add('edit', 'onecdev.form.add', 'Добавить форму', codicon('window'));
    }
    if (canAddHelp(node)) {
      add('edit', 'onecdev.help.add', 'Добавить справку', codicon('book'));
    }
    if (node.nodeKind === 'DataProcessor' || node.nodeKind === 'Report') {
      add('edit', 'onecdev.epf.bspInit', 'БСП: регистрация', codicon('symbol-key'));
      add('edit', 'onecdev.epf.bspAddCommand', 'БСП: добавить команду', codicon('add'));
    }
  }
  if (canBorrow(node, ctxValue, ctx)) {
    add('edit', 'onecdev.borrowToExtension', 'Добавить в расширение', codicon('add'));
  }
  if (canAddCfeInterceptor(node, ctxValue)) {
    add('edit', 'onecdev.cfe.addMethodInterceptor', 'Добавить перехватчик', codicon('symbol-method'));
  }
  if (node.canRemoveMetadata) {
    add('edit', 'onecdev.removeMetadata', 'Удалить', codicon('trash'));
  }
}

function addRepositoryActions(node: MetadataNode, ctxValue: string, isRoot: boolean, add: AddAction): void {
  if (ctxValue.includes('-repoUnlocked')) {
    add('repo.work', 'onecdev.repository.lock', 'Захватить', codicon('lock'));
  }
  if (ctxValue.includes('-repoLocked')) {
    add('repo.work', 'onecdev.repository.unlock', 'Освободить', codicon('unlock'));
  }
  const connected = ctxValue.includes('-repoConnected');
  if (connected && !/^(extensions-root|group-common|group-type)/.test(ctxValue)) {
    add('repo.work', 'onecdev.repository.commit', 'Поместить', codicon('cloud-upload'));
    add('repo.work', 'onecdev.repository.update', 'Получить', codicon('cloud-download'));
    add('repo.work', 'onecdev.repository.updateToVersion', 'Получить версию…', codicon('history'));
    if (!/^(configuration|extension)-/.test(ctxValue) && canShowRepositoryHistory(node)) {
      add('repo.work', 'onecdev.repository.objectHistory', 'История', codicon('history'));
    }
  }
  if (!isRoot) {return;}
  if (connected) {
    add('repo.work', 'onecdev.repository.fullUpdate', 'Обновить конфигурацию из хранилища', codicon('sync'));
    add('repo.work', 'onecdev.repository.refreshLocks', 'Обновить статусы захватов', codicon('refresh'));
    add('repo.work', 'onecdev.repository.history', 'История', codicon('history'));
    add('repo.admin', 'onecdev.repository.setLabel', 'Установить метку версии', codicon('tag'));
    add('repo.admin', 'onecdev.repository.report', 'Построить отчёт', codicon('graph'));
    add('repo.admin', 'onecdev.repository.dump', 'Выгрузить конфигурацию из хранилища', codicon('archive'));
    add('repo.users', 'onecdev.repository.addUser', 'Добавить пользователя', codicon('person-add'));
    add('repo.users', 'onecdev.repository.copyUsers', 'Скопировать пользователей', codicon('organization'));
    add('repo.connection', 'onecdev.repository.disconnect', 'Отключить от хранилища', codicon('debug-disconnect'));
    return;
  }
  if (ctxValue.includes('-repoDisconnected')) {
    add('repo.connection', 'onecdev.repository.connect', 'Подключить к хранилищу', codicon('plug'));
  }
  // Создавать хранилище имеет смысл только для конфигурации, ещё не подключённой ни к одному.
  add('repo.connection', 'onecdev.repository.create', 'Создать хранилище', codicon('database'));
}

function addCheckActions(node: MetadataNode, ctxValue: string, isRoot: boolean, add: AddAction): void {
  if (!node.xmlPath) {return;}
  if (isRoot) {
    add('check', 'onecdev.configuration.info', 'Информация', codicon('info'));
    add('check', 'onecdev.configuration.validate', 'Валидировать', codicon('check'));
  } else {
    add('check', 'onecdev.metadata.info', 'Структура объекта', codicon('info'));
    add('check', 'onecdev.metadata.validate', 'Валидировать объект', codicon('check'));
  }
  if (ctxValue.startsWith('extension-hasXml')) {
    add('check', 'onecdev.cfe.analyzeExtension', 'Анализ расширения', codicon('inspect'));
  }
  if (node.nodeKind === 'Role') {
    add('check', 'onecdev.role.info', 'Права роли', codicon('shield'));
    add('check', 'onecdev.role.validate', 'Валидировать роль', codicon('verified'));
  }
  if (node.nodeKind === 'Subsystem') {
    add('check', 'onecdev.subsystem.info', 'Информация о подсистеме', codicon('symbol-namespace'));
    add('check', 'onecdev.subsystem.validate', 'Валидировать подсистему', codicon('verified'));
    add('check', 'onecdev.interface.validate', 'Валидировать командный интерфейс', codicon('list-tree'));
  }
  if (node.nodeKind === 'Template' || node.nodeKind === 'CommonTemplate') {
    add('check', 'onecdev.mxl.info', 'MXL: структура', codicon('table'));
    add('check', 'onecdev.mxl.validate', 'MXL: валидировать', codicon('check'));
    add('check', 'onecdev.skd.info', 'СКД: структура', codicon('symbol-structure'));
    add('check', 'onecdev.skd.validate', 'СКД: валидировать', codicon('verified'));
  }
  if (node.nodeKind === 'Form' || node.nodeKind === 'CommonForm') {
    add('check', 'onecdev.form.info', 'Форма: структура', codicon('symbol-structure'));
    add('check', 'onecdev.form.validate', 'Форма: валидировать', codicon('verified'));
  }
  if (!isRoot) {addPropertiesAction(node, 'check', add);}
}

function canAddHelp(node: MetadataNode): boolean {
  return !['configuration', 'extension', 'Role', 'Template', 'CommonTemplate'].includes(node.nodeKind);
}

function canAddForm(node: MetadataNode): boolean {
  return ['Document', 'Catalog', 'DataProcessor', 'Report', 'InformationRegister', 'AccumulationRegister', 'ChartOfAccounts', 'ChartOfCharacteristicTypes', 'ExchangePlan', 'BusinessProcess', 'Task'].includes(node.nodeKind);
}

function canBorrow(node: MetadataNode, ctxValue: string, ctx: NodeMenuContext): boolean {
  if (!node.xmlPath || /^(configuration|extension|extensions-root|group-)/.test(ctxValue)) {return false;}
  if (ctxValue.includes('-fromCfe') || ctxValue.includes('-repoEditRestricted')) {return false;}
  const entries = ctx.getEntries();
  return entries.some((e) => e.kind === 'cfe') && isMainConf(node.metaContext?.ownerObjectXmlPath ?? node.xmlPath, entries);
}

function canAddCfeInterceptor(node: MetadataNode, ctxValue: string): boolean {
  if (!node.xmlPath || ctxValue.includes('-repoEditRestricted') || !ctxValue.includes('-fromCfe')) {
    return false;
  }
  if (node.nodeKind === 'Form') {
    return true;
  }
  const def = (META_TYPES as Record<string, { modules?: readonly string[] } | undefined>)[node.nodeKind];
  return Boolean(def?.modules?.length);
}

/** Узел из основной конфигурации: ближайший охватывающий корень реестра — `cf`. */
function isMainConf(src: string, entries: readonly ConfigEntry[]): boolean {
  const entry = entries
    .filter((e) => isInside(src, e.rootPath))
    .sort((a, b) => b.rootPath.length - a.rootPath.length)
    .at(0);
  return entry?.kind === 'cf';
}

function isInside(filePath: string, rootPath: string): boolean {
  const rel = path.relative(path.resolve(rootPath), path.resolve(filePath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function codicon(name: string): MenuIconDto {
  return { kind: 'codicon', name };
}
