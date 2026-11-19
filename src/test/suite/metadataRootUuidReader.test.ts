import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readMetadataRootUuid, readMetadataRootUuidFile } from '../../infra/xml/MetadataRootUuidReader';

/**
 * uuid корневого элемента XML единицы выгрузки (#117): им фильтруется история объекта в хранилище.
 * Оракул — ConfigDumpInfo.xml той же выгрузки (`<Metadata name="…" id="…">`), разобранный здесь
 * независимо от production-кода.
 */

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const EXAMPLE_EVOLC = path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC');

function dumpInfoId(root: string, name: string): string {
  const text = fs.readFileSync(path.join(root, 'ConfigDumpInfo.xml'), 'utf-8');
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<Metadata name="${escaped}" id="([0-9a-f-]{36})"`).exec(text);
  assert.ok(match, `${name} нет в ConfigDumpInfo.xml`);
  return match[1];
}

suite('MetadataRootUuidReader (#117)', () => {
  const cases: readonly { readonly name: string; readonly root: string; readonly rel: string; readonly dumpName: string }[] = [
    { name: 'cf: справочник', root: EXAMPLE_CF, rel: 'Catalogs/Контрагенты.xml', dumpName: 'Catalog.Контрагенты' },
    { name: 'cf: дескриптор формы', root: EXAMPLE_CF, rel: 'Catalogs/Контрагенты/Forms/ФормаЭлемента.xml', dumpName: 'Catalog.Контрагенты.Form.ФормаЭлемента' },
    { name: 'cf: макет объекта', root: EXAMPLE_CF, rel: 'Catalogs/Контрагенты/Templates/ЗагрузкаИзФайла.xml', dumpName: 'Catalog.Контрагенты.Template.ЗагрузкаИзФайла' },
    { name: 'cf: общая форма', root: EXAMPLE_CF, rel: 'CommonForms/АЛКОВводРеквизитовОП.xml', dumpName: 'CommonForm.АЛКОВводРеквизитовОП' },
    { name: 'cf: общий макет', root: EXAMPLE_CF, rel: 'CommonTemplates/Макет.xml', dumpName: 'CommonTemplate.Макет' },
    { name: 'cf: вложенная подсистема', root: EXAMPLE_CF, rel: 'Subsystems/Продажи/Subsystems/Розница.xml', dumpName: 'Subsystem.Продажи.Subsystem.Розница' },
    { name: 'cf: Configuration.xml', root: EXAMPLE_CF, rel: 'Configuration.xml', dumpName: 'Configuration.ТорговыйУчет' },
    { name: 'EVOLC: заимствованный справочник', root: EXAMPLE_EVOLC, rel: 'Catalogs/Контрагенты.xml', dumpName: 'Catalog.Контрагенты' },
    { name: 'EVOLC: собственный справочник', root: EXAMPLE_EVOLC, rel: 'Catalogs/ев_РабочийПроцесс.xml', dumpName: 'Catalog.ев_РабочийПроцесс' },
    { name: 'EVOLC: Configuration.xml', root: EXAMPLE_EVOLC, rel: 'Configuration.xml', dumpName: 'Configuration.EVOLC' },
  ];
  for (const c of cases) {
    test(`${c.name} — uuid как в ConfigDumpInfo.xml`, () => {
      const file = path.join(c.root, c.rel);
      const expected = dumpInfoId(c.root, c.dumpName);
      assert.strictEqual(readMetadataRootUuidFile(file), expected);
      assert.strictEqual(readMetadataRootUuid(fs.readFileSync(file, 'utf-8')), expected);
    });
  }

  test('BOM снимается, uuid приводится к нижнему регистру', () => {
    const text = fs.readFileSync(path.join(EXAMPLE_CF, 'Catalogs/Контрагенты.xml'), 'utf-8').replace(/^\uFEFF?/, '\uFEFF');
    const expected = dumpInfoId(EXAMPLE_CF, 'Catalog.Контрагенты');
    assert.strictEqual(readMetadataRootUuid(text.replace(expected, expected.toUpperCase())), expected);
  });

  test('uuid ищется только у корневого элемента, а не у вложенных', () => {
    const text = fs.readFileSync(path.join(EXAMPLE_CF, 'Catalogs/Контрагенты.xml'), 'utf-8');
    const expected = dumpInfoId(EXAMPLE_CF, 'Catalog.Контрагенты');
    const withoutRootUuid = text.replace(`uuid="${expected}"`, '');
    assert.ok(/uuid="[0-9a-f-]{36}"/.test(withoutRootUuid), 'у вложенных элементов фикстуры должны быть uuid');
    assert.strictEqual(readMetadataRootUuid(withoutRootUuid), null);
  });

  const broken: readonly [string, string][] = [
    ['нет MetaDataObject', '<Catalog uuid="2c53bb9d-bda3-431e-95f5-0d4145c8ac74"/>'],
    ['нет корневого элемента', '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"></MetaDataObject>'],
    ['не GUID', '<MetaDataObject><Catalog uuid="не-uuid"><Properties/></Catalog></MetaDataObject>'],
    ['пустая строка', ''],
  ];
  for (const [name, text] of broken) {
    test(`${name} — null`, () => {
      assert.strictEqual(readMetadataRootUuid(text), null);
    });
  }

  test('комментарий перед корневым элементом пропускается', () => {
    const text = '<MetaDataObject>\n<!-- служебный -->\n<Catalog uuid="2C53BB9D-BDA3-431E-95F5-0D4145C8AC74"/></MetaDataObject>';
    assert.strictEqual(readMetadataRootUuid(text), '2c53bb9d-bda3-431e-95f5-0d4145c8ac74');
  });

  test('дефисы и «--» внутри комментария, несколько комментариев подряд — корень находится', () => {
    const text = '<MetaDataObject>\n<!-- a - b -- c -->\n<!--x--><!---->\n<Catalog uuid="2c53bb9d-bda3-431e-95f5-0d4145c8ac74"/></MetaDataObject>';
    assert.strictEqual(readMetadataRootUuid(text), '2c53bb9d-bda3-431e-95f5-0d4145c8ac74');
  });

  test('10 000 повторов «--><!--» без корневого элемента — null (CodeQL js/redos)', () => {
    // Прежний `<!--[\s\S]*?-->` давал экспоненциальный перебор: каждое «--><!--» могло быть и границей
    // комментариев, и их содержимым (24 повтора — уже ~1 с). На таком входе он не завершился бы никогда,
    // поэтому регресс виден как зависание, а не как сравнение с порогом времени.
    const text = '<MetaDataObject><!--' + '--><!--'.repeat(10_000);
    assert.strictEqual(readMetadataRootUuid(text), null);
  });

  test('нет файла — null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-root-uuid-'));
    try {
      assert.strictEqual(readMetadataRootUuidFile(path.join(dir, 'Нет.xml')), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
