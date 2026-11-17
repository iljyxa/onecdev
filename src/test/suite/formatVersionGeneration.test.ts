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
import { buildFormXmlFromDefinition } from '../../infra/xml/form/FormBuilders';
import {
  DEFAULT_FORMAT_VERSION,
  registerFormatRuleset,
  resolveFormatRuleset,
  setFormatRulesetWarning,
} from '../../infra/xml/format/formatRegistry';
import { skipWithoutCorpus } from './support/corpus';

const EXAMPLE_2_20_CF = path.resolve(__dirname, '../../../example/2.20/src/cf');

// Виды → папка выгрузки. Покрывает все затронутые ветки генерации.
const KIND_FOLDER: Partial<Record<MetaKind, string>> = {
  Catalog: 'Catalogs', Document: 'Documents', DocumentJournal: 'DocumentJournals', Enum: 'Enums',
  InformationRegister: 'InformationRegisters', AccumulationRegister: 'AccumulationRegisters',
  AccountingRegister: 'AccountingRegisters', CalculationRegister: 'CalculationRegisters',
  ChartOfAccounts: 'ChartsOfAccounts', ChartOfCharacteristicTypes: 'ChartsOfCharacteristicTypes',
  ChartOfCalculationTypes: 'ChartsOfCalculationTypes', BusinessProcess: 'BusinessProcesses',
  Task: 'Tasks', ExchangePlan: 'ExchangePlans', Report: 'Reports', DataProcessor: 'DataProcessors',
  Constant: 'Constants', CommonModule: 'CommonModules', CommonCommand: 'CommonCommands',
  CommonTemplate: 'CommonTemplates', Subsystem: 'Subsystems', DefinedType: 'DefinedTypes',
  SessionParameter: 'SessionParameters', ScheduledJob: 'ScheduledJobs', FunctionalOption: 'FunctionalOptions',
  FunctionalOptionsParameter: 'FunctionalOptionsParameters', HTTPService: 'HTTPServices',
  WebService: 'WebServices', Role: 'Roles', EventSubscription: 'EventSubscriptions',
  FilterCriterion: 'FilterCriteria', CommandGroup: 'CommandGroups', XDTOPackage: 'XDTOPackages',
  Language: 'Languages', SettingsStorage: 'SettingsStorages', StyleItem: 'StyleItems',
  CommonPicture: 'CommonPictures', Bot: 'Bots', CommonForm: 'CommonForms', CommonAttribute: 'CommonAttributes',
};

