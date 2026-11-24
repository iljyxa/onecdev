import type * as vscode from 'vscode';

/**
 * Минимальные типы-фасады встроенного Git-расширения VS Code (`vscode.git`),
 * достаточные для наблюдения за состоянием репозиториев. Полный тип
 * `git.d.ts` расширения не подключается: нам нужны только события
 * инициализации API, открытия и закрытия репозитория и смены его состояния.
 */

/** Состояние Git Extension API: до и после первичной инициализации репозиториев. */
export type GitApiState = 'uninitialized' | 'initialized';

/** Один репозиторий Git Extension API. */
export interface RepositoryLike {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly onDidChange: vscode.Event<void>;
  };
}

/** Публичный API встроенного Git-расширения (`getAPI(1)`). */
export interface GitApiLike {
  readonly state: GitApiState;
  readonly repositories: readonly RepositoryLike[];
  onDidChangeState(cb: (state: GitApiState) => void): vscode.Disposable;
  onDidOpenRepository(cb: (repo: RepositoryLike) => void): vscode.Disposable;
  onDidCloseRepository(cb: (repo: RepositoryLike) => void): vscode.Disposable;
}

/** Экспорт расширения `vscode.git`: точка входа `getAPI(1)`. */
export interface GitExtensionLike {
  readonly exports: {
    readonly enabled: boolean;
    getAPI(version: 1): GitApiLike;
  };
}
