import * as fs from 'fs';
import * as path from 'path';
import type { ConfigEntry } from '../../domain/Configuration';
import { parseConfigXml } from '../xml';
import { computeFileHash, diffHashSnapshots, isSupportedConfigFile, loadHashCache } from './HashCache';
import { buildHashSnapshotWithStatIndexAsync, loadFileStatIndex, saveFileStatIndex } from './FileStatIndex';
import { buildMetadataCacheScopeKey } from './MetadataCache';

/**
 * Файлы выгрузки, изменённые после последней загрузки в базу или выгрузки из неё.
 * Базовая линия — хеш-кэш цели: его фиксируют операции с базой, тот же источник
 * использует «Обновить изменённые конфигурации».
 */
export interface UnloadedChanges {
  readonly entry: ConfigEntry;
  /** Имя конфигурации или расширения из `Configuration.xml`. */
  readonly name: string;
  /** `false` — база ни разу не загружалась и не выгружалась: сравнивать не с чем. */
  readonly hasBaseline: boolean;
  /** Добавленные и изменённые файлы, пути относительно корня выгрузки через `/`. */
  readonly changed: ReadonlySet<string>;
  /** Удалённые файлы: объекта уже нет в выгрузке, в дереве их не показать. */
  readonly deleted: ReadonlySet<string>;
  /** Хеши базовой линии — для инкрементального пересчёта без перечитывания кэша. */
  readonly baseline: Readonly<Partial<Record<string, string>>>;
}

/**
 * Считает незагруженные в базу изменения одной конфигурации: полный проход —
 * асинхронно через stat-индекс, затем — точечно по событиям файлов.
 */
export class UnloadedChangesScanner {
  constructor(
    private readonly projectRoot: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  async scan(entry: ConfigEntry): Promise<UnloadedChanges> {
    const info = parseConfigXml(path.join(entry.rootPath, 'Configuration.xml'));
    const scopeKey = buildMetadataCacheScopeKey(entry, info);
    const previous = loadHashCache(this.projectRoot, scopeKey);
    if (previous.initializedLocally || Object.keys(previous.files).length === 0) {
      return { entry, name: info.name, hasBaseline: false, changed: new Set(), deleted: new Set(), baseline: {} };
    }

    const built = await buildHashSnapshotWithStatIndexAsync(
      scopeKey,
      entry.rootPath,
      loadFileStatIndex(this.projectRoot, scopeKey),
      this.now()
    );
    if (built.indexChanged) {
      try {
        saveFileStatIndex(this.projectRoot, built.index);
      } catch {
        // Индекс — только ускоритель: без него следующий проход перехеширует файлы.
      }
    }
    const diff = diffHashSnapshots(previous, built.snapshot);
    return {
      entry,
      name: info.name,
      hasBaseline: true,
      changed: new Set([...diff.added, ...diff.modified]),
      deleted: new Set(diff.deleted),
      baseline: previous.files,
    };
  }

  /**
   * Пересчитывает состояние только по указанным файлам (события watcher'а): хеш
   * каждого файла сравнивается с базовой линией, остальное состояние не трогается.
   */
  refreshFiles(current: UnloadedChanges, absolutePaths: readonly string[]): UnloadedChanges {
    if (!current.hasBaseline) {
      return current;
    }

    const changed = new Set(current.changed);
    const deleted = new Set(current.deleted);
    for (const absolutePath of absolutePaths) {
      const relativePath = path.relative(current.entry.rootPath, absolutePath).split(path.sep).join('/');
      // Файл вне выгрузки даёт путь с `..`, на Windows с другим диском — абсолютный.
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || !isSupportedConfigFile(relativePath)) {
        continue;
      }
      changed.delete(relativePath);
      deleted.delete(relativePath);
      const baselineHash = current.baseline[relativePath];
      const hash = readHashIfExists(absolutePath);
      if (hash === undefined) {
        if (baselineHash !== undefined) {
          deleted.add(relativePath);
        }
      } else if (hash !== baselineHash) {
        changed.add(relativePath);
      }
    }
    return { ...current, changed, deleted };
  }
}

function readHashIfExists(filePath: string): string | undefined {
  try {
    return fs.statSync(filePath).isFile() ? computeFileHash(filePath) : undefined;
  } catch {
    return undefined;
  }
}
