import * as path from 'path';
import type { ConfigEntry } from '../../domain/Configuration';
import type { UnloadedChanges, UnloadedChangesScanner } from '../../infra/cache/UnloadedChangesScanner';
import { pathKey } from '../../infra/fs/PathKey';
import type { RepositoryService, RepositoryTarget } from '../../infra/repository/RepositoryService';
import { WorkingSetIndex, type WorkingSetSource } from '../../infra/repository/WorkingSetIndex';
import type { MetadataTreeProvider } from './MetadataTreeProvider';

/** Состояние фильтра для панели навигатора. */
export interface WorkingSetFilterStatus {
  readonly active: boolean;
  /** Идёт полный пересчёт изменений: дерево ещё не отфильтровано. */
  readonly pending: boolean;
  /** Сообщение над деревом; только у активного фильтра. */
  readonly message?: string;
}

export interface WorkingSetFilterControllerDeps {
  readonly scanner: Pick<UnloadedChangesScanner, 'scan' | 'refreshFiles'>;
  readonly treeProvider: Pick<MetadataTreeProvider, 'getEntries' | 'setWorkingSetFilter'>;
  readonly repositoryService?: Pick<
    RepositoryService,
    'resolveTargetByConfigRoot' | 'isConnected' | 'listOwnLockedFullNames' | 'onDidChangeLocks'
  >;
  readonly onDidChangeStatus: () => void;
  readonly log?: (message: string) => void;
  /** Пауза сбора событий файлов перед пересчётом. */
  readonly fileDebounceMs?: number;
  /**
   * Сколько событий файлов пересчитывается точечно; больше (checkout, массовая
   * замена) — полный асинхронный пересчёт вместо синхронного хеширования пачки.
   */
  readonly maxIncrementalFiles?: number;
}

const DEFAULT_FILE_DEBOUNCE_MS = 500;
const DEFAULT_MAX_INCREMENTAL_FILES = 200;

/**
 * Фильтр дерева «изменённые и захваченные»: держит незагруженные изменения по
 * каждой конфигурации и захваты, собирает из них `WorkingSetIndex` и отдаёт его
 * дереву. Состояние живёт только в сессии, как строка поиска.
 */
export class WorkingSetFilterController {
  private active = false;
  private pending = false;
  private index: WorkingSetIndex | undefined;
  private readonly changes = new Map<string, UnloadedChanges>();
  private readonly pendingFiles = new Set<string>();
  private fileTimer: NodeJS.Timeout | undefined;
  /** Номер полного пересчёта: результат устаревшего пересчёта отбрасывается. */
  private generation = 0;
  private readonly locksSubscription: { dispose(): void } | undefined;

  constructor(private readonly deps: WorkingSetFilterControllerDeps) {
    this.locksSubscription = deps.repositoryService?.onDidChangeLocks(() => {
      if (this.active && !this.pending) {
        this.applyIndex();
      }
    });
  }

  dispose(): void {
    this.locksSubscription?.dispose();
    this.clearFileTimer();
  }

  getStatus(): WorkingSetFilterStatus {
    if (!this.active) {
      return { active: false, pending: false };
    }
    return { active: true, pending: this.pending, message: this.buildMessage() };
  }

  async toggle(): Promise<void> {
    if (this.active) {
      this.active = false;
      this.pending = false;
      this.generation += 1;
      this.index = undefined;
      this.changes.clear();
      this.pendingFiles.clear();
      this.clearFileTimer();
      this.deps.treeProvider.setWorkingSetFilter(undefined);
      this.deps.onDidChangeStatus();
      return;
    }
    this.active = true;
    await this.rescan();
  }

  /**
   * Полный пересчёт незагруженных изменений: при включении, после операций с базой
   * (хеш-кэш обновлён) и при смене состава конфигураций. У выключенного фильтра — no-op.
   */
  async rescan(): Promise<void> {
    if (!this.active) {
      return;
    }
    const generation = ++this.generation;
    this.pending = true;
    this.pendingFiles.clear();
    this.clearFileTimer();
    this.deps.onDidChangeStatus();

    const entries = this.deps.treeProvider.getEntries();
    const scanned = await Promise.all(entries.map((entry) => this.scanEntry(entry)));
    if (generation !== this.generation) {
      return;
    }
    this.changes.clear();
    for (const item of scanned) {
      if (item) {
        this.changes.set(pathKey(item.entry.rootPath), item);
      }
    }
    this.pending = false;
    // За время обхода уже прочитанные файлы могли измениться.
    this.clearFileTimer();
    if (this.pendingFiles.size > 0) {
      this.flushFileChanges();
    } else {
      this.applyIndex();
    }
  }

