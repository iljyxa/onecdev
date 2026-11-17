import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BSL_ANALYZER_SOURCE_EXCLUDE_MIN_VERSION,
  compareBslAnalyzerVersions,
  parseBslAnalyzerVersion,
  probeBslAnalyzerVersion,
  resolveSourceExcludeSupport,
} from '../../infra/environment/BslAnalyzerVersion';

/**
 * Issue #112 — версия bsl-analyzer решает, можно ли писать `[source].exclude`:
 * разбор конфига строгий, и версия < 0.2.85 с этим ключом проект не загрузит.
 */
suite('BslAnalyzerVersion — разбор и сравнение версий (issue #112)', () => {
  const parsed: [string | undefined, [number, number, number] | undefined][] = [
    ['v0.4.6', [0, 4, 6]],
    ['0.2.85', [0, 2, 85]],
    // Реальный вывод `--version` загрузчика v0.4.6: первая строка — основной бинарь.
    ['bsl-analyzer 0.4.6\nbsl-analyzer-launcher 0.4.6\n', [0, 4, 6]],
    ['bsl-analyzer-app v1.0.0-rc1', [1, 0, 0]],
    ['', undefined],
    [undefined, undefined],
    ['garbage', undefined],
    ['1.2', undefined],
  ];
  for (const [text, expected] of parsed) {
    test(`parseBslAnalyzerVersion(${JSON.stringify(text)})`, () => {
      const result = parseBslAnalyzerVersion(text);
      assert.deepStrictEqual(
        result,
        expected ? { major: expected[0], minor: expected[1], patch: expected[2] } : undefined
      );
    });
  }

  const v = (major: number, minor: number, patch: number) => ({ major, minor, patch });
  test('compareBslAnalyzerVersions сравнивает покомпонентно и численно', () => {
    assert.ok(compareBslAnalyzerVersions(v(0, 2, 84), v(0, 2, 85)) < 0);
    assert.ok(compareBslAnalyzerVersions(v(0, 2, 86), v(0, 2, 85)) > 0);
    assert.ok(compareBslAnalyzerVersions(v(0, 1, 99), v(0, 2, 0)) < 0);
    assert.ok(compareBslAnalyzerVersions(v(0, 3, 0), v(0, 2, 99)) > 0);
    assert.ok(compareBslAnalyzerVersions(v(0, 99, 99), v(1, 0, 0)) < 0);
    assert.ok(compareBslAnalyzerVersions(v(2, 0, 0), v(1, 9, 9)) > 0);
    assert.strictEqual(compareBslAnalyzerVersions(v(0, 2, 85), v(0, 2, 85)), 0);
    assert.ok(compareBslAnalyzerVersions(v(0, 10, 0), v(0, 9, 0)) > 0);
  });

  const support: [string | undefined, string][] = [
    ['v0.2.84', 'unsupported'],
    ['0.1.0', 'unsupported'],
    ['v0.2.85', 'supported'],
    [BSL_ANALYZER_SOURCE_EXCLUDE_MIN_VERSION, 'supported'],
    ['0.3.0', 'supported'],
    ['v0.4.6', 'supported'],
    ['v1.0.0', 'supported'],
    [undefined, 'unknown'],
    ['мусор', 'unknown'],
  ];
  for (const [text, expected] of support) {
    test(`resolveSourceExcludeSupport(${JSON.stringify(text)}) = ${expected}`, () => {
      assert.strictEqual(resolveSourceExcludeSupport(text), expected);
    });
  }
});

suite('BslAnalyzerVersion — проба `--version` пользовательского бинарника (issue #112)', () => {
  let tempRoot: string;

  setup(function () {
    // Подменные бинарники — shell-скрипты; на Windows их не исполнить.
    if (process.platform === 'win32') {
      this.skip();
    }
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-bsl-probe-'));
  });

  teardown(() => {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  function script(name: string, body: string): string {
    const file = path.join(tempRoot, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  }

  test('код 0 и версия в stdout — возвращается stdout', async () => {
    const bin = script('ok', 'if [ "$1" = "--version" ]; then echo "bsl-analyzer 0.4.6"; echo "bsl-analyzer-launcher 0.4.6"; fi');
    const text = await probeBslAnalyzerVersion(bin);
    assert.ok(text?.startsWith('bsl-analyzer 0.4.6'), String(text));
    assert.strictEqual(resolveSourceExcludeSupport(text), 'supported');
  });

  test('ненулевой код — undefined', async () => {
    assert.strictEqual(await probeBslAnalyzerVersion(script('fail', 'echo 0.4.6; exit 2')), undefined);
  });

  test('несуществующий путь — undefined без исключения', async () => {
    assert.strictEqual(await probeBslAnalyzerVersion(path.join(tempRoot, 'missing')), undefined);
  });

  test('зависший процесс — undefined по таймауту, без ожидания завершения', async () => {
    const bin = script('hang', 'sleep 10');
    const startedAt = Date.now();
    assert.strictEqual(await probeBslAnalyzerVersion(bin, { timeoutMs: 200 }), undefined);
    assert.ok(Date.now() - startedAt < 2000, `проба заняла ${String(Date.now() - startedAt)} мс`);
  });

  test('stdin пробы закрыт сразу — читающий stdin процесс не зависает', async () => {
    const text = await probeBslAnalyzerVersion(script('stdin', 'cat >/dev/null; echo 0.4.6'), { timeoutMs: 3000 });
    assert.strictEqual(text?.trim(), '0.4.6');
  });
});
