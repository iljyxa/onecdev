import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { builtinModules } from 'module';
import { parse } from 'acorn';

const ROOT = path.resolve(__dirname, '../../..');

suite('Package manifest', () => {
  test('пути из contributes.grammars существуют в проекте', () => {
    const manifest = readJson('package.json') as { contributes?: { grammars?: { path?: string }[] } };
    const grammars = manifest.contributes?.grammars ?? [];

    assert.ok(grammars.length > 0, 'В package.json нет grammar contribution');
    for (const grammar of grammars) {
      assert.ok(grammar.path, 'У grammar contribution не указан path');
      assert.ok(
        fs.existsSync(path.join(ROOT, grammar.path)),
        `Не найден файл грамматики: ${grammar.path}`
      );
    }
  });

  test('пути из contributes.snippets существуют и содержат JSON-сниппеты', () => {
    const manifest = readJson('package.json') as { contributes?: { snippets?: { language?: string; path?: string }[] } };
    const snippets = manifest.contributes?.snippets ?? [];

    assert.ok(snippets.length > 0, 'В package.json нет snippet contribution');
    for (const snippet of snippets) {
      assert.strictEqual(snippet.language, 'bsl');
      assert.ok(snippet.path, 'У snippet contribution не указан path');
      const snippetPath = path.join(ROOT, snippet.path);
      assert.ok(
        fs.existsSync(snippetPath),
        `Не найден файл сниппетов: ${snippet.path}`
      );

      const content = readJson(snippet.path);
      assert.ok(
        content && typeof content === 'object' && Object.keys(content).length > 0,
        `Файл сниппетов пустой: ${snippet.path}`
      );

      for (const prefix of collectSnippetPrefixes(content)) {
        assert.match(prefix, /^\p{Lu}[\p{L}\p{N}]*$/u, `Префикс сниппета должен быть CamelCase: ${prefix}`);
      }
    }
  });

  test('меню окружения BSL ссылается на объявленные команды', () => {
    const manifest = readJson('package.json') as {
      contributes?: {
        commands?: { command?: string }[];
        menus?: Record<string, { command?: string; submenu?: string; when?: string }[]>;
        submenus?: { id?: string; label?: string }[];
      };
    };
    const contributes = manifest.contributes;
    const declaredCommands = new Set((contributes?.commands ?? []).map((item) => item.command));
    const declaredSubmenus = new Set((contributes?.submenus ?? []).map((item) => item.id));

    assert.ok(declaredSubmenus.has('onecdev.bslSurroundMenu'), 'Не объявлено подменю Окружить');

    const editorMenu = contributes?.menus?.['editor/context'] ?? [];
    assert.ok(
      editorMenu.some((item) => item.submenu === 'onecdev.bslSurroundMenu' && item.when?.includes('editorLangId == bsl')),
      'Подменю Окружить не добавлено в контекстное меню BSL-редактора'
    );

    const surroundItems = contributes?.menus?.['onecdev.bslSurroundMenu'] ?? [];
    assert.ok(surroundItems.length > 0, 'Подменю Окружить пустое');
    for (const item of surroundItems) {
      assert.ok(item.command, 'Пункт подменю Окружить должен быть командой');
      assert.ok(declaredCommands.has(item.command), `Команда не объявлена: ${item.command}`);
    }
  });

  /*
   * VSIX не содержит node_modules: `vsce package --no-dependencies` отбрасывает их
   * независимо от исключений в .vscodeignore, и тогда первый require пакета из
   * node_modules роняет активацию. Поэтому собранный node-бандл обязан требовать только
   * то, что даёт среда выполнения.
   */
  test('node-бандл dist/ не требует пакетов из node_modules', function () {
    // Полный разбор AST многомегабайтного dist/extension.js: под c8 при параллельных
    // порциях гейта покрытия он идёт дольше дефолтных 2 с. Проверка детерминирована —
    // расширяется только бюджет времени, а не ослабляется сама проверка.
    this.timeout(30_000);
    const bundleFiles = listFiles(path.join(ROOT, 'dist')).filter(
      (file) => file.endsWith('.js') && !file.startsWith(path.join(ROOT, 'dist', 'ui') + path.sep)
    );
    assert.ok(
      bundleFiles.includes(path.join(ROOT, 'dist', 'extension.js')),
      'Не найден dist/extension.js — node-бандл не собран'
    );

    const builtins = new Set(builtinModules);
    // Опциональные нативные аддоны ssh2: он загружает их в try/catch и без них работает на чистом JS.
    const optionalNative = new Set(['cpu-features', './crypto/build/Release/sshcrypto.node']);
    const violations: string[] = [];
    for (const file of bundleFiles) {
      // Разбор AST, а не поиск по тексту: кодогенератор ajv держит `require("ajv/...")` в строках-шаблонах.
      for (const specifier of collectRequireSpecifiers(fs.readFileSync(file, 'utf-8'))) {
        const bare = specifier.replace(/^node:/, '');
        const allowed = specifier === 'vscode'
          || builtins.has(bare)
          || optionalNative.has(specifier)
          || (specifier.startsWith('.') && fs.existsSync(path.resolve(path.dirname(file), specifier)));
        if (!allowed) {
          violations.push(`${path.relative(ROOT, file)}: require('${specifier}')`);
        }
      }
    }
    assert.deepStrictEqual(violations, []);
  });

  test('.vscodeignore не пропускает node_modules в VSIX', () => {
    const lines = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf-8').split(/\r?\n/).map((line) => line.trim());

    assert.ok(lines.includes('node_modules/**'), 'node_modules обязан исключаться из VSIX целиком');
    assert.deepStrictEqual(lines.filter((line) => line.startsWith('!node_modules')), []);
  });

  // release.yml берёт текст релиза из раздела `## [<версия>]` CHANGELOG.md: без раздела текущей версии
  // выпуск по тегу упадёт уже после того, как тег поставлен.
  test('CHANGELOG.md содержит непустой раздел версии из package.json', () => {
    const { version } = readJson('package.json') as { version: string };
    const lines = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8').split(/\r?\n/);
    const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));

    assert.ok(start >= 0, `в CHANGELOG.md нет раздела «## [${version}]»`);
    const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
    const body = lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.trim() !== '');
    assert.ok(body.length > 0, `раздел «## [${version}]» CHANGELOG.md пуст`);
  });

  test('скрипт package собирает VSIX без node_modules', () => {
    const manifest = readJson('package.json') as { scripts?: Record<string, string> };

    assert.strictEqual(manifest.scripts?.package, 'vsce package --no-dependencies');
  });

  test('прямые webview-импорты указаны как прямые зависимости', () => {
    const manifest = readJson('package.json') as { dependencies?: Record<string, string> };

    assert.ok(manifest.dependencies?.['@vscode/codicons'], '@vscode/codicons нужен для universal webview');
  });
});