  /** Событие файла выгрузки; пересчёт — пачкой после паузы. */
  notifyFileChanged(filePath: string): void {
    if (!this.active) {
      return;
    }
    this.pendingFiles.add(filePath);
    if (this.fileTimer) {
      return;
    }
    this.fileTimer = setTimeout(() => {
      this.fileTimer = undefined;
      this.flushFileChanges();
    }, this.deps.fileDebounceMs ?? DEFAULT_FILE_DEBOUNCE_MS);
  }

  /** Точечный пересчёт по накопленным событиям файлов. */
  flushFileChanges(): void {
    if (!this.active || this.pending || this.pendingFiles.size === 0) {
      return;
    }
    const files = [...this.pendingFiles];
    this.pendingFiles.clear();
    if (files.length > (this.deps.maxIncrementalFiles ?? DEFAULT_MAX_INCREMENTAL_FILES)) {
      void this.rescan();
      return;
    }
    for (const [key, current] of this.changes) {
      const ownFiles = files.filter((file) => isInside(file, current.entry.rootPath));
      if (ownFiles.length > 0) {
        this.changes.set(key, this.deps.scanner.refreshFiles(current, ownFiles));
      }
    }
    this.applyIndex();
  }

  private async scanEntry(entry: ConfigEntry): Promise<UnloadedChanges | undefined> {
    try {
      return await this.deps.scanner.scan(entry);
    } catch (error) {
      this.deps.log?.(`[working-set] Не удалось посчитать изменения ${entry.rootPath}: ${String(error)}`);
      return undefined;
    }
  }

  private applyIndex(): void {
    const sources: WorkingSetSource[] = [];
    for (const entry of this.deps.treeProvider.getEntries()) {
      const changes = this.changes.get(pathKey(entry.rootPath));
      const target = this.resolveTarget(entry, changes?.name);
      if (!target) {
        continue;
      }
      sources.push({
        target,
        changedRelativePaths: changes?.changed ?? [],
        ownLockedFullNames: this.listOwnLocks(target),
      });
    }
    this.index = WorkingSetIndex.build(sources);
    this.deps.treeProvider.setWorkingSetFilter(this.index);
    this.deps.onDidChangeStatus();
  }

  private resolveTarget(entry: ConfigEntry, name: string | undefined): RepositoryTarget | undefined {
    const resolved = this.deps.repositoryService?.resolveTargetByConfigRoot(entry.rootPath);
    return resolved ?? (name === undefined ? undefined : {
      configRoot: entry.rootPath,
      configKind: entry.kind,
      extensionName: entry.kind === 'cfe' ? name : undefined,
      displayName: name,
    });
  }

  private listOwnLocks(target: RepositoryTarget): string[] {
    const repositoryService = this.deps.repositoryService;
    return repositoryService?.isConnected(target) ? repositoryService.listOwnLockedFullNames(target) : [];
  }

  private buildMessage(): string {
    if (this.pending || !this.index) {
      return 'Фильтр: подсчёт изменений…';
    }
    const parts = [`Фильтр: не загруженные в базу и захваченные (${String(this.index.unitCount)})`];
    let deleted = 0;
    const withoutBaseline: string[] = [];
    for (const changes of this.changes.values()) {
      deleted += changes.deleted.size;
      if (!changes.hasBaseline) {
        withoutBaseline.push(changes.name);
      }
    }
    if (deleted > 0) {
      parts.push(`+ ${String(deleted)} удалённых`);
    }
    if (withoutBaseline.length > 0) {
      parts.push(`нет данных о загрузке в базу: ${withoutBaseline.join(', ')}`);
    }
    return parts.join('; ');
  }

  private clearFileTimer(): void {
    if (this.fileTimer) {
      clearTimeout(this.fileTimer);
      this.fileTimer = undefined;
    }
  }
}

function isInside(filePath: string, rootPath: string): boolean {
  return pathKey(filePath).startsWith(`${pathKey(rootPath)}${path.sep}`);
}
