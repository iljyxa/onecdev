import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataCompositionSchemaService } from '../../infra/xml/DataCompositionSchemaService';
import { skipWithoutCorpus } from './support/corpus';

/**
 * Разбор схемы берёт только прямых детей: параметр связи наборов — не параметр схемы (#133),
 * поля вложенных наборов объединения — не поля самого объединения (#134). Фикстура — макет
 * отчёта «Запасы» реальной выгрузки (DataSetUnion «ТоварыИПоступление» + dataSetLink).
 */
const TEMPLATE = path.join('Reports', 'Запасы', 'Templates', 'ОсновнаяСхемаКомпоновкиДанных', 'Ext', 'Template.xml');

suite('DataCompositionSchemaService — разбор прямых детей (#133, #134)', () => {
  for (const version of ['2.20', '2.21']) {
    suite(`формат ${version}`, () => {
      let root: string;
      let templatePath: string;
      const service = new DataCompositionSchemaService();

      suiteSetup(function () {
        skipWithoutCorpus(this);
      });

      setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-skd-direct-'));
        templatePath = path.join(root, 'Template.xml');
        fs.copyFileSync(path.resolve(__dirname, '../../../example', version, 'src', 'cf', TEMPLATE), templatePath);
      });

      teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
      });

      test('поля объединения — только его собственные; validate без ложных дублей', () => {
        const info = service.info({ templatePath });
        const union = info.dataSets.find((dataSet) => dataSet.name === 'ТоварыИПоступление');
        assert.deepStrictEqual(union?.fields.map((field) => field.dataPath), ['Номенклатура', 'Склад', 'КоличествоОстаток', 'Контрагент', 'Количество']);
        assert.strictEqual(service.validate({ templatePath }).errors, 0);
      });

      test('настоящий дубль поля в наборе по-прежнему ловится', () => {
        const xml = fs.readFileSync(templatePath, 'utf-8');
        const field = '<field xsi:type="DataSetFieldField">';
        fs.writeFileSync(templatePath, xml.replace(field, `${field}<dataPath>Склад</dataPath><field>Склад</field></field>\n\t\t${field}`), 'utf-8');
        const result = service.validate({ templatePath, detailed: true });
        assert.ok(result.issues.some((issue) => issue.message === 'Поля набора ТоварыИПоступление продублирован: Склад.'), JSON.stringify(result.issues));
      });

      test('параметр связи наборов не попадает в параметры схемы', () => {
        const before = service.info({ templatePath }).parameters.map((parameter) => parameter.name);
        assert.ok(before.length > 0 && before.every(Boolean), `параметры фикстуры: ${before.join(', ')}`);
        service.edit({ templatePath, operation: 'add-dataSetLink', value: 'ТоварыИПоступление > Цены on Склад = Склад [param Период]' });
        assert.deepStrictEqual(service.info({ templatePath }).parameters.map((parameter) => parameter.name), before);
      });
    });
  }

  test('файл без корня DataCompositionSchema — пустые наборы и параметры, без исключения', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-skd-noroot-'));
    try {
      const templatePath = path.join(root, 'Template.xml');
      fs.writeFileSync(templatePath, '<?xml version="1.0" encoding="UTF-8"?>\n<Другое><parameter><name>П</name></parameter></Другое>\n', 'utf-8');
      const info = new DataCompositionSchemaService().info({ templatePath });
      assert.deepStrictEqual(info.dataSets, []);
      assert.deepStrictEqual(info.parameters, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
