import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataCompositionSchemaService } from '../../infra/xml/DataCompositionSchemaService';
import { matchBlockRanges } from '../../infra/xml/dcs/dcsShared';
import { buildFieldXml } from '../../infra/xml/dcs/schemaBuilders';
import { assertWellFormedXml } from './support/typedFieldCorpus';
import { skipWithoutCorpus } from './support/corpus';

/**
 * #130: у поля набора данных СКД есть вложенный одноимённый `<field>Имя</field>`. Нежадный поиск
 * блока обрывался на нём, и `modify-field`/`remove-field` оставляли висящий `</field>` — платформа
 * отклоняла импорт всей конфигурации. Фикстура — макет отчёта «Запасы» реальной выгрузки.
 */
const TEMPLATE = path.join('Reports', 'Запасы', 'Templates', 'ОсновнаяСхемаКомпоновкиДанных', 'Ext', 'Template.xml');
// Поле КоличествоОстаток первого (union) набора — ровно в таком виде его пишет платформа.
const UNION_FIELD = [
  '<field xsi:type="DataSetFieldField">',
  '\t\t\t<dataPath>КоличествоОстаток</dataPath>',
  '\t\t\t<field>КоличествоОстаток</field>',
  '\t\t</field>',
].join('\n');

function lf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

suite('DataCompositionSchemaService — поле набора с вложенным <field> (#130)', () => {
  for (const version of ['2.20', '2.21']) {
    suite(`формат ${version}`, () => {
      let root: string;
      let templatePath: string;
      let original: string;

      suiteSetup(function () {
        skipWithoutCorpus(this);
      });

      setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-skd-nested-'));
        templatePath = path.join(root, 'Template.xml');
        fs.copyFileSync(path.resolve(__dirname, '../../../example', version, 'src', 'cf', TEMPLATE), templatePath);
        original = lf(fs.readFileSync(templatePath, 'utf-8'));
        assert.ok(original.includes(UNION_FIELD), 'фикстура: поле КоличествоОстаток набора-объединения');
      });

      teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
      });

      test('modify-field заменяет поле целиком, XML корректен', () => {
        const value = 'КоличествоОстаток [Кол]: decimal(15,3)';
        new DataCompositionSchemaService().edit({ templatePath, operation: 'modify-field', value });
        const after = lf(fs.readFileSync(templatePath, 'utf-8'));
        assertWellFormedXml(after, 'Template.xml после modify-field');
        assert.strictEqual(after, original.replace(UNION_FIELD, lf(buildFieldXml(value, '\t\t').trimStart())));
      });

      test('remove-field удаляет поле целиком, XML корректен', () => {
        new DataCompositionSchemaService().edit({ templatePath, operation: 'remove-field', value: 'КоличествоОстаток' });
        const after = lf(fs.readFileSync(templatePath, 'utf-8'));
        assertWellFormedXml(after, 'Template.xml после remove-field');
        assert.strictEqual(after, original.replace(UNION_FIELD, ''));
      });

      test('нет такого поля/набора: remove-field и add-field в чужой набор файл не трогают, modify-field добавляет поле с предупреждением', () => {
        const service = new DataCompositionSchemaService();
        assert.deepStrictEqual(service.edit({ templatePath, operation: 'remove-field', value: 'НетТакогоПоля' }).changedFiles, []);
        assert.deepStrictEqual(
          service.edit({ templatePath, operation: 'add-field', value: 'Новое: string', dataSet: 'НетТакогоНабора' }).changedFiles,
          []
        );
        assert.strictEqual(lf(fs.readFileSync(templatePath, 'utf-8')), original);

        const modified = service.edit({ templatePath, operation: 'modify-field', value: 'НетТакогоПоля: string' });
        assert.deepStrictEqual(modified.warnings, ['Поле не найдено, добавлено новое: НетТакогоПоля.']);
        assertWellFormedXml(fs.readFileSync(templatePath, 'utf-8'), 'Template.xml после modify-field несуществующего поля');
      });
    });
  }
});

suite('matchBlockRanges — внешние блоки с учётом вложенности (#130)', () => {
  test('вложенный одноимённый тег не обрывает внешний блок; самозакрытый — отдельный блок', () => {
    const xml = '<a><field x="1"><field>И</field></field><field/><field><dataPath>Б</dataPath></field></a>';
    assert.deepStrictEqual(matchBlockRanges(xml, 'field').map((range) => range.text), [
      '<field x="1"><field>И</field></field>',
      '<field/>',
      '<field><dataPath>Б</dataPath></field>',
    ]);
  });

  test('префикс имени тега не путается (fieldX), закрывающий без открывающего пропускается', () => {
    const xml = '</field><fieldX>1</fieldX><field>2</field>';
    const ranges = matchBlockRanges(xml, 'field');
    assert.deepStrictEqual(ranges.map((range) => [range.start, range.end, range.text]), [[26, 42, '<field>2</field>']]);
  });
});
