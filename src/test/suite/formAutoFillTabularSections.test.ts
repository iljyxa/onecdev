import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FormToolsService } from '../../infra/xml/form/FormToolsService';
import { skipWithoutCorpus } from './support/corpus';

/**
 * Автозаполнение формы по метаданным брало реквизиты табличной части за реквизиты самого
 * объекта: колонки ТЧ «Товары» документа ПриходТовара попадали в форму как `Список.Цена`,
 * `Объект.Сумма` и т.п. Платформа 8.5.1 отклоняла импорт всей конфигурации:
 * «Неверный путь к данным: "Список.Сумма"». Фикстура — реальная выгрузка `example/2.2x`.
 */
const TS_COLUMNS = ['Цена', 'Количество', 'Сумма', 'Номенклатура'];

function dataPaths(formXml: string): string[] {
  return Array.from(formXml.matchAll(/<DataPath>([^<]+)<\/DataPath>/g), (match) => match[1]);
}

suite('FormToolsService.addForm — колонки табличной части не становятся полями объекта', () => {
  suiteSetup(function () {
    skipWithoutCorpus(this);
  });

  for (const version of ['2.20', '2.21']) {
    suite(`формат ${version}`, () => {
      let root: string;
      let objectPath: string;

      setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-form-ts-'));
        const documents = path.join(root, 'Documents');
        fs.mkdirSync(documents);
        const source = path.resolve(__dirname, '../../../example', version, 'src', 'cf', 'Documents', 'ПриходТовара.xml');
        objectPath = path.join(documents, 'ПриходТовара.xml');
        fs.copyFileSync(source, objectPath);
      });

      teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
      });

      function addAndRead(formName: string, purpose: string): string[] {
        new FormToolsService().addForm({ objectPath, formName, purpose });
        return dataPaths(fs.readFileSync(path.join(root, 'Documents', 'ПриходТовара', 'Forms', formName, 'Ext', 'Form.xml'), 'utf-8'));
      }

      test('форма списка: колонки — реквизиты документа, без колонок ТЧ', () => {
        const paths = addAndRead('ТестСписка', 'List');
        assert.deepStrictEqual(paths, [
          'Список',
          'Список.Number',
          'Список.Date',
          'Список.Контрагент',
          'Список.Склад',
          'Список.ОтветственноеЛицо',
          'Список.Ref',
        ]);
      });

      test('форма документа: колонки ТЧ — только внутри таблицы Объект.Товары', () => {
        const paths = addAndRead('ТестДокумента', 'Object');
        for (const column of TS_COLUMNS) {
          assert.ok(!paths.includes(`Объект.${column}`), `колонка ТЧ ${column} не должна быть полем документа: ${paths.join(', ')}`);
          assert.ok(paths.includes(`Объект.Товары.${column}`), `колонка ТЧ ${column} должна остаться в таблице: ${paths.join(', ')}`);
        }
        assert.ok(paths.includes('Объект.Контрагент'));
      });
    });
  }
});
