import * as vscode from 'vscode';
import {
  describeRepositoryConnectionForm,
  type RepositoryConnectionMode,
  type RepositoryConnectionOptionValues,
} from '../../infra/repository/RepositoryConnectionOptions';
import { WebviewHtmlFactory } from './webview/WebviewHtmlFactory';

export type ConnectionMode = RepositoryConnectionMode;

export interface RepositoryBinding {
  readonly repoPath: string;
  readonly repoUser: string;
  /** Пароль в webview не передаётся — только признак того, что он уже задан. */
  readonly repoPasswordSet: boolean;
}

export interface RepositoryConnectionFormData extends RepositoryConnectionOptionValues {
  readonly repoPath: string;
  readonly repoUser: string;
  readonly repoPassword: string;
}

/** Исход отправки формы: успех закрывает форму, ошибка показывается в ней (issue #184). */
export type RepositoryConnectionSubmitOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export type RepositoryConnectionSubmitHandler<T> =
  (data: RepositoryConnectionFormData) => Promise<RepositoryConnectionSubmitOutcome<T>>;

type RepositoryConnectionMessage =
  | { readonly type: 'command'; readonly command: 'submit'; readonly payload: RepositoryConnectionFormData }
  | { readonly type: 'command'; readonly command: 'cancel' }
  | { readonly type: 'request'; readonly requestId: string; readonly name: 'browseRepoPath' };

interface PendingShow {
  readonly onSubmit: RepositoryConnectionSubmitHandler<unknown>;
  readonly resolve: (value: unknown) => void;
}

/**
 * Провайдер панели подключения/создания хранилища 1С (Vue-приложение `repository-connection`).
 *
 * Форма закрывается только успехом операции, «Отменой» или закрытием вкладки: данные формы
 * уходят в `onSubmit`, а его ошибка возвращается в форму с сохранёнными полями (issue #184).
 * Закрытие вкладки во время операции её не прерывает — `show()` разрешается исходом операции,
 * а ошибка, которую уже некуда показать, уходит уведомлением.
 */
export class RepositoryConnectionViewProvider implements vscode.Disposable {
  static readonly viewType = 'onecdevRepositoryConnectionPanel';

  private panel: vscode.WebviewPanel | undefined;
  private pending: PendingShow | undefined;
  private submitting = false;

  constructor(
    private readonly extensionUri: vscode.Uri
  ) {}

  /**
   * Показывает форму и ждёт её завершения.
   * Повторный вызов при открытой форме перерисовывает её под новый режим и цель, прежний вызов
   * получает `undefined`. Пока идёт операция (даже если вкладку уже закрыли), новая форма не
   * открывается: открытая только раскрывается, а вызов получает `undefined`.
   * @returns Значение успешного `onSubmit` или `undefined` при отмене.
   */
  show<T>(
    mode: ConnectionMode,
    target: string,
    initialBinding: RepositoryBinding | undefined,
    onSubmit: RepositoryConnectionSubmitHandler<T>
  ): Promise<T | undefined> {
    if (this.submitting) {
      this.panel?.reveal(vscode.ViewColumn.Active);
      return Promise.resolve(undefined);
    }
    this.settle(undefined);

    const title = mode === 'connect' ? 'Подключение к хранилищу' : 'Создание хранилища';
    let panel = this.panel;
    if (panel) {
      panel.title = title;
      panel.reveal(vscode.ViewColumn.Active);
    } else {
      panel = this.createPanel(title);
    }
    this.renderHtml(panel, title, { mode, target, initialBinding: initialBinding ?? null, form: describeRepositoryConnectionForm(mode) });

    return new Promise<T | undefined>((resolve) => {
      this.pending = {
        onSubmit,
        resolve: resolve as (value: unknown) => void,
      };
    });
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private createPanel(title: string): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      RepositoryConnectionViewProvider.viewType,
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false }
    );
    this.panel = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'ui')],
    };
    panel.webview.onDidReceiveMessage((message: RepositoryConnectionMessage) => {
      void this.handleMessage(message);
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      // Во время операции промис разрешит её исход: прерывать Конфигуратор закрытием вкладки нельзя.
      if (!this.submitting) {
        this.settle(undefined);
      }
    });
    return panel;
  }

  private renderHtml(panel: vscode.WebviewPanel, title: string, initialState: object): void {
    const factory = new WebviewHtmlFactory(this.extensionUri);
    panel.webview.html = factory.renderVueWebviewHtml({
      webview: panel.webview,
      title,
      entry: 'repository-connection',
      viewKind: 'repository-connection',
      initialState,
      csp: { allowStyles: true },
    });
  }

  private settle(value: unknown): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(value);
  }

  private async submit(data: RepositoryConnectionFormData): Promise<void> {
    const pending = this.pending;
    if (!pending || this.submitting) {
      return;
    }
    this.submitting = true;
    let outcome: RepositoryConnectionSubmitOutcome<unknown>;
    try {
      outcome = await pending.onSubmit(data);
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.submitting = false;
    }

    if (outcome.ok) {
      this.settle(outcome.value);
      this.panel?.dispose();
      return;
    }
    if (this.panel) {
      void this.panel.webview.postMessage({ type: 'error', message: outcome.error });
      return;
    }
    this.settle(undefined);
    void vscode.window.showErrorMessage(outcome.error);
  }

  private async handleMessage(message: RepositoryConnectionMessage): Promise<void> {
    switch (message.type) {
      case 'command':
        // Сообщение приходит из webview: неизвестная команда не должна читаться как отмена.
        switch (message.command) {
          case 'submit':
            await this.submit(message.payload);
            return;
          case 'cancel':
            if (!this.submitting) {
              this.settle(undefined);
              this.panel?.dispose();
            }
            return;
          default:
            return;
        }

      case 'request': {
        const selected = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          title: 'Выберите путь к хранилищу',
        });
        if (selected?.[0]) {
          void this.panel?.webview.postMessage({
            type: 'reply',
            requestId: message.requestId,
            payload: { repoPath: selected[0].fsPath },
          });
        }
        return;
      }
      default:
        return;
    }
  }
}
