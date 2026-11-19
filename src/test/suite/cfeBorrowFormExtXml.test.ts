import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CfeBorrowService } from '../../infra/cfe/CfeBorrowService';
import { formatNewExportText } from '../../infra/fs/NewExportFile';
import { buildBorrowedFormExtXml } from '../../infra/xml/BorrowedFormXml';

/**
 * #167: `Ext/Form.xml` заимствованной формы совпадает с выгрузкой платформы байт-в-байт.
 *
 * Эталоны `src/test/fixtures/borrowed-form/<формат>/…` сняты циклом: `borrowForm` в копию EVOLC
 * (для 2.20 — с `version="2.20"`) → `ibcmd infobase config import` конфигурации и расширения →
 * `ibcmd infobase config export --extension=EVOLC` на 8.3.27 (2.20) и 8.5.1 (2.21). Генерация,
 * давшая эталон, — неподвижная точка цикла: выгрузка повторяет загруженный файл.
 *
 *  - `ФормаЭлемента/Ext/Form.xml` — форма `Справочник.Контрагенты.ФормаЭлемента` корпуса `example/`;
 *  - `<случай>/source.xml` → `<случай>/expected.xml` — исходная форма, которой в корпусе нет
 *    (кнопки в командных панелях, свойства панели, многострочный текст, форма группы и списка),
 *    и выгрузка её заимствования.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'src', 'test', 'fixtures', 'borrowed-form');

function emptyExtension(format: string): string {
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), `onecdev-borrow-form-ext-${format}-`));
  fs.writeFileSync(path.join(extDir, 'Configuration.xml'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<MetaDataObject version="${format}">`,
    '\t<Configuration>',
    '\t\t<Properties><Name>Расширение</Name></Properties>',
    '\t\t<ChildObjects/>',
    '\t</Configuration>',
    '</MetaDataObject>',
    '',
  ].join('\n'), 'utf-8');
  return extDir;
}

/** Текст `Form.xml` в том виде, в каком его пишет `borrowForm` (BOM, CRLF). */
function generated(sourceXml: string): Buffer {
  return Buffer.from(formatNewExportText('Form.xml', buildBorrowedFormExtXml(sourceXml)), 'utf-8');
}

suite('CfeBorrowService — Form.xml заимствованной формы как у выгрузки платформы (#167)', () => {
  for (const format of ['2.20', '2.21'] as const) {
    test(`${format}: Form.xml байт-в-байт с выгрузкой, пустой Module.bsl не создаётся`, () => {
      const cfDir = path.join(REPO_ROOT, 'example', format, 'src', 'cf');
      const extDir = emptyExtension(format);
      try {
        const result = new CfeBorrowService().borrowForm(cfDir, extDir, 'Catalog', 'Контрагенты', 'ФормаЭлемента');

        const formExtDir = path.join(extDir, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext');
        const actual = fs.readFileSync(path.join(formExtDir, 'Form.xml'));
        const expected = fs.readFileSync(path.join(FIXTURES, format, 'ФормаЭлемента', 'Ext', 'Form.xml'));
        assert.strictEqual(actual.toString('utf-8'), expected.toString('utf-8'));
        assert.ok(actual.equals(expected), 'байты расходятся');

        // Платформа не выгружает пустой модуль формы: созданный нами пропадал после цикла.
        assert.ok(!fs.existsSync(path.join(formExtDir, 'Form')), 'каталог модуля формы не создаётся');
        assert.ok(!result.files.some((file) => file.endsWith('Module.bsl')));
      } finally {
        fs.rmSync(extDir, { recursive: true, force: true });
      }
    });
  }

  const cases: readonly (readonly [string, string, string])[] = [
    ['2.20', 'button-in-form-command-bar',
      'кнопка в командной панели формы → UseForFoldersAndItems на обоих уровнях'],
    ['2.21', 'command-bar-props-button-multiline-text',
      'свойства и кнопка панели формы, многострочный текст заголовка не сдвигается'],
    ['2.21', 'button-in-table-command-bar',
      'кнопка только в панели таблицы → UseForFoldersAndItems только в BaseForm'],
    ['2.21', 'group-form-with-button',
      'форма группы (Folders в исходнике) с кнопкой → UseForFoldersAndItems = Items'],
    ['2.21', 'list-form-with-button',
      'форма списка без UseForFoldersAndItems с кнопкой → свойство не пишется'],
  ];
  for (const [format, name, title] of cases) {
    test(`${format}/${name}: ${title}`, () => {
      const dir = path.join(FIXTURES, format, name);
      const actual = generated(fs.readFileSync(path.join(dir, 'source.xml'), 'utf-8'));
      const expected = fs.readFileSync(path.join(dir, 'expected.xml'));
      assert.strictEqual(actual.toString('utf-8'), expected.toString('utf-8'));
      assert.ok(actual.equals(expected), 'байты расходятся');
    });
  }

  test('исходник без пролога, версии и командной панели: умолчания платформы', () => {
    const xml = buildBorrowedFormExtXml('<Form>\n\t<ChildItems>\n\t\t<Button name="К" id="1"/>\n\t</ChildItems>\n</Form>');
    assert.strictEqual(xml, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Form>',
      '\t<AutoCommandBar name="" id="-1"/>',
      '\t<Attributes/>',
      '\t<BaseForm version="2.17">',
      '\t\t<AutoCommandBar name="" id="-1"/>',
      '\t\t<ChildItems>',
      '\t\t\t<Button name="К" id="1"/>',
      '\t\t</ChildItems>',
      '\t\t<Attributes/>',
      '\t</BaseForm>',
      '</Form>',
    ].join('\n'));
  });
});
