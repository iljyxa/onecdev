import * as assert from 'assert';
import {
  applyServiceExclude,
  buildBslAnalyzerSourceConfig,
  findSourceSectionRange,
  isServiceExcludeItem,
  mergeSourceLayout,
  parseTomlStringArray,
  scanSectionEntries,
  SERVICE_EXCLUDE_ENTRY,
  type ServiceExcludeEdit,
} from '../../infra/environment/BslAnalyzerToml';

const lines = (...parts: string[]): string => parts.join('\n');

function changed(edit: ServiceExcludeEdit): string {
  assert.strictEqual(edit.status, 'changed', JSON.stringify(edit));
  return (edit as { content: string }).content;
}

function unsupported(edit: ServiceExcludeEdit): string {
  assert.strictEqual(edit.status, 'unsupported-format', JSON.stringify(edit));
  return (edit as { detail: string }).detail;
}

/** Issue #112 — правка `bsl-analyzer.toml` без TOML-библиотеки, с сохранением ручных записей. */
suite('BslAnalyzerToml — сканер секции [source] (issue #112)', () => {
  test('служебный элемент — имя служебного каталога', () => {
    assert.strictEqual(SERVICE_EXCLUDE_ENTRY, '.onecdev');
  });

  test('findSourceSectionRange: секции нет', () => {
    assert.strictEqual(findSourceSectionRange(lines('[server]', 'port = 0', '')), undefined);
    assert.strictEqual(findSourceSectionRange(''), undefined);
  });

  test('findSourceSectionRange: секция в конце файла', () => {
    const content = lines('[server]', 'port = 0', '', '[source]', 'root = "src/cf"', '');
    const range = findSourceSectionRange(content);
    assert.deepStrictEqual(range, {
      start: content.indexOf('[source]'),
      bodyStart: content.indexOf('root'),
      end: content.length,
    });
  });

  test('findSourceSectionRange: секция перед [diagnostics] и с комментарием в заголовке', () => {
    const content = lines('[source] # корни', 'root = "src/cf"', '', '[diagnostics]', 'enabled = true', '');
    assert.deepStrictEqual(findSourceSectionRange(content), {
      start: 0,
      bodyStart: content.indexOf('root'),
      end: content.indexOf('[diagnostics]'),
    });
  });

  test('findSourceSectionRange: подтаблица [source.configuration] вне диапазона', () => {
    const content = lines('[source]', 'root = "src/cf"', '[source.configuration]', 'x = 1', '');
    assert.strictEqual(findSourceSectionRange(content)?.end, content.indexOf('[source.configuration]'));
  });

  test('findSourceSectionRange: заголовок без завершающего перевода строки', () => {
    const content = 'port = 1\n[source]';
    assert.deepStrictEqual(findSourceSectionRange(content), { start: 9, bodyStart: content.length, end: content.length });
  });

  test('findSourceSectionRange: строка `[`, похожая на заголовок, внутри многострочного массива не завершает секцию', () => {
    const content = lines('[source]', 'externals = [', '  ["a"],', ']', '[next]', '');
    assert.strictEqual(findSourceSectionRange(content)?.end, content.indexOf('[next]'));
  });

  test('scanSectionEntries: однострочные записи, пустые строки и комментарии записей не дают', () => {
    const body = lines('# комментарий', 'root = "src/cf"', '', '  flag=true', '');
    assert.deepStrictEqual(scanSectionEntries(body), [
      { key: 'root', start: 14, end: 30, valueText: '"src/cf"' },
      { key: 'flag', start: 31, end: 43, valueText: 'true' },
    ]);
  });

  test('scanSectionEntries: многострочный массив — одна запись до закрывающей скобки', () => {
    const body = lines('extensions = [', '  "a",', '  "b",', ']', 'root = "x"', '');
    const entries = scanSectionEntries(body);
    assert.deepStrictEqual(entries.map((e) => e.key), ['extensions', 'root']);
    assert.strictEqual(entries[0].valueText, lines('[', '  "a",', '  "b",', ']'));
    assert.strictEqual(body.slice(entries[0].start, entries[0].end), lines('extensions = [', '  "a",', '  "b",', ']', ''));
  });

  test('scanSectionEntries: `]` и `#` в строках обоих видов и экранированная кавычка не сбивают глубину', () => {
    const body = lines('a = ["x]#", \'y]#\', "q\\"]"', ']', 'b = 1 # хвост', 'c = """м]н', 'ого"""', 'd = \'\'\'l]', 'it\'\'\'', 'e = 2', '');
    const entries = scanSectionEntries(body);
    assert.deepStrictEqual(entries.map((e) => [e.key, e.valueText]), [
      ['a', lines('["x]#", \'y]#\', "q\\"]"', ']')],
      ['b', '1'],
      ['c', lines('"""м]н', 'ого"""')],
      ['d', lines('\'\'\'l]', 'it\'\'\'')],
      ['e', '2'],
    ]);
  });

  test('scanSectionEntries: последняя запись без перевода строки, строка без `=` пропускается', () => {
    const body = 'garbage\nk = "v"';
    assert.deepStrictEqual(scanSectionEntries(body), [{ key: 'k', start: 8, end: 15, valueText: '"v"' }]);
  });

  test('scanSectionEntries: CRLF, хвостовые пробелы, комментарий и незакрытые строки в конце текста', () => {
    assert.deepStrictEqual(scanSectionEntries('\r\nk = 1\r\n   ').map((e) => [e.key, e.valueText]), [['k', '1']]);
    assert.deepStrictEqual(scanSectionEntries('k = [1, # x').map((e) => [e.key, e.valueText]), [['k', '[1, # x']]);
    assert.deepStrictEqual(scanSectionEntries('k = 1 # x').map((e) => [e.key, e.valueText]), [['k', '1']]);
    assert.deepStrictEqual(scanSectionEntries('k = "a\nb = 2\n').map((e) => e.key), ['k', 'b']);
    assert.deepStrictEqual(scanSectionEntries('k = """a\\""""').map((e) => e.valueText), ['"""a\\""""']);
    assert.deepStrictEqual(scanSectionEntries('k = """open').map((e) => e.valueText), ['"""open']);
    assert.deepStrictEqual(scanSectionEntries('k = "open').map((e) => e.valueText), ['"open']);
    assert.deepStrictEqual(scanSectionEntries('k = {a = [1]}}\n').map((e) => e.valueText), ['{a = [1]}}']);
  });

  test('scanSectionEntries: ключ в кавычках и dotted-ключ нормализуются', () => {
    assert.deepStrictEqual(scanSectionEntries('"exclude" = []\nsource . exclude = []\n').map((e) => e.key), ['exclude', 'source.exclude']);
  });
});

