import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LEGACY_SERVICE_DIR_NAME,
  migrateLegacyServiceDir,
  runLegacyServiceDirMigration,
  SERVICE_DIR_NAME,
} from '../../infra/fs/LegacyServiceDirMigration';

/**
 * Перенос служебного каталога `.v8vscedit` → `.onecdev` после переименования расширения:
 * на реальных временных каталогах, состояние хранилища обязано переехать без потерь.
 */
suite('LegacyServiceDirMigration — перенос .v8vscedit → .onecdev', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-legacy-dir-'));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('старого каталога нет — not-needed, ничего не создаётся', () => {
    assert.strictEqual(migrateLegacyServiceDir(root), 'not-needed');
    assert.ok(!fs.existsSync(path.join(root, SERVICE_DIR_NAME)));
  });

  test('только старый каталог — переносится целиком вместе с состоянием хранилища', () => {
    const stateFile = path.join(root, LEGACY_SERVICE_DIR_NAME, 'repository', 'state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, '{"locks":["Справочник.Контрагенты"]}', 'utf-8');

    assert.strictEqual(migrateLegacyServiceDir(root), 'migrated');

    assert.ok(!fs.existsSync(path.join(root, LEGACY_SERVICE_DIR_NAME)));
    assert.strictEqual(
      fs.readFileSync(path.join(root, SERVICE_DIR_NAME, 'repository', 'state.json'), 'utf-8'),
      '{"locks":["Справочник.Контрагенты"]}'
    );
  });

  test('есть оба каталога — conflict, ни один не тронут', () => {
    fs.mkdirSync(path.join(root, LEGACY_SERVICE_DIR_NAME, 'cache'), { recursive: true });
    fs.mkdirSync(path.join(root, SERVICE_DIR_NAME, 'meta'), { recursive: true });

    assert.strictEqual(migrateLegacyServiceDir(root), 'conflict');

    assert.ok(fs.existsSync(path.join(root, LEGACY_SERVICE_DIR_NAME, 'cache')));
    assert.ok(fs.existsSync(path.join(root, SERVICE_DIR_NAME, 'meta')));
  });
});

suite('LegacyServiceDirMigration — журнал переноса при активации', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-legacy-log-'));
  });

  teardown(() => {
    fs.chmodSync(root, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('переносить нечего — журнал пуст', () => {
    assert.deepStrictEqual(runLegacyServiceDirMigration(root), []);
  });

  test('перенос и .onecdev/.gitignore — две записи журнала, пользовательский .gitignore не тронут', () => {
    fs.mkdirSync(path.join(root, LEGACY_SERVICE_DIR_NAME));
    fs.writeFileSync(path.join(root, '.gitignore'), '.v8vscedit/\n', 'utf-8');
    assert.deepStrictEqual(runLegacyServiceDirMigration(root), [
      '[migration] Служебный каталог .v8vscedit перенесён в .onecdev.',
      '[service-dir] Создан .onecdev/.gitignore — служебный каталог не попадает в git.',
    ]);
    assert.strictEqual(fs.readFileSync(path.join(root, '.gitignore'), 'utf-8'), '.v8vscedit/\n');
  });

  test('оба каталога — предупреждение, без ошибки', () => {
    fs.mkdirSync(path.join(root, LEGACY_SERVICE_DIR_NAME));
    fs.mkdirSync(path.join(root, SERVICE_DIR_NAME));
    assert.deepStrictEqual(runLegacyServiceDirMigration(root), [
      '[migration][warn] Найдены и .v8vscedit, и .onecdev — используется .onecdev, .v8vscedit не тронут.',
      '[service-dir] Создан .onecdev/.gitignore — служебный каталог не попадает в git.',
    ]);
  });

  test('переименование отказано файловой системой — ошибка в журнале, исключение не уходит наружу', function () {
    // Запрет записи в корень даёт настоящий отказ rename; у администратора/на Windows
    // права каталога его не ограничивают — проверять там нечего.
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      this.skip();
    }
    fs.mkdirSync(path.join(root, LEGACY_SERVICE_DIR_NAME));
    fs.chmodSync(root, 0o555);
    const log = runLegacyServiceDirMigration(root);
    assert.strictEqual(log.length, 1);
    assert.ok(log[0].startsWith('[migration][error] Не удалось перенести .v8vscedit в .onecdev: '), log[0]);
    assert.ok(fs.existsSync(path.join(root, LEGACY_SERVICE_DIR_NAME)), 'старый каталог не потерян');
  });

  test('.onecdev/.gitignore не создаётся из-за прав — ошибка в журнале, исключение не уходит наружу', function () {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      this.skip();
    }
    const serviceDir = path.join(root, SERVICE_DIR_NAME);
    fs.mkdirSync(serviceDir);
    fs.chmodSync(serviceDir, 0o555);
    try {
      const log = runLegacyServiceDirMigration(root);
      assert.strictEqual(log.length, 1);
      assert.ok(log[0].startsWith('[service-dir][error] Не удалось создать .onecdev/.gitignore: '), log[0]);
    } finally {
      fs.chmodSync(serviceDir, 0o755);
    }
  });
});
