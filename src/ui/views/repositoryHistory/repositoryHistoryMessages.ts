// Входящие сообщения панели «История хранилища». Webview — недоверенная сторона (при пробое CSP
// скрипт в нём шлёт что угодно), поэтому сообщение приходит как unknown и сводится к закрытому
// множеству команд; всё прочее отбрасывается.

export type RepositoryHistoryUiCommand = 'ready' | 'refresh' | 'loadMore' | 'clearFilter' | 'exportReport';

const TOOLBAR_COMMANDS = ['refresh', 'loadMore', 'clearFilter', 'exportReport'] as const;

export function parseRepositoryHistoryUiMessage(raw: unknown): RepositoryHistoryUiCommand | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const message = raw as { readonly type?: unknown; readonly command?: unknown };
  if (message.type === 'ready') {
    return 'ready';
  }
  // Сравнение строгим равенством: команда не строкой или чужая строка в множество не попадает.
  return message.type === 'command' ? TOOLBAR_COMMANDS.find((command) => command === message.command) : undefined;
}
