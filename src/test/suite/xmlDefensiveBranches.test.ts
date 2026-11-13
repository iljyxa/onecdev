import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ObjectXmlReader } from '../../infra/xml/ObjectXmlReader';
import { normalizeTypedFieldPropertiesAfterTypeChange } from '../../infra/xml/TypedFieldPropertyRules';
import {
  collectPropertyBlocks,
  insertBlockInCanonicalPosition,
  removeBlocks,
} from '../../infra/xml/typedField/PropertyBlockEditor';
import {
  CONTROLLED_PROPERTY_KEYS,
  controlledPropertyOrder,
  getGeneratedPropertyKeys,
} from '../../infra/xml/typedField/TypedFieldOwnerRules';

/**
 * Защитные ветки XML-редакторов, которые на маленьком корпусе `example/` не
 * достигаются (испорченные и нетипичные файлы встречались только в большой
 * выгрузке). Фрагменты минимальные: нужен именно вырожденный вход.
 */

suite('PropertyBlockEditor — вырожденные входы', () => {
  test('незакрытый тег пропускается, соседние блоки собираются', () => {
    const blocks = collectPropertyBlocks('\n\t\t<Name>А</Name>\n\t\t<Broken>\n\t\t<Comment>Б</Comment>');
    assert.deepStrictEqual(blocks.map((block) => block.key), ['Name', 'Comment']);
  });

  test('блок не с начала строки получает пустой отступ', () => {
    const blocks = collectPropertyBlocks('<A>1</A><B>2</B>');
    assert.deepStrictEqual(blocks.map((block) => block.indent), ['', '']);
  });

  test('removeBlocks: блок в самом начале текста удаляется без перевода строки перед ним', () => {
    const inner = '<A>1</A><B>2</B>';
    const [first] = collectPropertyBlocks(inner);
    assert.strictEqual(removeBlocks(inner, [first]), '<B>2</B>');
  });

  test('insertBlockInCanonicalPosition: без блоков текст возвращается без изменений', () => {
    assert.strictEqual(insertBlockInCanonicalPosition('', [], () => undefined, 0, '<X/>', '\n'), '');
  });
});

suite('TypedFieldPropertyRules — <Type> в одну строку', () => {
  test('закрывающий </Type> без собственной строки: отступ берётся у блока, а не из регэкспа', () => {
    const element =
      '<Attribute><Properties><Name>X</Name><Type><v8:Type>xs:string</v8:Type></Type></Properties></Attribute>';
    const result = normalizeTypedFieldPropertiesAfterTypeChange(element, 'Attribute', '<v8:Type>xs:boolean</v8:Type>');
    assert.ok(result.includes('<Type>\n<v8:Type>xs:boolean</v8:Type>\n</Type>'), result);
    assert.ok(!result.includes('xs:string'));
  });
});

suite('TypedFieldOwnerRules — категории типа и порядок', () => {
  const generated = (typeInner: string): string[] => getGeneratedPropertyKeys('Attribute', 'Catalog', typeInner);
  const CHOICE = ['ChoiceParameterLinks', 'ChoiceParameters', 'ChoiceForm', 'LinkByType'];

  test('двоичные типы не получают свойства выбора', () => {
    for (const type of ['xs:base64Binary', 'v8:ValueStorage']) {
      const keys = generated(`<v8:Type>${type}</v8:Type>`);
      assert.ok(CHOICE.every((key) => !keys.includes(key)), type);
    }
  });

  test('ссылочный, определяемый и прочий типы получают свойства выбора', () => {
    for (const type of ['cfg:CatalogRef.Контрагенты', 'cfg:DefinedType.Любой', 'v8:UUID']) {
      const keys = generated(`<v8:Type>${type}</v8:Type>`);
      assert.ok(CHOICE.every((key) => keys.includes(key)), type);
    }
  });

  test('неуправляемый ключ получает порядок после всех управляемых', () => {
    assert.strictEqual(controlledPropertyOrder('НеизвестныйТег'), CONTROLLED_PROPERTY_KEYS.length);
  });
});

suite('ObjectXmlReader.updateTypeInObject — объект без <Properties>', () => {
  test('нечего править: возвращает false и файл не меняется', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-noprops-'));
    try {
      const xmlPath = path.join(dir, 'SessionParam.xml');
      const xml = '<MetaDataObject><SessionParameter></SessionParameter></MetaDataObject>';
      fs.writeFileSync(xmlPath, xml, 'utf-8');
      const changed = new ObjectXmlReader().updateTypeInObject(xmlPath, {
        targetKind: 'SessionParameter',
        targetName: 'Тест',
        typeInnerXml: '<v8:Type>xs:boolean</v8:Type>',
      });
      assert.strictEqual(changed, false);
      assert.strictEqual(fs.readFileSync(xmlPath, 'utf-8'), xml);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
