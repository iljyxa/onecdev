import * as vscode from 'vscode';
import { resolveRepositoryHistoryTarget } from '../../../infra/repository/history/RepositoryHistoryTarget';
import type { RepositoryNodeRef } from '../../../infra/repository/RepositoryService';
import type { CommandServices } from '../_shared';

/**
 * «История хранилища» (корень) и «История в хранилище» (объект), issue #117: открывают панель истории
 * по протоколу сервера хранилища. Только чтение — ни XML выгрузки, ни база, ни Конфигуратор не
 * трогаются, поэтому нет ни аренды ConfigurationOperationGuard (параллельная операция Конфигуратора
 * историю не портит), ни post-mutation пути (изменённых файлов нет).
 */

export interface RepositoryHistoryNotifier {
  warning(message: string): void;
  error(message: string): void;
}

export type RepositoryHistoryCommandServices = Pick<CommandServices, 'repositoryService' | 'repositoryHistoryViewProvider'>;

const NO_TARGET = 'Не удалось определить конфигурацию для выбранного узла.';

/** `root` — вся история цели узла (от любого узла цели), `object` — история единицы хранилища узла. */
export function openRepositoryHistory(
  node: RepositoryNodeRef | undefined,
  mode: 'root' | 'object',
  services: RepositoryHistoryCommandServices,
  notifier: RepositoryHistoryNotifier,
): void {
  const { repositoryService, repositoryHistoryViewProvider } = services;
  if (mode === 'root') {
    const target = node?.xmlPath ? repositoryService.resolveTargetByXmlPath(node.xmlPath) : null;
    if (!target) {
      notifier.error(NO_TARGET);
      return;
    }
    repositoryHistoryViewProvider.show({ target });
    return;
  }
  const resolution = resolveRepositoryHistoryTarget(repositoryService, node ?? {});
  switch (resolution.kind) {
    case 'root':
    case 'object':
      repositoryHistoryViewProvider.show(resolution.scope);
      return;
    case 'no-target':
      notifier.error(NO_TARGET);
      return;
    case 'unsupported-node':
      notifier.warning('История в хранилище ведётся по объекту целиком: откройте историю объекта-владельца, его формы или макета.');
      return;
    case 'no-uuid':
      notifier.error(`Не удалось прочитать идентификатор объекта ${resolution.fullName} из его XML в выгрузке.`);
      return;
  }
}

/* c8 ignore start -- тонкая обёртка над vscode.window: сама логика команды проверяется с внедрённым notifier */
const WINDOW_NOTIFIER: RepositoryHistoryNotifier = {
  // Без ожидания: команда только открывает панель и эксклюзивных операций не держит.
  warning: (message) => { void vscode.window.showWarningMessage(message); },
  error: (message) => { void vscode.window.showErrorMessage(message); },
};
/* c8 ignore stop */

export function registerRepositoryHistoryCommands(
  context: vscode.ExtensionContext,
  services: RepositoryHistoryCommandServices,
  notifier: RepositoryHistoryNotifier = WINDOW_NOTIFIER,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('onecdev.repository.history', (node?: RepositoryNodeRef) =>
      openRepositoryHistory(node, 'root', services, notifier)),
    vscode.commands.registerCommand('onecdev.repository.objectHistory', (node?: RepositoryNodeRef) =>
      openRepositoryHistory(node, 'object', services, notifier)),
  );
}
