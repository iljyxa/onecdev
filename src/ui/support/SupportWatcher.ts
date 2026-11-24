import * as path from 'path';
import * as vscode from 'vscode';
import { isWorkspaceServicePath } from '../../infra/fs/WorkspaceTempDir';
import type { SupportInfoService } from '../../infra/support/SupportInfoService';

const SUPPORT_WATCHER_DEBOUNCE_MS = 250;

/**
 * Настраивает watcher за файлом `Ext/ParentConfigurations.bin`: при его
 * изменении сбрасывается кэш `SupportInfoService` и обновляется дерево:
 * индикатор поддержки строится из `contextValue` узлов при их перерисовке.
 *
 * Вынос из `extension.ts` выполнен для того, чтобы активатор оставался тонкой
 * композицией, а инфраструктурная подписка жила в `ui/support/`.
 */
export function registerSupportWatcher(
  workspaceFolder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
  supportService: SupportInfoService,
  onTreeRefresh: () => void
): void {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolder, '**/Ext/ParentConfigurations.bin'),
    false,
    false,
    false
  );

  const handlers = createParentConfigurationsHandlers(workspaceFolder.uri.fsPath, supportService, onTreeRefresh);

  watcher.onDidCreate(handlers.onChange, null, context.subscriptions);
  watcher.onDidChange(handlers.onChange, null, context.subscriptions);
  watcher.onDidDelete(handlers.onDelete, null, context.subscriptions);
  context.subscriptions.push(watcher, handlers);
}

export interface ParentConfigurationsHandlers extends vscode.Disposable {
  readonly onChange: (uri: vscode.Uri) => void;
  readonly onDelete: (uri: vscode.Uri) => void;
}

/**
 * Реакция на события файла `<корень>/Ext/ParentConfigurations.bin`. Отделена от
 * подписки, чтобы её можно было проверить на реальной выгрузке без ожидания
 * событий файловой системы.
 */
export function createParentConfigurationsHandlers(
  workspaceRoot: string,
  supportService: SupportInfoService,
  onTreeRefresh: () => void
): ParentConfigurationsHandlers {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const scheduleRefresh = (uri: vscode.Uri): void => {
    if (isWorkspaceServicePath(workspaceRoot, uri.fsPath)) {
      return;
    }

    const configRoot = configRootOfBin(uri);
    clearTimeout(timers.get(configRoot));
    timers.set(configRoot, setTimeout(() => {
      timers.delete(configRoot);
      // При замене каталога событие удаления может прийти уже после появления нового файла.
      if (supportService.loadConfig(configRoot, { invalidateCache: true })) {
        onTreeRefresh();
      }
    }, SUPPORT_WATCHER_DEBOUNCE_MS));
  };

  return {
    onChange: scheduleRefresh,
    onDelete: scheduleRefresh,
    dispose: () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    },
  };
}

function configRootOfBin(binUri: vscode.Uri): string {
  return path.dirname(path.dirname(binUri.fsPath));
}
