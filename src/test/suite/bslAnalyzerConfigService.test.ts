import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BslAnalyzerConfigService,
  formatServiceExcludeLog,
  type ServiceExcludeReconcileResult,
} from '../../infra/environment/BslAnalyzerConfigService';
import { buildBslAnalyzerSourceConfig } from '../../infra/environment/BslAnalyzerToml';
import type { SourceExcludeSupport } from '../../infra/environment/BslAnalyzerVersion';

const lines = (...parts: string[]): string => parts.join('\n');

suite('BslAnalyzerConfigService', () => {
  let root: string;
  let service: BslAnalyzerConfigService;
  let configPath: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-bsl-analyzer-'));
    service = new BslAnalyzerConfigService(root);
    configPath = path.join(root, 'bsl-analyzer.toml');
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const evolc = (): string => path.join(root, 'src', 'cfe', 'EVOLC');
  const read = (): string => fs.readFileSync(configPath, 'utf-8');
  const write = (content: string): void => fs.writeFileSync(configPath, content, 'utf-8');

  /** Подменяет mtime в прошлое: так «файл не переписан» проверяется без ожидания тика ФС. */
  function backdate(): number {
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(configPath, past, past);
    return fs.statSync(configPath).mtimeMs;
  }

  test('по умолчанию поддержка exclude неизвестна и выставляется сеттером', () => {
    assert.strictEqual(service.sourceExcludeSupport, 'unknown');
    service.setSourceExcludeSupport('supported');
    assert.strictEqual(service.sourceExcludeSupport, 'supported');
  });

  test('getConfigPath — bsl-analyzer.toml в корне проекта', () => {
    assert.strictEqual(service.getConfigPath(), configPath);
  });

  for (const support of ['unknown', 'unsupported'] as const) {
    test(`ensureExists при ${support} создаёт прежний конфиг без exclude`, () => {
      service.setSourceExcludeSupport(support);
      service.ensureExists([evolc(), evolc(), path.join(root, '..', 'outside')]);
      assert.strictEqual(read(), buildBslAnalyzerSourceConfig(['src/cfe/EVOLC']));
    });
  }

  test('ensureExists при supported создаёт конфиг со служебным exclude (golden)', () => {
    service.setSourceExcludeSupport('supported');
    service.ensureExists([]);
    assert.strictEqual(read(), '[source]\nroot = "src/cf"\nexclude = [".onecdev"]\n');
  });

  test('ensureExists не трогает существующий файл', () => {
    write('# ручной\n');
    const mtime = backdate();
    service.setSourceExcludeSupport('supported');
    service.ensureExists([evolc()]);
    assert.strictEqual(read(), '# ручной\n');
    assert.strictEqual(fs.statSync(configPath).mtimeMs, mtime);
  });

  test('updateSource: нет файла — создаётся', () => {
    service.updateSource([evolc()]);
    assert.strictEqual(read(), buildBslAnalyzerSourceConfig(['src/cfe/EVOLC']));
  });

  test('updateSource при supported сохраняет пользовательские записи и добавляет служебный элемент', () => {
    write(lines('[source]', 'root = "old"', 'exclude = ["vendor"]', 'exclude_globs = ["*.tmp"]', '', '[diagnostics]', 'x = 1', ''));
    service.setSourceExcludeSupport('supported');
    service.updateSource([evolc()]);
    assert.strictEqual(read(), lines(
      '[source]', 'root = "src/cf"', '', 'extensions = [', '  "src/cfe/EVOLC",', ']',
      'exclude = ["vendor", ".onecdev"]', 'exclude_globs = ["*.tmp"]', '', '[diagnostics]', 'x = 1', ''
    ));
  });

  test('updateSource при unknown сохраняет exclude дословно и служебный не добавляет', () => {
    write(lines('[source]', 'root = "src/cf"', 'exclude = [ "vendor" ]', ''));
    service.updateSource([]);
    assert.strictEqual(read(), lines('[source]', 'root = "src/cf"', 'exclude = [ "vendor" ]', ''));
  });

  test('updateSource при unsupported удаляет служебный элемент', () => {
    write(lines('[source]', 'root = "src/cf"', 'exclude = ["vendor", ".onecdev"]', ''));
    service.setSourceExcludeSupport('unsupported');
    service.updateSource([]);
    assert.strictEqual(read(), lines('[source]', 'root = "src/cf"', 'exclude = ["vendor"]', ''));
  });

  test('updateSource без изменений файл не переписывает (mtime тот же)', () => {
    write(buildBslAnalyzerSourceConfig(['src/cfe/EVOLC']));
    const mtime = backdate();
    service.updateSource([evolc()]);
    assert.strictEqual(fs.statSync(configPath).mtimeMs, mtime);
  });

  test('updateSource при неподдерживаемом формате exclude меняет только root/extensions', () => {
    write(lines('[source]', 'root = "old"', 'exclude = "vendor"', ''));
    service.setSourceExcludeSupport('supported');
    service.updateSource([]);
    assert.strictEqual(read(), lines('[source]', 'root = "src/cf"', 'exclude = "vendor"', ''));
  });

  test('updateSource сохраняет BOM и CRLF побайтно', () => {
    write('﻿[source]\r\nroot = "old"\r\nexclude = ["vendor"]\r\n');
    service.setSourceExcludeSupport('supported');
    service.updateSource([]);
    assert.strictEqual(read(), '﻿[source]\r\nroot = "src/cf"\r\nexclude = ["vendor", ".onecdev"]\r\n');
  });

  test('reconcile: нет файла — skipped/no-config, файл не создаётся', () => {
    service.setSourceExcludeSupport('supported');
    assert.deepStrictEqual(service.reconcileServiceExclude(), { action: 'skipped', support: 'supported', reason: 'no-config' });
    assert.strictEqual(fs.existsSync(configPath), false);
  });

  test('reconcile при unknown — skipped/unknown-version, файл не изменён; ключ exclude отмечается', () => {
    write(lines('[source]', 'root = "src/cf"', ''));
    let mtime = backdate();
    assert.deepStrictEqual(service.reconcileServiceExclude(), {
      action: 'skipped', support: 'unknown', reason: 'unknown-version', userExcludeRemains: false,
    });
    assert.strictEqual(fs.statSync(configPath).mtimeMs, mtime);

    write(lines('[server]', 'port = 0', ''));
    assert.strictEqual(service.reconcileServiceExclude().userExcludeRemains, false);

    write(lines('[source]', 'exclude = [".onecdev"]', ''));
    mtime = backdate();
    assert.deepStrictEqual(service.reconcileServiceExclude(), {
      action: 'skipped', support: 'unknown', reason: 'unknown-version', userExcludeRemains: true,
    });
    assert.strictEqual(fs.statSync(configPath).mtimeMs, mtime);
  });

  test('reconcile при supported — added, повторно — unchanged без перезаписи', () => {
    write(lines('[source]', 'root = "src/cf"', ''));
    service.setSourceExcludeSupport('supported');
    assert.deepStrictEqual(service.reconcileServiceExclude(), { action: 'added', support: 'supported' });
    assert.strictEqual(read(), lines('[source]', 'root = "src/cf"', 'exclude = [".onecdev"]', ''));
    const mtime = backdate();
    assert.deepStrictEqual(service.reconcileServiceExclude(), { action: 'unchanged', support: 'supported' });
    assert.strictEqual(fs.statSync(configPath).mtimeMs, mtime);
  });

  test('reconcile при unsupported — removed; пользовательский exclude отмечается', () => {
    write(lines('[source]', 'exclude = [".onecdev"]', ''));
    service.setSourceExcludeSupport('unsupported');
    assert.deepStrictEqual(service.reconcileServiceExclude(), {
      action: 'removed', support: 'unsupported', userExcludeRemains: false,
    });
    assert.strictEqual(read(), '[source]\n');

    write(lines('[source]', 'exclude = ["vendor", ".onecdev"]', ''));
    assert.deepStrictEqual(service.reconcileServiceExclude(), {
      action: 'removed', support: 'unsupported', userExcludeRemains: true,
    });
    assert.strictEqual(read(), lines('[source]', 'exclude = ["vendor"]', ''));

    const mtime = backdate();
    assert.deepStrictEqual(service.reconcileServiceExclude(), {
      action: 'unchanged', support: 'unsupported', userExcludeRemains: true,
    });
    assert.strictEqual(fs.statSync(configPath).mtimeMs, mtime);
  });

  test('reconcile: неподдерживаемый формат — skipped/unsupported-format без записи', () => {
    write(lines('[source]', 'exclude = "x"', ''));
    const mtime = backdate();
    service.setSourceExcludeSupport('supported');
    const result = service.reconcileServiceExclude();
    assert.strictEqual(result.action, 'skipped');
    assert.strictEqual(result.reason, 'unsupported-format');
    assert.ok(result.detail);
    assert.strictEqual(fs.statSync(configPath).mtimeMs, mtime);
  });

  test('reconcile сохраняет BOM и CRLF побайтно', () => {
    write('﻿[server]\r\nport = 0\r\n\r\n[source]\r\nroot = "src/cf"\r\n');
    service.setSourceExcludeSupport('supported');
    service.reconcileServiceExclude();
    assert.strictEqual(read(), '﻿[server]\r\nport = 0\r\n\r\n[source]\r\nroot = "src/cf"\r\nexclude = [".onecdev"]\r\n');
  });

  const noProbe = (): Promise<string | undefined> => {
    throw new Error('проба не должна вызываться для автоскачанного сервера');
  };

  const installed: [string | undefined, SourceExcludeSupport, ServiceExcludeReconcileResult['action']][] = [
    ['v0.2.84', 'unsupported', 'removed'],
    ['v0.2.85', 'supported', 'unchanged'],
    ['v0.4.6', 'supported', 'unchanged'],
    [undefined, 'unknown', 'skipped'],
  ];
  for (const [version, support, action] of installed) {
    test(`prepareForStart: автоскачанный ${String(version)} → ${support}/${action}, проба не вызывается`, async () => {
      write(lines('[source]', 'exclude = [".onecdev"]', ''));
      const result = await service.prepareForStart(
        { execPath: '/x/bsl-analyzer', custom: false, installedVersion: version, projectInitialized: true },
        noProbe
      );
      assert.strictEqual(result.support, support);
      assert.strictEqual(result.action, action);
      assert.strictEqual(service.sourceExcludeSupport, support);
    });
  }

  test('prepareForStart: пользовательский путь — версия из пробы с execPath', async () => {
    write(lines('[source]', 'root = "src/cf"', ''));
    const probed: string[] = [];
    const probe = (execPath: string): Promise<string | undefined> => {
      probed.push(execPath);
      return Promise.resolve('bsl-analyzer 0.4.6\n');
    };
    const input = { execPath: '/opt/bsl', custom: true, installedVersion: 'v0.1.0', projectInitialized: true };
    assert.strictEqual((await service.prepareForStart(input, probe)).action, 'added');
    assert.deepStrictEqual(probed, ['/opt/bsl']);

    assert.strictEqual(
      (await service.prepareForStart(input, () => Promise.resolve('0.2.80'))).action,
      'removed'
    );
    assert.strictEqual(read(), lines('[source]', 'root = "src/cf"', ''));

    const unknown = await service.prepareForStart(input, () => Promise.resolve(undefined));
    assert.deepStrictEqual(unknown, { action: 'skipped', support: 'unknown', reason: 'unknown-version', userExcludeRemains: false });
  });

  test('prepareForStart: проект не инициализирован — skipped/not-initialized, файл не тронут, поддержка выставлена', async () => {
    const result = await service.prepareForStart(
      { execPath: '/x', custom: false, installedVersion: 'v0.4.6', projectInitialized: false },
      noProbe
    );
    assert.deepStrictEqual(result, { action: 'skipped', support: 'supported', reason: 'not-initialized' });
    assert.strictEqual(fs.existsSync(configPath), false);
    assert.strictEqual(service.sourceExcludeSupport, 'supported');

    service.ensureExists([]);
    assert.strictEqual(read(), '[source]\nroot = "src/cf"\nexclude = [".onecdev"]\n');
  });

  test('prepareForStart без инжектированной пробы использует реальную пробу пути', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const bin = path.join(root, 'bsl');
    fs.writeFileSync(bin, '#!/bin/sh\necho "bsl-analyzer 0.2.80"\n', { mode: 0o755 });
    write(lines('[source]', 'exclude = [".onecdev"]', ''));
    const result = await service.prepareForStart({ execPath: bin, custom: true, installedVersion: undefined, projectInitialized: true });
    assert.strictEqual(result.action, 'removed');
  });
});

