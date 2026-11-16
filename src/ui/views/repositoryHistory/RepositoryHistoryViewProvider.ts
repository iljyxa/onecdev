import * as path from 'path';
import * as vscode from 'vscode';
import type { RepositoryHistoryScope, RepositoryHistoryService } from '../../../infra/repository/history/RepositoryHistoryService';
import { buildRepositoryHistoryViewDto } from '../../../infra/repository/history/RepositoryHistoryView';
import { WebviewHtmlFactory } from '../webview/WebviewHtmlFactory';
import { parseRepositoryHistoryUiMessage, type RepositoryHistoryUiCommand } from './repositoryHistoryMessages';

export type RepositoryHistoryPanelService = Pick<RepositoryHistoryService, 'view' | 'onDidChange' | 'setScope' | 'refresh' | 'loadMore' | 'ensureLoaded'>;

export type ExecuteCommand = (command: string, ...args: unknown[]) => Thenable<unknown>;

const PANEL_TITLE = 'История хранилища';

function panelTitle(scope: RepositoryHistoryScope): string {
  const filter = scope.filter === undefined ? '' : ` — ${scope.filter.title}`;
  return `${PANEL_TITLE}: ${scope.target.displayName}${filter}`;
}

/**
 * Панель «История хранилища» в области редактора — одна на окно: повторное открытие меняет область
 * и показывает ту же панель. Состояние живёт в сервисе, панель только пересылает готовый DTO
 * (`buildRepositoryHistoryViewDto`): при каждом изменении сервиса и по `ready` после пересоздания
 * webview (`retainContextWhenHidden: false` — скрытая панель не держит память).
 */
export class RepositoryHistoryViewProvider implements vscode.Disposable {
  static readonly viewType = 'onecdevRepositoryHistoryPanel';

  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: RepositoryHistoryPanelService,
    private readonly executeCommand: ExecuteCommand = vscode.commands.executeCommand,
  ) {}

  /** Открывает панель на области; загрузка — только если данных по ней ещё нет (ensureLoaded). */
  show(scope: RepositoryHistoryScope): void {
    // Область — до HTML: начальное состояние новой панели уже по ней, без мигания прежней.
    this.service.setScope(scope);
    if (this.panel) {
      this.panel.title = panelTitle(scope);
      this.panel.reveal(vscode.ViewColumn.Active);
    } else {
      this.panel = this.createPanel(panelTitle(scope));
    }
    void this.service.ensureLoaded();
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private createPanel(title: string): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(RepositoryHistoryViewProvider.viewType, title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
    });
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'ui')],
    };
    panel.webview.html = new WebviewHtmlFactory(this.extensionUri).renderVueWebviewHtml({
      webview: panel.webview,
      title: PANEL_TITLE,
      entry: 'repository-history',
      viewKind: 'repository-history',
      initialState: buildRepositoryHistoryViewDto(this.service.view),
      csp: { allowStyles: true },
    });
    const subscription = this.service.onDidChange(() => this.postState(panel));
    const messages = panel.webview.onDidReceiveMessage((raw: unknown) => this.handleMessage(panel, parseRepositoryHistoryUiMessage(raw)));
    panel.onDidDispose(() => {
      subscription.dispose();
      messages.dispose();
      this.panel = undefined;
      // Закрытая панель не держит загрузку: область сброшена — идущий запрос отменён.
      this.service.setScope(undefined);
    });
    return panel;
  }

  private postState(panel: vscode.WebviewPanel): void {
    void panel.webview.postMessage({ type: 'state', state: buildRepositoryHistoryViewDto(this.service.view) });
  }

  private handleMessage(panel: vscode.WebviewPanel, command: RepositoryHistoryUiCommand | undefined): void {
    switch (command) {
      case 'ready':
        this.postState(panel);
        return;
      case 'refresh':
        void this.service.refresh();
        return;
      case 'loadMore':
        void this.service.loadMore();
        return;
      case 'clearFilter':
      case 'exportReport':
        this.handleScopeCommand(command);
        return;
      default:
        return;
    }
  }

  /** Команды от области: если её сбросили извне (сервис общий), делать нечего. */
  private handleScopeCommand(command: 'clearFilter' | 'exportReport'): void {
    const scope = this.service.view.scope;
    if (scope === undefined) {
      return;
    }
    if (command === 'exportReport') {
      // Отчёт Конфигуратора — выход для файлового хранилища и слишком большой истории; команда
      // принимает корень цели так же, как из контекстного меню (nodeKind + Configuration.xml).
      const target = scope.target;
      void this.executeCommand('onecdev.repository.report', {
        nodeKind: target.configKind === 'cf' ? 'configuration' : 'extension',
        xmlPath: path.join(target.configRoot, 'Configuration.xml'),
      });
      return;
    }
    if (scope.filter !== undefined) {
      this.show({ target: scope.target });
    }
  }
}
