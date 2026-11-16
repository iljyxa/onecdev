import * as assert from 'assert';
import { BracketFormatError, type BracketList, bracketScalar, type BracketValue, parseBracketText } from '../../infra/repository/OneCBracketText';
import { callExceptionTexts, decodedBracketText, readFixture } from './support/crsFixtures';
import { readHttpExchange } from './support/repositoryLockFixtures';

/** Обратная сборка дерева в скобочный текст без переводов строк между элементами. */
function serialize(value: BracketValue): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return `{${(value as BracketList).map(serialize).join(',')}}`;
  }
  return `"${(value as { quoted: string }).quoted.split('"').join('""')}"`;
}

/**
 * Текст без переводов строк разметки: после { и , и перед }. Внутри строк они — часть значения
 * (tcp/probe-bind-new: «…пользователем,\r\nу которого…»), поэтому строки пропускаются.
 */
function withoutLayout(text: string): string {
  return text
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/([{,])\r\n/g, '$1').replace(/\r\n\}/g, '}')))
    .join('');
}

function formatError(text: string): BracketFormatError {
  try {
    parseBracketText(text);
  } catch (e) {
    assert.ok(e instanceof BracketFormatError, String(e));
    assert.strictEqual(typeof e.offset, 'number', e.message);
    return e;
  }
  return assert.fail('ожидался BracketFormatError');
}

suite('crs bracket: скобочный текст исключений 1С', () => {
  const texts = callExceptionTexts();

  test('каждый снятый текст исключения разбирается без потерь', () => {
    for (const { name, text } of texts) {
      assert.ok(text.startsWith('\uFEFF'), name);
      const tree = parseBracketText(text);
      // Переводы строк вне строк стоят только после { и , и перед }; внутри строк они сохраняются.
      assert.strictEqual(serialize(tree), withoutLayout(text.slice(1)), name);
    }
  });

  test('структура неверного пароля: запись, код 4, адрес хранилища, пустая строка', () => {
    const text = decodedBracketText('tcp', 'lock-wrong-password', '04-conn-02-s2c-call_exception.xml');
    const tree = parseBracketText(text);
    assert.strictEqual(tree.length, 4);
    const record = tree[0] as BracketList;
    assert.ok(Array.isArray(record));
    assert.strictEqual(record[0], '3ccb2518-9616-4445-aaa7-20048fead174');
    assert.ok((record[1] as { quoted: string }).quoted.startsWith('Ошибка аутентификации в хранилище конфигурации!\r\n'));
    assert.deepStrictEqual(record[2], ['00000000-0000-0000-0000-000000000000']);
    assert.deepStrictEqual(tree.slice(1), ['4', [{ quoted: 'file://crsdata/exp' }, '0'], { quoted: '' }]);
  });

  test('данные исключения разбора XML: вложенный список в начале, отрицательные числа, пустые строки', () => {
    const text = decodedBracketText('http', 'probe-malformed-body', 'response.xml');
    const tree = parseBracketText(text);
    assert.ok(Array.isArray(tree[0]) && Array.isArray((tree[0] as BracketList)[0]));
    assert.strictEqual(tree[1], '-6');
    assert.deepStrictEqual(tree.slice(-4), [{ quoted: '' }, { quoted: '' }, '1', '1']);
  });

  test('любой обрезанный префикс — BracketFormatError', () => {
    const text = decodedBracketText('tcp', 'lock-wrong-password', '04-conn-02-s2c-call_exception.xml');
    for (let length = 0; length < text.length; length += 1) {
      formatError(text.slice(0, length));
    }
  });

  test('текст не того вида — BracketFormatError', () => {
    // Тело XML вместо скобочного текста: первый же токен не открывает список.
    formatError(readFixture('http', 'probe-valid', 'request.xml').toString('utf-8'));
    // Два текста подряд: после закрытия корня ничего быть не может.
    const text = decodedBracketText('tcp', 'lock-wrong-password', '04-conn-02-s2c-call_exception.xml');
    formatError(text + text.slice(1));
  });
});

/** Полезная нагрузка `crs:call_exception` фикстуры захватов (example/repository/2.21-locks): base64 → UTF-8 с BOM. */
function lockExceptionPayload(name: 'version-mismatch' | 'auth-failed'): string {
  const text = readHttpExchange('8.5.1', name).response.toString('utf-8');
  const base64 = /<crs:call_exception[^>]*>([^<]*)</.exec(text)?.[1] ?? '';
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function list(value: BracketValue | undefined): BracketList {
  assert.ok(Array.isArray(value), `ожидался список, получено ${JSON.stringify(value)}`);
  return value as BracketList;
}

suite('OneCBracketText — исключения фикстуры захватов и общий разборщик', () => {
  test('«несоответствие версий»: BOM снят, CRLF между элементами не мешает, версия сервера во вложенной записи', () => {
    const payload = lockExceptionPayload('version-mismatch');
    assert.strictEqual(payload.charCodeAt(0), 0xfeff, 'фикстура должна начинаться с BOM');
    const root = parseBracketText(payload);
    const error = list(root[0]);
    assert.strictEqual(error[0], '3ccb2518-9616-4445-aaa7-20048fead174');
    assert.match(bracketScalar(error[1]) ?? '', /^Несоответствие версий клиентского приложения/);
    const nested = list(list(error[2])[1]);
    assert.deepStrictEqual([nested[0], bracketScalar(nested[1]), bracketScalar(nested[3])], ['9f06d311-1431-4a54-bd6f-fa93c4d4c471', '', '8.5.1.1529']);
    assert.strictEqual(bracketScalar(root[1]), '17');
  });

  test('ошибка аутентификации: код 4 и текст', () => {
    const root = parseBracketText(lockExceptionPayload('auth-failed'));
    assert.match(bracketScalar(list(root[0])[1]) ?? '', /^Ошибка аутентификации в хранилище конфигурации!/);
    assert.strictEqual(bracketScalar(root[1]), '4');
  });

  test('удвоенная кавычка внутри строки — одна кавычка; пустая строка и пустой список сохраняются', () => {
    assert.deepStrictEqual(parseBracketText('{"a""b","",x,{}}'), [{ quoted: 'a"b' }, { quoted: '' }, 'x', []]);
  });

  test('bracketScalar: атом и строка — текст; список и отсутствие — undefined', () => {
    const root = parseBracketText('{atom,"строка",{1}}');
    assert.deepStrictEqual([0, 1, 2, 3].map((index) => bracketScalar(root[index])), ['atom', 'строка', undefined, undefined]);
  });

  const malformed: [string, string, number][] = [
    ['второй корень', '{1},{2}', 3],
    ['незакрытая скобка', '{1,{2}', 6],
    ['лишняя закрывающая скобка', '{1}}', 3],
    ['незакрытая строка', '{"abc}', 1],
    ['пустой текст', '', 0],
  ];
  for (const [title, text, offset] of malformed) {
    test(`${title} → BracketFormatError со смещением ${String(offset)}, без содержимого`, () => {
      const error = formatError(text);
      assert.strictEqual(error.name, 'BracketFormatError');
      assert.strictEqual(error.offset, offset);
      assert.ok(!error.message.includes('abc'), error.message);
    });
  }
});
