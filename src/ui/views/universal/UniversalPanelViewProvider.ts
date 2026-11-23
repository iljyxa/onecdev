import * as vscode from 'vscode';
import type {
  GitMetadataStatusService,
  MetadataGitDecorationStatus,
  MetadataGitDecorationTarget,
} from '../../../infra/git/GitMetadataStatusService';
import type { StandaloneServerStatus } from '../../../infra/standalone';
import { buildNodeMenu, type NodeMenuItemDto } from './nodeContextMenu';
import { getIconUris } from '../../tree/presentation/icon';
import { WebviewHtmlFactory } from '../webview/WebviewHtmlFactory';
import { resolveWebviewLocalResourceRoots } from '../webview/webviewResourceRoots';
import { isWebviewCommandAllowed } from '../webview/webviewCommandGuard';
import type { MetadataTreeProvider } from '../../tree/MetadataTreeProvider';
import type { MetadataNode } from '../../tree/TreeNode';
import { supportIndicatorOf, supportModeDtoOf, type SupportModeDto } from '../../support/supportLockReason';
import { formatRepositoryLockTitle } from '../../tree/repositoryLockTitle';
import type { RepositoryLockInfo } from '../../../infra/repository/RepositoryLockState';

/** Пара SVG `src/icons/{light,dark}/<имя>.svg`: замок с человеком — объект захвачен другим. */
export const REPOSITORY_FOREIGN_LOCK_ICON = 'repo-locked-foreign';

// ── DTO-типы (зеркалят src-ui/shared/types) ──

interface IconDto {
  readonly kind: 'codicon' | 'metadata' | 'asset' | 'none';
  readonly name?: string;
  readonly lightUri?: string;
  readonly darkUri?: string;
}

type TreeNodeActionDto = NodeMenuItemDto;

interface TreeNodeStateIconDto {
  readonly title: string;
  readonly icon: IconDto;
}

interface TreeNodeDto {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: IconDto;
  readonly kind?: string;
  readonly ownership?: 'own' | 'borrowed' | 'unknown';
  readonly supportMode?: SupportModeDto;
  readonly hasChildren: boolean;
  readonly loaded: boolean;
  readonly children?: TreeNodeDto[];
  readonly actions: TreeNodeActionDto[];
  readonly inlineActions?: TreeNodeActionDto[];
  readonly stateIcons?: TreeNodeStateIconDto[];
  readonly gitStatus?: 'added' | 'modified' | 'deleted';
}

interface UniversalPanelState {
  readonly initialized: boolean;
  readonly processing: boolean;
  readonly processingTitle?: string;
  readonly processingMessage?: string;
  readonly searchQuery: string;
  readonly openNodeIds: readonly string[];
  readonly selectedNodeId?: string;
  readonly rootNodes: readonly TreeNodeDto[];
  readonly standaloneStatus: {
    readonly configured: boolean;
    readonly state: string;
    readonly port?: number;
    readonly pid?: number;
    readonly name?: string;
  };
}

interface UniversalPanelServices {
  readonly state: vscode.Memento;
  readonly treeProvider: MetadataTreeProvider;
  readonly setTreeMessage: (message: string | undefined) => void;
  readonly isProjectInitialized: () => boolean;
  readonly getStandaloneServerStatus: () => StandaloneServerStatus;
  readonly refreshStandaloneServerStatus: () => Promise<StandaloneServerStatus>;
  readonly getProcessingState: () => UniversalPanelProcessingState;
  readonly gitMetadataStatusService: GitMetadataStatusService;
  readonly refreshActionsView: () => void;
  readonly log?: (message: string) => void;
}

export interface UniversalPanelProcessingState {
  readonly active: boolean;
  readonly title?: string;
  readonly message?: string;
}

// ── Сообщения от webview (формат MessageBus / UiToHostMessage) ──

interface WebviewMessage {
  readonly type: 'ready' | 'refresh' | 'command' | 'request';
  readonly command?: string;
  readonly requestId?: string;
  readonly name?: string;
  readonly payload?: unknown;
}

