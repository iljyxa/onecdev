import * as vscode from 'vscode';
import { ModuleStructureContextHandler } from './contexts/ModuleStructureContextHandler';
import type { ActiveDocumentInfo, DynamicPanelState, ModuleSymbolDto, RangeDto } from './_types';

export interface DynamicPanelHost {
  postState(state: DynamicPanelState): void;
}

const MODULE_SYMBOL_RETRY_DELAYS_MS: readonly number[] = [400, 1200, 3000, 7000];
export class DynamicPanelController implements vscode.Disposable {
  private host: DynamicPanelHost | undefined;
  private currentState: DynamicPanelState = { kind: 'empty' };
  private activeDocumentUri: string | undefined;
  private readonly moduleHandler: ModuleStructureContextHandler;
  private readonly disposables: vscode.Disposable[] = [];
  private retryHandles: NodeJS.Timeout[] = [];

  constructor() {
    this.moduleHandler = new ModuleStructureContextHandler(
      (info, symbols) => this.applyModuleSymbols(info, symbols),
      (info) => this.applyModuleLoading(info)
    );

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.onActiveEditor(editor);
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        this.onEditorSelectionChanged(event);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.currentState.kind === 'module-structure'
          && event.document.uri.toString() === this.activeDocumentUri) {
          this.moduleHandler.schedule(event.document);
        }
      })
    );

    this.evaluateInitialState();
  }

  attachHost(host: DynamicPanelHost): void {
    this.host = host;
    this.host.postState(this.currentState);
  }

  detachHost(): void {
    this.host = undefined;
  }

  getCurrentState(): DynamicPanelState {
    return this.currentState;
  }

  async handleWebviewCommand(command: string, payload: unknown): Promise<void> {
    if (command === 'revealSymbol') {
      await this.revealSymbol(payload as { range?: RangeDto } | undefined);
    }
  }

  dispose(): void {
    this.host = undefined;
    this.cancelRetries();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.moduleHandler.dispose();
  }

  // ── Внутреннее ──

  private evaluateInitialState(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor && ModuleStructureContextHandler.isSupported(editor.document)) {
      // Дебаунс (не immediate): DocumentSymbolProvider регистрируется в Container
      // после конструктора контроллера, дадим ему время встать на регистр.
      this.switchToModule(editor.document, false);
    }
  }

  /** Срабатывает при смене активного редактора (вкладка/новый файл). */
  private onActiveEditor(editor: vscode.TextEditor | undefined): void {
    if (!editor || !ModuleStructureContextHandler.isSupported(editor.document)) {
      return;
    }
    this.switchToModule(editor.document, true);
  }

  /**
   * Реакция на действия пользователя в редакторе: клик, движение курсора.
   * Программные изменения (`SelectionChangeKind.Command` — от `executeCommand`,
   * `revealRange` и т.п.) игнорируются: пользователь их не инициировал.
   */
  private onEditorSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
    if (event.kind === undefined || event.kind === vscode.TextEditorSelectionChangeKind.Command) {
      return;
    }
    const editor = event.textEditor;
    if (!ModuleStructureContextHandler.isSupported(editor.document)) {
      return;
    }
    const uri = editor.document.uri.toString();
    if (this.currentState.kind === 'module-structure' && this.activeDocumentUri === uri) {
      return;
    }
    this.switchToModule(editor.document, false);
  }

  private switchToModule(document: vscode.TextDocument, immediate: boolean): void {
    this.cancelRetries();
    this.activeDocumentUri = document.uri.toString();
    this.moduleHandler.schedule(document, immediate);
  }

  private applyModuleLoading(info: ActiveDocumentInfo): void {
    if (this.activeDocumentUri !== info.uri) {
      this.activeDocumentUri = info.uri;
    }
    this.setState({
      kind: 'module-structure',
      document: info,
      symbols: this.currentState.kind === 'module-structure' && this.currentState.document.uri === info.uri
        ? this.currentState.symbols
        : [],
      loading: true,
    });
  }

  private applyModuleSymbols(info: ActiveDocumentInfo, symbols: ModuleSymbolDto[]): void {
    if (this.activeDocumentUri !== info.uri) {
      return;
    }
    this.cancelRetries();
    this.setState({ kind: 'module-structure', document: info, symbols, loading: false });

    if (symbols.length === 0) {
      // LSP/regex-провайдер может ещё инициализироваться при старте VSCode —
      // делаем несколько повторных запросов с нарастающей задержкой.
      this.scheduleSymbolRetries(info);
    }
  }

  private scheduleSymbolRetries(info: ActiveDocumentInfo): void {
    for (const delay of MODULE_SYMBOL_RETRY_DELAYS_MS) {
      const handle = setTimeout(() => {
        if (this.activeDocumentUri !== info.uri) {
          return;
        }
        const editor = vscode.window.activeTextEditor;
        const document = editor?.document.uri.toString() === info.uri
          ? editor.document
          : vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === info.uri);
        if (document) {
          this.moduleHandler.schedule(document, true);
        }
      }, delay);
      this.retryHandles.push(handle);
    }
  }

  private cancelRetries(): void {
    for (const handle of this.retryHandles) {
      clearTimeout(handle);
    }
    this.retryHandles = [];
  }

  private async revealSymbol(payload: { range?: RangeDto } | undefined): Promise<void> {
    if (!payload?.range || !this.activeDocumentUri) {
      return;
    }
    try {
      const uri = vscode.Uri.parse(this.activeDocumentUri);
      const document = await vscode.workspace.openTextDocument(uri);
      const range = this.clampRange(document, payload.range);
      const selection = new vscode.Selection(range.start, range.start);
      const editor = await vscode.window.showTextDocument(document, {
        preserveFocus: false,
        selection,
      });
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      // Гарантированный фокус — иногда showTextDocument не переводит фокус, если редактор уже активен.
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    } catch {
      // Документ закрыт/перемещён — игнор.
    }
  }

  /** Ограничивает координаты диапазона границами документа (защита от багов LSP). */
  private clampRange(document: vscode.TextDocument, range: RangeDto): vscode.Range {
    const lastLine = Math.max(0, document.lineCount - 1);
    const clampPos = (line: number, character: number): vscode.Position => {
      const safeLine = Math.min(Math.max(line, 0), lastLine);
      const lineLength = document.lineAt(safeLine).text.length;
      const safeChar = Math.min(Math.max(character, 0), lineLength);
      return new vscode.Position(safeLine, safeChar);
    };
    return new vscode.Range(
      clampPos(range.start.line, range.start.character),
      clampPos(range.end.line, range.end.character)
    );
  }

  private setState(next: DynamicPanelState): void {
    this.currentState = next;
    this.host?.postState(next);
  }
}
