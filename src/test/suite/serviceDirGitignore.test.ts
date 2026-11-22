import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runLegacyServiceDirMigration } from '../../infra/fs/LegacyServiceDirMigration';
import {
  createImportTempDir,
  ensureServiceDirSelfIgnored,
  ensureWorkspaceServiceDirIgnored,
  isWorkspaceServicePath,
  mkdirInsideServiceDir,
  SERVICE_DIR_GITIGNORE_CONTENT,
} from '../../infra/fs/WorkspaceTempDir';

/**
 * Issue #194 — служебный `.onecdev/` игнорирует сам себя собственным `.gitignore`
 * с `*`: пользовательский `.gitignore` не нужен и не трогается.
 */
suite('Служебный каталог .onecdev — самоигнорирование в git (#194)', () => {
  let root: string;
  let serviceDir: string;
  let ignoreFile: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-service-ignore-'));
    serviceDir = path.join(root, '.onecdev');
    ignoreFile = path.join(serviceDir, '.gitignore');
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('создание вложенного каталога создаёт и .onecdev/.gitignore с *', () => {
    const dir = path.join(serviceDir, 'meta');
    mkdirInsideServiceDir(dir);

    assert.ok(fs.statSync(dir).isDirectory());
    assert.strictEqual(fs.readFileSync(ignoreFile, 'utf-8'), SERVICE_DIR_GITIGNORE_CONTENT);
    assert.ok(SERVICE_DIR_GITIGNORE_CONTENT.split('\n').includes('*'));
  });

  test('создание самого .onecdev тоже кладёт .gitignore', () => {
    mkdirInsideServiceDir(serviceDir);
    assert.strictEqual(fs.readFileSync(ignoreFile, 'utf-8'), SERVICE_DIR_GITIGNORE_CONTENT);
  });

  test('существующий .gitignore не перезаписывается', () => {
    fs.mkdirSync(serviceDir);
    fs.writeFileSync(ignoreFile, 'своё\n', 'utf-8');

    mkdirInsideServiceDir(path.join(serviceDir, 'cache'));
    assert.strictEqual(ensureServiceDirSelfIgnored(serviceDir), false);
    assert.strictEqual(ensureWorkspaceServiceDirIgnored(root), false);

    assert.strictEqual(fs.readFileSync(ignoreFile, 'utf-8'), 'своё\n');
  });

  test('каталог вне .onecdev создаётся без .gitignore', () => {
    const dir = path.join(root, 'server-data', 'db');
    mkdirInsideServiceDir(dir);

    assert.ok(fs.statSync(dir).isDirectory());
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'server-data')), ['db']);
  });

  test('активация: существующий .onecdev без .gitignore получает его, повтор — без изменений', () => {
    fs.mkdirSync(path.join(serviceDir, 'repository'), { recursive: true });

    assert.strictEqual(ensureWorkspaceServiceDirIgnored(root), true);
    assert.strictEqual(fs.readFileSync(ignoreFile, 'utf-8'), SERVICE_DIR_GITIGNORE_CONTENT);
    assert.strictEqual(ensureWorkspaceServiceDirIgnored(root), false);
  });

  test('активация вне проекта 1С не создаёт .onecdev', () => {
    assert.strictEqual(ensureWorkspaceServiceDirIgnored(root), false);
    assert.ok(!fs.existsSync(serviceDir));
  });

  test('активация после переноса .v8vscedit — .gitignore в перенесённом каталоге, пользовательский не тронут', () => {
    fs.mkdirSync(path.join(root, '.v8vscedit', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), '.v8vscedit/\n', 'utf-8');

    const log = runLegacyServiceDirMigration(root);

    assert.ok(log.some((line) => line.includes('.onecdev/.gitignore')));
    assert.strictEqual(fs.readFileSync(ignoreFile, 'utf-8'), SERVICE_DIR_GITIGNORE_CONTENT);
    assert.strictEqual(fs.readFileSync(path.join(root, '.gitignore'), 'utf-8'), '.v8vscedit/\n');
  });

  test('сбой записи, отличный от EEXIST, пробрасывается', () => {
    assert.throws(() => ensureServiceDirSelfIgnored(serviceDir), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  });

  test('createImportTempDir создаёт .onecdev/.gitignore', () => {
    createImportTempDir(root, 'cf-');
    assert.strictEqual(fs.readFileSync(ignoreFile, 'utf-8'), SERVICE_DIR_GITIGNORE_CONTENT);
  });

  test('.onecdev/.gitignore — служебный путь для watcher\'ов', () => {
    assert.ok(isWorkspaceServicePath(root, ignoreFile));
  });

  test('git без пользовательского .gitignore игнорирует содержимое .onecdev и сам .gitignore', () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirInsideServiceDir(path.join(serviceDir, 'meta'));
    fs.writeFileSync(path.join(serviceDir, 'meta', 'x.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(root, 'Configuration.xml'), '<x/>', 'utf-8');

    // check-ignore завершается кодом 0 только для игнорируемого пути.
    execFileSync('git', ['check-ignore', '-q', '.onecdev/meta/x.json'], { cwd: root });
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf-8' });
    assert.strictEqual(status.trim(), '?? Configuration.xml');
  });
});