suite('BslAnalyzerConfigService — formatServiceExcludeLog (issue #112)', () => {
  const cases: [ServiceExcludeReconcileResult, RegExp | undefined][] = [
    [{ action: 'added', support: 'supported' }, /^\[lsp\] .*\.onecdev/],
    [{ action: 'removed', support: 'unsupported', userExcludeRemains: false }, /^\[lsp\]\[warn\] .*0\.2\.85/],
    [{ action: 'removed', support: 'unsupported', userExcludeRemains: true }, /^\[lsp\]\[warn\] .*пользовательск/],
    [{ action: 'unchanged', support: 'supported' }, undefined],
    [{ action: 'unchanged', support: 'unsupported', userExcludeRemains: false }, undefined],
    [{ action: 'unchanged', support: 'unsupported', userExcludeRemains: true }, /^\[lsp\]\[warn\] .*пользовательск/],
    [{ action: 'skipped', support: 'supported', reason: 'no-config' }, /^\[lsp\] .*bsl-analyzer\.toml/],
    [{ action: 'skipped', support: 'supported', reason: 'not-initialized' }, /^\[lsp\] .*не инициализирован/],
    [{ action: 'skipped', support: 'unknown', reason: 'unknown-version', userExcludeRemains: false }, /^\[lsp\] .*не определена/],
    [{ action: 'skipped', support: 'unknown', reason: 'unknown-version', userExcludeRemains: true }, /^\[lsp\]\[warn\] .*exclude/],
    [{ action: 'skipped', support: 'supported', reason: 'unsupported-format', detail: 'ДЕТАЛЬ' }, /^\[lsp\]\[warn\] .*ДЕТАЛЬ/],
    [{ action: 'skipped', support: 'supported', reason: 'unsupported-format' }, /^\[lsp\]\[warn\] .*формат/],
  ];
  for (const [result, expected] of cases) {
    test(`${result.action}/${result.reason ?? '-'}/${String(result.userExcludeRemains)}/${result.support}`, () => {
      const line = formatServiceExcludeLog(result);
      if (expected) {
        assert.match(line ?? '', expected);
      } else {
        assert.strictEqual(line, undefined);
      }
    });
  }
});
