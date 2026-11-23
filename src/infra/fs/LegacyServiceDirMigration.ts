import * as fs from 'fs';
import * as path from 'path';
import { ensureWorkspaceServiceDirIgnored } from './WorkspaceTempDir';

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
 * Разовый перенос `.v8vscedit/` → `.onecdev/` и самоигнорирование служебного каталога
 * (#194) при активации, с переводом исходов в строки журнала. Сбой не должен мешать
 * активации: расширение продолжит работу, а причина останется в журнале. Строка в
 * пользовательском `.gitignore` больше не нужна — `.onecdev/.gitignore` с `*` работает
 * и без него, поэтому файл проекта не трогается.
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
  } catch (error) {
    // fs бросает только Error — его строковое представление уже содержит код и путь.
    log.push(`[migration][error] Не удалось перенести .v8vscedit в .onecdev: ${String(error)}`);
  }
  // После переноса: перенесённый каталог тоже должен получить `.gitignore`.
  try {
    if (ensureWorkspaceServiceDirIgnored(workspaceRoot)) {
      log.push('[service-dir] Создан .onecdev/.gitignore — служебный каталог не попадает в git.');
    }
  } catch (error) {
    log.push(`[service-dir][error] Не удалось создать .onecdev/.gitignore: ${String(error)}`);
  }
  return log;
}
