import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { MetaKind } from '../../domain/MetaTypes';
import { MetadataXmlCreator } from '../../infra/xml/MetadataXmlCreator';
import { ObjectXmlReader } from '../../infra/xml/ObjectXmlReader';
import { BASELINE_RULESET } from '../../infra/xml/format/baselineRuleset';
import { FORMAT_2_20_RULESET } from '../../infra/xml/format/format2_20Ruleset';
import { FORMAT_PRE_2_20_RULESET } from '../../infra/xml/format/formatPre2_20Ruleset';
import { STANDARD_ATTRIBUTES_BLOCKS, STANDARD_TABULAR_SECTIONS_BLOCKS } from '../../infra/xml/format/standardAttributes';
import {
  defaultStandardAttributeElementXml,
  detectObjectXmlFormatVersion,
  resolveStandardAttributeXml,
  rulesetForObjectXml,
} from '../../infra/xml/properties/StandardAttributesBlock';
import { EXAMPLE_GENERATIONS, skipWithoutCorpus } from './support/corpus';

/** Элемент `<xr:Standard…  name="X">…</…>` из блока (без ведущего отступа). */
function elementOf(block: string, tag: 'StandardAttribute' | 'StandardTabularSection', name: string): string {
  const match = new RegExp(`<xr:${tag} name="${name}">[\\s\\S]*?</xr:${tag}>`).exec(block);
  assert.ok(match, `в блоке нет ${tag} ${name}`);
  return match[0];
}

/** Значение простого дочернего свойства `<xr:Key>…</xr:Key>` элемента. */
function valueOf(elementXml: string, key: string): string {
  const match = new RegExp(`<xr:${key}>([^<]*)</xr:${key}>`).exec(elementXml);
  assert.ok(match, `нет свойства ${key}`);
  return match[1];
}

/** Минимальный корень объекта вида с `<Properties>`; `version` — опционально. */
function objectXml(kind: string, properties: string, version: string | null = '2.21'): string {
  const versionAttr = version === null ? '' : ` version="${version}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable"${versionAttr}>\n\t<${kind} uuid="00000000-0000-0000-0000-000000000000">\n\t\t<Properties>\n\t\t\t<Name>Тест</Name>\n${properties}\t\t</Properties>\n\t</${kind}>\n</MetaDataObject>\n`;
}

const EXPLICIT_DESCRIPTION =
  '<xr:StandardAttribute name="Description">\n\t\t\t\t\t<xr:FillChecking>DontCheck</xr:FillChecking>\n\t\t\t\t</xr:StandardAttribute>';

suite('Шаблоны стандартных реквизитов — умолчания платформы (#16)', () => {
  // Значения сняты с платформы 8.5.1 (2.21) и 8.3.27 (2.20): пустой элемент
  // `<xr:StandardAttribute name="…"/>` → import → export, платформа достраивает
  // блок своими умолчаниями. Здесь — точки, где прежний шаблон расходился с
  // платформой; у остальных 8 видов шаблон совпал с достроенным блоком байт-в-байт.
  const cases: [MetaKind, string, string, string][] = [
    ['ExchangePlan', 'ExchangeDate', 'FullTextSearch', 'Use'],
    ['CalculationRegister', 'RegistrationPeriod', 'FillChecking', 'ShowError'],
    ['CalculationRegister', 'CalculationType', 'FillChecking', 'ShowError'],
    ['ChartOfAccounts', 'Description', 'FillChecking', 'ShowError'],
    ['ChartOfAccounts', 'Code', 'FillChecking', 'ShowError'],
    ['ChartOfAccounts', 'Parent', 'FillFromFillingValue', 'true'],
  ];
  for (const [kind, name, key, expected] of cases) {
    test(`${kind}.${name}.${key} = ${expected}`, () => {
      const block = STANDARD_ATTRIBUTES_BLOCKS[kind] ?? '';
      assert.strictEqual(valueOf(elementOf(block, 'StandardAttribute', name), key), expected);
    });
  }

  test('ChartOfAccounts: ТЧ ExtDimensionTypes, реквизит ExtDimensionType — FillChecking = ShowError', () => {
    const section = elementOf(STANDARD_TABULAR_SECTIONS_BLOCKS.ChartOfAccounts ?? '', 'StandardTabularSection', 'ExtDimensionTypes');
    assert.strictEqual(valueOf(elementOf(section, 'StandardAttribute', 'ExtDimensionType'), 'FillChecking'), 'ShowError');
  });
});

