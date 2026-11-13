import * as fs from 'fs';
import * as path from 'path';

/**
 * Перенос служебного каталога проекта после переименования расширения v8vscedit → onecdev.
 *
 * В `.v8vscedit/` лежат не только восстановимые кэши, но и состояние захватов хранилища
 * (`repository/state.json`) и снимки — база трёхстороннего слияния. Начать с пустого
 * `.onecdev/` значило бы молча потерять их, поэтому каталог переносится целиком, один раз.
 */

export const LEGACY_SERVICE_DIR_NAME = '.v8vscedit';
export const SERVICE_DIR_NAME = '.onecdev';

/**
 * - `migrated` — старый каталог переименован в новый;
 * - `not-needed` — старого каталога нет;
 * - `conflict` — есть оба: новый уже используется, старый не трогаем (слияние двух
 *   состояний вслепую опаснее, чем оставить решение человеку).
 */
export type LegacyServiceDirMigrationResult = 'migrated' | 'not-needed' | 'conflict';

/**
 * Переименовывает `<root>/.v8vscedit` в `<root>/.onecdev`, если нового каталога ещё нет.
 * Сбой переименования (например, каталог держит другой процесс) пробрасывается —
 * решение, как сообщить о нём, остаётся за вызывающим.
 */
export function migrateLegacyServiceDir(workspaceRoot: string): LegacyServiceDirMigrationResult {
  const legacy = path.join(workspaceRoot, LEGACY_SERVICE_DIR_NAME);
  if (!fs.existsSync(legacy)) {
    return 'not-needed';
  }
  if (fs.existsSync(path.join(workspaceRoot, SERVICE_DIR_NAME))) {
    return 'conflict';
  }
  fs.renameSync(legacy, path.join(workspaceRoot, SERVICE_DIR_NAME));
  return 'migrated';
}

/**
 * Дописывает `.onecdev/` в `.gitignore` проекта, если там игнорировался старый каталог,
 * а новый ещё нет. Без этого после переноса кэши и снимки хранилища попали бы в git.
 * Возвращает true, если файл изменён. Стиль переводов строк файла сохраняется.
 */
export function ensureServiceDirIgnored(workspaceRoot: string): boolean {
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    return false;
  }
  const content = fs.readFileSync(gitignorePath, 'utf-8');
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const ignores = (name: string): boolean => lines.includes(name) || lines.includes(`${name}/`);
  if (!ignores(LEGACY_SERVICE_DIR_NAME) || ignores(SERVICE_DIR_NAME)) {
    return false;
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  // Пустым файл здесь быть не может: в нём уже есть строка старого каталога.
  const separator = content.endsWith('\n') ? '' : eol;
  fs.writeFileSync(gitignorePath, `${content}${separator}${SERVICE_DIR_NAME}/${eol}`, 'utf-8');
  return true;
}

/**
 * Разовый перенос `.v8vscedit/` → `.onecdev/` и строки `.gitignore` при активации, с
 * переводом исхода в строки журнала. Сбой не должен мешать активации: расширение
 * продолжит работу с пустым `.onecdev/`, а причина останется в журнале.
 */
export function runLegacyServiceDirMigration(workspaceRoot: string): string[] {
  const log: string[] = [];
  try {
    const result = migrateLegacyServiceDir(workspaceRoot);
    if (result === 'migrated') {
      log.push('[migration] Служебный каталог .v8vscedit перенесён в .onecdev.');
    } else if (result === 'conflict') {
      log.push('[migration][warn] Найдены и .v8vscedit, и .onecdev — используется .onecdev, .v8vscedit не тронут.');
    }
    if (ensureServiceDirIgnored(workspaceRoot)) {
      log.push('[migration] В .gitignore добавлена строка .onecdev/.');
    }
  } catch (error) {
    // fs бросает только Error — его строковое представление уже содержит код и путь.
    log.push(`[migration][error] Не удалось перенести .v8vscedit в .onecdev: ${String(error)}`);
  }
  return log;
}
