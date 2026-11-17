import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createProjectDirectories,
  ensureGitignore,
  ensureProjectDirectoryIsEmpty,
} from '../../ui/commands/project/InitializeProjectCommand';

suite('initializeProjectCommand', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-init-'));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('разрешает инициализацию только в пустом каталоге', () => {
    assert.doesNotThrow(() => ensureProjectDirectoryIsEmpty(root));

    fs.writeFileSync(path.join(root, 'env.json'), '{}', 'utf-8');

    assert.throws(
      () => ensureProjectDirectoryIsEmpty(root),
      /Каталог проекта не пуст/
    );
  });

  test('создаются только каталоги, которыми пользуется расширение, без каркаса vanessa-bootstrap (#107)', () => {
    createProjectDirectories(root);

    const created: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        created.push(path.relative(root, full).split(path.sep).join('/'));
        walk(full);
      }
    };
    walk(root);

    assert.deepStrictEqual(created.sort(), ['.vscode', 'src', 'src/cf', 'src/cfe']);
  });

  test('.gitignore не скрывает каталоги, куда ставятся ИИ-роли (#107)', () => {
    ensureGitignore(root);

    const rules = fs.readFileSync(path.join(root, '.gitignore'), 'utf-8').split('\n').map((line) => line.trim());
    for (const rolesDir of ['.cursor/', '.codex/', '.claude/']) {
      assert.ok(!rules.includes(rolesDir), `${rolesDir} не должен быть в .gitignore:\n${rules.join('\n')}`);
    }
    assert.ok(rules.includes('env.json'));
    assert.ok(rules.includes('.onecdev/'));
  });

  test('.gitignore: существующие правила не дублируются, недостающие дописываются блоком', () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\nenv.json', 'utf-8');

    ensureGitignore(root);
    const once = fs.readFileSync(path.join(root, '.gitignore'), 'utf-8');
    ensureGitignore(root);

    assert.strictEqual(fs.readFileSync(path.join(root, '.gitignore'), 'utf-8'), once, 'повторный вызов файл не меняет');
    assert.ok(once.startsWith('node_modules/\nenv.json\n\n# Локальные настройки'), once);
    assert.strictEqual(once.split('\n').filter((line) => line === 'env.json').length, 1);
  });
});