// ── Встроенные (inline) действия узла ──

interface TreeAction {
  readonly command: string;
  readonly title: string;
  readonly icon: IconDto;
}


const FALLBACK_HTML =
  '<!DOCTYPE html><html lang="ru"><body style="font-family:var(--vscode-font-family);padding:12px">' +
  'Не удалось загрузить панель. Подробности — в выводе «1С Редактор».</body></html>';

const CHILDREN_CHUNK_SIZE = 40;
const PASSIVE_NODE_ACTIONS = new Set<string>([
  'onecdev.showProperties',
  'onecdev.openXmlFile',
  'onecdev.openObjectModule',
  'onecdev.openManagerModule',
  'onecdev.openConstantModule',
  'onecdev.openRecordSetModule',
  'onecdev.openServiceModule',
  'onecdev.openCommonModuleCode',
  'onecdev.openCommandModule',
  'onecdev.openFormModule',
]);

/**
 * Универсальная панель — основной навигатор метаданных на Vue.
 * Генерирует HTML через renderVueWebviewHtml, передаёт состояние дерева как TreeNodeDto[].
 */
export class UniversalPanelViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'onecdevUniversal';
  private static readonly selectedNodeStateKey = 'onecdev.universalPanel.selectedNodeKey';

  private view: vscode.WebviewView | undefined;
  private readonly nodeById = new Map<string, MetadataNode>();
  private readonly nodeKeyById = new Map<string, string>();
  private readonly openNodeKeys = new Set<string>();
  private readonly treeListener: vscode.Disposable;
  private viewDisposables: vscode.Disposable[] = [];
  /** Кэш зарегистрированных команд для guard'а webview (S2); команды расширения стабильны после активации. */
  private registeredCommandsCache: readonly string[] | undefined;
  private selectedNodeKey: string | undefined;
  private cachedRootNodes: TreeNodeDto[] = [];
  private currentOpenNodeIds = new Set<string>();
  private currentSelectedNodeId: string | undefined;
  // Webview прислал 'ready' (Vue примонтировался). На медленном холодном старте
  // (Windows) первый рендер при восстановлении вью мог не успеть смонтироваться —
  // тогда панель остаётся пустой. Этот флаг + healTimer перерисовывают её сами.
  private ready = false;
  private healAttempts = 0;
  private healTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly services: UniversalPanelServices
  ) {
    this.selectedNodeKey = services.state.get<string>(UniversalPanelViewProvider.selectedNodeStateKey);
    this.treeListener = this.services.treeProvider.onDidChangeTreeData(() => {
      this.refresh();
    });
  }

  // ── WebviewViewProvider ──

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    // View может пересоздаваться (сворачивание/разворачивание контейнера),
    // поэтому освобождаем подписки прошлого экземпляра, чтобы они не накапливались.
    this.disposeViewSubscriptions();
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: resolveWebviewLocalResourceRoots(this.extensionUri, { includeIcons: true }),
    };

    this.renderHtml();
    this.viewDisposables.push(
      webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void this.handleMessage(message);
      }),
      webviewView.onDidChangeVisibility(() => {
        // Перерисовываем при показе только если вью так и не сообщила о готовности
        // (пустая панель после неудачного восстановления), не сбрасывая рабочее состояние.
        if (webviewView.visible && !this.ready) {
          this.renderHtml();
        }
      }),
      webviewView.onDidDispose(() => {
        this.view = undefined;
        this.clearHealTimer();
        this.disposeViewSubscriptions();
      })
    );
  }

  /** Ставит HTML и запускает контроль готовности webview. */
  private renderHtml(): void {
    if (!this.view) {return;}
    this.ready = false;
    this.healAttempts = 0;
    try {
      this.view.webview.html = this.buildHtml(this.view.webview);
    } catch (error) {
      // resolveWebviewView не должен бросать — иначе VS Code заменит вью
      // плейсхолдером «Ошибка при восстановлении представления».
      this.logError('Не удалось построить HTML панели', error);
      this.view.webview.html = FALLBACK_HTML;
      return;
    }
    this.scheduleHealCheck();
  }

  /**
   * Если webview не пришлёт 'ready' за отведённое время, повторно ставим HTML.
   * Покрывает гонку восстановления вью на медленном старте, когда первый рендер
   * не смонтировался и панель осталась пустой.
   */
  private scheduleHealCheck(): void {
    this.clearHealTimer();
    this.healTimer = setTimeout(() => {
      this.healTimer = undefined;
      if (this.ready || !this.view || this.healAttempts >= 2) {return;}
      this.healAttempts += 1;
      this.view.webview.html = this.buildHtml(this.view.webview);
      this.scheduleHealCheck();
    }, 2500);
  }

  private clearHealTimer(): void {
    if (this.healTimer) {
      clearTimeout(this.healTimer);
      this.healTimer = undefined;
    }
  }

  private disposeViewSubscriptions(): void {
    for (const disposable of this.viewDisposables) {
      disposable.dispose();
    }
    this.viewDisposables = [];
  }

  refresh(): void {
    if (this.view) {
      this.postState();
    }
  }

  dispose(): void {
    this.treeListener.dispose();
    this.clearHealTimer();
    this.disposeViewSubscriptions();
  }

  // ── HTML (Vue) ──

  private buildHtml(webview: vscode.Webview): string {
    const factory = new WebviewHtmlFactory(this.extensionUri);
    return factory.renderVueWebviewHtml({
      webview,
      title: 'Метаданные',
      entry: 'universal',
      viewKind: 'universal',
      initialState: this.buildInitialState(),
      csp: { allowStyles: true, allowImages: true },
    });
  }

  private buildInitialState(): UniversalPanelState {
    this.nodeById.clear();
    this.nodeKeyById.clear();
    this.cachedRootNodes = this.buildRootNodes();
    const processingState = this.services.getProcessingState();
    return {
      initialized: this.services.isProjectInitialized(),
      processing: processingState.active,
      processingTitle: processingState.title,
      processingMessage: processingState.message,
      searchQuery: this.services.treeProvider.getSearchQuery(),
      openNodeIds: [...this.currentOpenNodeIds],
      selectedNodeId: this.currentSelectedNodeId,
      rootNodes: this.cachedRootNodes,
      standaloneStatus: this.toStatusDto(this.services.getStandaloneServerStatus()),
    };
  }

  private postState(): void {
    if (!this.view) {return;}
    this.cachedRootNodes = this.buildRootNodes();
    const processingState = this.services.getProcessingState();
    void this.view.webview.postMessage({
      type: 'state',
      state: {
        initialized: this.services.isProjectInitialized(),
        processing: processingState.active,
        processingTitle: processingState.title,
        processingMessage: processingState.message,
        searchQuery: this.services.treeProvider.getSearchQuery(),
        openNodeIds: [...this.currentOpenNodeIds],
        selectedNodeId: this.currentSelectedNodeId,
        rootNodes: this.cachedRootNodes,
        standaloneStatus: this.toStatusDto(this.services.getStandaloneServerStatus()),
      },
    });
  }

  // ── Сообщения от webview ──

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    if (msg.type === 'ready') {
      this.ready = true;
      this.clearHealTimer();
      return;
    }

    if (this.services.getProcessingState().active) {return;}

    if (msg.type === 'command') {
      await this.handleCommand(msg.command ?? '', msg.payload);
      return;
    }

    if (msg.type === 'request') {
      await this.handleRequest(msg.name ?? '', msg.requestId ?? '', msg.payload);
    }
  }

  private async handleCommand(command: string, payload?: unknown): Promise<void> {
    const p = payload as { nodeId?: string; actionId?: string } | undefined;

    // Выбор узла
    if (command === 'selectNode' && p?.nodeId) {
      await this.selectNode(p.nodeId);
      return;
    }

    if (command === 'nodeDefault' && p?.nodeId) {
      await this.executeNodeDefault(p.nodeId);
      return;
    }

    if (command === 'toggleNode' && p?.nodeId) {
      this.rememberNodeState(p.nodeId, Boolean((payload as { open?: boolean } | undefined)?.open));
      return;
    }

    // Действие узла (контекстное меню / inline-кнопка)
    if (command === 'executeNodeAction' && p?.nodeId && p.actionId) {
      const node = this.nodeById.get(p.nodeId);
      if (node) {
        await this.executeCommand(p.actionId, node);
        if (!PASSIVE_NODE_ACTIONS.has(p.actionId)) {
          this.services.refreshActionsView();
        }
      }
      return;
    }

    // Остальные команды — через единый guarded-gateway (S2)
    const node = p?.nodeId ? this.nodeById.get(p.nodeId) : undefined;
    await this.executeCommand(command, node);
  }

  private async handleRequest(name: string, _requestId: string, payload?: unknown): Promise<void> {
    const p = payload as { nodeId?: string; query?: string } | undefined;

    if (name === 'loadChildren' && p?.nodeId) {
      await this.loadChildren(p.nodeId);
      return;
    }

    if (name === 'search') {
      const query = typeof payload === 'string' ? payload : (p?.query ?? '');
      this.applySearch(query);
      this.postState();
      return;
    }

    if (name === 'refreshStandaloneStatus') {
      const status = await this.services.refreshStandaloneServerStatus();
      await this.postStandaloneStatus(status);
    }
  }

  private async postStandaloneStatus(status = this.services.getStandaloneServerStatus()): Promise<void> {
    await this.view?.webview.postMessage({
      type: 'standaloneStatus',
      status: this.toStatusDto(status),
    });
  }

  // ── Построение дерева ──

  private buildRootNodes(): TreeNodeDto[] {
    this.nodeById.clear();
    this.nodeKeyById.clear();
    this.currentOpenNodeIds = new Set<string>();
    this.currentSelectedNodeId = undefined;
    let roots: MetadataNode[];
    try {
      roots = this.services.treeProvider.getChildren();
    } catch (error) {
      this.logError('Не удалось получить корневые узлы дерева', error);
      return [];
    }
    return roots.flatMap((node, i) => {
      try {
        return [this.toDto(node, 0, `n${String(i)}`, '')];
      } catch (error) {
        // Сбой одного корня не должен ронять весь resolveWebviewView (иначе VS Code
        // показывает плейсхолдер «Ошибка при восстановлении представления»).
        this.logError(`Не удалось построить узел дерева: ${node.textLabel}`, error);
        return [];
      }
    });
  }

  private logError(message: string, error: unknown): void {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    this.services.log?.(`[universal] ${message}: ${detail}`);
  }

  private toDto(node: MetadataNode, depth: number, id: string, parentKey: string): TreeNodeDto {
    this.services.treeProvider.getTreeItem(node);
    const nodeKey = this.buildNodeKey(node, parentKey);
    this.nodeById.set(id, node);
    this.nodeKeyById.set(id, nodeKey);

    const hasChildren = Boolean(node.childrenLoader);
    const ctxValue = node.contextValue ?? '';
    const open = this.openNodeKeys.has(nodeKey) || this.isSelectedAncestor(nodeKey);
    const selected = this.selectedNodeKey === nodeKey;
    if (open) {
      this.currentOpenNodeIds.add(id);
    }
    if (selected) {
      this.currentSelectedNodeId = id;
    }

    // Дети загружаем сразу, если узел открыт (как в старом коде).
    // Сбой обхода (например, недоступный XML) не должен ронять весь рендер —
    // узел остаётся свёрнутым и подгрузится лениво.
    let children: TreeNodeDto[] | undefined;
    let loaded = false;
    if (open && hasChildren) {
      try {
        const raw = this.services.treeProvider.getChildren(node);
        children = raw.map((child, i) => this.toDto(child, depth + 1, `${id}_${String(i)}`, nodeKey));
        loaded = true;
      } catch (error) {
        this.logError(`Не удалось загрузить дочерние узлы: ${node.textLabel}`, error);
        children = undefined;
        loaded = false;
      }
    }

    return {
      id,
      key: nodeKey,
      label: node.textLabel,
      description: this.nodeDescription(node),
      icon: this.buildIcon(node),
      kind: node.nodeKind,
      ownership: this.ownership(node),
      supportMode: supportModeDtoOf(ctxValue),
      hasChildren,
      loaded,
      children,
      actions: this.buildActions(node),
      inlineActions: this.buildInlineActions(node),
      stateIcons: this.buildStateIcons(node),
      gitStatus: this.resolveGitStatus(node),
    };
  }

  private nodeDescription(node: MetadataNode): string | undefined {
    if (node.ownershipTag) {
      return undefined;
    }
    return typeof node.description === 'string' ? node.description : undefined;
  }

  private buildIcon(node: MetadataNode): IconDto {
    try {
      const iconUris = getIconUris(node.nodeKind, node.ownershipTag, this.extensionUri);
      const lightUri = this.view?.webview.asWebviewUri(iconUris.light).toString();
      const darkUri = this.view?.webview.asWebviewUri(iconUris.dark).toString();
      if (!lightUri || !darkUri) {
        return { kind: 'none' };
      }
      return { kind: 'asset', lightUri, darkUri };
    } catch {
      return { kind: 'none' };
    }
  }

  private ownership(node: MetadataNode): 'own' | 'borrowed' | 'unknown' {
    if (node.ownershipTag === 'OWN') {return 'own';}
    if (node.ownershipTag === 'BORROWED') {return 'borrowed';}
    return 'unknown';
  }

  /** Меню узла с группами и подменю — раскладка в `nodeContextMenu.ts` (#187). */
  private buildActions(node: MetadataNode): TreeNodeActionDto[] {
    return buildNodeMenu(node, { getEntries: () => this.services.treeProvider.getEntries() });
  }

  private buildInlineActions(node: MetadataNode): TreeNodeActionDto[] {
    const contextValue = node.contextValue ?? '';
    const actions: TreeAction[] = [];
    if (contextValue.startsWith('extensions-root')) {
      actions.push({ command: 'onecdev.connectExtension', title: 'Подключить расширение', icon: codicon('plug') });
    }
    if (node.addMetadataTarget) {
      actions.push({ command: 'onecdev.addMetadata', title: 'Добавить', icon: codicon('add') });
    }
    return actions.map((action) => ({
      id: action.command,
      label: action.title,
      command: action.command,
      icon: action.icon,
    }));
  }

  private buildStateIcons(node: MetadataNode): TreeNodeStateIconDto[] {
    const contextValue = node.contextValue ?? '';
    const result: TreeNodeStateIconDto[] = [];
    const supportIndicator = supportIndicatorOf(contextValue);
    if (supportIndicator) {
      result.push(this.themeStateIcon(supportIndicator.icon, supportIndicator.title));
    }

    // Замок отвечает на вопрос «могу ли я править здесь»: открыт только при своём захвате.
    // Запрет правки (`-repoEditRestricted`) отдельной иконкой не дублируется — его и
    // обозначает закрытый замок; суффикс нужен только меню (заимствование, перехватчик).
    const lock = node.repositoryLock;
    if (lock) {
      result.push(this.repositoryLockStateIcon(lock));
    } else if (contextValue.includes('-repoConnected') && (node.nodeKind === 'configuration' || node.nodeKind === 'extension')) {
      result.push({ title: 'Подключено к хранилищу', icon: codicon('database') });
    }

    return result;
  }

  private repositoryLockStateIcon(lock: RepositoryLockInfo): TreeNodeStateIconDto {
    const title = formatRepositoryLockTitle(lock);
    switch (lock.state) {
      case 'own':
        return { title, icon: codicon('unlock') };
      case 'foreign':
        // В codicon нет замка с человеком: «захвачено другим» — своя пара SVG по темам.
        return this.themeStateIcon(REPOSITORY_FOREIGN_LOCK_ICON, title);
      case 'free':
      case 'own-elsewhere':
        return { title, icon: codicon('lock') };
    }
  }

  private themeStateIcon(name: string, title: string): TreeNodeStateIconDto {
    const lightUri = this.view?.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'icons', 'light', `${name}.svg`)
    ).toString();
    const darkUri = this.view?.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'icons', 'dark', `${name}.svg`)
    ).toString();
    if (!lightUri || !darkUri) {
      return { title, icon: { kind: 'none' } };
    }
    return { title, icon: { kind: 'asset', lightUri, darkUri } };
  }

  private buildNodeKey(node: MetadataNode, parentKey: string): string {
    const ctx = node.metaContext;
    const segment = [
      node.nodeKind,
      node.textLabel,
      node.xmlPath ?? '',
      node.model.decorationPath ?? '',
      ctx?.ownerObjectXmlPath ?? '',
      ctx?.tabularSectionName ?? '',
      node.ownershipTag ?? '',
    ].map((p) => encodeURIComponent(p)).join('~');
    return parentKey ? `${parentKey}/${segment}` : segment;
  }

  // ── Загрузка детей (ленивая — если не загружены при начальном рендере) ──

  private async loadChildren(nodeId: string): Promise<void> {
    const node = this.nodeById.get(nodeId);
    if (!node || !this.view) {return;}

    this.rememberNodeState(nodeId, true);
    const raw = this.services.treeProvider.getChildren(node);
    const depth = this.nodeDepth(nodeId);
    const parentKey = this.nodeKeyById.get(nodeId) ?? '';
    if (raw.length === 0) {
      await this.view.webview.postMessage({
        type: 'childrenLoaded',
        nodeId,
        children: [],
        append: false,
        done: true,
      });
      return;
    }

    for (let offset = 0; offset < raw.length; offset += CHILDREN_CHUNK_SIZE) {
      const chunk = raw
        .slice(offset, offset + CHILDREN_CHUNK_SIZE)
        .map((child, index) => this.toDto(child, depth + 1, `${nodeId}_${String(offset + index)}`, parentKey));
      await this.view.webview.postMessage({
        type: 'childrenLoaded',
        nodeId,
        children: chunk,
        append: offset > 0,
        done: offset + CHILDREN_CHUNK_SIZE >= raw.length,
      });
      if (offset + CHILDREN_CHUNK_SIZE < raw.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  // ── Выбор узла ──

  private async selectNode(nodeId: string): Promise<void> {
    const nodeKey = this.nodeKeyById.get(nodeId);
    if (!nodeKey) {return;}

    this.selectedNodeKey = nodeKey;
    this.openSelectedAncestors(nodeKey);
    void this.services.state
      .update(UniversalPanelViewProvider.selectedNodeStateKey, nodeKey)
      .then(undefined, () => undefined);

    const node = this.nodeById.get(nodeId);
    if (!node) {return;}
    // Сначала показываем свойства — DynamicPanelController ставит окно приоритета,
    // и последующие программные события активного редактора не перебьют state.
    if (node.xmlPath && !node.hidePropertiesCommand) {
      await this.executeCommand('onecdev.showProperties', node);
    }
    if (node.command) {
      // Связанный документ (модуль/XML) открываем без перехвата фокуса:
      // курсор остаётся в боковой панели, свойства видны, а при клике в редактор
      // пользователем — динамическая панель переключится на структуру модуля.
      await this.executeCommand(node.command.command, node, { preserveFocus: true });
    }
  }

  private async executeNodeDefault(nodeId: string): Promise<void> {
    const node = this.nodeById.get(nodeId);
    if (!node?.xmlPath) {
      return;
    }
    // Двойной клик по подсистеме открывает полноценный редактор (состав, дочерние подсистемы).
    if (node.nodeKind === 'Subsystem') {
      await this.executeCommand('onecdev.openSubsystemEditor', node);
      return;
    }
    await this.executeCommand('onecdev.showProperties', node);
  }

  private async executeCommand(command: string, node?: MetadataNode, options?: Record<string, unknown>): Promise<void> {
    if (!(await this.isWebviewCommandAllowed(command))) {
      this.services.log?.(`[webview][guard] Отклонена команда из webview: ${command}`);
      return;
    }
    try {
      if (node) {
        if (options !== undefined) {
          await vscode.commands.executeCommand(command, node, options);
        } else {
          await vscode.commands.executeCommand(command, node);
        }
      } else {
        await vscode.commands.executeCommand(command);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`Команда не выполнена: ${text}`);
    }
  }

  /**
   * Проверяет, что инициированная из webview команда допустима (S2): только
   * зарегистрированные команды расширения `onecdev.*`. Список команд
   * кэшируется — команды расширения регистрируются при активации и стабильны.
   */
  private async isWebviewCommandAllowed(command: string): Promise<boolean> {
    this.registeredCommandsCache ??= await vscode.commands.getCommands(true);
    return isWebviewCommandAllowed(command, this.registeredCommandsCache);
  }

  private rememberNodeState(nodeId: string, open: boolean): void {
    const nodeKey = this.nodeKeyById.get(nodeId);
    if (!nodeKey) {return;}
    if (open) {
      this.openNodeKeys.add(nodeKey);
    } else {
      this.openNodeKeys.delete(nodeKey);
      for (const k of [...this.openNodeKeys]) {
        if (k.startsWith(`${nodeKey}/`)) {this.openNodeKeys.delete(k);}
      }
    }
  }

  private openSelectedAncestors(nodeKey: string): void {
    const parts = nodeKey.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      this.openNodeKeys.add(parts.slice(0, i).join('/'));
    }
  }

  private isSelectedAncestor(nodeKey: string): boolean {
    return Boolean(this.selectedNodeKey?.startsWith(`${nodeKey}/`));
  }

  private nodeDepth(nodeId: string): number {
    return nodeId.split('_').length - 1;
  }

  // ── Поиск ──

  private applySearch(value: string): void {
    const query = value.trim();
    this.services.treeProvider.setSearchQuery(query);
    const hasSearch = query.length > 2;
    void vscode.commands.executeCommand('setContext', 'onecdev.hasTreeSearch', hasSearch);
    this.services.setTreeMessage(hasSearch ? `Поиск: ${query}` : undefined);
    this.services.refreshActionsView();
  }

  // ── Статус автономного сервера ──

  private toStatusDto(status: StandaloneServerStatus): UniversalPanelState['standaloneStatus'] {
    return {
      configured: status.configured,
      state: status.state,
      port: status.settings.httpPort,
      pid: status.pid ?? undefined,
      name: status.settings.name,
    };
  }

  private resolveGitStatus(node: MetadataNode): MetadataGitDecorationStatus | undefined {
    const target = this.resolveGitTarget(node);
    return target ? this.services.gitMetadataStatusService.getStatus(target) : undefined;
  }

  private resolveGitTarget(node: MetadataNode): MetadataGitDecorationTarget | undefined {
    if (node.model.gitDecorationTarget) {
      return node.model.gitDecorationTarget;
    }

    const resourcePath = node.model.decorationPath ?? node.xmlPath;
    if (!resourcePath) {
      return undefined;
    }

    return {
      kind: 'paths',
      ownerXmlPath: resourcePath,
      childKind: node.nodeKind,
      paths: [resourcePath],
    };
  }
}

function codicon(name: string): IconDto {
  return { kind: 'codicon', name };
}
