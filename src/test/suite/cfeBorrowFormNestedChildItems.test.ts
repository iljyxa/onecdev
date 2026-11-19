import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CfeBorrowService } from '../../infra/cfe/CfeBorrowService';
import { assertWellFormedXml } from './support/typedFieldCorpus';
import { skipWithoutCorpus } from './support/corpus';

/**
 * #132: у формы с таблицей есть вложенный `<ChildItems>`; копия элементов в `<BaseForm>`
 * обрывалась на нём, и Form.xml заимствованной формы был некорректным XML — платформа
 * отклоняла загрузку расширения. Фикстура — реальная форма `Справочник.Контрагенты.ФормаЭлемента`
 * (таблица «КонтактныеЛица») и расширение EVOLC.
 */
suite('CfeBorrowService.borrowForm — форма с вложенными ChildItems (#132)', () => {
  for (const version of ['2.20', '2.21']) {
    test(`${version}: BaseForm содержит элементы формы целиком, Form.xml корректен`, function () {
      skipWithoutCorpus(this);
      const example = path.resolve(__dirname, '../../../example', version, 'src');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-borrow-form-'));
      try {
        const cfDir = path.join(root, 'cf');
        const extDir = path.join(root, 'cfe');
        fs.cpSync(path.join(example, 'cf'), cfDir, { recursive: true });
        // Расширение в корпусе только 2.21; проверяется разбор исходной формы обоих форматов.
        fs.cpSync(path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC'), extDir, { recursive: true });

        new CfeBorrowService().borrowForm(cfDir, extDir, 'Catalog', 'Контрагенты', 'ФормаЭлемента');

        const formXml = fs.readFileSync(path.join(extDir, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext', 'Form.xml'), 'utf-8');
        assertWellFormedXml(formXml, 'Form.xml заимствованной формы');
        const baseForm = /<BaseForm[^>]*>([\s\S]*)<\/BaseForm>/.exec(formXml)?.[1] ?? '';
        assert.ok(baseForm.includes('<Table name="КонтактныеЛица"'), 'таблица формы в BaseForm');
        assert.ok(baseForm.includes('</Table>'), 'таблица закрыта');
        // Элементы исходной формы после таблицы тоже на месте: копия не оборвана.
        const source = fs.readFileSync(path.join(cfDir, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext', 'Form.xml'), 'utf-8');
        const sourceNames = Array.from(source.matchAll(/<(?:InputField|Table|LabelField|UsualGroup|CheckBoxField)\b[^>]*name="([^"]+)"/g), (m) => m[1]);
        const baseNames = Array.from(baseForm.matchAll(/<(?:InputField|Table|LabelField|UsualGroup|CheckBoxField)\b[^>]*name="([^"]+)"/g), (m) => m[1]);
        assert.deepStrictEqual(baseNames, sourceNames);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('исходный Form.xml без корня <Form> (рукописный) → BaseForm без элементов, с командной панелью по умолчанию, XML корректен', function () {
    skipWithoutCorpus(this);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-borrow-form-noroot-'));
    try {
      const cfDir = path.join(root, 'cf');
      const extDir = path.join(root, 'cfe');
      fs.cpSync(path.resolve(__dirname, '../../../example/2.21/src/cf'), cfDir, { recursive: true });
      fs.cpSync(path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC'), extDir, { recursive: true });
      const sourceForm = path.join(cfDir, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext', 'Form.xml');
      fs.writeFileSync(sourceForm, '<?xml version="1.0" encoding="UTF-8"?>\n<ChildItems><Table name="Т"/></ChildItems>\n', 'utf-8');

      new CfeBorrowService().borrowForm(cfDir, extDir, 'Catalog', 'Контрагенты', 'ФормаЭлемента');

      const formXml = fs.readFileSync(path.join(extDir, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext', 'Form.xml'), 'utf-8');
      assertWellFormedXml(formXml, 'Form.xml из рукописного источника');
      assert.ok(/<BaseForm[^>]*>\s*<AutoCommandBar name="" id="-1"\/>\s*<Attributes\/>/.test(formXml), formXml);
      assert.ok(!formXml.includes('<ChildItems'), formXml);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
