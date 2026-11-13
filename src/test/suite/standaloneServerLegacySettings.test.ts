import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StandaloneServerService } from '../../infra/standalone/StandaloneServerService';
import type { Logger } from '../../infra/support/Logger';

/** Журнал сервиса копится в массив: тест его не проверяет, но и не теряет. */
class TestLogger implements Logger {
  readonly lines: string[] = [];
  appendLine(message: string): void {
    this.lines.push(message);
  }
}

/**
 * Настройки автономного сервера, сохранённые до переименования v8vscedit → onecdev:
 * каталог `.v8vscedit/` переехал в `.onecdev/` целиком, но в `settings.json` остались
 * абсолютные пути старого каталога. Сервер обязан работать с перенесённой базой.
 */
suite('StandaloneServerService — настройки после переноса .v8vscedit → .onecdev', () => {
  let root: string;
  let serverRoot: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-standalone-'));
    serverRoot = path.join(root, '.onecdev', 'standalone-server');
    fs.mkdirSync(serverRoot, { recursive: true });
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeStored(settings: Record<string, unknown>): void {
    fs.writeFileSync(path.join(serverRoot, 'settings.json'), JSON.stringify(settings), 'utf-8');
  }

  function readSettings(): { dataPath: string; databasePath: string } {
    return new StandaloneServerService(root, new TestLogger()).getSettingsSnapshot().settings;
  }

  test('пути внутри .v8vscedit/standalone-server пересчитываются на .onecdev/standalone-server', () => {
    const legacyRoot = path.join(root, '.v8vscedit', 'standalone-server');
    writeStored({ dataPath: legacyRoot, databasePath: path.join(legacyRoot, 'моя-база') });

    const settings = readSettings();

    assert.strictEqual(settings.dataPath, serverRoot);
    assert.strictEqual(settings.databasePath, path.join(serverRoot, 'моя-база'));
    assert.ok(!fs.existsSync(path.join(root, '.v8vscedit')), 'чтение настроек не воссоздаёт старый каталог');
  });

  test('сгенерированная база по умолчанию (db-data) из старого каталога → db-data в новом', () => {
    const legacyRoot = path.join(root, '.v8vscedit', 'standalone-server');
    writeStored({ dataPath: legacyRoot, databasePath: path.join(legacyRoot, 'db-data') });
    assert.strictEqual(readSettings().databasePath, path.join(serverRoot, 'db-data'));
  });

  test('внешняя файловая база пользователя вне служебного каталога не меняется', () => {
    const external = path.join(root, 'bases', 'ТорговыйУчет');
    writeStored({ dataPath: path.join(root, '.v8vscedit', 'standalone-server'), databasePath: external });
    assert.strictEqual(readSettings().databasePath, external);
  });

  test('путь к базе не сохранён — берётся база по умолчанию в новом каталоге', () => {
    writeStored({ httpPort: 8314 });
    const settings = readSettings();
    assert.strictEqual(settings.dataPath, serverRoot);
    assert.strictEqual(settings.databasePath, path.join(serverRoot, 'db-data'));
  });
});