function configXml(version: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<MetaDataObject version="${version}">\n\t<Configuration>\n\t\t<Properties>\n\t\t\t<Name>Тест</Name>\n\t\t\t<Synonym/>\n\t\t</Properties>\n\t\t<ChildObjects/>\n\t</Configuration>\n</MetaDataObject>`;
}

function generate(kind: MetaKind, version: string): { xml: string; xmlPath: string } {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-fmt-'));
  fs.writeFileSync(path.join(configRoot, 'Configuration.xml'), configXml(version), 'utf-8');
  const result = new MetadataXmlCreator().addRootObject({
    configRoot,
    kind,
    name: 'Тест',
    templateType: kind === 'CommonTemplate' ? 'SpreadsheetDocument' : undefined,
  });
  assert.strictEqual(result.success, true, `генерация ${kind}@${version}: ${result.errors.join('; ')}`);
  const xmlPath = path.join(configRoot, KIND_FOLDER[kind] ?? "", 'Тест.xml');
  return { xml: fs.readFileSync(xmlPath, 'utf-8'), xmlPath };
}

// Прямые дети первого (корневого) <Properties>: имена тегов по порядку.
function rootPropertyTags(xml: string): string[] {
  const match = /<Properties>([\s\S]*?)<\/Properties>/.exec(xml);
  if (!match) {
    return [];
  }
  const tags: string[] = [];
  let depth = 0;
  const tokenRe = /<(\/?)([A-Za-z][\w:.]*)[^>]*?(\/?)>/g;
  let token: RegExpExecArray | null;
  while ((token = tokenRe.exec(match[1])) !== null) {
    const closing = token[1] === '/';
    const selfClose = token[3] === '/';
    if (depth === 0 && !closing) {
      tags.push(token[2]);
    }
    if (closing) {
      depth -= 1;
    } else if (!selfClose) {
      depth += 1;
    }
  }
  return tags;
}

function referenceRootTags(folder: string, sample: string): string[] {
  return rootPropertyTags(fs.readFileSync(path.join(EXAMPLE_2_20_CF, folder, sample), 'utf-8'));
}

// Виды с корневым блоком StandardAttributes у свежего объекта.
const SA_KINDS: MetaKind[] = [
  'Catalog', 'Document', 'AccumulationRegister', 'AccountingRegister', 'CalculationRegister',
  'ChartOfAccounts', 'ChartOfCharacteristicTypes', 'ChartOfCalculationTypes', 'BusinessProcess',
  'Task', 'ExchangePlan',
];

suite('formatRegistry — резолвинг ruleset по версии', () => {
  test('2.20 → ruleset format-2.20, 2.21 → baseline, 2.18 (DEFAULT) → format-pre-2.20', () => {
    assert.strictEqual(resolveFormatRuleset('2.20').id, FORMAT_2_20_RULESET.id);
    assert.strictEqual(resolveFormatRuleset('2.21').id, BASELINE_RULESET.id);
    assert.strictEqual(resolveFormatRuleset(DEFAULT_FORMAT_VERSION).id, FORMAT_PRE_2_20_RULESET.id);
  });

  for (const version of ['2.17', '2.18', '2.19']) {
    test(`${version} → format-pre-2.20 без предупреждения`, () => {
      const warnings: string[] = [];
      setFormatRulesetWarning((message) => warnings.push(message));
      try {
        assert.strictEqual(resolveFormatRuleset(version).id, FORMAT_PRE_2_20_RULESET.id);
        assert.deepStrictEqual(warnings, []);
      } finally {
        setFormatRulesetWarning(() => undefined);
      }
    });
  }

  test('незнакомая версия → самый свежий известный ruleset + предупреждение', () => {
    const warnings: string[] = [];
    setFormatRulesetWarning((message) => warnings.push(message));
    try {
      const ruleset = resolveFormatRuleset('9.99');
      assert.strictEqual(ruleset.id, BASELINE_RULESET.id, 'baseline привязан к максимальной версии 2.21');
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes('9.99'));
    } finally {
      setFormatRulesetWarning(() => undefined);
    }
  });

  test('registerFormatRuleset привязывает новую версию к ruleset', () => {
    registerFormatRuleset(FORMAT_2_20_RULESET, ['2.20-test']);
    assert.strictEqual(resolveFormatRuleset('2.20-test').id, FORMAT_2_20_RULESET.id);
  });
});

suite('format2_20Ruleset — дельта от baseline', () => {
  test('namespace без xmlns:pal (в baseline есть)', () => {
    assert.ok(BASELINE_RULESET.metaDataObjectXmlns.includes('xmlns:pal='));
    assert.ok(!FORMAT_2_20_RULESET.metaDataObjectXmlns.includes('xmlns:pal='));
  });

  test('AuxiliaryVariantForm отключён (в baseline включён)', () => {
    assert.strictEqual(BASELINE_RULESET.includeReportAuxiliaryVariantForm, true);
    assert.strictEqual(FORMAT_2_20_RULESET.includeReportAuxiliaryVariantForm, false);
  });

  test('standardAttributes: блок для вида с SA и пустая строка для вида без SA', () => {
    assert.ok(FORMAT_2_20_RULESET.standardAttributes('Catalog').includes('<StandardAttributes>'));
    assert.strictEqual(FORMAT_2_20_RULESET.standardAttributes('Enum'), '');
    assert.strictEqual(BASELINE_RULESET.standardAttributes('Enum'), '');
  });

  test('standardTabularSections: только план счетов', () => {
    assert.ok(FORMAT_2_20_RULESET.standardTabularSections('ChartOfAccounts').includes('<StandardTabularSections>'));
    assert.strictEqual(FORMAT_2_20_RULESET.standardTabularSections('Catalog'), '');
    assert.strictEqual(BASELINE_RULESET.standardTabularSections('Catalog'), '');
  });
});

suite('Генерация объектов по версии формата', () => {
  test('2.20: нет xmlns:pal, version="2.20"; 2.21: pal есть', () => {
    const cat20 = generate('Catalog', '2.20').xml;
    const cat21 = generate('Catalog', '2.21').xml;
    assert.ok(cat20.includes('version="2.20"'));
    assert.ok(!cat20.includes('xmlns:pal='));
    assert.ok(cat21.includes('version="2.21"'));
    assert.ok(cat21.includes('xmlns:pal='));
  });

  test('Report: AuxiliaryVariantForm только в 2.21', () => {
    assert.ok(!generate('Report', '2.20').xml.includes('<AuxiliaryVariantForm/>'));
    assert.ok(generate('Report', '2.21').xml.includes('<AuxiliaryVariantForm/>'));
  });

  test('StandardAttributes выпускается для нужных видов в обеих версиях', () => {
    for (const version of ['2.20', '2.21']) {
      for (const kind of SA_KINDS) {
        assert.ok(
          generate(kind, version).xml.includes('<StandardAttributes>'),
          `${kind}@${version} должен содержать StandardAttributes`
        );
      }
    }
  });

  test('InformationRegister (независимый непериодический) — без StandardAttributes', () => {
    assert.ok(!generate('InformationRegister', '2.20').xml.includes('<StandardAttributes>'));
    assert.ok(!generate('InformationRegister', '2.21').xml.includes('<StandardAttributes>'));
  });

  test('Enum и простые виды — без StandardAttributes', () => {
    assert.ok(!generate('Enum', '2.20').xml.includes('<StandardAttributes>'));
    assert.ok(!generate('DocumentJournal', '2.20').xml.includes('<StandardAttributes>'));
  });

  test('ChartOfAccounts содержит StandardTabularSections (ExtDimensionTypes)', () => {
    const xml = generate('ChartOfAccounts', '2.20').xml;
    assert.ok(xml.includes('<StandardTabularSections>'));
    assert.ok(xml.includes('name="ExtDimensionTypes"'));
  });

  test('CalculationRegister: полный набор свойств (были пропущены)', () => {
    const xml = generate('CalculationRegister', '2.20').xml;
    for (const tag of ['<Periodicity>Month</Periodicity>', '<ActionPeriod>false</ActionPeriod>', '<ChartOfCalculationTypes/>', '<DataLockControlMode>Automatic</DataLockControlMode>']) {
      assert.ok(xml.includes(tag), `CalculationRegister должен содержать ${tag}`);
    }
    assert.ok(xml.includes('<StandardAttributes>'));
  });

  test('FunctionalOptionsParameter содержит <Use/>', () => {
    assert.ok(generate('FunctionalOptionsParameter', '2.20').xml.includes('<Use/>'));
  });

  test('Виды из бывшей default-ветки получают свои свойства', () => {
    const cases: [MetaKind, string][] = [
      ['EventSubscription', '<Handler/>'],
      ['FilterCriterion', '<Type/>'],
      ['CommandGroup', '<Representation>Auto</Representation>'],
      ['SettingsStorage', '<DefaultSaveForm/>'],
      ['StyleItem', '<Type>Color</Type>'],
      ['CommonPicture', '<AvailabilityForChoice>false</AvailabilityForChoice>'],
      ['Bot', '<Predefined>false</Predefined>'],
      ['Language', '<LanguageCode/>'],
    ];
    for (const [kind, tag] of cases) {
      assert.ok(generate(kind, '2.20').xml.includes(tag), `${kind} должен содержать ${tag}`);
    }
  });

  test('InternalInfo: Characteristic.<Имя>, а не ChartOfCharacteristicTypesCharacteristic', () => {
    const xml = generate('ChartOfCharacteristicTypes', '2.20').xml;
    assert.ok(xml.includes('name="Characteristic.Тест"'));
    assert.ok(!xml.includes('ChartOfCharacteristicTypesCharacteristic'));
  });

  test('FilterCriterion/SettingsStorage: InternalInfo и пустой ChildObjects', () => {
    const fc = generate('FilterCriterion', '2.20').xml;
    assert.ok(fc.includes('FilterCriterionManager.Тест') && fc.includes('FilterCriterionList.Тест'));
    assert.ok(fc.includes('<ChildObjects/>'));
    const ss = generate('SettingsStorage', '2.20').xml;
    assert.ok(ss.includes('SettingsStorageManager.Тест'));
    assert.ok(ss.includes('<ChildObjects/>'));
  });

  test('Все виды парсятся ObjectXmlReader (well-formed) в обеих версиях', () => {
    const reader = new ObjectXmlReader();
    for (const version of ['2.20', '2.21']) {
      for (const kind of Object.keys(KIND_FOLDER) as MetaKind[]) {
        const { xmlPath } = generate(kind, version);
        const parsed = reader.read(xmlPath);
        assert.ok(parsed, `${kind}@${version} не прочитан ObjectXmlReader`);
        assert.strictEqual(parsed.name, 'Тест');
      }
    }
  });
});

suite('Golden: порядок свойств совпадает с эталоном 2.20', () => {
  // `example/` не отслеживается git — без корпуса сьют пропускается, а не падает
  // (единый гейт: support/corpus.ts).
  suiteSetup(function () {
    skipWithoutCorpus(this);
  });

  const goldenCases: [MetaKind, string][] = [
    ['Catalog', 'Регионы.xml'],
    ['Document', 'Заказ.xml'],
    ['AccumulationRegister', 'Взаиморасчеты.xml'],
    ['AccountingRegister', 'Хозрасчетный.xml'],
    ['CalculationRegister', 'Начисления.xml'],
    ['ChartOfAccounts', 'Хозрасчетный.xml'],
    ['ChartOfCharacteristicTypes', 'ВидыСубконтоХозрасчетные.xml'],
    ['ChartOfCalculationTypes', 'ОсновныеНачисления.xml'],
    ['BusinessProcess', 'Поручение.xml'],
    ['Task', 'ЗадачаИсполнителя.xml'],
    ['ExchangePlan', 'Мобильные.xml'],
    ['EventSubscription', 'ПриЗаписиКонтрагента.xml'],
    ['FilterCriterion', 'ДокументыКонтрагента.xml'],
    ['CommandGroup', 'Информация.xml'],
    ['SettingsStorage', 'ХранилищеВариантовОтчетов.xml'],
    ['Bot', 'ОфисМенеджер.xml'],
    ['Language', 'Русский.xml'],
  ];

  // Платформа пишет эти блоки только при настройках стандартных реквизитов/ТЧ не по
  // умолчанию, генератор — всегда (платформа принимает оба варианта). Пока генератор
  // не научен их опускать (iljyxa/onecdev#16), порядок сверяется без них, если их нет в эталоне.
  const OPTIONAL_DEFAULT_BLOCKS = ['StandardAttributes', 'StandardTabularSections'];

  for (const [kind, sample] of goldenCases) {
    test(`${kind}: теги <Properties> совпадают с эталоном`, () => {
      const folder = KIND_FOLDER[kind] ?? '';
      const reference = referenceRootTags(folder, sample);
      const generated = rootPropertyTags(generate(kind, '2.20').xml)
        .filter((tag) => !OPTIONAL_DEFAULT_BLOCKS.includes(tag) || reference.includes(tag));
      assert.deepStrictEqual(generated, reference);
    });
  }
});

suite('formatPre2_20Ruleset — гибрид: объекты baseline, форма 2.20', () => {
  test('данные объектов совпадают с baseline', () => {
    assert.strictEqual(FORMAT_PRE_2_20_RULESET.metaDataObjectXmlns, BASELINE_RULESET.metaDataObjectXmlns);
    assert.strictEqual(FORMAT_PRE_2_20_RULESET.graphicalSchemaXmlns, BASELINE_RULESET.graphicalSchemaXmlns);
    assert.strictEqual(FORMAT_PRE_2_20_RULESET.generatedTypes, BASELINE_RULESET.generatedTypes);
    assert.strictEqual(
      FORMAT_PRE_2_20_RULESET.includeReportAuxiliaryVariantForm,
      BASELINE_RULESET.includeReportAuxiliaryVariantForm
    );
    for (const kind of SA_KINDS) {
      assert.strictEqual(FORMAT_PRE_2_20_RULESET.standardAttributes(kind), BASELINE_RULESET.standardAttributes(kind), kind);
    }
  });

  test('ось формы совпадает с 2.20', () => {
    assert.strictEqual(FORMAT_PRE_2_20_RULESET.managedFormXmlns, FORMAT_2_20_RULESET.managedFormXmlns);
    assert.deepStrictEqual(
      FORMAT_PRE_2_20_RULESET.managedFormPropertyValueAliases,
      FORMAT_2_20_RULESET.managedFormPropertyValueAliases
    );
    assert.strictEqual(FORMAT_PRE_2_20_RULESET.includeFormUseInInterfaceCompatibilityMode, false);
    assert.strictEqual(FORMAT_2_20_RULESET.includeFormUseInInterfaceCompatibilityMode, false);
    assert.strictEqual(BASELINE_RULESET.includeFormUseInInterfaceCompatibilityMode, true);
  });

  test('managedFormXmlns: pal только у baseline, dcssch у всех, без version', () => {
    for (const ruleset of [BASELINE_RULESET, FORMAT_2_20_RULESET, FORMAT_PRE_2_20_RULESET]) {
      assert.ok(ruleset.managedFormXmlns.startsWith('xmlns="http://v8.1c.ru/8.3/xcf/logform" '), ruleset.id);
      assert.ok(ruleset.managedFormXmlns.includes(' xmlns:dcssch="http://v8.1c.ru/8.1/data-composition-system/schema"'), ruleset.id);
      assert.ok(!ruleset.managedFormXmlns.includes('version='), ruleset.id);
      assert.strictEqual(ruleset.managedFormXmlns.includes('xmlns:pal='), ruleset === BASELINE_RULESET, ruleset.id);
    }
  });
});

suite('buildFormXmlFromDefinition — написание WindowOpeningMode по версии формата', () => {
  // Значение — из строки корня формы; ruleset разрешается по версии (дефолтный аргумент).
  function windowOpeningMode(value: string, version: string): string {
    const xml = buildFormXmlFromDefinition({ properties: { windowOpeningMode: value } }, version);
    const match = /\n\t<WindowOpeningMode>([^<]*)<\/WindowOpeningMode>\n/.exec(xml);
    assert.ok(match, `нет WindowOpeningMode в форме ${version}`);
    return match[1];
  }

  const expected: Record<string, Record<string, string>> = {
    '2.21': { LockOwnerWindow: 'LockOwner', LockOwner: 'LockOwner', DontBlock: 'DontBlock', LockWholeInterface: 'LockWholeInterface' },
    '2.20': { LockOwnerWindow: 'LockOwnerWindow', LockOwner: 'LockOwnerWindow', DontBlock: 'DontBlock', LockWholeInterface: 'LockWholeInterface' },
  };
  for (const version of ['2.17', '2.18', '2.19', '2.20', '2.21']) {
    const table = expected[version === '2.21' ? '2.21' : '2.20'];
    for (const input of Object.keys(table)) {
      test(`${version}: ${input} → ${table[input]}`, () => {
        assert.strictEqual(windowOpeningMode(input, version), table[input]);
      });
    }
  }

  test('свойство без таблицы переименований пишется как есть', () => {
    for (const version of ['2.20', '2.21']) {
      const xml = buildFormXmlFromDefinition({ properties: { width: 60 } }, version, resolveFormatRuleset(version));
      assert.ok(xml.includes('\n\t<Width>60</Width>\n'), version);
    }
  });
});
