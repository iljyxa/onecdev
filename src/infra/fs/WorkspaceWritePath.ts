import * as fs from 'fs';
import * as path from 'path';
import { pathKey } from './PathKey';

/**
 * Проверяет, что путь записи от недоверенного клиента (MCP-агента) лежит внутри корня
 * workspace, и возвращает его абсолютным (#174).
 *
 * Относительный путь отсчитывается от корня workspace: cwd процесса extension host для
 * агента непредсказуем. Вложенность сравнивается по реальным путям ближайших существующих
 * предков — иначе симлинк внутри workspace уводил бы запись наружу, а ещё не созданный
 * каталог назначения не удалось бы проверить вовсе.
 */
export function resolveWritePathInsideRoot(
  targetPath: string,
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (targetPath.trim() === '') {
    throw new Error('Путь записи не задан.');
  }
  const absoluteRoot = path.resolve(rootPath);
  const absoluteTarget = path.resolve(absoluteRoot, targetPath);
  const rootKey = pathKey(realPathOfExistingPrefix(absoluteRoot), platform);
  const targetKey = pathKey(realPathOfExistingPrefix(absoluteTarget), platform);
  const rootPrefix = rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep;
  if (targetKey !== rootKey && !targetKey.startsWith(rootPrefix)) {
    throw new Error(
      `Путь записи «${targetPath}» вне рабочего пространства «${absoluteRoot}». `
      + 'MCP-инструменты пишут только внутри папки workspace; относительный путь отсчитывается от её корня.',
    );
  }
  return absoluteTarget;
}

/**
 * Реальный путь ближайшего существующего предка с дописанным несуществующим хвостом.
 * Существование — через `lstat`: висячий симлинк не «пропускается» как несуществующий,
 * а валит `realpath` — запись через него отклоняется, а не проверяется лексически.
 */
function realPathOfExistingPrefix(absolutePath: string): string {
  const tail: string[] = [];
  let current = absolutePath;
  while (!entryExists(current) && path.dirname(current) !== current) {
    tail.unshift(path.basename(current));
    current = path.dirname(current);
  }
  return path.join(fs.realpathSync.native(current), ...tail);
}

function entryExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}
