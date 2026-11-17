import { slashPathKey } from '../fs/PathKey';

/**
 * Нормализованная форма абсолютного пути для сравнения git-корней.
 * Совпадает по логике с `normalizePath` в `GitMetadataStatusService`:
 * `path.resolve` → унификация разделителей на forward slash → нижний регистр только на
 * регистронезависимой ФС (`slashPathKey`, #123).
 * Дополнительно срезается хвостовой `/`: git toplevel из Git Extension API и
 * рабочий `gitRoot` панели могут отличаться только завершающим слэшем, а это
 * один и тот же каталог.
 */
export function normalizeGitPath(filePath: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = slashPathKey(filePath, platform);
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

/**
 * Возвращает индекс репозитория из `repoRoots`, чей корень нормализованно
 * совпадает с `gitRoot`, иначе `-1`. Сравнение — точное, без ancestor-fallback:
 * обе стороны заведомо git toplevel, а не произвольный путь внутри репозитория,
 * поэтому подстрочное вхождение недопустимо (иначе вложенный подкаталог-репо
 * ложно совпал бы с внешним).
 */
export function selectGitRepository(
  repoRoots: readonly string[],
  gitRoot: string,
  platform: NodeJS.Platform = process.platform
): number {
  const target = normalizeGitPath(gitRoot, platform);
  return repoRoots.findIndex((root) => normalizeGitPath(root, platform) === target);
}
