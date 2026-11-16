import * as assert from 'assert';
import { CrsFormatError } from '../../infra/repository/crs/CrsErrors';
import { CRS_NAMESPACE, VRS_NAMESPACE } from '../../infra/xml/crs/CrsEnvelope';
import { escapeXmlAttribute } from '../../infra/xml/XmlUtils';
import { attributeOf, childElement, parseCrsXml, type CrsXmlElement } from '../../infra/xml/crs/CrsXmlReader';
import { crsCorpus, readFixture, tcpRawProbeBodies } from './support/crsFixtures';

const CORE_NAMESPACE = 'http://v8.1c.ru/8.1/data/core';

function text(...parts: string[]): string {
  return readFixture(...parts).toString('utf-8');
}

/** Все элементы дерева в порядке документа. */
function elements(root: CrsXmlElement): CrsXmlElement[] {
  const result: CrsXmlElement[] = [];
  const stack = [root];
  for (let element = stack.pop(); element !== undefined; element = stack.pop()) {
    result.push(element);
    stack.push(...[...element.children].reverse());
  }
  return result;
}

function formatError(source: string): CrsFormatError {
  try {
    parseCrsXml(source);
  } catch (e) {
    assert.ok(e instanceof CrsFormatError, String(e));
    assert.strictEqual(typeof e.offset, 'number', e.message);
    return e;
  }
  return assert.fail('ожидался CrsFormatError');
}