suite('BslAnalyzerToml — массив строк и служебный элемент (issue #112)', () => {
  test('parseTomlStringArray: однострочный', () => {
    assert.deepStrictEqual(parseTomlStringArray('["a", \'b\\c\', "d\\\\e"]'), {
      items: [
        { raw: '"a"', value: 'a' },
        { raw: '\'b\\c\'', value: 'b\\c' },
        { raw: '"d\\\\e"', value: 'd\\e' },
      ],
      multiline: false,
      itemIndent: '',
    });
  });

  test('parseTomlStringArray: экранирования базовой строки', () => {
    assert.deepStrictEqual(parseTomlStringArray('["\\"\\t\\n\\u0041\\U00000042\\b\\f\\r\\x"]')?.items[0].value, '"\t\nAB\b\f\r\\x');
  });

  test('parseTomlStringArray: многострочный с хвостовой запятой и без, отступ первого элемента', () => {
    assert.deepStrictEqual(parseTomlStringArray(lines('[', '    "a",', '    "b",', ']')), {
      items: [{ raw: '"a"', value: 'a' }, { raw: '"b"', value: 'b' }],
      multiline: true,
      itemIndent: '    ',
    });
    assert.deepStrictEqual(parseTomlStringArray(lines('[', '\t"a",', '\t"b"', ']'))?.itemIndent, '\t');
    assert.deepStrictEqual(parseTomlStringArray(lines('["a",', '  "b"]'))?.itemIndent, '  ');
    assert.deepStrictEqual(parseTomlStringArray(lines('[', ']')), { items: [], multiline: true, itemIndent: '  ' });
  });

  test('parseTomlStringArray: пустой массив', () => {
    assert.deepStrictEqual(parseTomlStringArray('[ ]'), { items: [], multiline: false, itemIndent: '' });
  });

  const rejected = [
    lines('[', '  "a", # мой', ']'),
    '[1]',
    '[{ a = "b" }]',
    '"x"',
    '["a" "b"]',
    '["a",,]',
    '["a"',
    '["незакрытая]',
    '[\'незакрытая]',
    '["a"] x',
    '[,]',
    '["\\uZZZZ"]',
    '["\\u00"]',
    '["""a"""]',
    "['''a''']",
    "['a\n', 'b']",
    '["a\n"]',
    '["a\\',
  ];
  for (const text of rejected) {
    test(`parseTomlStringArray отвергает ${JSON.stringify(text)}`, () => {
      assert.strictEqual(parseTomlStringArray(text), undefined);
    });
  }

  const items: [string, boolean][] = [
    ['.onecdev', true],
    ['./.onecdev', true],
    ['.onecdev/', true],
    ['.\\.onecdev', true],
    ['.onecdev\\', true],
    ['.onecdev2', false],
    ['.onecdev/sub', false],
    ['.v8vscedit', false],
    ['src/.onecdev', false],
  ];
  for (const [value, expected] of items) {
    test(`isServiceExcludeItem(${JSON.stringify(value)}) = ${String(expected)}`, () => {
      assert.strictEqual(isServiceExcludeItem(value), expected);
    });
  }
});