suite('Шаблон Catalog — сверка с корпусом', () => {
  const borrowedCatalog = path.join(EXAMPLE_GENERATIONS.cfe21, 'Catalogs', 'ев_РабочийПроцесс.xml');
  suiteSetup(function () {
    skipWithoutCorpus(this, borrowedCatalog);
  });

  test('блок ев_РабочийПроцесс (единственный полный блок корпуса) равен шаблону Catalog', () => {
    const xml = fs.readFileSync(borrowedCatalog, 'utf-8').replace(/\r\n/g, '\n');
    const match = /\t\t\t<StandardAttributes>[\s\S]*?\t\t\t<\/StandardAttributes>/.exec(xml);
    assert.ok(match, 'в эталоне нет блока StandardAttributes');
    assert.strictEqual(match[0], STANDARD_ATTRIBUTES_BLOCKS.Catalog);
  });
});

suite('StandardAttributesBlock — чтение без записи', () => {
  const templateDescription = elementOf(STANDARD_ATTRIBUTES_BLOCKS.Catalog ?? '', 'StandardAttribute', 'Description');

  test('явный элемент файла имеет приоритет над шаблоном', () => {
    const xml = objectXml('Catalog', `\t\t\t<StandardAttributes>\n\t\t\t\t${EXPLICIT_DESCRIPTION}\n\t\t\t</StandardAttributes>\n`);
    for (const useDefaults of [true, false]) {
      assert.strictEqual(
        resolveStandardAttributeXml(xml, 'Description', { ruleset: BASELINE_RULESET, useDefaults }),
        EXPLICIT_DESCRIPTION
      );
    }
  });

  test('без блока и с useDefaults — элемент из шаблона вида', () => {
    const xml = objectXml('Catalog', '');
    assert.strictEqual(
      resolveStandardAttributeXml(xml, 'Description', { ruleset: BASELINE_RULESET, useDefaults: true }),
      templateDescription
    );
  });

  test('блок есть, но реквизита в нём нет — с useDefaults берётся шаблон', () => {
    const xml = objectXml('Catalog', `\t\t\t<StandardAttributes>\n\t\t\t\t${EXPLICIT_DESCRIPTION}\n\t\t\t</StandardAttributes>\n`);
    assert.strictEqual(
      resolveStandardAttributeXml(xml, 'Code', { ruleset: BASELINE_RULESET, useDefaults: true }),
      elementOf(STANDARD_ATTRIBUTES_BLOCKS.Catalog ?? '', 'StandardAttribute', 'Code')
    );
  });

  test('useDefaults: false — голый элемент, умолчания не подставляются', () => {
    assert.strictEqual(
      resolveStandardAttributeXml(objectXml('Catalog', ''), 'Description', { ruleset: BASELINE_RULESET, useDefaults: false }),
      '<xr:StandardAttribute name="Description"/>'
    );
  });

  test('вид без шаблона — голый элемент', () => {
    assert.strictEqual(
      resolveStandardAttributeXml(objectXml('Enum', ''), 'Ref', { ruleset: BASELINE_RULESET, useDefaults: true }),
      '<xr:StandardAttribute name="Ref"/>'
    );
  });

  test('реквизит не из шаблона вида — голый элемент с экранированным именем', () => {
    assert.strictEqual(
      resolveStandardAttributeXml(objectXml('Catalog', ''), 'A&B', { ruleset: BASELINE_RULESET, useDefaults: true }),
      '<xr:StandardAttribute name="A&amp;B"/>'
    );
  });

  test('XML без корня объекта — голый элемент', () => {
    assert.strictEqual(
      resolveStandardAttributeXml('<MetaDataObject/>', 'Ref', { ruleset: BASELINE_RULESET, useDefaults: true }),
      '<xr:StandardAttribute name="Ref"/>'
    );
  });

  test('defaultStandardAttributeElementXml: вид без шаблона и не вид метаданных — null', () => {
    assert.strictEqual(defaultStandardAttributeElementXml(BASELINE_RULESET, 'Enum', 'Ref'), null);
    assert.strictEqual(defaultStandardAttributeElementXml(BASELINE_RULESET, 'NotAKind', 'Ref'), null);
    assert.strictEqual(defaultStandardAttributeElementXml(BASELINE_RULESET, 'toString', 'Ref'), null);
    assert.strictEqual(defaultStandardAttributeElementXml(BASELINE_RULESET, 'Catalog', 'Нет'), null);
    assert.strictEqual(defaultStandardAttributeElementXml(BASELINE_RULESET, 'Catalog', 'Description'), templateDescription);
  });

  test('detectObjectXmlFormatVersion: атрибут version корня или null', () => {
    assert.strictEqual(detectObjectXmlFormatVersion(objectXml('Catalog', '', '2.20')), '2.20');
    assert.strictEqual(detectObjectXmlFormatVersion(objectXml('Catalog', '', null)), null);
    assert.strictEqual(detectObjectXmlFormatVersion('<Catalog/>'), null);
  });

  test('rulesetForObjectXml: по версии корня, без версии — DEFAULT_FORMAT_VERSION', () => {
    assert.strictEqual(rulesetForObjectXml(objectXml('Catalog', '', '2.20')).id, FORMAT_2_20_RULESET.id);
    assert.strictEqual(rulesetForObjectXml(objectXml('Catalog', '', '2.21')).id, BASELINE_RULESET.id);
    assert.strictEqual(rulesetForObjectXml(objectXml('Catalog', '', null)).id, FORMAT_PRE_2_20_RULESET.id);
  });
});

