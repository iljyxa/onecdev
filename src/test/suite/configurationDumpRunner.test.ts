import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildScopeKey, computeFileHash, loadHashCache } from '../../infra/cache/HashCache';
import {
  buildExportToTempCliArgs,
  refreshConfigurationHashCache,
  runDecompileExtension,
  runDecompileMainConfiguration,
} from '../../ui/commands/ext/ExtensionCommandRunner';
import { cliPath } from './support/cfeBatchFixtures';

/**
 * `buildExportToTempCliArgs` — чистая сборка аргументов для уже существующего
 * внутреннего CLI `export-configuration` (`cli/commands/export-configuration.ts`) —
 * тот же `-ProjectRoot/-Target/-ConfigDir/-Mode/-Objects/-Extension` конвейер, что
 * раньше использовал удалённый `ExtensionCommandRunner.runBatchPartialDump`, только
 * с новыми значениями `-Mode` `UpdateInfo`/`Full` вместо единственного прежнего
 * `Partial`. Реальный запуск процесса (`dumpConfigurationToTemp`) не тестируется
 * здесь — согласно плану архитектора это единственная сознательно помеченная
 * c8-ignore ветка нового файла (внешний процесс, недоступный в CI).
 */
suite('ConfigurationDumpRunner — buildExportToTempCliArgs', () => {
  const cfTarget = { kind: 'cf' as const, name: 'ТорговыйУчет', rootPath: '/proj/src/cf' };
  const cfeTarget = { kind: 'cfe' as const, name: 'EVOLC', rootPath: '/proj/src/cfe/EVOLC', extensionName: 'EVOLC' };
  const connectionArgs = ['-S', 'server/ref', '-N', 'user'];

  test('mode "partial" (cf): -Mode Partial + -Objects из fullNames через запятую, без -Extension', () => {
    const args = buildExportToTempCliArgs(
      cfTarget,
      { mode: 'partial', fullNames: ['Справочник.Товары', 'Документ.Заказ'] },
      '/tmp/dump-1',
      '/proj',
      connectionArgs
    );
    assert.deepStrictEqual(args, [
      'export-configuration',
      '-ProjectRoot', '/proj',
      '-Target', 'cf',
      '-ConfigDir', '/tmp/dump-1',
      '-Mode', 'Partial',
      '-Objects', 'Справочник.Товары,Документ.Заказ',
      '-S', 'server/ref',
      '-N', 'user',
    ]);
  });

  test('mode "partial" (cfe): дополнительно вставляется -Extension перед аргументами подключения', () => {
    const args = buildExportToTempCliArgs(
      cfeTarget,
      { mode: 'partial', fullNames: ['Справочник.Товары'] },
      '/tmp/dump-2',
      '/proj',
      connectionArgs
    );
    assert.deepStrictEqual(args, [
      'export-configuration',
      '-ProjectRoot', '/proj',
      '-Target', 'cfe',
      '-ConfigDir', '/tmp/dump-2',
      '-Mode', 'Partial',
      '-Objects', 'Справочник.Товары',
      '-Extension', 'EVOLC',
      '-S', 'server/ref',
      '-N', 'user',
    ]);
  });

  test('mode "update-info" (cf): -Mode UpdateInfo, без -Objects', () => {
    const args = buildExportToTempCliArgs(cfTarget, { mode: 'update-info' }, '/tmp/dump-3', '/proj', connectionArgs);
    assert.deepStrictEqual(args, [
      'export-configuration',
      '-ProjectRoot', '/proj',
      '-Target', 'cf',
      '-ConfigDir', '/tmp/dump-3',
      '-Mode', 'UpdateInfo',
      '-S', 'server/ref',
      '-N', 'user',
    ]);
  });

  test('mode "update-info" (cfe): -Extension присутствует, -Objects отсутствует', () => {
    const args = buildExportToTempCliArgs(cfeTarget, { mode: 'update-info' }, '/tmp/dump-4', '/proj', connectionArgs);
    assert.deepStrictEqual(args, [
      'export-configuration',
      '-ProjectRoot', '/proj',
      '-Target', 'cfe',
      '-ConfigDir', '/tmp/dump-4',
      '-Mode', 'UpdateInfo',
      '-Extension', 'EVOLC',
      '-S', 'server/ref',
      '-N', 'user',
    ]);
  });

  test('mode "full" (cf): -Mode Full, без -Objects', () => {
    const args = buildExportToTempCliArgs(cfTarget, { mode: 'full' }, '/tmp/dump-5', '/proj', connectionArgs);
    assert.deepStrictEqual(args, [
      'export-configuration',
      '-ProjectRoot', '/proj',
      '-Target', 'cf',
      '-ConfigDir', '/tmp/dump-5',
      '-Mode', 'Full',
      '-S', 'server/ref',
      '-N', 'user',
    ]);
  });

  test('mode "full" (cfe): -Extension присутствует', () => {
    const args = buildExportToTempCliArgs(cfeTarget, { mode: 'full' }, '/tmp/dump-6', '/proj', connectionArgs);
    assert.deepStrictEqual(args, [
      'export-configuration',
      '-ProjectRoot', '/proj',
      '-Target', 'cfe',
      '-ConfigDir', '/tmp/dump-6',
      '-Mode', 'Full',
      '-Extension', 'EVOLC',
      '-S', 'server/ref',
      '-N', 'user',
    ]);
  });

  test('partial с пустым fullNames — -Objects всё равно передаётся пустой строкой (вызывающая сторона отвечает за непустоту списка)', () => {
    const args = buildExportToTempCliArgs(cfTarget, { mode: 'partial', fullNames: [] }, '/tmp/dump-7', '/proj', []);
    assert.deepStrictEqual(args, [
      'export-configuration',
      '-ProjectRoot', '/proj',
      '-Target', 'cf',
      '-ConfigDir', '/tmp/dump-7',
      '-Mode', 'Partial',
      '-Objects', '',
    ]);
  });

  test('пустой connectionArgs не добавляет лишних элементов', () => {
    const args = buildExportToTempCliArgs(cfTarget, { mode: 'full' }, '/tmp/dump-8', '/proj', []);
    assert.deepStrictEqual(args, [
      'export-configuration',
      '-ProjectRoot', '/proj',
      '-Target', 'cf',
      '-ConfigDir', '/tmp/dump-8',
      '-Mode', 'Full',
    ]);
  });
});