suite('BslAnalyzerToml — генерация и слияние [source] (issue #112)', () => {
  test('buildBslAnalyzerSourceConfig без опции — прежний вывод', () => {
    assert.strictEqual(buildBslAnalyzerSourceConfig([]), '[source]\nroot = "src/cf"\n');
    assert.strictEqual(
      buildBslAnalyzerSourceConfig(['src/cfe/EVOLC', 'a"b']),
      lines('[source]', 'root = "src/cf"', '', 'extensions = [', '  "src/cfe/EVOLC",', '  "a\\"b",', ']', '')
    );
  });

  test('buildBslAnalyzerSourceConfig со служебным exclude', () => {
    assert.strictEqual(
      buildBslAnalyzerSourceConfig([], { serviceExclude: true }),
      '[source]\nroot = "src/cf"\nexclude = [".onecdev"]\n'
    );
    assert.strictEqual(
      buildBslAnalyzerSourceConfig(['src/cfe/EVOLC'], { serviceExclude: true }),
      lines('[source]', 'root = "src/cf"', 'exclude = [".onecdev"]', '', 'extensions = [', '  "src/cfe/EVOLC",', ']', '')
    );
    assert.strictEqual(buildBslAnalyzerSourceConfig([], { serviceExclude: false }), '[source]\nroot = "src/cf"\n');
  });

  test('mergeSourceLayout: меняет root/extensions на месте, остальное — дословно и в прежнем порядке', () => {
    const content = lines(
      '[server]',
      'port = 0',
      '',
      '[source]',
      '# корень',
      'root = "old"',
      'exclude = ["vendor", ".onecdev"] # мои',
      '',
      'extensions = [',
      '  "src/cfe/OLD",',
      ']',
      'exclude_globs = ["**/*.tmp"]',
      'externals = [',
      '  "lib]#x",',
      ']',
      '',
      '[diagnostics]',
      'enabled = true',
      ''
    );
    assert.strictEqual(mergeSourceLayout(content, ['src/cfe/EVOLC']), lines(
      '[server]',
      'port = 0',
      '',
      '[source]',
      '# корень',
      'root = "src/cf"',
      'exclude = ["vendor", ".onecdev"] # мои',
      '',
      'extensions = [',
      '  "src/cfe/EVOLC",',
      ']',
      'exclude_globs = ["**/*.tmp"]',
      'externals = [',
      '  "lib]#x",',
      ']',
      '',
      '[diagnostics]',
      'enabled = true',
      ''
    ));
  });

  test('mergeSourceLayout идемпотентен на собственном выводе', () => {
    const generated = buildBslAnalyzerSourceConfig(['src/cfe/EVOLC'], { serviceExclude: true });
    assert.strictEqual(mergeSourceLayout(generated, ['src/cfe/EVOLC']), generated);
  });

  test('mergeSourceLayout: расширения исчезли — запись и пустая строка перед ней удаляются', () => {
    const content = lines('[source]', 'root = "src/cf"', '', 'extensions = [', '  "a",', ']', 'exclude = ["x"]', '');
    assert.strictEqual(mergeSourceLayout(content, []), lines('[source]', 'root = "src/cf"', 'exclude = ["x"]', ''));
    assert.strictEqual(
      mergeSourceLayout(lines('[source]', 'root = "src/cf"', 'extensions = []', ''), []),
      lines('[source]', 'root = "src/cf"', '')
    );
    assert.strictEqual(
      mergeSourceLayout(lines('[source]', 'extensions = []', 'k = 1', ''), []),
      lines('[source]', 'root = "src/cf"', 'k = 1', '')
    );
  });

  test('mergeSourceLayout: расширения появились — вставка после root', () => {
    assert.strictEqual(
      mergeSourceLayout(lines('[source]', 'root = "src/cf"', 'exclude = ["x"]', ''), ['src/cfe/E']),
      lines('[source]', 'root = "src/cf"', '', 'extensions = [', '  "src/cfe/E",', ']', 'exclude = ["x"]', '')
    );
  });

  test('mergeSourceLayout: в секции нет root — вставка в начало тела', () => {
    assert.strictEqual(
      mergeSourceLayout(lines('[source]', 'exclude = ["x"]', ''), []),
      lines('[source]', 'root = "src/cf"', 'exclude = ["x"]', '')
    );
    assert.strictEqual(
      mergeSourceLayout('[source]', ['e']),
      lines('[source]', 'root = "src/cf"', '', 'extensions = [', '  "e",', ']', '')
    );
  });

  test('mergeSourceLayout: секции нет — в конец; пустой файл — только секция', () => {
    assert.strictEqual(
      mergeSourceLayout(lines('[server]', 'port = 0'), []),
      lines('[server]', 'port = 0', '', '[source]', 'root = "src/cf"', '')
    );
    assert.strictEqual(
      mergeSourceLayout(lines('[server]', 'port = 0', '', ''), []),
      lines('[server]', 'port = 0', '', '[source]', 'root = "src/cf"', '')
    );
    assert.strictEqual(mergeSourceLayout('', ['e']), buildBslAnalyzerSourceConfig(['e']));
  });
});

