import * as vscode from 'vscode';
import type { MetadataNode } from '../../tree/TreeNode';
import { WebviewHtmlFactory } from '../webview/WebviewHtmlFactory';
import { resolveWebviewLocalResourceRoots } from '../webview/webviewResourceRoots';
import type { PropertiesViewController } from './PropertiesViewController';
import type { PropertiesPanelState, PropertiesViewSession } from './PropertiesViewSession';
import { PROPERTIES_PLACEMENT_CONTEXT, PROPERTIES_VIEW_ID } from './propertiesViewPlacement';

type WebviewMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'command'; readonly command: string; readonly viewVersion: number; readonly payload?: unknown };

export class PropertiesViewProvider implements vscode.WebviewViewProvider {
  private readonly htmlFactory: WebviewHtmlFactory;
  private placementReady: Thenable<unknown> | undefined;
  private openingByDefault = false;
  private static readonly openedByDefaultKey = 'onecdev.propertiesOpenedByDefault';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly viewId: string,
    private readonly session: PropertiesViewSession,
    private readonly controller: PropertiesViewController,
    private readonly logError: (error: unknown) => void
  ) {
    this.htmlFactory = new WebviewHtmlFactory(context.extensionUri);
  }

  register(): void {
    this.context.subscriptions.push(vscode.window.registerWebviewViewProvider(
      this.viewId,
      this,
      { webviewOptions: { retainContextWhenHidden: true } }
    ));
    this.placementReady = vscode.commands.executeCommand(
      'setContext', PROPERTIES_PLACEMENT_CONTEXT,
      this.viewId === PROPERTIES_VIEW_ID ? 'secondarySidebar' : 'navigator'
    );
  }

  async reveal(node?: MetadataNode): Promise<void> {
    if (node) {
      this.selectNode(node);
    }
    await this.placementReady;
    await vscode.commands.executeCommand(`${this.viewId}.focus`);
  }

  async openByDefault(): Promise<void> {
    if (this.openingByDefault || this.context.workspaceState.get(PropertiesViewProvider.openedByDefaultKey)) {
      return;
    }
    this.openingByDefault = true;
    try {
      await this.placementReady;
      await vscode.commands.executeCommand('onecdevUniversal.focus', { preserveFocus: true });
      await vscode.commands.executeCommand(`${this.viewId}.focus`, { preserveFocus: true });
      await this.context.workspaceState.update(PropertiesViewProvider.openedByDefaultKey, true);
    } finally {
      this.openingByDefault = false;
    }
  }

  selectNode(node: MetadataNode | undefined): void {
    this.controller.setActiveNode(node);
    void this.session.selectNode(node).catch(this.logError);
  }

  handleMetadataRemoved(node: MetadataNode): void {
    const refresh = this.session.handleMetadataRemoved(node);
    if (refresh) {
      this.controller.clearActiveNode();
      void refresh.catch(this.logError);
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    let ready = false;
    const updateHost = () => {
      const host = ready && view.visible
        ? (state: PropertiesPanelState) => { void view.webview.postMessage({ type: 'state', state }); }
        : undefined;
      void this.session.setHost(host).catch(this.logError);
    };

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: resolveWebviewLocalResourceRoots(this.context.extensionUri, { includeIcons: false }),
    };
    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === 'ready') {
        ready = true;
        updateHost();
      } else if (view.visible && this.session.isCurrent(message.viewVersion)) {
        void this.handleCommand(message).catch(this.logError);
      }
    });
    view.onDidChangeVisibility(updateHost);
    view.onDidDispose(() => {
      void this.session.setHost(undefined);
    });
    view.webview.html = this.htmlFactory.renderVueWebviewHtml({
      webview: view.webview,
      title: 'Свойства',
      entry: 'properties',
      viewKind: 'properties',
      initialState: null,
      csp: { allowStyles: true, allowImages: true },
    });
  }

  private async handleCommand(message: Extract<WebviewMessage, { type: 'command' }>): Promise<void> {
    const { command, payload } = message;
    if (command === 'propertyChanged') {
      const change = payload as { key?: string; controlId?: string; value: unknown };
      this.controller.handlePropertyChange(change.key ?? change.controlId ?? '', change.value);
      return;
    }
    await this.controller.handleWebviewMessage({
      ...(typeof payload === 'object' && payload !== null ? payload : {}),
      type: command,
    });
  }
}
