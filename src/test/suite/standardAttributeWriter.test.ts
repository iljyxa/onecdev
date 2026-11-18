import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { MetaKind } from '../../domain/MetaTypes';
import { ConfigurationXmlEditor } from '../../infra/xml/ConfigurationXmlEditor';
import { ObjectXmlReader } from '../../infra/xml/ObjectXmlReader';
import { BASELINE_RULESET } from '../../infra/xml/format/baselineRuleset';
import { FORMAT_2_20_RULESET } from '../../infra/xml/format/format2_20Ruleset';
import type { FormatRuleset } from '../../infra/xml/format/FormatRuleset';
import { resolveFormatRuleset, setFormatRulesetWarning } from '../../infra/xml/format/formatRegistry';
import { ROOT_PROPERTY_ORDER } from '../../infra/xml/properties/PropertyOrder';
import {
  applyStandardAttributePropertyEdit,
  resolveStandardAttributeXml,
  rulesetForObjectXml,
  type StandardAttributeEditResult,
  type StandardAttributePropertyEdit,
} from '../../infra/xml/properties/StandardAttributesBlock';
import {
  collectPropertyBlocks,
  findPropertiesRange,
  isAdoptedObjectBelonging,
  type PropertyBlock,
} from '../../infra/xml/typedField/PropertyBlockEditor';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { structuredMetaChildHandler } from '../../ui/tree/nodeBuilders/structuredMetaChildHandler';
import * as vscode from 'vscode';
import { EXAMPLE_GENERATIONS, skipWithoutCorpus } from './support/corpus';
import { assertWellFormedXml } from './support/typedFieldCorpus';

/**
 * Писатель свойств стандартных реквизитов корня объекта (#145).
 *
 * У нового объекта платформа блок `<StandardAttributes>` не пишет, и до #145
 * правка свойства стандартного реквизита на таком объекте молча не делала
 * ничего. Теперь блок материализуется из шаблона умолчаний вида (снят с
 * платформы) ровно с одной изменённой строкой.
 *
 * Мутации — только над копиями во временном каталоге: `example/` не
 * отслеживается git, испорченный эталон теряется безвозвратно.
 */

const ROOT = path.resolve(__dirname, '../../../');
/** Эталон: блок, выгруженный платформой 8.5.1 после правки в Конфигураторе. */
const GOLDEN_CATALOG_DESCRIPTION = path.join(
  ROOT,
  'src/test/fixtures/standard-attributes/catalog-description-8.5.1.xml'
);

/** Объекты корпуса без блока `<StandardAttributes>` — по одному на вид с шаблоном. */
const KIND_FIXTURES: readonly (readonly [MetaKind, string])[] = [
  ['Catalog', 'Catalogs/Регионы.xml'],
  ['Document', 'Documents/Заказ.xml'],
  ['ChartOfCharacteristicTypes', 'ChartsOfCharacteristicTypes/ВидыСубконтоХозрасчетные.xml'],
  ['ChartOfAccounts', 'ChartsOfAccounts/Хозрасчетный.xml'],
  ['ChartOfCalculationTypes', 'ChartsOfCalculationTypes/ОсновныеНачисления.xml'],
  ['BusinessProcess', 'BusinessProcesses/Поручение.xml'],
  ['Task', 'Tasks/ЗадачаИсполнителя.xml'],
  ['ExchangePlan', 'ExchangePlans/Мобильные.xml'],
  ['AccumulationRegister', 'AccumulationRegisters/ТоварыНаСкладах.xml'],
  ['AccountingRegister', 'AccountingRegisters/Хозрасчетный.xml'],
  ['CalculationRegister', 'CalculationRegisters/Начисления.xml'],
];

const GENERATIONS: readonly (readonly [string, keyof typeof EXAMPLE_GENERATIONS, FormatRuleset])[] = [
  ['2.20', 'cf20', FORMAT_2_20_RULESET],
  ['2.21', 'cf21', BASELINE_RULESET],
];

const tempDirs: string[] = [];

function copyToTemp(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-std-attr-writer-'));
  tempDirs.push(dir);
  const target = path.join(dir, path.basename(source));
  fs.copyFileSync(source, target);
  return target;
}