suite('BslAnalyzerToml — служебный элемент exclude: ensure (issue #112)', () => {
  test('нет [source] — секция дописывается в конец', () => {
    assert.strictEqual(
      changed(applyServiceExclude(lines('[server]', 'port = 0', ''), 'ensure')),
      lines('[server]', 'port = 0', '', '[source]', 'exclude = [".onecdev"]', '')
    );
    assert.strictEqual(changed(applyServiceExclude('', 'ensure')), '[source]\nexclude = [".onecdev"]\n');
  });

  test('[source] без exclude — строка после последней записи, до пустых строк перед следующей секцией', () => {
    assert.strictEqual(
      changed(applyServiceExclude(lines('[source]', 'root = "src/cf"', '', 'extensions = [', '  "e",', ']', '', '[diagnostics]', 'x = 1', ''), 'ensure')),
      lines('[source]', 'root = "src/cf"', '', 'extensions = [', '  "e",', ']', 'exclude = [".onecdev"]', '', '[diagnostics]', 'x = 1', '')
    );
  });

  test('[source] без записей и последняя запись без перевода строки', () => {
    assert.strictEqual(
      changed(applyServiceExclude(lines('[source]', '', '[x]', ''), 'ensure')),
      lines('[source]', 'exclude = [".onecdev"]', '', '[x]', '')
    );
    assert.strictEqual(
      changed(applyServiceExclude('[source]\nroot = "src/cf"', 'ensure')),
      '[source]\nroot = "src/cf"\nexclude = [".onecdev"]\n'
    );
    assert.strictEqual(changed(applyServiceExclude('[source]', 'ensure')), '[source]\nexclude = [".onecdev"]\n');
  });

  test('однострочный массив с пользовательскими элементами — служебный в конец', () => {
    assert.strictEqual(
      changed(applyServiceExclude(lines('[source]', 'exclude = [ "vendor", \'tmp\' ] # мои', ''), 'ensure')),
      lines('[source]', 'exclude = ["vendor", \'tmp\', ".onecdev"] # мои', '')
    );
    assert.strictEqual(
      changed(applyServiceExclude(lines('[source]', 'exclude = []', ''), 'ensure')),
      lines('[source]', 'exclude = [".onecdev"]', '')
    );
  });

  test('многострочный массив с хвостовой запятой и без — отступ первого элемента сохранён', () => {
    assert.strictEqual(
      changed(applyServiceExclude(lines('[source]', 'exclude = [', '    "vendor",', ']', ''), 'ensure')),
      lines('[source]', 'exclude = [', '    "vendor",', '    ".onecdev",', ']', '')
    );
    assert.strictEqual(
      changed(applyServiceExclude(lines('[source]', 'exclude = [', '  "a",', '  "b"', ']', 'x = 1', ''), 'ensure')),
      lines('[source]', 'exclude = [', '  "a",', '  "b",', '  ".onecdev",', ']', 'x = 1', '')
    );
    assert.strictEqual(
      changed(applyServiceExclude(lines('[source]', 'exclude = [', ']', ''), 'ensure')),
      lines('[source]', 'exclude = [', '  ".onecdev",', ']', '')
    );
    assert.strictEqual(
      changed(applyServiceExclude(lines('[source]', 'exclude = [', '  "a"]', ''), 'ensure')),
      lines('[source]', 'exclude = [', '  "a",', '  ".onecdev",', ']', '')
    );
  });

  for (const form of ['".onecdev"', '"./.onecdev"', '".onecdev/"', '\'.onecdev\'']) {
    test(`служебный элемент уже есть (${form}) — unchanged`, () => {
      assert.deepStrictEqual(applyServiceExclude(lines('[source]', `exclude = ["a", ${form}]`, ''), 'ensure'), { status: 'unchanged' });
    });
  }

  test('unsupported-format: комментарий в массиве, не-массив, dotted source.exclude/source = без заголовка', () => {
    assert.match(unsupported(applyServiceExclude(lines('[source]', 'exclude = [', '  "a", # мой', ']', ''), 'ensure')), /exclude/);
    assert.match(unsupported(applyServiceExclude(lines('[source]', 'exclude = "x"', ''), 'ensure')), /exclude/);
    assert.match(unsupported(applyServiceExclude(lines('source.exclude = ["a"]', ''), 'ensure')), /source/);
    assert.match(unsupported(applyServiceExclude(lines('source = { root = "src/cf" }', ''), 'remove')), /source/);
  });

  test('dotted source.* внутри другой таблицы — не наш [source], секция дописывается', () => {
    assert.strictEqual(
      changed(applyServiceExclude(lines('[server]', 'source.x = 1', ''), 'ensure')),
      lines('[server]', 'source.x = 1', '', '[source]', 'exclude = [".onecdev"]', '')
    );
  });
});

