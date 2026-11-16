/**
 * Ui-зеркало DTO панели «История хранилища» (Vue-сторона). Зеркалит
 * `src/infra/repository/history/RepositoryHistoryView.ts` (host-сторона исключена из
 * webview-сборки, поэтому типы дублируются по конвенции протокола). Форма ОБЯЗАНА
 * совпадать с host-зеркалом, иначе рассинхрон протокола.
 */

export type RepositoryHistoryChangeKind = 'added' | 'modified' | 'removed';

export type RepositoryHistoryStatus = 'no-scope' | 'disconnected' | 'file-repository' | 'idle' | 'loading' | 'ready' | 'failed';

export interface RepositoryHistoryChangeDto {
  readonly objectId: string;
  readonly title: string;
  readonly kind: RepositoryHistoryChangeKind;
  readonly kindText: string;
}

export interface RepositoryHistoryVersionDto {
  readonly verNum: number;
  readonly title: string;
  readonly author: string;
  readonly date: string;
  readonly comment: string;
  readonly summary?: string;
  readonly label?: { readonly name: string; readonly comment: string; readonly author: string; readonly date: string };
  readonly tooltip: string;
  readonly configVersion: string;
  readonly platformVersion: string;
  readonly changes: readonly RepositoryHistoryChangeDto[];
  readonly hiddenChanges: number;
}

export interface RepositoryHistoryOlderDto {
  readonly state: 'available' | 'loading' | 'failed';
  readonly label: string;
  readonly description?: string;
  readonly tooltip: string;
  readonly remaining: number;
}

export interface RepositoryHistoryViewDto {
  readonly title: string;
  readonly filterTitle?: string;
  readonly status: RepositoryHistoryStatus;
  readonly message?: string;
  readonly description?: string;
  readonly versions: readonly RepositoryHistoryVersionDto[];
  readonly older?: RepositoryHistoryOlderDto;
  readonly canClearFilter: boolean;
  readonly canExportReport: boolean;
}

/** Сообщения панели хосту; хост разбирает их `parseRepositoryHistoryUiMessage`. */
export type RepositoryHistoryUiMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'command'; readonly command: 'refresh' | 'loadMore' | 'clearFilter' | 'exportReport' };
