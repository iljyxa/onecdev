import * as fs from 'fs';
import * as path from 'path';
import { FS_RM_MAX_RETRIES, FS_RM_RETRY_DELAY_MS } from './PathRemoval';

/**
 * Одноразовые каталоги операций Конфигуратора в `.onecdev/import-temp` (выгрузки
 * хранилища, импорт cf/cfe, список расширений). Каталог служебный: в нём нет ничего,
 * кроме таких каталогов, — и создание, и подметание опираются на этот модуль.
 */

function getWorkspaceServiceRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.onecdev');
}

/**
 * Файл в служебном `.onecdev/` рабочей области (бэкапы слияния, копии хранилища,
 * кэши) — не файл конфигурации, даже если корень конфигурации совпадает с корнем
 * рабочей области.
 */
export function isInsideWorkspaceServiceDir(workspaceRoot: string, filePath: string): boolean {
  const relative = path.relative(getWorkspaceServiceRoot(workspaceRoot), filePath);
  return relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative);
}

/**
 * Каталог-бэкап атомарной замены снимка: `replaceDirectorySnapshot` переименовывает
 * заменяемый каталог в `.<имя>.onecdev-backup-<pid>-<время>` рядом с ним и удаляет
 * после замены. Пока он существует, в нём лежит прежняя копия конфигурации.
 */
const SNAPSHOT_BACKUP_DIR_NAME = /^\..+\.onecdev-backup-\d+-\d+$/;

/**
 * Служебный путь рабочей области: события watcher'ов по нему — не правки конфигурации.
 * Кроме `.onecdev/` это бэкапы замены снимка: они лежат рядом с каталогом конфигурации
 * и попадают под шаблоны watcher'ов, хотя в служебном каталоге не находятся.
 */
export function isWorkspaceServicePath(workspaceRoot: string, filePath: string): boolean {
  if (isInsideWorkspaceServiceDir(workspaceRoot, filePath)) {
    return true;
  }
  return path.relative(workspaceRoot, filePath).split(path.sep).some((part) => SNAPSHOT_BACKUP_DIR_NAME.test(part));
}

export function getImportTempRoot(workspaceRoot: string): string {
  return path.join(getWorkspaceServiceRoot(workspaceRoot), 'import-temp');
}

export function createImportTempDir(workspaceRoot: string, prefix: string): string {
  const tempParent = getImportTempRoot(workspaceRoot);
  fs.mkdirSync(tempParent, { recursive: true });
  return fs.mkdtempSync(path.join(tempParent, prefix));
}

/** Отсутствие каталога — нормальное состояние «чистить нечего»; прочие сбои — наружу. */
export async function readDirOrEmptyAsync(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Возраст строго больше порога; метки из будущего (сбитые часы) устаревшими не считаются.
 * Нет метки — нет и оснований удалять: так же трактуются исчезнувший каталог и чужое имя.
 */
export function isStale(timeMs: number | undefined, nowMs: number, maxAgeMs: number): boolean {
  return timeMs !== undefined && timeMs <= nowMs && nowMs - timeMs > maxAgeMs;
}

/**
 * mtime или `undefined`, если записи уже нет: между `readdir` и `stat` каталог может
 * удалить его собственный поток или подметание из другого окна — это не сбой, и
 * остальные каталоги должны подметаться дальше. Прочие ошибки — наружу.
 */
export async function readMtimeMs(target: string): Promise<number | undefined> {
  try {
    return (await fs.promises.stat(target)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Удаляет каталоги `import-temp/*` старше `maxAgeMs` — хвосты потоков, прерванных
 * аварийным завершением extension host (штатно их удаляет `dispose()` самого потока).
 * В имени `mkdtemp` метки времени нет, поэтому возраст — по mtime каталога: он
 * фиксируется при создании подкаталога выгрузки и за время живого потока не
 * обновляется, так что порог обязан быть заведомо больше самой долгой операции.
 * Файлы на верхнем уровне не трогаются: их туда никто не кладёт.
 */
export async function pruneStaleImportTempDirs(workspaceRoot: string, now: Date, maxAgeMs: number): Promise<string[]> {
  const root = getImportTempRoot(workspaceRoot);
  const nowMs = now.getTime();
  const removed: string[] = [];
  for (const entry of await readDirOrEmptyAsync(root)) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(root, entry.name);
    if (isStale(await readMtimeMs(dir), nowMs, maxAgeMs)) {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: FS_RM_MAX_RETRIES, retryDelay: FS_RM_RETRY_DELAY_MS });
      removed.push(dir);
    }
  }
  return removed;
}
