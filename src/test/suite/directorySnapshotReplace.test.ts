import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { syncDirectorySnapshot } from '../../infra/agent/DirectorySnapshot';
import { buildSnapshotBackupDirName, isWorkspaceServicePath } from '../../infra/fs/WorkspaceTempDir';
import { skipWithoutCorpus } from './support/corpus';

/**
 * #124: раннер операций Конфигуратора держал частную копию замены снимка, разошедшуюся с
 * общей (`infra/agent/DirectorySnapshot`) в откате; формат имени бэкапа жил строкой в двух
 * местах и отдельной регуляркой в `WorkspaceTempDir`. Теперь путь один. Фикстура — реальное
 * расширение EVOLC (как выгрузка расширения из базы) во временном каталоге.
 */
const EVOLC = path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC');

function listFiles(dir: string): string[] {
  const result: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        result.push(path.relative(dir, full));
      }
    }
  };
  walk(dir);
  return result.sort();
}

suite('syncDirectorySnapshot — общий путь замены снимка (#124)', () => {
  let root: string;
  const lockedDirs: string[] = [];

  suiteSetup(function () {
    skipWithoutCorpus(this);
  });

  setup(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-snapshot-')));
  });

  teardown(() => {
    for (const dir of lockedDirs.splice(0)) {
      fs.chmodSync(dir, 0o700);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  function prepare(): { source: string; target: string } {
    const source = path.join(root, '.onecdev', 'import-temp', 'import-cfe-1', 'cfe');
    const target = path.join(root, 'src', 'cfe', 'EVOLC');
    fs.cpSync(EVOLC, source, { recursive: true });
    fs.cpSync(EVOLC, target, { recursive: true });
    // В проекте лишний файл: снимок базы его не содержит — после синхронизации его быть не должно.
    fs.writeFileSync(path.join(target, 'Catalogs', 'Лишний.xml'), '<x/>', 'utf-8');
    fs.writeFileSync(path.join(source, 'Catalogs', 'Новый.xml'), '<y/>', 'utf-8');
    return { source, target };
  }

  test('атомарная замена: цель = снимок; бэкап (удаляется в фоне) — служебный путь для watcher\'ов', () => {
    const { source, target } = prepare();
    const expected = listFiles(source);
    syncDirectorySnapshot(source, target);
    assert.deepStrictEqual(listFiles(target), expected);
    assert.strictEqual(fs.existsSync(source), false, 'снимок переносится, а не копируется');
    // Бэкап удаляется асинхронно; пока он есть, его события не должны считаться правками конфигурации.
    for (const name of fs.readdirSync(path.dirname(target)).filter((item) => item !== 'EVOLC')) {
      assert.strictEqual(isWorkspaceServicePath(root, path.join(path.dirname(target), name, 'Configuration.xml')), true, name);
    }
  });

  test('перенос снимка невозможен (EACCES) — цель восстановлена из бэкапа и синхронизирована копированием', function () {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      this.skip();
    }
    const { source, target } = prepare();
    const expected = listFiles(source);
    // Родитель снимка без права записи: rename снимка в цель отбивается EACCES уже после того,
    // как цель ушла в бэкап — раннер обязан вернуть цель и перейти к копированию.
    const sourceParent = path.dirname(source);
    fs.chmodSync(sourceParent, 0o500);
    lockedDirs.push(sourceParent);

    syncDirectorySnapshot(source, target);

    assert.deepStrictEqual(listFiles(target), expected);
    assert.strictEqual(fs.existsSync(path.join(target, 'Catalogs', 'Лишний.xml')), false, 'лишний файл проекта удалён');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(target)).filter((name) => name.includes('onecdev-backup')), [], 'бэкап не брошен');
  });

  test('имя бэкапа из buildSnapshotBackupDirName распознаётся как служебный путь, соседние имена — нет', () => {
    const name = buildSnapshotBackupDirName('cf', 4242, 1763300000000);
    assert.strictEqual(name, '.cf.onecdev-backup-4242-1763300000000');
    assert.strictEqual(isWorkspaceServicePath(root, path.join(root, 'src', name, 'Configuration.xml')), true);
    assert.strictEqual(isWorkspaceServicePath(root, path.join(root, 'src', '.cfXonecdevXbackup-1-2', 'Configuration.xml')), false);
  });
});
