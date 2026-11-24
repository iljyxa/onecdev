import type * as vscode from 'vscode';
import { watchGitRepositoryMarkers } from '../../infra/git/GitRepositoryMarkerWatcher';
import { selectGitRepository } from '../../infra/git/GitRepositorySelector';
import { resolveGitRoot } from '../../infra/git/GitStatusReader';
import type { GitApiLike, RepositoryLike } from './gitExtensionApi';

/** Следит за git-корнем рабочей папки и статусом соответствующего репозитория. */
export class GitStateObserver implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private gitRoot: string | null | undefined;
  private onRepositoryChange: RepositoryLike['state']['onDidChange'] | undefined;
  private repositorySubscription: vscode.Disposable | undefined;

  constructor(
    private readonly api: GitApiLike | undefined,
    private readonly workspaceRoot: string,
    private readonly onChange: () => void,
    private readonly onRootChange?: (gitRoot: string | null) => void
  ) {}

  start(): void {
    const api = this.api;
    if (api) {
      const update = () => this.recheckRepository();
      this.disposables.push(
        watchGitRepositoryMarkers(this.workspaceRoot, update),
        api.onDidOpenRepository(update),
        api.onDidCloseRepository(update),
        api.onDidChangeState((state) => {
          if (state === 'initialized') {
            update();
          }
        })
      );
    }
    this.updateRepository(api?.state === 'initialized' ? api.repositories : []);
  }

  recheckRepository(): void {
    if (this.api) {
      this.updateRepository(this.api.repositories);
    }
  }

  dispose(): void {
    this.repositorySubscription?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private updateRepository(repositories: readonly RepositoryLike[]): void {
    // SCM может закрыть репозиторий, который по-прежнему есть на диске.
    // При удалении вложенного .git рабочая папка может остаться в родительском репозитории.
    const gitRoot = resolveGitRoot(this.workspaceRoot);
    if (gitRoot !== this.gitRoot) {
      this.gitRoot = gitRoot;
      this.onRootChange?.(gitRoot);
    }
    const index = gitRoot ? selectGitRepository(repositories.map((repo) => repo.rootUri.fsPath), gitRoot) : -1;
    // Git API возвращает новые обёртки Repository при каждом чтении списка.
    const onRepositoryChange = index === -1 ? undefined : repositories[index].state.onDidChange;
    if (onRepositoryChange !== this.onRepositoryChange) {
      this.repositorySubscription?.dispose();
      this.onRepositoryChange = onRepositoryChange;
      this.repositorySubscription = onRepositoryChange?.(this.onChange);
    }
  }
}