suite('BslAnalyzerToml — служебный элемент exclude: remove (issue #112)', () => {
  test('только служебный — удаляется строка ключа целиком', () => {
    assert.strictEqual(
      changed(applyServiceExclude(lines('[source]', 'root = "src/cf"', 'exclude = [".onecdev"]', '', '[x]', ''), 'remove')),
      lines('[source]', 'root = "src/cf"', '', '[x]', '')
    );
    assert.strictEqual(
      changed(applyServiceExclude(lines('[source]', 'exclude = [', '  "./.onecdev",', ']', 'k = 1', ''), 'remove')),
      lines('[source]', 'k = 1', '')
    );
  });

  test('служебный и пользовательский — пользовательский остаётся (однострочный)', () => {
    assert.strictEqual(
      changed(applyServiceExclude(lines('[source]', 'exclude = ["vendor", ".onecdev", \'tmp\']', ''), 'remove')),
      lines('[source]', 'exclude = ["vendor", \'tmp\']', '')
    );
  });

  test('служебный и пользовательский — пользовательский остаётся (многострочный)', () => {
    assert.strictEqual(
      changed(applyServiceExclude(lines('[source]', 'exclude = [', '  "vendor",', '  ".onecdev",', '  "tmp",', ']', ''), 'remove')),
      lines('[source]', 'exclude = [', '  "vendor",', '  "tmp",', ']', '')
    );
    assert.strictEqual(
      changed(applyServiceExclude(lines('[source]', 'exclude = [', '  "vendor", ".onecdev",', '  "tmp"', ']', ''), 'remove')),
      lines('[source]', 'exclude = [', '  "vendor", ', '  "tmp"', ']', '')
    );
    assert.strictEqual(
      changed(applyServiceExclude(lines('[source]', 'exclude = [', '  "vendor",', '  ".onecdev"]', ''), 'remove')),
      lines('[source]', 'exclude = [', '  "vendor",', '  ]', '')
    );
    assert.strictEqual(
      changed(applyServiceExclude(lines('[source]', 'exclude = [', '  "vendor",', '  ".onecdev" ,', ']', ''), 'remove')),
      lines('[source]', 'exclude = [', '  "vendor",', ']', '')
    );
  });

  test('служебного нет, нет exclude, нет [source] — unchanged', () => {
    assert.deepStrictEqual(applyServiceExclude(lines('[source]', 'exclude = ["vendor"]', ''), 'remove'), { status: 'unchanged' });
    assert.deepStrictEqual(applyServiceExclude(lines('[source]', 'root = "src/cf"', ''), 'remove'), { status: 'unchanged' });
    assert.deepStrictEqual(applyServiceExclude(lines('[server]', 'port = 0', ''), 'remove'), { status: 'unchanged' });
  });

  test('unsupported-format при remove', () => {
    unsupported(applyServiceExclude(lines('[source]', 'exclude = [1]', ''), 'remove'));
  });
});