suite('detectObjectXmlFormatVersion — корпус', () => {
  const cases: [string, string][] = [
    [path.join(EXAMPLE_GENERATIONS.cf20, 'Catalogs', 'Регионы.xml'), '2.20'],
    [path.join(EXAMPLE_GENERATIONS.cf21, 'Catalogs', 'Регионы.xml'), '2.21'],
  ];
  suiteSetup(function () {
    skipWithoutCorpus(this, ...cases.map(([file]) => file));
  });

  for (const [file, expected] of cases) {
    test(`${expected}: ${path.basename(file)}`, () => {
      assert.strictEqual(detectObjectXmlFormatVersion(fs.readFileSync(file, 'utf-8')), expected);
    });
  }
});

suite('ObjectXmlReader — стандартные реквизиты нового объекта без блока', () => {
  test('сгенерированный Catalog 2.21 без блока перечисляет все стандартные реквизиты вида', () => {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-sa-reader-'));
    try {
      fs.writeFileSync(
        path.join(configRoot, 'Configuration.xml'),
        '<?xml version="1.0" encoding="utf-8"?>\n<MetaDataObject version="2.21">\n\t<Configuration>\n\t\t<Properties>\n\t\t\t<Name>Тест</Name>\n\t\t</Properties>\n\t\t<ChildObjects/>\n\t</Configuration>\n</MetaDataObject>',
        'utf-8'
      );
      const created = new MetadataXmlCreator().addRootObject({ configRoot, kind: 'Catalog', name: 'Тест' });
      assert.strictEqual(created.success, true, created.errors.join('; '));
      const xmlPath = path.join(configRoot, 'Catalogs', 'Тест.xml');
      assert.ok(!fs.readFileSync(xmlPath, 'utf-8').includes('<StandardAttributes'));

      const parsed = new ObjectXmlReader().read(xmlPath);
      const names = (parsed?.children ?? []).filter((item) => item.tag === 'StandardAttribute').map((item) => item.name);
      const expected = [...(STANDARD_ATTRIBUTES_BLOCKS.Catalog ?? '').matchAll(/<xr:StandardAttribute name="([^"]+)">/g)]
        .map((match) => match[1]);
      assert.deepStrictEqual([...names].sort(), [...expected].sort());
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });
});
