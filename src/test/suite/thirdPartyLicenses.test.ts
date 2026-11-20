import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { importEsmModule } from './support/importEsm';

/**
 * Тесты сборки THIRD_PARTY_LICENSES (#115): `scripts/third-party-licenses/thirdPartyLicenses.mjs`
 * вызывается Vite-плагином из `vite.shared.ts` по модулям, фактически попавшим в бандл. Плагин —
 * тонкая обёртка над хуками сборщика, вся логика (поиск корня пакета, чтение лицензии, слияние
 * фрагментов двух сборок, рендер) — здесь, на реальных пакетах из node_modules.
 */

interface PackageNotice {
  name: string;
  version: string;
  license: string;
  licenseFiles: { file: string; text: string }[];
}

interface ThirdPartyLicensesModule {
  packageRootOf(moduleId: string): string | null;
  readPackageNotice(root: string): PackageNotice;
  renderThirdPartyLicenses(notices: PackageNotice[]): string;
  updateThirdPartyLicenses(args: { outDir: string; build: string; moduleIds: Iterable<string> }): {
    file: string;
    packages: number;
  };
}

const ROOT = path.resolve(__dirname, '../../..');
const MODULE_PATH = path.resolve(ROOT, 'scripts/third-party-licenses/thirdPartyLicenses.mjs');
const NM = path.join(ROOT, 'node_modules');

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-3pl-'));
}