suite('Полная выгрузка из базы — общий CLI импорта и обновления из хранилища (#192)', () => {
  let root: string;
  let workspace: vscode.WorkspaceFolder;
  let output: vscode.OutputChannel;
  let lines: string[];

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-full-export-'));
    workspace = { uri: vscode.Uri.file(root), name: 'Тест', index: 0 };
    lines = [];
    output = { appendLine: (line: string) => { lines.push(line); } } as vscode.OutputChannel;
    const cliDir = path.join(root, 'dist', 'cli');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.copyFileSync(cliPath(), path.join(cliDir, 'onec-tools.js'));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const kind of ['cf', 'cfe'] as const) {
    test(`импорт ${kind}: экспортирует весь объект во временный каталог`, async () => {
      const extension = 'EVOLC';
      const configRoot = kind === 'cf' ? path.join(root, 'src', 'cf') : path.join(root, 'src', 'cfe', extension);
      fs.mkdirSync(configRoot, { recursive: true });
      fs.writeFileSync(path.join(root, 'env.json'), JSON.stringify({
        default: { '--ibconnection': '/Ffake', '--path': path.join(root, 'missing', '1cv8') },
      }));
      const ok = kind === 'cf'
        ? await runDecompileMainConfiguration('ТорговыйУчет', configRoot, workspace, output)
        : await runDecompileExtension(extension, configRoot, workspace, output);

      assert.strictEqual(ok, false);
      const start = lines.find((line) => line.includes(' export-configuration '));
      assert.ok(start, lines.join('\n'));
      assert.ok(start.includes(`-Target ${kind} -ConfigDir `), start);
      assert.match(start, kind === 'cf' ? /-Mode Full (?!-Extension)/ : /-Mode Full -Extension EVOLC /);
      assert.ok(!start.includes('-Objects'), start);
    });
  }

  for (const writable of [true, false]) {
    test(`актуализация кэша возвращает ${String(writable)} по результату CLI`, async () => {
      const configRoot = path.join(root, 'src', 'cf');
      const example = path.resolve(__dirname, '../../../example/2.21/src/cf');
      fs.cpSync(example, configRoot, { recursive: true });
      if (!writable) {
        fs.mkdirSync(path.join(root, '.onecdev'));
        fs.writeFileSync(path.join(root, '.onecdev', 'cache'), '');
      }

      assert.strictEqual(await refreshConfigurationHashCache('cf', '', configRoot, workspace, output), writable);
      if (writable) {
        const cache = loadHashCache(root, buildScopeKey('cf', configRoot));
        assert.strictEqual(cache.files['Configuration.xml'], computeFileHash(path.join(configRoot, 'Configuration.xml')));
      } else {
        assert.match(lines.join('\n'), /Не удалось обновить кэш выгрузки/);
      }
    });
  }
});