suite('crs xml: узкий XML-ридер на снятых телах', () => {
  const corpus = crsCorpus();

  test('каждое тело корпуса tcp и http разбирается, корень — crs в своём пространстве имён', () => {
    for (const frame of corpus) {
      const source = frame.body.toString('utf-8');
      const root = parseCrsXml(source);
      const expected = frame.direction === 'c2s' ? 'call' : /-s2c-(\w+)\.xml$/.exec(frame.file)?.[1];
      const where = `${frame.transport}/${frame.scenario}/${frame.file}`;
      assert.strictEqual(root.local, expected, where);
      assert.strictEqual(root.name, `crs:${root.local}`, where);
      assert.strictEqual(root.namespace, CRS_NAMESPACE, where);
      // Независимая сверка: число элементов и атрибутов — по открывающим тегам в исходном тексте.
      const all = elements(root);
      assert.strictEqual(all.length, (source.match(/<crs:/g) ?? []).length, where);
      const attributes = all.reduce((sum, e) => sum + e.attributes.size, 0);
      // Атрибуты декларации <?xml …?> — не атрибуты элементов.
      assert.strictEqual(attributes, (source.replace(/<\?[^>]*\?>/g, '').match(/ [\w:]+="/g) ?? []).length, where);
      for (const element of all) {
        assert.strictEqual(element.namespace, CRS_NAMESPACE, where);
      }
    }
  });

  test('&quot; в атрибуте раскрывается (bindString и ответ истории)', () => {
    for (const parts of [
      ['tcp', 'lock-held-by-other', '05-conn-02-c2s-DevDepot_bind.xml'],
      ['tcp', 'history-all', '11-conn-02-s2c-call_return.xml'],
    ]) {
      const source = text(...parts);
      const raw = /bindString value="([^"]*)"/.exec(source)?.[1];
      assert.ok(raw, parts.join('/'));
      assert.ok(raw.includes('&quot;'), parts.join('/'));
      const bindString = elements(parseCrsXml(source)).find((e) => e.local === 'bindString');
      assert.ok(bindString);
      assert.strictEqual(attributeOf(bindString, 'value'), raw.split('&quot;').join('"'));
      assert.ok(attributeOf(bindString, 'value').startsWith('Computer="'));
    }
  });

  test('текст элемента сохраняется как есть (комментарий версии в истории)', () => {
    const source = text('tcp', 'history-all', '12-conn-02-s2c-call_return.xml');
    const comments = elements(parseCrsXml(source))
      .map((e) => e.text)
      .filter((t) => t !== '');
    assert.ok(comments.includes('Первый релиз'), comments.join('|'));
  });

  test('тело с BOM и без BOM дают равные деревья', () => {
    const withBom = text('http', 'probe-valid', 'request.xml');
    const withoutBom = text('http', 'probe-no-bom', 'request.xml');
    assert.ok(withBom.startsWith('\uFEFF'));
    assert.ok(!withoutBom.startsWith('\uFEFF'));
    assert.deepStrictEqual(parseCrsXml(withBom), parseCrsXml(withoutBom));
  });

  test('инструкция xml-stylesheet перед корнем пропускается, префикс d1p1 и default ns разрешаются', () => {
    for (const source of [text('http', 'probe-malformed-body', 'response.xml'), tcpRawProbeBodies('probe-malformed-body').response.body.toString('utf-8')]) {
      const root = parseCrsXml(source);
      assert.strictEqual(root.local, 'exception');
      assert.strictEqual(root.namespace, VRS_NAMESPACE);
      const descr = childElement(root, CORE_NAMESPACE, 'descr');
      assert.ok(descr);
      assert.strictEqual(descr.name, 'd1p1:descr');
      assert.ok(descr.text.startsWith('Ошибка разбора XML'), descr.text);
      assert.strictEqual(childElement(root, VRS_NAMESPACE, 'descr'), undefined);
      assert.strictEqual(attributeOf(root, 'reason'), '');
      assert.strictEqual(attributeOf(root, 'clsid'), 'c593fe3b-aeaf-496a-a32e-6b4dc2d13fff');
    }
    const wrongPath = parseCrsXml(text('http', 'probe-wrong-path', 'response.xml'));
    const descr = childElement(wrongPath, CORE_NAMESPACE, 'descr');
    assert.ok(descr);
    assert.strictEqual(descr.name, 'descr');
    assert.ok(descr.text.startsWith('HTTP: Not found\nОшибка при работе с ресурсом'), descr.text);
    assert.strictEqual(attributeOf(wrongPath, 'reason'), '404');
    // Атрибуты — в порядке документа, объявления пространств имён тоже.
    assert.deepStrictEqual([...wrongPath.attributes.keys()], ['xmlns', 'xmlns:xs', 'xmlns:xsi', 'xsi:type', 'clsid', 'reason']);
  });

  test('CRLF в тексте call_exception сохраняется', () => {
    const source = text('tcp', 'lock-wrong-password', '04-conn-02-s2c-call_exception.xml');
    const raw = /<crs:call_exception [^>]*>([^<]*)</.exec(source)?.[1];
    assert.ok(raw?.includes('\r\n'));
    assert.strictEqual(parseCrsXml(source).text, raw);
  });

  test('любой обрезанный префикс тела — CrsFormatError, иных исключений нет', () => {
    for (const source of [
      text('tcp', 'lock-one', '06-conn-02-c2s-DevDepot_devObjectsStatistic.xml'),
      text('tcp', 'lock-wrong-password', '04-conn-02-s2c-call_exception.xml'),
      text('http', 'probe-wrong-path', 'response.xml'),
    ]) {
      for (let length = 0; length < source.length; length += 1) {
        formatError(source.slice(0, length));
      }
    }
  });

  test('не XML, тело из одного BOM и два тела подряд — CrsFormatError', () => {
    formatError(tcpRawProbeBodies('probe-malformed-body').request.toString('utf-8'));
    formatError(tcpRawProbeBodies('probe-unknown-method').response.body.toString('utf-8'));
    const body = text('http', 'probe-valid', 'request.xml');
    assert.match(formatError(body + body).message, /после корневого/);
    assert.match(formatError(body + text('http', 'probe-no-bom', 'request.xml')).message, /после корневого/);
  });

  test('escapeXmlAttribute обращает раскрытие сущностей', () => {
    const source = text('tcp', 'lock-held-by-other', '05-conn-02-c2s-DevDepot_bind.xml');
    const raw = /bindString value="([^"]*)"/.exec(source)?.[1];
    assert.ok(raw);
    assert.strictEqual(escapeXmlAttribute(raw.split('&quot;').join('"')), raw);
    // Остальные символы, недопустимые в атрибуте, — по спецификации XML.
    assert.strictEqual(escapeXmlAttribute('a&b<c>d"e'), 'a&amp;b&lt;c&gt;d&quot;e');
  });
});
