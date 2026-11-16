import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataCompositionSchemaService } from '../../infra/xml/DataCompositionSchemaService';
import {
  DCS_SETTINGS_ELEMENT_ORDER,
  DCS_SETTINGS_NAMESPACES,
  buildConditionalAppearanceItemXml,
  buildDataParameterItemXml,
  buildFilterItemXml,
  buildOrderItemXml,
  buildOutputParameterItemXml,
  buildSectionXml,
  buildSelectionItemXml,
  buildSettingsValueXml,
  buildStructureItemsXml,
  buildVariantXml,
  stableUserSettingId,
} from '../../infra/xml/dcs/settingsVariant';
import { EXAMPLE_GENERATIONS, skipWithoutCorpus } from './support/corpus';

/**
 * Вариант настроек СКД в формате платформы (#131): `dcsset:name`/`dcsset:presentation`/
 * `dcsset:settings` с префиксованными секциями. Эталоны — реальная выгрузка
 * (`example/2.2x`: «Запасы», «Пользователи», «ПраваДоступа») и Template.xml «Запасов»
 * после round-trip через платформу 8.5.1 (`src/test/fixtures/dcs-settings-variant`).
 * compile пишет LF без BOM, а фикстура в git может прийти и с CRLF, и с LF — поэтому
 * сравнение с ней идёт после нормализации переводов строк.
 */

const ROOT = path.resolve(__dirname, '../../..');
const ROUNDTRIP_FIXTURE = path.join(ROOT, 'src/test/fixtures/dcs-settings-variant/zapasy-variant-roundtrip-8.5.1.xml');
const GENERATIONS = [['2.20', EXAMPLE_GENERATIONS.cf20], ['2.21', EXAMPLE_GENERATIONS.cf21]] as const;
const ZAPASY = 'Reports/Запасы/Templates/ОсновнаяСхемаКомпоновкиДанных/Ext/Template.xml';
const POLZOVATELI = 'Reports/Пользователи/Templates/ОсновнаяСхемаКомпоновкиДанных/Ext/Template.xml';
const PRAVA = 'Reports/ПраваДоступа/Templates/МакетПараметров/Ext/Template.xml';

const NAMESPACES = 'xmlns:pal="http://v8.1c.ru/8.1/data/ui/colors/palette" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows"';

const toLf = (text: string): string => text.replace(/\r\n/g, '\n').replace(/^\ufeff/, '');
const bareLfCount = (text: string): number => (text.match(/(?<!\r)\n/g) ?? []).length;

/** Временные каталоги сьюта: удаляются в suiteTeardown, чтобы прогоны не копили мусор в tmp. */
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-skd-variant-'));
  tempDirs.push(dir);
  return dir;
}

function copyTemplate(sourcePath: string): string {
  const dir = makeTempDir();
  const target = path.join(dir, 'Template.xml');
  fs.copyFileSync(sourcePath, target);
  return target;
}

function writeTemplate(content: string): string {
  const dir = makeTempDir();
  const target = path.join(dir, 'Template.xml');
  fs.writeFileSync(target, content, 'utf-8');
  return target;
}

function variantBlocks(xml: string): string[] {
  return [...toLf(xml).matchAll(/\t<settingsVariant>[\s\S]*?<\/settingsVariant>/g)].map((match) => match[0]);
}

function settingsBlock(variant: string): string {
  return /\t*<dcsset:settings[\s\S]*?<\/dcsset:settings>/.exec(variant)?.[0] ?? '';
}

/** Содержимое dcsset:settings без открывающего тега: в 2.20 нет xmlns:pal, состав секций общий. */
function settingsBody(variant: string): string {
  const block = settingsBlock(variant);
  return block.slice(block.indexOf('>') + 1);
}

function replaceOnce(text: string, search: string, replacement: string): string {
  const at = text.indexOf(search);
  assert.ok(at >= 0, `в эталоне нет фрагмента: ${search}`);
  return text.slice(0, at) + replacement + text.slice(at + search.length);
}

const PRAVA_FILTER_SECTION = [
  '\t\t\t<dcsset:filter>',
  '\t\t\t\t<dcsset:item xsi:type="dcsset:FilterItemComparison">',
  '\t\t\t\t\t<dcsset:left xsi:type="dcscor:Field">Пользователь</dcsset:left>',
  '\t\t\t\t\t<dcsset:comparisonType>Equal</dcsset:comparisonType>',
  '\t\t\t\t\t<dcsset:viewMode>Inaccessible</dcsset:viewMode>',
  '\t\t\t\t</dcsset:item>',
  '\t\t\t</dcsset:filter>',
  '',
].join('\n');

const PRAVA_DATA_PARAMETERS_END = [
  '\t\t\t\t\t<dcsset:userSettingID>7a4419ba-878e-4056-8b60-9ffd5a8cd15d</dcsset:userSettingID>',
  '\t\t\t\t</dcscor:item>',
  '\t\t\t</dcsset:dataParameters>',
  '',
].join('\n');

const DETAILS_GROUP = [
  '\t\t\t<dcsset:item xsi:type="dcsset:StructureItemGroup">',
  '\t\t\t\t<dcsset:order>',
  '\t\t\t\t\t<dcsset:item xsi:type="dcsset:OrderItemAuto"/>',
  '\t\t\t\t</dcsset:order>',
  '\t\t\t\t<dcsset:selection>',
  '\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>',
  '\t\t\t\t</dcsset:selection>',
  '\t\t\t</dcsset:item>',
].join('\n');