suite('THIRD_PARTY_LICENSES — тексты лицензий вшитых npm-зависимостей (#115)', () => {
  let mod: ThirdPartyLicensesModule;

  suiteSetup(async () => {
    mod = await importEsmModule<ThirdPartyLicensesModule>(MODULE_PATH);
  });

  test('packageRootOf: обычный, scoped, вложенный пакет; виртуальные id и query Vite', () => {
    assert.strictEqual(mod.packageRootOf(path.join(NM, 'zod/v4/core/core.js')), path.join(NM, 'zod'));
    assert.strictEqual(
      mod.packageRootOf(path.join(NM, '@vue/shared/dist/shared.esm-bundler.js')),
      path.join(NM, '@vue/shared')
    );
    assert.strictEqual(
      mod.packageRootOf(path.join(NM, 'vscode-languageclient/node_modules/minimatch/dist/index.js')),
      path.join(NM, 'vscode-languageclient/node_modules/minimatch')
    );
    assert.strictEqual(
      mod.packageRootOf(`\0${path.join(NM, 'ssh2/lib/client.js')}?commonjs-proxy`),
      path.join(NM, 'ssh2')
    );
    assert.strictEqual(mod.packageRootOf('C:\\work\\node_modules\\@scope\\pkg\\index.js'), 'C:/work/node_modules/@scope/pkg');
    assert.strictEqual(mod.packageRootOf(path.join(ROOT, 'src/extension.ts')), null);
    assert.strictEqual(mod.packageRootOf('\0commonjsHelpers.js'), null);
    assert.strictEqual(mod.packageRootOf(path.join(NM, 'zod')), path.join(NM, 'zod'));
  });

  test('readPackageNotice: лицензия из поля license и все файлы LICENSE* пакета', () => {
    const codicons = mod.readPackageNotice(path.join(NM, '@vscode/codicons'));
    assert.strictEqual(codicons.name, '@vscode/codicons');
    assert.strictEqual(codicons.license, 'CC-BY-4.0');
    assert.deepStrictEqual(
      codicons.licenseFiles.map((f) => f.file),
      ['LICENSE', 'LICENSE-CODE']
    );
    assert.ok(codicons.licenseFiles[1].text.includes('MIT License'));

    const lsp = mod.readPackageNotice(path.join(NM, 'vscode-jsonrpc'));
    assert.deepStrictEqual(lsp.licenseFiles.map((f) => f.file), ['License.txt']);
  });

  test('readPackageNotice: устаревшее поле licenses[] (ssh2)', () => {
    const ssh2 = mod.readPackageNotice(path.join(NM, 'ssh2'));
    assert.strictEqual(ssh2.license, 'MIT');
    assert.match(ssh2.version, /^\d+\.\d+\.\d+/);
  });

  test('readPackageNotice: пакет без текста лицензии — ошибка сборки, а не молча пустая запись', () => {
    const dir = tempDir();
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'bare', version: '1.0.0' }));
      assert.throws(() => mod.readPackageNotice(dir), /bare@1\.0\.0.*нет файла лицензии/s);

      fs.writeFileSync(path.join(dir, 'LICENCE.md'), 'Some licence\n');
      const notice = mod.readPackageNotice(dir);
      assert.strictEqual(notice.license, 'не указана в package.json');
      assert.deepStrictEqual(notice.licenseFiles, [{ file: 'LICENCE.md', text: 'Some licence' }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('renderThirdPartyLicenses: сортировка по имени, дедупликация name@version, текст лицензии целиком', () => {
    const vue = mod.readPackageNotice(path.join(NM, '@vue/shared'));
    const zod = mod.readPackageNotice(path.join(NM, 'zod'));
    const text = mod.renderThirdPartyLicenses([zod, vue, zod]);
    const vueAt = text.indexOf(`@vue/shared ${vue.version}`);
    const zodAt = text.indexOf(`zod ${zod.version}`);
    assert.ok(vueAt > 0 && zodAt > vueAt, 'пакеты в алфавитном порядке');
    assert.strictEqual(text.split(`zod ${zod.version}`).length, 2, 'одна запись на name@version');
    assert.ok(text.includes(zod.licenseFiles[0].text));
    assert.ok(text.includes('Лицензия: MIT'));
    assert.ok(text.endsWith('\n'));
  });

  test('updateThirdPartyLicenses: фрагменты двух сборок сливаются в один файл, повтор сборки замещает свой фрагмент', () => {
    const outDir = tempDir();
    try {
      const first = mod.updateThirdPartyLicenses({
        outDir,
        build: 'node',
        moduleIds: [
          path.join(NM, 'zod/v4/core/core.js'),
          path.join(NM, 'zod/v4/classic/schemas.js'),
          path.join(ROOT, 'src/extension.ts'),
        ],
      });
      assert.strictEqual(first.file, path.join(outDir, 'THIRD_PARTY_LICENSES.txt'));
      assert.strictEqual(first.packages, 1);

      mod.updateThirdPartyLicenses({
        outDir,
        build: 'webview',
        moduleIds: [path.join(NM, '@vscode/codicons/dist/codicon.css')],
      });
      let text = fs.readFileSync(first.file, 'utf-8');
      assert.ok(text.includes('@vscode/codicons '));
      assert.ok(text.includes('\nzod '));

      const again = mod.updateThirdPartyLicenses({ outDir, build: 'node', moduleIds: [] });
      assert.strictEqual(again.packages, 1);
      text = fs.readFileSync(first.file, 'utf-8');
      assert.ok(!text.includes('\nzod '), 'пересборка node заменяет её прежний фрагмент');
      assert.ok(text.includes('@vscode/codicons '));
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  // dist/ пересобирает pretest (build:node + build:webview), так что файл — результат настоящих сборок.
  test('реальная сборка dist/: THIRD_PARTY_LICENSES.txt содержит пакеты обеих сборок', () => {
    const file = path.join(ROOT, 'dist/THIRD_PARTY_LICENSES.txt');
    const text = fs.readFileSync(file, 'utf-8');
    for (const pkg of ['@modelcontextprotocol/sdk', 'fast-xml-parser', 'ssh2', 'vscode-languageclient', '@vue/runtime-core', '@vscode/codicons']) {
      assert.ok(text.includes(`\n${pkg} `), `нет пакета ${pkg}`);
    }
  });

  test('.vscodeignore пропускает THIRD_PARTY_LICENSES.txt в VSIX и прячет служебные фрагменты', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf-8').split(/\r?\n/);
    assert.ok(ignore.includes('dist/third-party/**'));
    assert.ok(!ignore.some((line) => line.startsWith('dist/THIRD_PARTY') || line === 'dist/**'));
  });
});