interface RequireArgument {
  type: string;
  value?: unknown;
  expressions?: unknown[];
  quasis?: { value: { cooked?: string } }[];
}

/** Аргументы вызовов `require('<литерал>')` в модуле; строки, похожие на вызов, не считаются. */
function collectRequireSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') {
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.type === 'CallExpression') {
      const callee = record.callee as { type?: string; name?: string };
      const argument = (record.arguments as RequireArgument[]).at(0);
      if (callee.type === 'Identifier' && callee.name === 'require' && argument) {
        if (argument.type === 'Literal' && typeof argument.value === 'string') {
          specifiers.push(argument.value);
        } else if (argument.type === 'TemplateLiteral' && argument.expressions?.length === 0) {
          specifiers.push(argument.quasis?.[0]?.value.cooked ?? '');
        }
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'type' && value && typeof value === 'object') {
        visit(value);
      }
    }
  };
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true }));
  return specifiers;
}

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf-8')) as unknown;
}

function collectSnippetPrefixes(content: unknown): string[] {
  if (!content || typeof content !== 'object') {
    return [];
  }

  const prefixes: string[] = [];
  for (const snippet of Object.values(content as Record<string, unknown>)) {
    if (!snippet || typeof snippet !== 'object') {
      continue;
    }

    const prefix = (snippet as Record<string, unknown>).prefix;
    if (typeof prefix === 'string') {
      prefixes.push(prefix);
    } else if (Array.isArray(prefix)) {
      prefixes.push(...prefix.filter((item): item is string => typeof item === 'string'));
    }
  }

  return prefixes;
}
