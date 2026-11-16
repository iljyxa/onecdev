import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataCompositionSchemaService } from '../../infra/xml/DataCompositionSchemaService';
import { buildDataSetLinkXml } from '../../infra/xml/dcs/editOperations';
import { skipWithoutCorpus } from './support/corpus';

/**
 * Связь наборов данных в формате платформы (#33): `sourceExpression`, `destinationExpression` и
 * `parameter` — прямые дети `<dataSetLink>`. Обёртка `<field>` ломала импорт конфигурации целиком
 * (XDTO: «НачалоСвойства: …schema}field»).
 *
 * Эталон — реальная выгрузка отчёта «Запасы» (8.5.1 / 2.21): связь из неё убирается и
 * добавляется заново операцией add-dataSetLink, результат обязан совпасть с выгрузкой байт-в-байт.
 */
const TEMPLATE_RELATIVE = path.join('Reports', 'Запасы', 'Templates', 'ОсновнаяСхемаКомпоновкиДанных', 'Ext', 'Template.xml');

function linkBlockOf(xml: string): string {
  const start = xml.indexOf('\t<dataSetLink>');
  const closeTag = '</dataSetLink>';
  const end = xml.indexOf(closeTag, start) + closeTag.length;
  assert.ok(start >= 0, 'в фикстуре ожидается dataSetLink');
  // Вместе с переводом строки, предшествующим блоку, чтобы удаление не оставило пустую строку.
  const eol = xml[start - 2] === '\r' ? '\r\n' : '\n';
  return xml.slice(start - eol.length, end);
}

suite('DataCompositionSchemaService — add-dataSetLink в формате платформы (#33)', () => {
  for (const version of ['2.20', '2.21']) {
    suite(`формат ${version}`, () => {
      const source = path.resolve(__dirname, '../../../example', version, 'src', 'cf', TEMPLATE_RELATIVE);

      suiteSetup(function () {
        skipWithoutCorpus(this);
      });

      test('удалённая из выгрузки связь, добавленная заново, совпадает с выгрузкой байт-в-байт', () => {
        const original = fs.readFileSync(source);
        const text = original.toString('utf-8');
        const withoutLink = text.replace(linkBlockOf(text), '');
        assert.ok(!withoutLink.includes('<dataSetLink>'), 'связь должна быть удалена перед проверкой');

        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-skd-link-'));
        try {
          const templatePath = path.join(root, 'Template.xml');
          fs.writeFileSync(templatePath, withoutLink, 'utf-8');

          new DataCompositionSchemaService().edit({
            templatePath,
            operation: 'add-dataSetLink',
            value: 'ТоварыИПоступление > Цены on Номенклатура = Номенклатура',
          });

          assert.ok(fs.readFileSync(templatePath).equals(original), 'связь обязана совпасть с выгрузкой платформы');
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    });
  }

  test('параметр связи — прямой ребёнок dataSetLink после выражений, без обёртки field', () => {
    assert.strictEqual(
      buildDataSetLinkXml('Остатки > Цены on Товар = Номенклатура [param Период]'),
      [
        '\t<dataSetLink>',
        '\t\t<sourceDataSet>Остатки</sourceDataSet>',
        '\t\t<destinationDataSet>Цены</destinationDataSet>',
        '\t\t<sourceExpression>Товар</sourceExpression>',
        '\t\t<destinationExpression>Номенклатура</destinationExpression>',
        '\t\t<parameter>Период</parameter>',
        '\t</dataSetLink>',
      ].join('\n')
    );
  });

  test('без параметра связи элемент parameter не пишется', () => {
    const xml = buildDataSetLinkXml('А > Б on Х = У');
    assert.ok(!xml.includes('<parameter>'));
    assert.ok(!xml.includes('<field>'), 'обёртки field у связи в формате платформы нет');
  });

  test('неверный формат значения отбивается подсказкой формата', () => {
    assert.throws(() => buildDataSetLinkXml('А и Б'), /Источник > Приёмник on Поле1 = Поле2/);
  });
});