function writeTemp(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-std-attr-writer-'));
  tempDirs.push(dir);
  const target = path.join(dir, name);
  fs.writeFileSync(target, content, 'utf-8');
  return target;
}

/** Имена реквизитов шаблона вида в порядке шаблона. */
function templateNames(ruleset: FormatRuleset, kind: MetaKind): string[] {
  return [...ruleset.standardAttributes(kind).matchAll(/<xr:StandardAttribute name="([^"]+)">/g)].map((m) => m[1]);
}

/** Элемент реквизита из блока (без ведущего отступа). */
function elementOf(block: string, name: string): string {
  const match = new RegExp(`<xr:StandardAttribute name="${name}">[\\s\\S]*?</xr:StandardAttribute>`).exec(block);
  assert.ok(match, `в блоке нет реквизита ${name}`);
  return match[0];
}

/** Значение `<xr:Key>…</xr:Key>` элемента. */
function valueOf(elementXml: string, key: string): string {
  const match = new RegExp(`<xr:${key}>([^<]*)</xr:${key}>`).exec(elementXml);
  assert.ok(match, `нет свойства ${key}`);
  return match[1];
}

/** Прямые дети `<Properties>` корня. */
function rootBlocks(objectXml: string): PropertyBlock[] {
  const props = findPropertiesRange(objectXml);
  assert.ok(props, 'нет <Properties> корня');
  return collectPropertyBlocks(props.inner);
}

/** Блок `<StandardAttributes>` корня вместе с ведущим отступом или `null`. */
function standardAttributesBlock(objectXml: string): string | null {
  const block = rootBlocks(objectXml).find((item) => item.key === 'StandardAttributes');
  return block ? `${block.indent}${block.xml}` : null;
}

function toggledFillChecking(current: string): string {
  return current === 'DontCheck' ? 'ShowError' : 'DontCheck';
}

function fillCheckingEdit(attributeName: string, value: string): StandardAttributePropertyEdit {
  return { attributeName, propertyKey: 'FillChecking', valueKind: 'string', value };
}

function assertChanged(result: StandardAttributeEditResult): string {
  assert.strictEqual(result.status, 'changed', JSON.stringify(result));
  return (result as { xml: string }).xml;
}

/** Ключи прямых детей `<Properties>` — подпоследовательность канона вида. */
function assertCanonicalRootOrder(objectXml: string, kind: MetaKind): void {
  const order = ROOT_PROPERTY_ORDER[kind] ?? [];
  const ranks = rootBlocks(objectXml)
    .map((block) => order.indexOf(block.key))
    .filter((rank) => rank >= 0);
  assert.ok(ranks.includes(order.indexOf('StandardAttributes')), 'StandardAttributes нет в канонической строке');
  assert.deepStrictEqual(ranks, [...ranks].sort((a, b) => a - b), 'порядок свойств корня нарушен');
}

