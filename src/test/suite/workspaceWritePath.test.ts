import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveWritePathInsideRoot } from '../../infra/fs/WorkspaceWritePath';

/**
 * #174: путь записи от недоверенного клиента (MCP) обязан лежать внутри корня workspace.
 * Проверка — на реальных временных каталогах, включая симлинк наружу.
 */
suite('resolveWritePathInsideRoot — запись только внутри workspace (#174)', () => {
  let sandbox: string;
  let root: string;
  let outside: string;

  setup(() => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-write-path-')));
    root = path.join(sandbox, 'ws');
    outside = path.join(sandbox, 'outside');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(outside);
  });

  teardown(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('абсолютный путь внутри workspace (в том числе ещё не существующий) возвращается нормализованным', () => {
    const target = path.join(root, 'src', 'new', '..', 'epf');
    assert.strictEqual(resolveWritePathInsideRoot(target, root), path.join(root, 'src', 'epf'));
  });

  test('сам корень workspace допустим', () => {
    assert.strictEqual(resolveWritePathInsideRoot(root, root), root);
  });

  test('относительный путь отсчитывается от корня workspace, а не от cwd процесса', () => {
    assert.strictEqual(resolveWritePathInsideRoot(path.join('src', 'epf'), root), path.join(root, 'src', 'epf'));
  });

  test('абсолютный путь вне workspace отклоняется с понятной причиной', () => {
    assert.throws(
      () => resolveWritePathInsideRoot(path.join(outside, 'x'), root),
      (error: unknown) => error instanceof Error
        && error.message.includes(path.join(outside, 'x'))
        && error.message.includes(root)
        && error.message.includes('вне рабочего пространства'),
    );
  });

  test('выход через «..» отклоняется', () => {
    assert.throws(() => resolveWritePathInsideRoot(path.join('..', 'outside', 'x'), root), /вне рабочего пространства/);
  });

  test('соседний каталог с общим префиксом имени («ws-evil») не считается вложенным', () => {
    assert.throws(() => resolveWritePathInsideRoot(`${root}-evil`, root), /вне рабочего пространства/);
  });

  test('корень ФС как workspace: разделитель в конце корня не удваивается', () => {
    const fsRoot = path.parse(root).root;
    assert.strictEqual(resolveWritePathInsideRoot(root, fsRoot), root);
  });

  test('пустой путь отклоняется', () => {
    assert.throws(() => resolveWritePathInsideRoot('  ', root), /не задан/);
  });

  test('симлинк внутри workspace, ведущий наружу, отклоняется (и для несуществующего хвоста)', function () {
    const link = path.join(root, 'escape');
    try {
      fs.symlinkSync(outside, link, 'dir');
    } catch {
      // На Windows без прав разработчика симлинк не создать — сценарий там не воспроизводим.
      this.skip();
    }
    assert.throws(() => resolveWritePathInsideRoot(path.join(link, 'new', 'file.cf'), root), /вне рабочего пространства/);
  });

  test('висячий симлинк внутри workspace отклоняется, а не проверяется лексически', function () {
    const link = path.join(root, 'dangling');
    try {
      fs.symlinkSync(path.join(outside, 'absent'), link, 'dir');
    } catch {
      this.skip();
    }
    assert.throws(() => resolveWritePathInsideRoot(path.join(link, 'file.cf'), root));
  });

  test('корень workspace, заданный через симлинк, сравнивается по реальному пути', function () {
    const linkedRoot = path.join(sandbox, 'ws-link');
    try {
      fs.symlinkSync(root, linkedRoot, 'dir');
    } catch {
      this.skip();
    }
    const target = path.join(root, 'src', 'epf');
    assert.strictEqual(resolveWritePathInsideRoot(target, linkedRoot), target);
  });

  test('на регистронезависимой ФС регистр букв пути не влияет на вложенность', () => {
    const target = path.join(root.toUpperCase(), 'src');
    assert.strictEqual(resolveWritePathInsideRoot(target, root, 'win32'), path.resolve(target));
    assert.throws(() => resolveWritePathInsideRoot(target, root, 'linux'), /вне рабочего пространства/);
  });
});
