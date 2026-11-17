import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectJsonIndent,
  formatJsonPreservingStyle,
  parseJsonObjectText,
  writeJsonPreservingStyle,
} from '../../infra/fs/JsonTextFile';

const BOM = '﻿';

/**
 * Issue #120: env.json и autumn-properties.json правятся и пользователем, и
 * Platform Tools (табуляция), поэтому перезапись не должна менять отступ, BOM и
 * переводы строк исходника.
 */
suite('JsonTextFile — parseJsonObjectText (issue #120)', () => {
  test('BOM снимается', () => {
    assert.deepStrictEqual(parseJsonObjectText(`${BOM}{"a":1}`, 'env.json', '/p/env.json'), { a: 1 });
  });

  for (const [title, text] of [['пустой', ''], ['пробельный', ' \r\n\t'], ['только BOM', BOM]] as const) {
    test(`${title} → {}`, () => {
      assert.deepStrictEqual(parseJsonObjectText(text, 'env.json', '/p/env.json'), {});
    });
  }

  test('битый JSON → сообщение с меткой файла и путём, cause задан', () => {
    let caught: unknown;
    try {
      parseJsonObjectText('{"a":', 'autumn-properties.json', '/w/autumn-properties.json');
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /^autumn-properties\.json повреждён \(\/w\/autumn-properties\.json\): \S/);
    assert.ok(caught.cause instanceof SyntaxError);
  });

  for (const [title, text] of [['массив', '[1]'], ['строка', '"x"'], ['null', 'null'], ['число', '1']] as const) {
    test(`${title} → «ожидался объект»`, () => {
      assert.throws(
        () => parseJsonObjectText(text, 'env.json', '/p/env.json'),
        (error: Error) => error.message === 'env.json повреждён (/p/env.json): ожидался объект'
      );
    });
  }
});

suite('JsonTextFile — detectJsonIndent (issue #120)', () => {
  const cases: [string, string, string][] = [
    ['2 пробела', '{\n  "a": 1\n}\n', '  '],
    ['4 пробела', '{\n    "a": {\n        "b": 1\n    }\n}', '    '],
    ['табуляция с CRLF и BOM', `${BOM}{\r\n\t"a": 1\r\n}\r\n`, '\t'],
    ['однострочный', '{"a":1,"b":[1,2]}\n', ''],
    ['пустой объект {}', '{}', '  '],
    ['пустой объект на двух строках', '{\n}', '  '],
    ['пустой текст', '', '  '],
    ['многострочный без отступов', '{\n"a": 1\n}\n', '  '],
  ];
  for (const [title, text, expected] of cases) {
    test(title, () => {
      assert.strictEqual(detectJsonIndent(text), expected);
    });
  }
});

suite('JsonTextFile — formatJsonPreservingStyle (issue #120)', () => {
  const value = { default: { '--ibconnection': '/F./ib', list: [1, 2] }, xunit: { '--path': 'x' } };
  const changed = { default: { '--ibconnection': '/F./ib', list: [1, 2], '--storage-name': 'tcp://a' }, xunit: { '--path': 'x' } };

  const styles: [string, string, string][] = [
    // [название, исходник с value, ожидаемый текст для changed]
    ['LF и завершающий \\n', `${JSON.stringify(value, null, 2)}\n`, `${JSON.stringify(changed, null, 2)}\n`],
    [
      'CRLF',
      `${JSON.stringify(value, null, 2).replace(/\n/g, '\r\n')}\r\n`,
      `${JSON.stringify(changed, null, 2).replace(/\n/g, '\r\n')}\r\n`,
    ],
    ['без завершающего EOL', JSON.stringify(value, null, 4), JSON.stringify(changed, null, 4)],
    [
      'BOM + CRLF + табуляция',
      `${BOM}${JSON.stringify(value, null, '\t').replace(/\n/g, '\r\n')}\r\n`,
      `${BOM}${JSON.stringify(changed, null, '\t').replace(/\n/g, '\r\n')}\r\n`,
    ],
    ['однострочный', `${JSON.stringify(value)}\n`, `${JSON.stringify(changed)}\n`],
  ];
  for (const [title, original, expected] of styles) {
    test(`${title}: неизменённое значение → байт в байт исходник`, () => {
      assert.strictEqual(formatJsonPreservingStyle(original, value), original);
    });
    test(`${title}: изменённое значение → стиль исходника`, () => {
      assert.strictEqual(formatJsonPreservingStyle(original, changed), expected);
    });
  }

  for (const [title, original] of [['undefined (файла нет)', undefined], ['пустой файл', ''], ['пробельный файл', '\n']] as const) {
    test(`${title} → 2 пробела и \\n`, () => {
      assert.strictEqual(formatJsonPreservingStyle(original, changed), `${JSON.stringify(changed, null, 2)}\n`);
    });
  }
});

suite('JsonTextFile — writeJsonPreservingStyle (issue #120)', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-json-text-'));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('создаёт отсутствующий родитель; возвращённый текст равен содержимому файла', () => {
    const filePath = path.join(root, 'nested', 'dir', 'env.json');

    const written = writeJsonPreservingStyle(filePath, undefined, { default: { a: 1 } });

    assert.strictEqual(written, '{\n  "default": {\n    "a": 1\n  }\n}\n');
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), written);
  });

  test('существующий файл перезаписывается в стиле исходника', () => {
    const filePath = path.join(root, 'env.json');
    const original = `${BOM}{\r\n\t"a": 1\r\n}\r\n`;
    fs.writeFileSync(filePath, original, 'utf-8');

    const written = writeJsonPreservingStyle(filePath, original, { a: 2 });

    assert.strictEqual(written, `${BOM}{\r\n\t"a": 2\r\n}\r\n`);
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), written);
  });
});
