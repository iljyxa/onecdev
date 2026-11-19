import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CfeBorrowService } from '../../infra/cfe/CfeBorrowService';

/**
 * #161: дескриптор заимствованной формы с `Ext/Form.xml` совпадает с выгрузкой платформы.
 *
 * Эталоны `src/test/fixtures/borrowed-form/<формат>/ФормаЭлемента.xml` сняты так: копия EVOLC
 * (для 2.20 — с `version="2.20"`) → `borrowForm(example/<формат>/src/cf, …, 'Catalog',
 * 'Контрагенты', 'ФормаЭлемента')` → `ibcmd infobase config import --extension=EVOLC` →
 * `ibcmd infobase config export --extension=EVOLC` на 8.3.27 (2.20) и 8.5.1 (2.21). Платформа
 * дописывает в `<InternalInfo>` состояние свойства «Форма» (Form/Extended), остальное совпадает.
 *
 * Нормализуется только uuid формы (новый при каждом заимствовании); BOM и EOL совпадают с
 * выгрузкой платформы байт-в-байт (#165).
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'src', 'test', 'fixtures', 'borrowed-form');

function normalize(xml: string): string {
  return xml.replace(/<Form uuid="[0-9a-f-]+">/, '<Form uuid="UUID">');
}

suite('CfeBorrowService — дескриптор заимствованной формы как у выгрузки платформы (#161)', () => {
  for (const format of ['2.20', '2.21'] as const) {
    test(`${format}: InternalInfo с PropertyState Form/Extended, байт-в-байт с эталоном`, () => {
      const cfDir = path.join(REPO_ROOT, 'example', format, 'src', 'cf');
      const extDir = fs.mkdtempSync(path.join(os.tmpdir(), `onecdev-borrow-form-state-${format}-`));
      try {
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

        new CfeBorrowService().borrowForm(cfDir, extDir, 'Catalog', 'Контрагенты', 'ФормаЭлемента');

        const actual = fs.readFileSync(
          path.join(extDir, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента.xml'), 'utf-8'
        );
        const expected = fs.readFileSync(path.join(FIXTURES, format, 'ФормаЭлемента.xml'), 'utf-8');
        assert.strictEqual(normalize(actual), normalize(expected));
      } finally {
        fs.rmSync(extDir, { recursive: true, force: true });
      }
    });
  }
});