/** Минимальный корень объекта вида (LF, без BOM); `properties` — строки после `<Name>`. */
function objectXml(kind: string, properties: string, version = '2.21'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="${version}">\n\t<${kind} uuid="00000000-0000-0000-0000-000000000000">\n\t\t<Properties>\n\t\t\t<Name>Тест</Name>\n${properties}\t\t</Properties>\n\t</${kind}>\n</MetaDataObject>\n`;
}

/** Блок `<StandardAttributes>` из перечисленных элементов (каждый — без ведущего отступа). */
function explicitBlock(...elements: string[]): string {
  return `\t\t\t<StandardAttributes>\n${elements.map((element) => `\t\t\t\t${element}\n`).join('')}\t\t\t</StandardAttributes>\n`;
}

function catalogTemplateElement(name: string): string {
  return elementOf(BASELINE_RULESET.standardAttributes('Catalog'), name);
}

suiteTeardown(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

suite('Писатель стандартных реквизитов: материализация шаблона (#145)', () => {
  for (const [generation, root, ruleset] of GENERATIONS) {
    for (const [kind, relative] of KIND_FIXTURES) {
      for (const name of templateNames(ruleset, kind)) {
        test(`${generation} ${kind}.${name}: FillChecking — блок = шаблон с одной изменённой строкой`, function () {
          const source = path.join(EXAMPLE_GENERATIONS[root], relative);
          skipWithoutCorpus(this, source);
          const original = fs.readFileSync(source, 'utf-8');
          const template = ruleset.standardAttributes(kind);
          const templateElement = elementOf(template, name);
          const current = valueOf(templateElement, 'FillChecking');
          const next = toggledFillChecking(current);

          const xml = assertChanged(applyStandardAttributePropertyEdit(original, fillCheckingEdit(name, next), ruleset));

          const expectedElement = templateElement.replace(
            `<xr:FillChecking>${current}</xr:FillChecking>`,
            `<xr:FillChecking>${next}</xr:FillChecking>`
          );
          const block = standardAttributesBlock(xml);
          assert.strictEqual(
            block?.replace(/\r\n/g, '\n'),
            template.replace(templateElement, () => expectedElement)
          );
          assertCanonicalRootOrder(xml, kind);
        });
      }
    }
  }
});

suite('Писатель стандартных реквизитов: файлы корпуса (#145)', () => {
  for (const [generation, root, ruleset] of GENERATIONS) {
    for (const [kind, relative] of KIND_FIXTURES) {
      test(`${generation} ${kind}: вставлен только блок, BOM/CRLF сохранены, повтор — без изменений`, function () {
        const source = path.join(EXAMPLE_GENERATIONS[root], relative);
        skipWithoutCorpus(this, source);
        const copy = copyToTemp(source);
        const reader = new ObjectXmlReader();
        const original = fs.readFileSync(copy, 'utf-8');
        const childrenBefore = reader.read(copy)?.children.filter((item) => item.tag === 'StandardAttribute').map((item) => item.name);
        const name = templateNames(ruleset, kind).at(-1) ?? '';
        const next = toggledFillChecking(valueOf(elementOf(ruleset.standardAttributes(kind), name), 'FillChecking'));

        const outcome = reader.updateStandardAttributeProperty(copy, fillCheckingEdit(name, next));

        assert.deepStrictEqual(outcome, { status: 'changed' });
        const bytes = fs.readFileSync(copy);
        assert.deepStrictEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM потерян');
        const after = bytes.toString('utf-8');
        assert.ok(!/[^\r]\n/.test(after), 'в CRLF-файле появился голый \\n');
        assertWellFormedXml(after, `${generation} ${kind}`);
        const block = standardAttributesBlock(after);
        assert.ok(block, 'блок не вставлен');
        assert.strictEqual(after.replace(`${block}\r\n`, ''), original, 'изменено что-то кроме вставки блока');

        const repeated = reader.updateStandardAttributeProperty(copy, fillCheckingEdit(name, next));
        assert.deepStrictEqual(repeated, { status: 'unchanged' });
        assert.ok(fs.readFileSync(copy).equals(bytes), 'повтор изменил файл');

        const childrenAfter = reader.read(copy)?.children.filter((item) => item.tag === 'StandardAttribute').map((item) => item.name);
        // Ни один реквизит из дерева не пропадает. Новые могут появиться только из
        // шаблона: у ChartOfCharacteristicTypes и CalculationRegister перечень домена
        // (STANDARD_ATTRIBUTES_BY_KIND) уже шаблона платформы, а явный блок читатель
        // показывает целиком — как у файла, выгруженного платформой.
        const templateSet = new Set(templateNames(ruleset, kind));
        assert.deepStrictEqual(childrenAfter?.slice(0, childrenBefore?.length), childrenBefore);
        assert.deepStrictEqual(childrenAfter?.filter((item) => !childrenBefore?.includes(item) && !templateSet.has(item)), []);
        const resolved = resolveStandardAttributeXml(after, name, { ruleset, useDefaults: true });
        assert.strictEqual(valueOf(resolved, 'FillChecking'), next);
      });
    }
  }

  test('golden 8.5.1: Catalog 2.21 Description FillChecking=DontCheck + ToolTip — блок побайтно как у платформы', function () {
    const source = path.join(EXAMPLE_GENERATIONS.cf21, 'Catalogs/Регионы.xml');
    skipWithoutCorpus(this, source);
    const copy = copyToTemp(source);
    const reader = new ObjectXmlReader();

    assert.deepStrictEqual(reader.updateStandardAttributeProperty(copy, fillCheckingEdit('Description', 'DontCheck')), { status: 'changed' });
    assert.deepStrictEqual(
      reader.updateStandardAttributeProperty(copy, {
        attributeName: 'Description',
        propertyKey: 'ToolTip',
        valueKind: 'localizedString',
        value: 'Подсказка',
      }),
      { status: 'changed' }
    );

    const golden = fs.readFileSync(GOLDEN_CATALOG_DESCRIPTION, 'utf-8').replace(/\r\n/g, '\n').replace(/\n$/, '');
    const block = standardAttributesBlock(fs.readFileSync(copy, 'utf-8'));
    assert.strictEqual(block?.replace(/\r\n/g, '\n'), golden);
  });

  test('значение = умолчанию на объекте без блока — unchanged, файл не тронут', function () {
    const source = path.join(EXAMPLE_GENERATIONS.cf21, 'Catalogs/Регионы.xml');
    skipWithoutCorpus(this, source);
    const copy = copyToTemp(source);
    const before = fs.readFileSync(copy);
    const current = valueOf(catalogTemplateElement('Description'), 'FillChecking');

    const outcome = new ObjectXmlReader().updateStandardAttributeProperty(copy, fillCheckingEdit('Description', current));

    assert.deepStrictEqual(outcome, { status: 'unchanged' });
    assert.ok(fs.readFileSync(copy).equals(before));
  });

  test('виды значений на Catalog 2.21: boolean, localizedString (вставка/правка/очистка), пустая строка', function () {
    const source = path.join(EXAMPLE_GENERATIONS.cf21, 'Catalogs/Регионы.xml');
    skipWithoutCorpus(this, source);
    const copy = copyToTemp(source);
    const reader = new ObjectXmlReader();
    const description = (): string => elementOf(fs.readFileSync(copy, 'utf-8'), 'Description');

    assert.deepStrictEqual(
      reader.updateStandardAttributeProperty(copy, { attributeName: 'Description', propertyKey: 'MultiLine', valueKind: 'boolean', value: true }),
      { status: 'changed' }
    );
    assert.strictEqual(valueOf(description(), 'MultiLine'), 'true');

    assert.deepStrictEqual(
      reader.updateStandardAttributeProperty(copy, { attributeName: 'Description', propertyKey: 'ToolTip', valueKind: 'localizedString', value: 'Подсказка' }),
      { status: 'changed' }
    );
    assert.ok(
      description().includes(
        '\t\t\t\t\t<xr:ToolTip>\r\n\t\t\t\t\t\t<v8:item>\r\n\t\t\t\t\t\t\t<v8:lang>ru</v8:lang>\r\n\t\t\t\t\t\t\t<v8:content>Подсказка</v8:content>\r\n\t\t\t\t\t\t</v8:item>\r\n\t\t\t\t\t</xr:ToolTip>\r\n'
      ),
      description()
    );

    // Парный блок с v8:item правится по месту — второй язык/разметка не теряются.
    assert.deepStrictEqual(
      reader.updateStandardAttributeProperty(copy, { attributeName: 'Description', propertyKey: 'ToolTip', valueKind: 'localizedString', value: 'Другая' }),
      { status: 'changed' }
    );
    assert.ok(description().includes('<v8:content>Другая</v8:content>'));

    assert.deepStrictEqual(
      reader.updateStandardAttributeProperty(copy, { attributeName: 'Description', propertyKey: 'ToolTip', valueKind: 'localizedString', value: '' }),
      { status: 'changed' }
    );
    assert.ok(description().includes('\t\t\t\t\t<xr:ToolTip/>\r\n'));
    assert.ok(!description().includes('v8:item'));

    const before = fs.readFileSync(copy);
    assert.deepStrictEqual(
      reader.updateStandardAttributeProperty(copy, { attributeName: 'Description', propertyKey: 'Format', valueKind: 'string', value: '' }),
      { status: 'unchanged' }
    );
    assert.ok(fs.readFileSync(copy).equals(before));
  });

  test('существующий блок (EVOLC ев_РабочийПроцесс): меняется одна строка, возврат значения не удаляет блок', function () {
    const source = path.join(EXAMPLE_GENERATIONS.cfe21, 'Catalogs/ев_РабочийПроцесс.xml');
    skipWithoutCorpus(this, source);
    const copy = copyToTemp(source);
    const reader = new ObjectXmlReader();
    const original = fs.readFileSync(copy, 'utf-8');
    const current = valueOf(elementOf(original, 'Owner'), 'FillChecking');
    const next = toggledFillChecking(current);

    assert.deepStrictEqual(reader.updateStandardAttributeProperty(copy, fillCheckingEdit('Owner', next)), { status: 'changed' });
    const after = fs.readFileSync(copy, 'utf-8');
    const ownerBefore = elementOf(original, 'Owner');
    assert.strictEqual(
      after,
      original.replace(ownerBefore, ownerBefore.replace(`<xr:FillChecking>${current}</xr:FillChecking>`, `<xr:FillChecking>${next}</xr:FillChecking>`))
    );

    assert.deepStrictEqual(reader.updateStandardAttributeProperty(copy, fillCheckingEdit('Owner', current)), { status: 'changed' });
    assert.strictEqual(fs.readFileSync(copy, 'utf-8'), original, 'блок, совпавший с шаблоном, удалён или испорчен');
  });
});

suite('Писатель стандартных реквизитов: частичный блок (#145)', () => {
  const description = catalogTemplateElement('Description');

  test('блок есть, элемента нет — элемент шаблона встаёт ПОСЛЕ предшественника по шаблону', () => {
    const original = objectXml('Catalog', explicitBlock(description));
    const next = toggledFillChecking(valueOf(catalogTemplateElement('Code'), 'FillChecking'));

    const xml = assertChanged(applyStandardAttributePropertyEdit(original, fillCheckingEdit('Code', next), BASELINE_RULESET));

    const code = catalogTemplateElement('Code').replace(/<xr:FillChecking>[^<]*</, `<xr:FillChecking>${next}<`);
    assert.strictEqual(xml, objectXml('Catalog', explicitBlock(description, code)));
  });

  test('блок есть, элемента нет — элемент шаблона встаёт ПЕРЕД последователем по шаблону', () => {
    const original = objectXml('Catalog', explicitBlock(description));
    const next = toggledFillChecking(valueOf(catalogTemplateElement('Ref'), 'FillChecking'));

    const xml = assertChanged(applyStandardAttributePropertyEdit(original, fillCheckingEdit('Ref', next), BASELINE_RULESET));

    const ref = catalogTemplateElement('Ref').replace(/<xr:FillChecking>[^<]*</, `<xr:FillChecking>${next}<`);
    assert.strictEqual(xml, objectXml('Catalog', explicitBlock(ref, description)));
  });

  test('элемент без атрибута name (испорченный файл) не участвует в порядке — вставка после последнего известного', () => {
    const unnamed = '<xr:StandardAttribute>\n\t\t\t\t\t<xr:FillChecking>DontCheck</xr:FillChecking>\n\t\t\t\t</xr:StandardAttribute>';
    const original = objectXml('Catalog', explicitBlock(description, unnamed));
    const next = toggledFillChecking(valueOf(catalogTemplateElement('Code'), 'FillChecking'));

    const xml = assertChanged(applyStandardAttributePropertyEdit(original, fillCheckingEdit('Code', next), BASELINE_RULESET));

    const code = catalogTemplateElement('Code').replace(/<xr:FillChecking>[^<]*</, `<xr:FillChecking>${next}<`);
    assert.strictEqual(xml, objectXml('Catalog', explicitBlock(description, code, unnamed)));
  });

  test('блок есть, элемента нет, значение = умолчанию — unchanged', () => {
    const original = objectXml('Catalog', explicitBlock(description));
    const current = valueOf(catalogTemplateElement('Code'), 'FillChecking');

    assert.deepStrictEqual(
      applyStandardAttributePropertyEdit(original, fillCheckingEdit('Code', current), BASELINE_RULESET),
      { status: 'unchanged' }
    );
  });

  test('пустой <StandardAttributes/> заменяется полным блоком шаблона', () => {
    const original = objectXml('Catalog', '\t\t\t<StandardAttributes/>\n');
    const template = BASELINE_RULESET.standardAttributes('Catalog');
    const next = toggledFillChecking(valueOf(description, 'FillChecking'));

    const xml = assertChanged(applyStandardAttributePropertyEdit(original, fillCheckingEdit('Description', next), BASELINE_RULESET));

    const edited = description.replace(/<xr:FillChecking>[^<]*</, `<xr:FillChecking>${next}<`);
    assert.strictEqual(xml, objectXml('Catalog', `${template.replace(description, () => edited)}\n`));
  });

  test('частичный элемент (только FillChecking) — отказ partial-element', () => {
    const partial = '<xr:StandardAttribute name="Description">\n\t\t\t\t\t<xr:FillChecking>DontCheck</xr:FillChecking>\n\t\t\t\t</xr:StandardAttribute>';
    const original = objectXml('Catalog', explicitBlock(partial));

    const result = applyStandardAttributePropertyEdit(
      original,
      { attributeName: 'Description', propertyKey: 'MultiLine', valueKind: 'boolean', value: true },
      BASELINE_RULESET
    );

    assert.deepStrictEqual(result, {
      status: 'refused',
      reason: 'partial-element',
      message: 'Элемент "Description" записан в файле не полностью; выгрузите объект платформой заново.',
    });
  });
});

suite('Писатель стандартных реквизитов: отказы (#145)', () => {
  /** Отказ через файловый путь: причина, текст и нетронутый файл. */
  function assertRefusedOnFile(file: string, edit: StandardAttributePropertyEdit, reason: string, message: string): void {
    const before = fs.readFileSync(file);
    const outcome = new ObjectXmlReader().updateStandardAttributeProperty(file, edit);
    assert.deepStrictEqual(outcome, { status: 'refused', reason, message });
    assert.ok(fs.readFileSync(file).equals(before), 'файл изменён при отказе');
  }

  test('tabular-section: реквизит табличной части (Documents/Заказ, ТЧ ТабличнаяЧасть1)', function () {
    const source = path.join(EXAMPLE_GENERATIONS.cf21, 'Documents/Заказ.xml');
    skipWithoutCorpus(this, source);
    assertRefusedOnFile(
      copyToTemp(source),
      { ...fillCheckingEdit('LineNumber', 'ShowError'), tabularSectionName: 'ТабличнаяЧасть1' },
      'tabular-section',
      'Свойства стандартных реквизитов табличной части пока не редактируются: для них нет шаблона умолчаний платформы.'
    );
  });

  for (const valueKind of ['metadataReferenceList', 'metadataFieldList'] as const) {
    test(`unsupported-value-kind: ${valueKind}`, () => {
      assertRefusedOnFile(
        writeTemp('Тест.xml', objectXml('Catalog', '')),
        { attributeName: 'Description', propertyKey: 'ChoiceParameterLinks', valueKind, value: ['A'] },
        'unsupported-value-kind',
        'Свойство "ChoiceParameterLinks" стандартного реквизита не принимает список значений.'
      );
    });
  }

  const noRootProperties: readonly (readonly [string, string])[] = [
    ['<Catalog><Properties/></Catalog>', 'самозакрытый <Properties/>'],
    ['<MetaDataObject/>', 'пустой MetaDataObject'],
    ['<Catalog><Properties><Name>X</Name></Properties></Catalog>', 'корень без обёртки MetaDataObject'],
  ];
  for (const [xml, label] of noRootProperties) {
    test(`no-root-properties: ${label}`, () => {
      assertRefusedOnFile(
        writeTemp('Тест.xml', xml),
        fillCheckingEdit('Description', 'DontCheck'),
        'no-root-properties',
        'В XML объекта не найден блок свойств корня.'
      );
    });
  }

  for (const name of ['Номенклатура.xml', 'Контрагенты.xml']) {
    test(`adopted-object: заимствованный EVOLC/Catalogs/${name}`, function () {
      const source = path.join(EXAMPLE_GENERATIONS.cfe21, 'Catalogs', name);
      skipWithoutCorpus(this, source);
      assertRefusedOnFile(
        copyToTemp(source),
        fillCheckingEdit('Description', 'DontCheck'),
        'adopted-object',
        'Стандартные реквизиты заимствованного объекта не редактируются в расширении.'
      );
    });
  }

  const withoutTemplate: readonly (readonly [string, string])[] = [
    ['InformationRegister', 'InformationRegisters/КурсыВалют.xml'],
    ['Enum', 'Enums/PushУведомления.xml'],
    ['DocumentJournal', 'DocumentJournals/ДокументыСклада.xml'],
  ];
  for (const [kind, relative] of withoutTemplate) {
    test(`no-template-for-kind: ${kind} (${relative})`, function () {
      const source = path.join(EXAMPLE_GENERATIONS.cf20, relative);
      skipWithoutCorpus(this, source);
      assertRefusedOnFile(
        copyToTemp(source),
        fillCheckingEdit('Ref', 'ShowError'),
        'no-template-for-kind',
        `Для вида "${kind}" нет шаблона стандартных реквизитов; правка не поддерживается.`
      );
    });
  }

  test('no-template-for-kind: корневой тег — унаследованное имя Object (toString)', () => {
    assertRefusedOnFile(
      writeTemp('Тест.xml', objectXml('toString', '')),
      fillCheckingEdit('Description', 'DontCheck'),
      'no-template-for-kind',
      'Для вида "toString" нет шаблона стандартных реквизитов; правка не поддерживается.'
    );
  });

  for (const name of ['НесуществующийРеквизит', 'toString']) {
    test(`unknown-attribute: ${name}`, () => {
      assertRefusedOnFile(
        writeTemp('Тест.xml', objectXml('Catalog', '')),
        fillCheckingEdit(name, 'DontCheck'),
        'unknown-attribute',
        `У вида "Catalog" нет стандартного реквизита "${name}".`
      );
    });
  }

  for (const key of ['Name', 'Indexing']) {
    test(`unknown-property: ${key}`, () => {
      assertRefusedOnFile(
        writeTemp('Тест.xml', objectXml('Catalog', '')),
        { attributeName: 'Description', propertyKey: key, valueKind: 'string', value: 'X' },
        'unknown-property',
        `У стандартного реквизита нет свойства "${key}".`
      );
    });
  }

  test('unsupported-value-shape: MaxValue xsi:nil', () => {
    assertRefusedOnFile(
      writeTemp('Тест.xml', objectXml('Catalog', '')),
      { attributeName: 'Description', propertyKey: 'MaxValue', valueKind: 'string', value: '10' },
      'unsupported-value-shape',
      'Свойство "MaxValue" хранит составное значение; запись простой строкой не поддерживается.'
    );
  });

  // Вложенные элементы допустимы только как v8:item у локализованной строки.
  const nestedShapes: readonly (readonly [string, 'string' | 'localizedString'])[] = [
    ['ChoiceParameters', 'string'],
    ['ChoiceParameters', 'localizedString'],
    ['ToolTip', 'string'],
  ];
  for (const [key, valueKind] of nestedShapes) {
    test(`unsupported-value-shape: ${key} с вложенными элементами, valueKind=${valueKind}`, () => {
      const element = catalogTemplateElement('Description')
        .replace(
          '<xr:ChoiceParameters/>',
          '<xr:ChoiceParameters>\n\t\t\t\t\t\t<app:item name="Отбор.Активный">\n\t\t\t\t\t\t\t<app:value xsi:type="xs:boolean">true</app:value>\n\t\t\t\t\t\t</app:item>\n\t\t\t\t\t</xr:ChoiceParameters>'
        )
        .replace(
          '<xr:ToolTip/>',
          '<xr:ToolTip>\n\t\t\t\t\t\t<v8:item>\n\t\t\t\t\t\t\t<v8:lang>ru</v8:lang>\n\t\t\t\t\t\t\t<v8:content>Было</v8:content>\n\t\t\t\t\t\t</v8:item>\n\t\t\t\t\t</xr:ToolTip>'
        );
      assertRefusedOnFile(
        writeTemp('Тест.xml', objectXml('Catalog', explicitBlock(element))),
        { attributeName: 'Description', propertyKey: key, valueKind, value: 'X' },
        'unsupported-value-shape',
        `Свойство "${key}" хранит составное значение; запись простой строкой не поддерживается.`
      );
    });
  }

  test('read-failed: файла нет', () => {
    const missing = path.join(os.tmpdir(), 'onecdev-std-attr-writer-missing', 'Нет.xml');
    assert.deepStrictEqual(
      new ObjectXmlReader().updateStandardAttributeProperty(missing, fillCheckingEdit('Description', 'DontCheck')),
      { status: 'refused', reason: 'read-failed', message: 'Не удалось прочитать файл объекта.' }
    );
  });
});

suite('Писатель стандартных реквизитов: предупреждение о незнакомой версии (#145)', () => {
  /** Считает предупреждения реестра форматов за время `action`. */
  function countWarnings(action: () => void): number {
    let count = 0;
    setFormatRulesetWarning(() => {
      count += 1;
    });
    try {
      action();
    } finally {
      setFormatRulesetWarning(() => undefined);
    }
    return count;
  }

  const futureXml = objectXml('Catalog', '', '9.99');

  test('чтение молчит: rulesetForObjectXml по умолчанию и показ свойств узла', () => {
    const file = writeTemp('Тест.xml', futureXml);
    const node = new MetadataNode({
      label: 'Description',
      nodeKind: 'StandardAttribute',
      xmlPath: file,
      metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: file, standardAttributeName: 'Description' },
    }, vscode.TreeItemCollapsibleState.None);

    assert.strictEqual(countWarnings(() => rulesetForObjectXml(futureXml)), 0);
    assert.strictEqual(countWarnings(() => structuredMetaChildHandler.getProperties?.(node)), 0);
  });

  test('явный запрос предупреждения и запись — ровно одно предупреждение', () => {
    const file = writeTemp('Тест.xml', futureXml);
    assert.strictEqual(countWarnings(() => rulesetForObjectXml(futureXml, { warnOnUnknownVersion: true })), 1);
    assert.strictEqual(
      countWarnings(() => new ObjectXmlReader().updateStandardAttributeProperty(file, fillCheckingEdit('Description', 'DontCheck'))),
      1
    );
  });

  test('resolveFormatRuleset(warnOnUnknown: false) — самый свежий ruleset без предупреждения', () => {
    let ruleset: FormatRuleset | undefined;
    assert.strictEqual(countWarnings(() => {
      ruleset = resolveFormatRuleset('9.99', { warnOnUnknown: false });
    }), 0);
    assert.strictEqual(ruleset?.id, BASELINE_RULESET.id);
  });
});

suite('isAdoptedObjectBelonging (#145)', () => {
  // Свойства корня собственного объекта расширения тоже несут ObjectBelonging,
  // но без Adopted — такой объект не заимствован.
  const cases: readonly (readonly [string, boolean])[] = [
    ['<ObjectBelonging>Adopted</ObjectBelonging>\n<Name>X</Name>', true],
    ['<ObjectBelonging>Native</ObjectBelonging>\n<Name>X</Name>', false],
    ['<Name>X</Name>', false],
  ];
  for (const [inner, expected] of cases) {
    test(`${JSON.stringify(inner)} → ${String(expected)}`, () => {
      assert.strictEqual(isAdoptedObjectBelonging(collectPropertyBlocks(inner)), expected);
    });
  }
});

suite('ConfigurationXmlEditor.modifyObjectProperty: StandardAttribute (#145)', () => {
  const options = (value: string) => ({
    targetKind: 'StandardAttribute' as const,
    targetName: 'Description',
    propertyKey: 'FillChecking',
    valueKind: 'string' as const,
    value,
  });

  test('changed → changedFiles=[xmlPath]; повтор → success без изменений; отказ → текст причины', function () {
    const source = path.join(EXAMPLE_GENERATIONS.cf21, 'Catalogs/Регионы.xml');
    skipWithoutCorpus(this, source);
    const copy = copyToTemp(source);
    const editor = new ConfigurationXmlEditor();
    const next = toggledFillChecking(valueOf(catalogTemplateElement('Description'), 'FillChecking'));

    assert.deepStrictEqual(editor.modifyObjectProperty(copy, options(next)), {
      success: true, changed: true, changedFiles: [copy], warnings: [], errors: [],
    });
    assert.deepStrictEqual(editor.modifyObjectProperty(copy, options(next)), {
      success: true, changed: false, changedFiles: [], warnings: [], errors: [],
    });
    assert.deepStrictEqual(editor.modifyObjectProperty(copy, { ...options(next), targetName: 'НесуществующийРеквизит' }), {
      success: false, changed: false, changedFiles: [], warnings: [],
      errors: ['У вида "Catalog" нет стандартного реквизита "НесуществующийРеквизит".'],
    });
  });
});
