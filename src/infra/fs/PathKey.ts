import * as path from 'path';

/**
 * ФС по умолчанию регистронезависимы только на Windows (NTFS) и macOS (APFS/HFS+). На Linux
 * `ObjectModule.bsl` и `objectmodule.bsl` — разные файлы, и ключ через `toLowerCase()` их
 * склеивал (#123). Платформа — параметром, чтобы правило проверялось тестом на любой ОС.
 */
const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>(['win32', 'darwin']);

/** Ключ сравнения путей: абсолютный путь, в нижнем регистре — только на регистронезависимой ФС. */
export function pathKey(filePath: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(filePath);
  return CASE_INSENSITIVE_PLATFORMS.has(platform) ? resolved.toLowerCase() : resolved;
}