suite('settingsVariant — билдеры элементов варианта настроек СКД (#131)', () => {
  test('порядок прямых детей dcsset:settings и пространства имён — как в выгрузке платформы', () => {
    assert.deepStrictEqual([...DCS_SETTINGS_ELEMENT_ORDER], [
      'dcsset:selection', 'dcsset:filter', 'dcsset:dataParameters', 'dcsset:order', 'dcsset:conditionalAppearance',
      'dcsset:outputParameters', 'dcsset:item', 'dcsset:itemsViewMode', 'dcsset:itemsUserSettingID',
    ]);
    assert.strictEqual(DCS_SETTINGS_NAMESPACES, NAMESPACES);
  });

  const typedCases: readonly [string, string][] = [
    ['true', 'xs:boolean'],
    ['false', 'xs:boolean'],
    ['0', 'xs:decimal'],
    ['-1.5', 'xs:decimal'],
    ['0001-01-01T00:00:00', 'xs:dateTime'],
    ['web:Red', 'v8ui:Color'],
    ['win:ButtonFace', 'v8ui:Color'],
    ['style:ПоясняющийТекст', 'v8ui:Color'],
  ];
  for (const plainStringType of ['xs:string', 'v8:LocalStringType'] as const) {
    for (const [raw, xsiType] of typedCases) {
      test(`buildSettingsValueXml: «${raw}» → ${xsiType} (строковый тип по умолчанию ${plainStringType})`, () => {
        assert.strictEqual(
          buildSettingsValueXml('dcsset:right', raw, '\t', plainStringType),
          `\t<dcsset:right xsi:type="${xsiType}">${raw}</dcsset:right>`,
        );
      });
    }
  }

  test('buildSettingsValueXml: строка → xs:string однострочно с экранированием', () => {
    assert.strictEqual(buildSettingsValueXml('dcscor:value', 'Иванов & К', '\t\t', 'xs:string'), '\t\t<dcscor:value xsi:type="xs:string">Иванов &amp; К</dcscor:value>');
  });

  test('buildSettingsValueXml: строка → v8:LocalStringType многострочно, как выгружает платформа', () => {
    assert.strictEqual(buildSettingsValueXml('dcscor:value', 'Тест', '\t', 'v8:LocalStringType'), [
      '\t<dcscor:value xsi:type="v8:LocalStringType">',
      '\t\t<v8:item>',
      '\t\t\t<v8:lang>ru</v8:lang>',
      '\t\t\t<v8:content>Тест</v8:content>',
      '\t\t</v8:item>',
      '\t</dcscor:value>',
    ].join('\n'));
  });

  test('stableUserSettingId: детерминирован, различает seed, формат GUID версии 5', () => {
    const first = stableUserSettingId('Основной/dataParameters/Период');
    assert.strictEqual(first, stableUserSettingId('Основной/dataParameters/Период'));
    assert.strictEqual(first, '455615a1-8db4-5784-b63f-403185206ddf');
    assert.notStrictEqual(first, stableUserSettingId('Основной/dataParameters/Организация'));
    for (const seed of ['', 'a', 'ПоСкладам/filter/Склад', 'x'.repeat(500)]) {
      assert.match(stableUserSettingId(seed), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  test('buildSelectionItemXml: Auto → SelectedItemAuto, поле → SelectedItemField с экранированием', () => {
    assert.strictEqual(buildSelectionItemXml('Auto', '\t'), '\t<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>');
    assert.strictEqual(buildSelectionItemXml('A<B', '\t'), [
      '\t<dcsset:item xsi:type="dcsset:SelectedItemField">',
      '\t\t<dcsset:field>A&lt;B</dcsset:field>',
      '\t</dcsset:item>',
    ].join('\n'));
  });

  test('buildFilterItemXml: «Поле = _» — без use, без right, без userSettingID', () => {
    assert.strictEqual(buildFilterItemXml('Номенклатура = _', '\t\t\t\t', 'Основной/filter'), [
      '\t\t\t\t<dcsset:item xsi:type="dcsset:FilterItemComparison">',
      '\t\t\t\t\t<dcsset:left xsi:type="dcscor:Field">Номенклатура</dcsset:left>',
      '\t\t\t\t\t<dcsset:comparisonType>Equal</dcsset:comparisonType>',
      '\t\t\t\t</dcsset:item>',
    ].join('\n'));
  });

  test('buildFilterItemXml: @off и @user — use=false первым, userSettingID последним (seed + поле)', () => {
    assert.strictEqual(buildFilterItemXml('Поле > 0 @off @user', '\t', 'Основной/filter'), [
      '\t<dcsset:item xsi:type="dcsset:FilterItemComparison">',
      '\t\t<dcsset:use>false</dcsset:use>',
      '\t\t<dcsset:left xsi:type="dcscor:Field">Поле</dcsset:left>',
      '\t\t<dcsset:comparisonType>Greater</dcsset:comparisonType>',
      '\t\t<dcsset:right xsi:type="xs:decimal">0</dcsset:right>',
      '\t\t<dcsset:userSettingID>afeea5dc-732a-5627-a8ca-a0bf41c20d05</dcsset:userSettingID>',
      '\t</dcsset:item>',
    ].join('\n'));
  });

  const operators: readonly [string, string, string][] = [
    ['Поле = 5', 'Equal', '5'],
    ['Поле <> 5', 'NotEqual', '5'],
    ['Поле > 5', 'Greater', '5'],
    ['Поле >= 5', 'GreaterOrEqual', '5'],
    ['Поле < 5', 'Less', '5'],
    ['Поле <= 5', 'LessOrEqual', '5'],
    ['Поле filled', 'Filled', ''],
    ['Поле notFilled', 'NotFilled', ''],
    ['Поле', 'Equal', ''],
  ];
  for (const [value, comparison, right] of operators) {
    test(`buildFilterItemXml: «${value}» → ${comparison}`, () => {
      const xml = buildFilterItemXml(value, '', 'В/filter');
      assert.ok(xml.includes('<dcsset:left xsi:type="dcscor:Field">Поле</dcsset:left>'), xml);
      assert.ok(xml.includes(`<dcsset:comparisonType>${comparison}</dcsset:comparisonType>`), xml);
      assert.strictEqual(xml.includes('<dcsset:right'), right !== '', xml);
      if (right) {
        assert.ok(xml.includes(`<dcsset:right xsi:type="xs:decimal">${right}</dcsset:right>`), xml);
      }
    });
  }

  test('buildOrderItemXml: Auto, поле по возрастанию, поле desc в любом регистре', () => {
    assert.strictEqual(buildOrderItemXml('Auto', '\t'), '\t<dcsset:item xsi:type="dcsset:OrderItemAuto"/>');
    const field = (name: string, type: string): string => [
      '\t<dcsset:item xsi:type="dcsset:OrderItemField">',
      `\t\t<dcsset:field>${name}</dcsset:field>`,
      `\t\t<dcsset:orderType>${type}</dcsset:orderType>`,
      '\t</dcsset:item>',
    ].join('\n');
    assert.strictEqual(buildOrderItemXml('Номенклатура', '\t'), field('Номенклатура', 'Asc'));
    assert.strictEqual(buildOrderItemXml('Склад desc', '\t'), field('Склад', 'Desc'));
    assert.strictEqual(buildOrderItemXml(' Склад DESC ', '\t'), field('Склад', 'Desc'));
  });

  test('buildDataParameterItemXml: с userSettingID и без него', () => {
    assert.strictEqual(buildDataParameterItemXml('Период', '\t', 'id-1'), [
      '\t<dcscor:item xsi:type="dcsset:SettingsParameterValue">',
      '\t\t<dcscor:parameter>Период</dcscor:parameter>',
      '\t\t<dcscor:value xsi:nil="true"/>',
      '\t\t<dcsset:userSettingID>id-1</dcsset:userSettingID>',
      '\t</dcscor:item>',
    ].join('\n'));
    assert.strictEqual(buildDataParameterItemXml('Период', '\t'), [
      '\t<dcscor:item xsi:type="dcsset:SettingsParameterValue">',
      '\t\t<dcscor:parameter>Период</dcscor:parameter>',
      '\t\t<dcscor:value xsi:nil="true"/>',
      '\t</dcscor:item>',
    ].join('\n'));
  });

  test('buildSectionXml: обёртка dcsset:<секция> вокруг готовых элементов', () => {
    assert.strictEqual(buildSectionXml('order', ['\t\t<dcsset:item xsi:type="dcsset:OrderItemAuto"/>'], '\t'), [
      '\t<dcsset:order>',
      '\t\t<dcsset:item xsi:type="dcsset:OrderItemAuto"/>',
      '\t</dcsset:order>',
    ].join('\n'));
  });

  test('buildConditionalAppearanceItemXml: when + for — побайтно как элемент фикстуры round-trip 8.5.1', () => {
    const fixture = toLf(fs.readFileSync(ROUNDTRIP_FIXTURE, 'utf-8'));
    const expected = /\t\t\t\t<dcsset:item>\n[\s\S]*?\n\t\t\t\t<\/dcsset:item>/.exec(fixture.slice(fixture.indexOf('<dcsset:conditionalAppearance>')))?.[0];
    assert.strictEqual(buildConditionalAppearanceItemXml('ЦветТекста = web:Red when Количество < 0 for Количество', '\t\t\t\t', 'В/conditionalAppearance/filter'), expected);
  });

  test('buildConditionalAppearanceItemXml: без when/for — пустые selection/filter (как выгружает платформа) и appearance', () => {
    assert.strictEqual(buildConditionalAppearanceItemXml('Шрифт = Жирный', '', 'В/conditionalAppearance/filter'), [
      '<dcsset:item>',
      '\t<dcsset:selection/>',
      '\t<dcsset:filter/>',
      '\t<dcsset:appearance>',
      '\t\t<dcscor:item xsi:type="dcsset:SettingsParameterValue">',
      '\t\t\t<dcscor:parameter>Шрифт</dcscor:parameter>',
      '\t\t\t<dcscor:value xsi:type="xs:string">Жирный</dcscor:value>',
      '\t\t</dcscor:item>',
      '\t</dcsset:appearance>',
      '</dcsset:item>',
    ].join('\n'));
  });

  test('buildConditionalAppearanceItemXml: только when — пустая selection и filter', () => {
    const xml = buildConditionalAppearanceItemXml('ЦветФона = web:Yellow when Сумма filled', '', 'В/conditionalAppearance/filter');
    assert.ok(xml.startsWith('<dcsset:item>\n\t<dcsset:selection/>\n\t<dcsset:filter>'), xml);
    assert.ok(xml.includes('\t<dcsset:filter>\n\t\t<dcsset:item xsi:type="dcsset:FilterItemComparison">\n\t\t\t<dcsset:left xsi:type="dcscor:Field">Сумма</dcsset:left>\n\t\t\t<dcsset:comparisonType>Filled</dcsset:comparisonType>\n\t\t</dcsset:item>\n\t</dcsset:filter>\n\t<dcsset:appearance>'), xml);
  });

  test('buildConditionalAppearanceItemXml: «when … @user» — userSettingID из затравки варианта и поля', () => {
    const xml = buildConditionalAppearanceItemXml('ЦветТекста = web:Red when Сумма < 0 @user', '', 'ПоСкладам/conditionalAppearance/filter');
    assert.ok(xml.includes(`<dcsset:userSettingID>${stableUserSettingId('ПоСкладам/conditionalAppearance/filter/Сумма')}</dcsset:userSettingID>`), xml);
    assert.notStrictEqual(stableUserSettingId('ПоСкладам/conditionalAppearance/filter/Сумма'), stableUserSettingId('Основной/conditionalAppearance/filter/Сумма'));
  });

  test('buildConditionalAppearanceItemXml: только for с несколькими полями — selection и пустой filter', () => {
    const xml = buildConditionalAppearanceItemXml('ЦветТекста = web:Blue for Склад, Номенклатура', '', 'В/conditionalAppearance/filter');
    assert.ok(xml.startsWith([
      '<dcsset:item>',
      '\t<dcsset:selection>',
      '\t\t<dcsset:item>',
      '\t\t\t<dcsset:field>Склад</dcsset:field>',
      '\t\t</dcsset:item>',
      '\t\t<dcsset:item>',
      '\t\t\t<dcsset:field>Номенклатура</dcsset:field>',
      '\t\t</dcsset:item>',
      '\t</dcsset:selection>',
      '\t<dcsset:filter/>',
      '\t<dcsset:appearance>',
    ].join('\n')), xml);
  });

  test('buildConditionalAppearanceItemXml: неразбираемый DSL — прежний текст ошибки', () => {
    assert.throws(() => buildConditionalAppearanceItemXml('без знака равенства', '', 'В/conditionalAppearance/filter'), {
      message: 'add-conditionalAppearance ожидает формат: Параметр = значение [when условие] [for Поле1, Поле2].',
    });
  });

  test('buildOutputParameterItemXml: строка — LocalStringType, как в фикстуре round-trip 8.5.1', () => {
    const fixture = toLf(fs.readFileSync(ROUNDTRIP_FIXTURE, 'utf-8'));
    const expected = /\t\t\t\t<dcscor:item[\s\S]*?<\/dcscor:item>/.exec(fixture.slice(fixture.indexOf('<dcsset:outputParameters>')))?.[0];
    assert.strictEqual(buildOutputParameterItemXml('Заголовок = Тест', '\t\t\t\t'), expected);
  });

  test('buildOutputParameterItemXml: boolean и пустое значение', () => {
    assert.ok(buildOutputParameterItemXml('ВыводитьЗаголовок = false', '').includes('<dcscor:value xsi:type="xs:boolean">false</dcscor:value>'));
    assert.ok(buildOutputParameterItemXml('Заголовок', '').includes('<dcscor:parameter>Заголовок</dcscor:parameter>'));
  });

  test('buildStructureItemsXml: details / детали / пустая строка — одна группировка детальных записей', () => {
    for (const structure of ['details', 'детали', '']) {
      assert.strictEqual(buildStructureItemsXml(structure, '\t\t\t'), DETAILS_GROUP, structure);
    }
  });

  test('buildStructureItemsXml: «A > B > details» — вложенные группировки, внутренняя без groupItems', () => {
    const xml = buildStructureItemsXml('A > B > details', '');
    assert.strictEqual((xml.match(/xsi:type="dcsset:StructureItemGroup"/g) ?? []).length, 3);
    assert.strictEqual((xml.match(/<dcsset:groupItems>/g) ?? []).length, 2);
    assert.ok(xml.includes(DETAILS_GROUP.replace(/^\t\t\t/gm, '\t\t')), xml);
  });

  test('buildStructureItemsXml: массив — имя, groupBy/groupFields, своя selection, дочерние', () => {
    const xml = buildStructureItemsXml([
      { name: 'Группировка', groupBy: ['Склад'], selection: ['Склад', 'Auto'], children: [{ groupFields: ['Номенклатура'] }] },
      {},
    ], '');
    assert.strictEqual(xml, [
      '<dcsset:item xsi:type="dcsset:StructureItemGroup">',
      '\t<dcsset:name>Группировка</dcsset:name>',
      '\t<dcsset:groupItems>',
      '\t\t<dcsset:item xsi:type="dcsset:GroupItemField">',
      '\t\t\t<dcsset:field>Склад</dcsset:field>',
      '\t\t\t<dcsset:groupType>Items</dcsset:groupType>',
      '\t\t\t<dcsset:periodAdditionType>None</dcsset:periodAdditionType>',
      '\t\t\t<dcsset:periodAdditionBegin xsi:type="xs:dateTime">0001-01-01T00:00:00</dcsset:periodAdditionBegin>',
      '\t\t\t<dcsset:periodAdditionEnd xsi:type="xs:dateTime">0001-01-01T00:00:00</dcsset:periodAdditionEnd>',
      '\t\t</dcsset:item>',
      '\t</dcsset:groupItems>',
      '\t<dcsset:order>',
      '\t\t<dcsset:item xsi:type="dcsset:OrderItemAuto"/>',
      '\t</dcsset:order>',
      '\t<dcsset:selection>',
      '\t\t<dcsset:item xsi:type="dcsset:SelectedItemField">',
      '\t\t\t<dcsset:field>Склад</dcsset:field>',
      '\t\t</dcsset:item>',
      '\t\t<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>',
      '\t</dcsset:selection>',
      '\t<dcsset:item xsi:type="dcsset:StructureItemGroup">',
      '\t\t<dcsset:groupItems>',
      '\t\t\t<dcsset:item xsi:type="dcsset:GroupItemField">',
      '\t\t\t\t<dcsset:field>Номенклатура</dcsset:field>',
      '\t\t\t\t<dcsset:groupType>Items</dcsset:groupType>',
      '\t\t\t\t<dcsset:periodAdditionType>None</dcsset:periodAdditionType>',
      '\t\t\t\t<dcsset:periodAdditionBegin xsi:type="xs:dateTime">0001-01-01T00:00:00</dcsset:periodAdditionBegin>',
      '\t\t\t\t<dcsset:periodAdditionEnd xsi:type="xs:dateTime">0001-01-01T00:00:00</dcsset:periodAdditionEnd>',
      '\t\t\t</dcsset:item>',
      '\t\t</dcsset:groupItems>',
      '\t\t<dcsset:order>',
      '\t\t\t<dcsset:item xsi:type="dcsset:OrderItemAuto"/>',
      '\t\t</dcsset:order>',
      '\t\t<dcsset:selection>',
      '\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>',
      '\t\t</dcsset:selection>',
      '\t</dcsset:item>',
      '</dcsset:item>',
      DETAILS_GROUP.replace(/^\t\t\t/gm, ''),
    ].join('\n'));
  });

  test('buildVariantXml: заголовок по умолчанию = имя; dataParameters списком (значение отбрасывается) и auto по параметрам схемы', () => {
    const explicit = buildVariantXml({ name: 'В', filter: ['Поле = _'], order: ['Поле'], dataParameters: ['Период = 2020'] }, []);
    assert.ok(explicit.includes('\t\t\t\t<v8:content>В</v8:content>'), explicit);
    assert.ok(!explicit.includes('\n\t\t\t<dcsset:selection>'), 'верхняя selection без variant.selection не выводится');
    const sectionOrder = ['<dcsset:filter>', '<dcsset:dataParameters>', '<dcsset:order>', '<dcsset:item xsi:type="dcsset:StructureItemGroup">'].map((tag) => explicit.indexOf(`\n\t\t\t${tag}`));
    assert.ok(sectionOrder.every((at, i) => at > 0 && (i === 0 || at > sectionOrder[i - 1])), `секции в каноническом порядке: ${sectionOrder.join(',')}`);
    assert.ok(explicit.includes(`<dcscor:parameter>Период</dcscor:parameter>\n\t\t\t\t\t<dcscor:value xsi:nil="true"/>\n\t\t\t\t\t<dcsset:userSettingID>${stableUserSettingId('В/dataParameters/Период')}</dcsset:userSettingID>`), explicit);

    const auto = buildVariantXml({ name: 'А', selection: ['Auto'], dataParameters: 'auto' }, ['Дата', 'Организация']);
    assert.ok(auto.includes('\n\t\t\t<dcsset:selection>\n\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>\n\t\t\t</dcsset:selection>'), auto);
    assert.ok(auto.includes('<dcscor:parameter>Дата</dcscor:parameter>'), auto);
    assert.ok(auto.includes('<dcscor:parameter>Организация</dcscor:parameter>'), auto);
    assert.ok(!buildVariantXml({ name: 'Б', dataParameters: 'auto' }, []).includes('dataParameters'), 'пустой список параметров — без секции');
  });
});

suite('settingsVariant — compile/edit/info/validate на реальной выгрузке (#131)', () => {
  suiteSetup(function () {
    skipWithoutCorpus(this);
  });

  suiteTeardown(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const service = new DataCompositionSchemaService();
  const fixture =(): string => fs.readFileSync(ROUNDTRIP_FIXTURE, 'utf-8');

  test('compile: вариант «ПоСкладам» побайтно равен варианту фикстуры round-trip 8.5.1', () => {
    const outputPath = path.join(makeTempDir(), 'Template.xml');
    service.compile({
      outputPath,
      definition: { settingsVariants: [{ name: 'ПоСкладам', title: 'По складам', selection: ['Склад', 'Номенклатура', 'Количество'], structure: 'Склад > Номенклатура' }] },
    });
    const xml = fs.readFileSync(outputPath, 'utf-8');
    assert.strictEqual(variantBlocks(xml)[0], variantBlocks(fixture())[1]);
    assert.ok(!/<structure>|<settings>|<selection>|<filter>|<order>|<item[\s>]/.test(variantBlocks(xml)[0]), 'внутри варианта нет неквалифицированных элементов старого формата');
  });

  for (const [generation, cfRoot] of GENERATIONS) {
    test(`compile {Основной, details}: dcsset:settings совпадает с «Пользователями» (${generation})`, () => {
      const outputPath = path.join(makeTempDir(), 'Template.xml');
      service.compile({ outputPath, definition: { settingsVariants: [{ name: 'Основной', structure: 'details' }] } });
      const generated = variantBlocks(fs.readFileSync(outputPath, 'utf-8'))[0];
      const real = variantBlocks(fs.readFileSync(path.join(cfRoot, POLZOVATELI), 'utf-8'))[0];
      assert.strictEqual(settingsBody(generated), settingsBody(real));
      if (generation === '2.21') {
        assert.strictEqual(settingsBlock(generated), settingsBlock(real));
      }
    });
  }

  test('edit-цепочка на «Запасах» 2.21 в произвольном порядке операций = фикстура round-trip без dataParameters; BOM и EOL сохранены', () => {
    const source = path.join(EXAMPLE_GENERATIONS.cf21, ZAPASY);
    const templatePath = copyTemplate(source);
    const original = fs.readFileSync(source, 'utf-8');
    const operations = [
      ['set-outputParameter', 'Заголовок = Тест'],
      ['add-conditionalAppearance', 'ЦветТекста = web:Red when Количество < 0 for Количество'],
      ['add-order', 'Номенклатура'],
      ['add-filter', 'Номенклатура = _'],
    ] as const;
    for (const [operation, value] of operations) {
      const result = service.edit({ templatePath, operation, value });
      assert.deepStrictEqual([result.changedFiles.length, result.warnings], [1, []], operation);
    }
    const after = fs.readFileSync(templatePath, 'utf-8');
    const expected = toLf(fixture()).replace(/\t\t\t<dcsset:dataParameters>\n[\s\S]*?<\/dcsset:dataParameters>\n/, '');
    assert.strictEqual(toLf(after), expected);
    assert.ok(after.startsWith('\ufeff'), 'BOM сохранён');
    assert.ok(after.includes('\t\t\t<dcsset:outputParameters>\r\n'), 'новые строки — в CRLF окружения');
    assert.strictEqual(bareLfCount(after), bareLfCount(original), 'голые LF текста запроса не тронуты');
  });

  test('add-dataParameter «Период = …» на «Запасах»: секция после selection перед структурой, значение отбрасывается, userSettingID детерминирован', () => {
    const source = path.join(EXAMPLE_GENERATIONS.cf21, ZAPASY);
    const templatePath = copyTemplate(source);
    const result = service.edit({ templatePath, operation: 'add-dataParameter', value: 'Период = 2020-01-01' });
    assert.strictEqual(result.changedFiles.length, 1);
    const expected = replaceOnce(toLf(fs.readFileSync(source, 'utf-8')), '\t\t\t<dcsset:item xsi:type="dcsset:StructureItemGroup">', [
      '\t\t\t<dcsset:dataParameters>',
      '\t\t\t\t<dcscor:item xsi:type="dcsset:SettingsParameterValue">',
      '\t\t\t\t\t<dcscor:parameter>Период</dcscor:parameter>',
      '\t\t\t\t\t<dcscor:value xsi:nil="true"/>',
      '\t\t\t\t\t<dcsset:userSettingID>455615a1-8db4-5784-b63f-403185206ddf</dcsset:userSettingID>',
      '\t\t\t\t</dcscor:item>',
      '\t\t\t</dcsset:dataParameters>',
      '\t\t\t<dcsset:item xsi:type="dcsset:StructureItemGroup">',
    ].join('\n'));
    assert.strictEqual(toLf(fs.readFileSync(templatePath, 'utf-8')), expected);
  });

  for (const [generation, cfRoot] of GENERATIONS) {
    test(`set-structure идемпотентен к форме платформы: «Запасы» (оба варианта) и «Пользователи» (${generation})`, () => {
      const zapasy = copyTemplate(path.join(cfRoot, ZAPASY));
      const polzovateli = copyTemplate(path.join(cfRoot, POLZOVATELI));
      const cases = [
        { templatePath: zapasy, value: 'Склад > Номенклатура', variant: 'ПоСкладам' },
        { templatePath: zapasy, value: 'Номенклатура', variant: undefined },
        { templatePath: polzovateli, value: 'details', variant: undefined },
      ];
      for (const item of cases) {
        const result = service.edit({ ...item, operation: 'set-structure' });
        assert.deepStrictEqual([result.changedFiles, result.warnings], [[], []], item.value);
      }
    });

    suite(`«ПраваДоступа»: операции над секциями (${generation})`, () => {
      const source = path.join(cfRoot, PRAVA);
      const originalLf = (): string => toLf(fs.readFileSync(source, 'utf-8'));
      const run = (operation: Parameters<DataCompositionSchemaService['edit']>[0]['operation'], value: string) => {
        const templatePath = copyTemplate(source);
        const result = service.edit({ templatePath, operation, value });
        return { result, xml: toLf(fs.readFileSync(templatePath, 'utf-8')) };
      };

      test('modify-filter заменяет первый элемент: viewMode уходит, right — xs:string', () => {
        const { result, xml } = run('modify-filter', 'Пользователь = Иванов');
        assert.strictEqual(result.changedFiles.length, 1);
        assert.strictEqual(xml, replaceOnce(originalLf(), '\t\t\t\t\t<dcsset:viewMode>Inaccessible</dcsset:viewMode>', '\t\t\t\t\t<dcsset:right xsi:type="xs:string">Иванов</dcsset:right>'));
      });

      test('remove-filter по полю удаляет опустевшую секцию целиком', () => {
        const { xml } = run('remove-filter', 'Пользователь');
        assert.strictEqual(xml, replaceOnce(originalLf(), PRAVA_FILTER_SECTION, ''));
      });

      test('remove-filter несуществующего поля — без изменений', () => {
        assert.deepStrictEqual(run('remove-filter', 'Другое').result.changedFiles, []);
      });

      test('clear-filter удаляет секцию; clear-order/clear-selection без секции — no-op', () => {
        assert.strictEqual(run('clear-filter', '_').xml, replaceOnce(originalLf(), PRAVA_FILTER_SECTION, ''));
        assert.deepStrictEqual(run('clear-order', '_').result.changedFiles, []);
        assert.deepStrictEqual(run('clear-selection', '_').result.changedFiles, []);
      });

      test('add-order «Пользователь desc» — новая секция после dataParameters', () => {
        const { xml } = run('add-order', 'Пользователь desc');
        assert.strictEqual(xml, replaceOnce(originalLf(), PRAVA_DATA_PARAMETERS_END, PRAVA_DATA_PARAMETERS_END + [
          '\t\t\t<dcsset:order>',
          '\t\t\t\t<dcsset:item xsi:type="dcsset:OrderItemField">',
          '\t\t\t\t\t<dcsset:field>Пользователь</dcsset:field>',
          '\t\t\t\t\t<dcsset:orderType>Desc</dcsset:orderType>',
          '\t\t\t\t</dcsset:item>',
          '\t\t\t</dcsset:order>',
          '',
        ].join('\n')));
      });

      test('add-selection «Пользователь» — секция первой, перед filter', () => {
        const { xml } = run('add-selection', 'Пользователь');
        assert.strictEqual(xml, replaceOnce(originalLf(), PRAVA_FILTER_SECTION, [
          '\t\t\t<dcsset:selection>',
          '\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemField">',
          '\t\t\t\t\t<dcsset:field>Пользователь</dcsset:field>',
          '\t\t\t\t</dcsset:item>',
          '\t\t\t</dcsset:selection>',
          '',
        ].join('\n') + PRAVA_FILTER_SECTION));
      });

      test('add-dataParameter существующего параметра — предупреждение без изменений', () => {
        const { result } = run('add-dataParameter', 'ПодробныеСведенияОПравахДоступа');
        assert.deepStrictEqual(result.changedFiles, []);
        assert.deepStrictEqual(result.warnings, ['add-dataParameter: параметр уже есть в варианте ПраваДоступа: ПодробныеСведенияОПравахДоступа.']);
      });

      test('modify-dataParameter существующего параметра — предупреждение; нового — элемент без userSettingID в конце секции', () => {
        assert.deepStrictEqual(run('modify-dataParameter', 'ПодробныеСведенияОПравахДоступа').result.warnings, ['modify-dataParameter: параметр уже есть в варианте ПраваДоступа: ПодробныеСведенияОПравахДоступа.']);
        const { xml } = run('modify-dataParameter', 'НовыйПараметр');
        assert.strictEqual(xml, replaceOnce(originalLf(), PRAVA_DATA_PARAMETERS_END, [
          '\t\t\t\t\t<dcsset:userSettingID>7a4419ba-878e-4056-8b60-9ffd5a8cd15d</dcsset:userSettingID>',
          '\t\t\t\t</dcscor:item>',
          '\t\t\t\t<dcscor:item xsi:type="dcsset:SettingsParameterValue">',
          '\t\t\t\t\t<dcscor:parameter>НовыйПараметр</dcscor:parameter>',
          '\t\t\t\t\t<dcscor:value xsi:nil="true"/>',
          '\t\t\t\t</dcscor:item>',
          '\t\t\t</dcsset:dataParameters>',
          '',
        ].join('\n')));
      });

      test('set-structure без структуры в варианте — группировка в конец dcsset:settings', () => {
        const { xml } = run('set-structure', 'details');
        assert.strictEqual(xml, replaceOnce(originalLf(), PRAVA_DATA_PARAMETERS_END, `${PRAVA_DATA_PARAMETERS_END}${DETAILS_GROUP}\n`));
      });

      test('set-outputParameter: повтор с тем же именем заменяет значение, другое имя добавляется в секцию', () => {
        const templatePath = copyTemplate(source);
        service.edit({ templatePath, operation: 'set-outputParameter', value: 'Заголовок = Первый' });
        service.edit({ templatePath, operation: 'set-outputParameter', value: 'Заголовок = Второй' });
        service.edit({ templatePath, operation: 'set-outputParameter', value: 'ВыводитьЗаголовок = false' });
        const xml = toLf(fs.readFileSync(templatePath, 'utf-8'));
        assert.strictEqual(xml, replaceOnce(originalLf(), PRAVA_DATA_PARAMETERS_END, PRAVA_DATA_PARAMETERS_END + [
          '\t\t\t<dcsset:outputParameters>',
          '\t\t\t\t<dcscor:item xsi:type="dcsset:SettingsParameterValue">',
          '\t\t\t\t\t<dcscor:parameter>Заголовок</dcscor:parameter>',
          '\t\t\t\t\t<dcscor:value xsi:type="v8:LocalStringType">',
          '\t\t\t\t\t\t<v8:item>',
          '\t\t\t\t\t\t\t<v8:lang>ru</v8:lang>',
          '\t\t\t\t\t\t\t<v8:content>Второй</v8:content>',
          '\t\t\t\t\t\t</v8:item>',
          '\t\t\t\t\t</dcscor:value>',
          '\t\t\t\t</dcscor:item>',
          '\t\t\t\t<dcscor:item xsi:type="dcsset:SettingsParameterValue">',
          '\t\t\t\t\t<dcscor:parameter>ВыводитьЗаголовок</dcscor:parameter>',
          '\t\t\t\t\t<dcscor:value xsi:type="xs:boolean">false</dcscor:value>',
          '\t\t\t\t</dcscor:item>',
          '\t\t\t</dcsset:outputParameters>',
          '',
        ].join('\n')));
      });

      test('FilterItemGroup с вложенным «Пользователь» не совпадает с полем: remove-filter его не трогает, info его не показывает', () => {
        const group = [
          '\t\t\t\t<dcsset:item xsi:type="dcsset:FilterItemGroup">',
          '\t\t\t\t\t<dcsset:groupType>AndGroup</dcsset:groupType>',
          '\t\t\t\t\t<dcsset:item xsi:type="dcsset:FilterItemComparison">',
          '\t\t\t\t\t\t<dcsset:left xsi:type="dcscor:Field">Пользователь</dcsset:left>',
          '\t\t\t\t\t\t<dcsset:comparisonType>Filled</dcsset:comparisonType>',
          '\t\t\t\t\t</dcsset:item>',
          '\t\t\t\t</dcsset:item>',
          '',
        ].join('\n');
        const withGroup = replaceOnce(originalLf(), '\t\t\t<dcsset:filter>\n', `\t\t\t<dcsset:filter>\n${group}`);
        const templatePath = writeTemplate(withGroup);
        assert.deepStrictEqual(service.info({ templatePath }).variants[0].filters, ['Пользователь']);
        service.edit({ templatePath, operation: 'remove-filter', value: 'Пользователь' });
        const after = fs.readFileSync(templatePath, 'utf-8');
        assert.strictEqual(after, replaceOnce(originalLf(), PRAVA_FILTER_SECTION, `\t\t\t<dcsset:filter>\n${group}\t\t\t</dcsset:filter>\n`));
        assert.deepStrictEqual(service.info({ templatePath }).variants[0].filters, []);
      });

      test('info: вариант виден с именем, заголовком и отбором', () => {
        const info = service.info({ templatePath: source, mode: 'variant' });
        assert.deepStrictEqual(info.variants, [{ name: 'ПраваДоступа', title: 'ПраваДоступа', selection: [], filters: ['Пользователь'], order: [] }]);
        assert.deepStrictEqual(info.lines, ['', '--- Variants ---', '  ПраваДоступа: selection=Auto']);
      });
    });

    test(`info «Запасов»: оба варианта, вложенные selection структуры не попадают (${generation})`, () => {
      const info = service.info({ templatePath: path.join(cfRoot, ZAPASY) });
      assert.deepStrictEqual(info.variants, [
        { name: 'Основной', title: 'Основной', selection: ['Номенклатура', 'Количество', 'Цена'], filters: [], order: [] },
        { name: 'ПоСкладам', title: 'По складам', selection: ['Склад', 'Номенклатура', 'Количество'], filters: [], order: [] },
      ]);
      // У «Запасов» validate находит ложные дубли полей в DataSetUnion — дефект вне #131;
      // здесь важно лишь, что варианты платформенного формата ошибок не дают.
      const zapasyIssues = service.validate({ templatePath: path.join(cfRoot, ZAPASY) }).issues;
      assert.deepStrictEqual(zapasyIssues.filter((issue) => issue.message.startsWith('Вариант настроек')), []);
      for (const report of [POLZOVATELI, PRAVA]) {
        assert.strictEqual(service.validate({ templatePath: path.join(cfRoot, report) }).errors, 0, report);
      }
    });
  }

  test('info на фикстуре round-trip: filters/order варианта, элементы conditionalAppearance не попадают', () => {
    const info = service.info({ templatePath: copyTemplate(ROUNDTRIP_FIXTURE) });
    assert.deepStrictEqual(info.variants[0], { name: 'Основной', title: 'Основной', selection: ['Номенклатура', 'Количество', 'Цена'], filters: ['Номенклатура'], order: ['Номенклатура'] });
  });

  test('--variant ПоСкладам: правится только второй вариант, секция встаёт перед структурой', () => {
    const source = path.join(EXAMPLE_GENERATIONS.cf21, ZAPASY);
    const templatePath = copyTemplate(source);
    service.edit({ templatePath, operation: 'add-order', value: 'Склад', variant: 'ПоСкладам' });
    const before = variantBlocks(fs.readFileSync(source, 'utf-8'));
    const after = variantBlocks(fs.readFileSync(templatePath, 'utf-8'));
    assert.strictEqual(after[0], before[0]);
    assert.strictEqual(after[1], replaceOnce(before[1], '\t\t\t</dcsset:selection>\n', [
      '\t\t\t</dcsset:selection>',
      '\t\t\t<dcsset:order>',
      '\t\t\t\t<dcsset:item xsi:type="dcsset:OrderItemField">',
      '\t\t\t\t\t<dcsset:field>Склад</dcsset:field>',
      '\t\t\t\t\t<dcsset:orderType>Asc</dcsset:orderType>',
      '\t\t\t\t</dcsset:item>',
      '\t\t\t</dcsset:order>',
      '',
    ].join('\n')));
  });

  test('add-filter двумя значениями и remove-filter одного: секция остаётся со вторым элементом', () => {
    const templatePath = copyTemplate(path.join(EXAMPLE_GENERATIONS.cf21, ZAPASY));
    service.edit({ templatePath, operation: 'add-filter', value: 'Номенклатура = _ ;; Склад = _' });
    service.edit({ templatePath, operation: 'remove-filter', value: 'Номенклатура' });
    const settings = settingsBlock(variantBlocks(fs.readFileSync(templatePath, 'utf-8'))[0]);
    assert.ok(settings.includes([
      '\t\t\t</dcsset:selection>',
      '\t\t\t<dcsset:filter>',
      '\t\t\t\t<dcsset:item xsi:type="dcsset:FilterItemComparison">',
      '\t\t\t\t\t<dcsset:left xsi:type="dcscor:Field">Склад</dcsset:left>',
      '\t\t\t\t\t<dcsset:comparisonType>Equal</dcsset:comparisonType>',
      '\t\t\t\t</dcsset:item>',
      '\t\t\t</dcsset:filter>',
      '\t\t\t<dcsset:item',
    ].join('\n')), settings);
  });

  test('set-structure заменяет все группировки верхнего уровня одной', () => {
    const outputPath = path.join(makeTempDir(), 'Template.xml');
    service.compile({ outputPath, definition: { settingsVariants: [{ name: 'В', selection: ['Auto'], structure: [{ groupFields: ['А'] }, { groupFields: ['Б'] }] }] } });
    service.edit({ templatePath: outputPath, operation: 'set-structure', value: 'details' });
    const settings = settingsBlock(variantBlocks(fs.readFileSync(outputPath, 'utf-8'))[0]);
    assert.strictEqual(settings, [
      `\t\t<dcsset:settings ${NAMESPACES}>`,
      '\t\t\t<dcsset:selection>',
      '\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>',
      '\t\t\t</dcsset:selection>',
      DETAILS_GROUP,
      '\t\t</dcsset:settings>',
    ].join('\n'));
  });

  test('add-variant добавляет вариант в формате платформы', () => {
    const templatePath = copyTemplate(path.join(EXAMPLE_GENERATIONS.cf21, PRAVA));
    service.edit({ templatePath, operation: 'add-variant', value: 'Новый [Новый вариант]' });
    const info = service.info({ templatePath });
    assert.deepStrictEqual(info.variants[1], { name: 'Новый', title: 'Новый вариант', selection: [], filters: [], order: [] });
    assert.ok(settingsBlock(variantBlocks(fs.readFileSync(templatePath, 'utf-8'))[1]).includes('<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>'));
  });

  suite('редактор варианта: граничные формы XML', () => {
    const prava = (): string => fs.readFileSync(path.join(EXAMPLE_GENERATIONS.cf21, PRAVA), 'utf-8');
    const realSettings = (): string => /<dcsset:settings [^>]*>[\s\S]*?<\/dcsset:settings>/.exec(prava())?.[0] ?? '';

    test('несуществующий вариант — предупреждение, файл не меняется', () => {
      const result = service.edit({ templatePath: copyTemplate(path.join(EXAMPLE_GENERATIONS.cf21, ZAPASY)), operation: 'add-order', value: 'Склад', variant: 'Нет' });
      assert.deepStrictEqual([result.changedFiles, result.warnings], [[], ['Вариант настроек не найден: Нет.']]);
    });

    test('схема без вариантов — предупреждение, файл не меняется', () => {
      const xml = prava().replace(/\t<settingsVariant>[\s\S]*?<\/settingsVariant>\r?\n/, '');
      const result = service.edit({ templatePath: writeTemplate(xml), operation: 'add-filter', value: 'Пользователь = _' });
      assert.deepStrictEqual([result.changedFiles, result.warnings], [[], ['Вариант настроек не найден: первый вариант.']]);
    });

    test('вариант старого формата (без dcsset:settings) — edit предупреждает, validate даёт ошибку, info не видит секций', () => {
      const xml = prava().replace(/\t<settingsVariant>[\s\S]*?<\/settingsVariant>/, '\t<settingsVariant>\n\t\t<name>Старый</name>\n\t\t<settings>\n\t\t\t<selection><item xsi:type="dcsset:SelectedItemAuto"/></selection>\n\t\t</settings>\n\t</settingsVariant>');
      const templatePath = writeTemplate(xml);
      const result = service.edit({ templatePath, operation: 'add-filter', value: 'Пользователь = _' });
      assert.deepStrictEqual([result.changedFiles, result.warnings], [[], ['Вариант настроек без dcsset:settings (формат не платформы) — правка не применена.']]);
      const validation = service.validate({ templatePath });
      assert.strictEqual(validation.errors, 1);
      assert.ok(validation.lines.includes('[ERROR] Вариант настроек №1 не содержит dcsset:settings: платформа такой вариант не загрузит.'), validation.lines.join('\n'));
      assert.deepStrictEqual(service.info({ templatePath }).variants, [{ name: '', title: '', selection: [], filters: [], order: [] }]);
    });

    test('самозакрытый dcsset:settings разворачивается с теми же атрибутами; no-op правка его не трогает', () => {
      const xml = prava().replace(realSettings(), `<dcsset:settings ${NAMESPACES}/>`);
      const noop = writeTemplate(xml);
      assert.deepStrictEqual(service.edit({ templatePath: noop, operation: 'clear-filter', value: '_' }).changedFiles, []);
      assert.deepStrictEqual(service.info({ templatePath: noop }).variants[0].filters, []);
      const templatePath = writeTemplate(xml);
      service.edit({ templatePath, operation: 'add-filter', value: 'Пользователь = _' });
      assert.strictEqual(settingsBlock(variantBlocks(fs.readFileSync(templatePath, 'utf-8'))[0]), [
        `\t\t<dcsset:settings ${NAMESPACES}>`,
        '\t\t\t<dcsset:filter>',
        '\t\t\t\t<dcsset:item xsi:type="dcsset:FilterItemComparison">',
        '\t\t\t\t\t<dcsset:left xsi:type="dcscor:Field">Пользователь</dcsset:left>',
        '\t\t\t\t\t<dcsset:comparisonType>Equal</dcsset:comparisonType>',
        '\t\t\t\t</dcsset:item>',
        '\t\t\t</dcsset:filter>',
        '\t\t</dcsset:settings>',
      ].join('\n'));
    });

    for (const operation of ['add-filter', 'modify-filter'] as const) {
      test(`самозакрытая секция разворачивается: ${operation}`, () => {
        const xml = toLf(prava()).replace(PRAVA_FILTER_SECTION, '\t\t\t<dcsset:filter/>\n');
        const templatePath = writeTemplate(xml);
        service.edit({ templatePath, operation, value: 'Пользователь = Иванов' });
        assert.ok(fs.readFileSync(templatePath, 'utf-8').includes([
          '\t\t\t<dcsset:filter>',
          '\t\t\t\t<dcsset:item xsi:type="dcsset:FilterItemComparison">',
          '\t\t\t\t\t<dcsset:left xsi:type="dcscor:Field">Пользователь</dcsset:left>',
          '\t\t\t\t\t<dcsset:comparisonType>Equal</dcsset:comparisonType>',
          '\t\t\t\t\t<dcsset:right xsi:type="xs:string">Иванов</dcsset:right>',
          '\t\t\t\t</dcsset:item>',
          '\t\t\t</dcsset:filter>',
          '\t\t\t<dcsset:dataParameters>',
        ].join('\n')));
      });
    }

    test('самозакрытая секция: remove-filter — без изменений; modify-filter без секции — добавляет её', () => {
      const selfClosed = writeTemplate(toLf(prava()).replace(PRAVA_FILTER_SECTION, '\t\t\t<dcsset:filter/>\n'));
      assert.deepStrictEqual(service.edit({ templatePath: selfClosed, operation: 'remove-filter', value: 'Пользователь' }).changedFiles, []);
      const missing = writeTemplate(toLf(prava()).replace(PRAVA_FILTER_SECTION, ''));
      assert.deepStrictEqual(service.edit({ templatePath: missing, operation: 'remove-filter', value: 'Пользователь' }).changedFiles, []);
      service.edit({ templatePath: missing, operation: 'modify-filter', value: 'Пользователь = _' });
      assert.deepStrictEqual(service.info({ templatePath: missing }).variants[0].filters, ['Пользователь']);
    });
  });
});
