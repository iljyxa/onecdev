import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatNewExportText } from '../../infra/fs/NewExportFile';
import { FormToolsService, MetadataXmlCreator } from '../../infra/xml';
import { buildManagedFormXml } from '../../infra/xml/creator/auxiliaryFileBuilders';
import { buildFormDescriptorXml } from '../../infra/xml/form/FormAddService';
import { buildFormXmlFromDefinition } from '../../infra/xml/form/FormBuilders';
import type { FormDefinition } from '../../infra/xml/form/types';
import { resolveFormatRuleset } from '../../infra/xml/format/formatRegistry';
import { EXAMPLE_GENERATIONS, EXAMPLE_ROOT, skipWithoutCorpus } from './support/corpus';

/**
 * Генератор форм против эталона платформы обеих генераций формата (issue #56).
 *
 * Эталоны: пары форм `example/2.20` ↔ `example/2.21` (одна конфигурация,
 * выгруженная 8.3.27 и 8.5.1 в режиме совместимости 8.3.27) и родная форма 2.21
 * `example/crs/config` (выгружена 8.5.1 без режима совместимости).
 */

const CRS_CONFIG = path.join(EXAMPLE_ROOT, 'crs/config');
const CRS_FORM = path.join(CRS_CONFIG, 'Catalogs/Контрагенты/Forms/ФормаЭлемента/Ext/Form.xml');
const CRS_FORM_DESCRIPTOR = path.join(CRS_CONFIG, 'Catalogs/Контрагенты/Forms/ФормаЭлемента.xml');
const VERSIONS = ['2.20', '2.21'] as const;
type Version = (typeof VERSIONS)[number];

const ALKO_FORM = 'CommonForms/АЛКОВводРеквизитовОП/Ext/Form.xml';
const ALKO_DESCRIPTOR = 'CommonForms/АЛКОВводРеквизитовОП.xml';

/** Формы элемента справочников и событие формы из эталона. */
const ITEM_FORMS: readonly { readonly catalog: string; readonly event: string; readonly handler: string }[] = [
  { catalog: 'ПричиныВозврата', event: 'OnOpen', handler: 'ПриОткрытии' },
  { catalog: 'РолиКонтактныхЛиц', event: 'ChoiceProcessing', handler: 'ОбработкаВыбора' },
  { catalog: 'Контрагенты', event: 'OnCreateAtServer', handler: 'ПриСозданииНаСервере' },
];

const LIST_FORMS = [
  'Catalogs/Контрагенты/Forms/ФормаСписка/Ext/Form.xml',
  'ExternalDataSources/ИнтернетМагазин/Tables/Заказы/Forms/ФормаСписка/Ext/Form.xml',
];

/** Все `Form.xml` корпуса, корень которых сверяется с генератором (13 файлов). */
function corpusFormFiles(): { readonly version: Version; readonly file: string }[] {
  const files: { version: Version; file: string }[] = [];
  for (const version of VERSIONS) {
    const root = generationRoot(version);
    for (const rel of [ALKO_FORM, ...ITEM_FORMS.map((f) => itemFormRel(f.catalog)), ...LIST_FORMS]) {
      files.push({ version, file: path.join(root, rel) });
    }
  }
  files.push({ version: '2.21', file: CRS_FORM });
  return files;
}

function generationRoot(version: Version): string {
  return version === '2.20' ? EXAMPLE_GENERATIONS.cf20 : EXAMPLE_GENERATIONS.cf21;
}

function itemFormRel(catalog: string): string {
  return `Catalogs/${catalog}/Forms/ФормаЭлемента/Ext/Form.xml`;
}

/**
 * Эталон платформы — с BOM, CRLF и без перевода строки после корня; генератор
 * пишет без BOM, LF и с финальным `\n` (BOM/EOL нового файла — забота записи).
 * Сводим эталон к стилю генератора, предварительно зафиксировав его байты.
 */
function readNormalized(file: string): string {
  const buffer = fs.readFileSync(file);
  assert.ok(buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf, `${file}: эталон с BOM`);
  assert.ok(buffer.includes(Buffer.from('\r\n')), `${file}: эталон с CRLF`);
  assert.strictEqual(buffer[buffer.length - 1], 0x3e /* '>' */, `${file}: без перевода строки после корня`);
  return buffer.toString('utf-8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n') + '\n';
}

/** Вторая строка (корень документа) — без учёта стиля EOL: эталон сведён к LF, файл на диске — в CRLF. */
function secondLine(text: string): string {
  return text.split(/\r?\n/)[1];
}

function normalizeUuid(xml: string): string {
  return xml.replace(/uuid="[0-9a-f-]{36}"/g, 'uuid="<UUID>"');
}

/** Убирает верхнеуровневый блок `\t<ChildItems>…\t</ChildItems>` (вложенные имеют больший отступ). */
function withoutTopChildItems(xml: string): string {
  const next = xml.replace(/\n\t<ChildItems>\n[\s\S]*?\n\t<\/ChildItems>\n/, '\n');
  assert.notStrictEqual(next, xml, 'в эталоне нет верхнеуровневого ChildItems');
  return next;
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const UIC_LINE = '\t\t\t<UseInInterfaceCompatibilityMode>Any</UseInInterfaceCompatibilityMode>';

suite('Генератор форм против корпуса обеих генераций формата (#56)', () => {
  suiteSetup(function () {
    skipWithoutCorpus(this, EXAMPLE_GENERATIONS.cf20, EXAMPLE_GENERATIONS.cf21, CRS_FORM, CRS_FORM_DESCRIPTOR);
  });

  test('корень <Form> каждой формы корпуса = managedFormXmlns ruleset той же версии', () => {
    const files = corpusFormFiles();
    assert.strictEqual(files.length, 13);
    for (const { version, file } of files) {
      const expected = `<Form ${resolveFormatRuleset(version).managedFormXmlns} version="${version}">`;
      assert.strictEqual(secondLine(readNormalized(file)), expected, file);
    }
  });

  test('buildManagedFormXml(2.20) байт-в-байт = пустая общая форма 2.20', () => {
    const expected = readNormalized(path.join(EXAMPLE_GENERATIONS.cf20, ALKO_FORM));
    assert.strictEqual(buildManagedFormXml('2.20'), expected);
    assert.strictEqual(buildManagedFormXml('2.20', resolveFormatRuleset('2.20')), expected);
  });

  test('buildManagedFormXml(2.21) = корень 2.21 + тело 2.20', () => {
    const alko20 = readNormalized(path.join(EXAMPLE_GENERATIONS.cf20, ALKO_FORM)).split('\n');
    const alko21 = readNormalized(path.join(EXAMPLE_GENERATIONS.cf21, ALKO_FORM));
    const expected = [alko20[0], secondLine(alko21), ...alko20.slice(2)].join('\n');
    assert.strictEqual(buildManagedFormXml('2.21'), expected);

    // В корпусе 2.21 встречаются оба варианта состава свойств. При создании
    // одинаковых форм смена режима совместимости состава не меняет (#140).
    const crs = readNormalized(CRS_FORM);
    assert.ok(alko21.includes('\n\t<WindowOpeningMode>'));
    assert.ok(alko21.includes('\n\t<Group>'));
    assert.ok(!crs.includes('\n\t<WindowOpeningMode>'));
    assert.ok(!crs.includes('\n\t<Group>'));
  });

  test('buildFormXmlFromDefinition(2.21) байт-в-байт = родная форма элемента 8.5.1 (crs)', () => {
    const definition: FormDefinition = {
      properties: { useForFoldersAndItems: 'Items' },
      elements: [
        { input: 'Наименование', path: 'Объект.Description' },
        { input: 'ИНН', path: 'Объект.ИНН' },
      ],
      attributes: [{ name: 'Объект', type: 'CatalogObject.Контрагенты', main: true }],
    };
    assert.strictEqual(buildFormXmlFromDefinition(definition, '2.21'), readNormalized(CRS_FORM));
  });

  for (const version of VERSIONS) {
    for (const { catalog, event, handler } of ITEM_FORMS) {
      test(`форма элемента ${catalog} ${version}: свойства, события, реквизиты байт-в-байт`, () => {
        // Поля формы в эталоне несут EditMode и прочие свойства, которых
        // генератор не пишет, — верхнеуровневый ChildItems из сверки исключён.
        // DSL задаёт написание 2.20: приведение к формату — дело ruleset.
        const definition: FormDefinition = {
          properties: { windowOpeningMode: 'LockOwnerWindow', useForFoldersAndItems: 'Items' },
          events: { [event]: handler },
          attributes: [{ name: 'Объект', type: `CatalogObject.${catalog}`, main: true }],
        };
        let expected = withoutTopChildItems(readNormalized(path.join(generationRoot(version), itemFormRel(catalog))));
        if (version === '2.21') {
          // Group в 2.21 — режим совместимости (см. контрпример crs выше).
          assert.strictEqual(countOccurrences(expected, '\n\t<Group>Vertical</Group>\n'), 1);
          expected = expected.replace('\n\t<Group>Vertical</Group>\n', '\n');
        }
        assert.strictEqual(buildFormXmlFromDefinition(definition, version), expected);
      });
    }

    test(`форма списка ${version}: без свойств в DSL нет WindowOpeningMode/Group`, () => {
      const xml = buildFormXmlFromDefinition({
        events: { OnCreateAtServer: 'ПриСозданииНаСервере' },
        attributes: [{ name: 'Список', type: 'DynamicList', main: true, settings: { mainTable: 'Catalog.Контрагенты' } }],
      }, version);
      assert.ok(!xml.includes('<WindowOpeningMode>'));
      assert.ok(!xml.includes('\n\t<Group>'));
      assert.strictEqual(secondLine(xml), secondLine(readNormalized(path.join(generationRoot(version), LIST_FORMS[0]))));
    });

    test(`дескриптор формы FormAddService ${version} байт-в-байт = эталон ПричиныВозврата`, () => {
      const expected = normalizeUuid(readNormalized(path.join(generationRoot(version), 'Catalogs/ПричиныВозврата/Forms/ФормаЭлемента.xml')));
      assert.strictEqual(normalizeUuid(buildFormDescriptorXml('ФормаЭлемента', 'Форма элемента', version, false)), expected);
      assert.strictEqual(
        normalizeUuid(buildFormDescriptorXml('ФормаЭлемента', 'Форма элемента', version, false, resolveFormatRuleset(version))),
        expected
      );
    });
  }

  test('дескриптор формы FormAddService 2.21 байт-в-байт = родной дескриптор 8.5.1 (crs)', () => {
    assert.strictEqual(
      normalizeUuid(buildFormDescriptorXml('ФормаЭлемента', 'Форма элемента', '2.21', false)),
      normalizeUuid(readNormalized(CRS_FORM_DESCRIPTOR))
    );
  });

  for (const version of VERSIONS) {
    test(`форма объекта через MetadataXmlCreator ${version}: дескриптор байт-в-байт = эталон ПричиныВозврата (#142)`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-form-fmt-'));
      try {
        const ownerXml = path.join(root, 'Catalogs', 'Банки.xml');
        fs.mkdirSync(path.dirname(ownerXml), { recursive: true });
        fs.copyFileSync(path.join(generationRoot(version), 'Catalogs/Банки.xml'), ownerXml);
        const result = new MetadataXmlCreator().addChildElement({ ownerObjectXmlPath: ownerXml, childTag: 'Form', name: 'ФормаЭлемента' });
        assert.strictEqual(result.success, true, result.errors.join('; '));

        // Байт-в-байт с выгрузкой платформы, включая BOM и CRLF (#165).
        const descriptor = fs.readFileSync(path.join(root, 'Catalogs/Банки/Forms/ФормаЭлемента.xml'), 'utf-8');
        const expected = fs.readFileSync(path.join(generationRoot(version), 'Catalogs/ПричиныВозврата/Forms/ФормаЭлемента.xml'), 'utf-8');
        assert.strictEqual(normalizeUuid(descriptor), normalizeUuid(expected));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('форма обработки через MetadataXmlCreator: дескриптор с ExtendedPresentation, как у FormAddService (#142)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-form-fmt-'));
    try {
      fs.copyFileSync(path.join(generationRoot('2.21'), 'Configuration.xml'), path.join(root, 'Configuration.xml'));
      const created = new MetadataXmlCreator().addRootObject({ configRoot: root, kind: 'DataProcessor', name: 'Обработка' });
      assert.strictEqual(created.success, true, created.errors.join('; '));
      const result = new MetadataXmlCreator().addChildElement({
        ownerObjectXmlPath: path.join(root, 'DataProcessors', 'Обработка.xml'), childTag: 'Form', name: 'Форма',
      });
      assert.strictEqual(result.success, true, result.errors.join('; '));
      const descriptor = fs.readFileSync(path.join(root, 'DataProcessors/Обработка/Forms/Форма.xml'), 'utf-8');
      assert.strictEqual(normalizeUuid(descriptor), normalizeUuid(formatNewExportText('Форма.xml', buildFormDescriptorXml('Форма', 'Форма', '2.21', true))));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  for (const version of VERSIONS) {
    test(`общая форма через MetadataXmlCreator ${version}: дескриптор и Form.xml по эталону той же генерации`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-form-fmt-'));
      try {
        fs.copyFileSync(path.join(generationRoot(version), 'Configuration.xml'), path.join(root, 'Configuration.xml'));
        const result = new MetadataXmlCreator().addRootObject({ configRoot: root, kind: 'CommonForm', name: 'Тест' });
        assert.strictEqual(result.success, true, result.errors.join('; '));

        const descriptor = fs.readFileSync(path.join(root, 'CommonForms/Тест.xml'), 'utf-8');
        const reference = fs.readFileSync(path.join(generationRoot(version), ALKO_DESCRIPTOR), 'utf-8');
        assert.strictEqual(descriptor.includes(UIC_LINE), reference.includes(UIC_LINE));
        assert.strictEqual(descriptor.includes(UIC_LINE), version === '2.21');
        // Назначения использования — как в эталоне той же генерации (#142).
        const usePurposes = (xml: string): string => /<UsePurposes>[\s\S]*?<\/UsePurposes>/.exec(xml)?.[0] ?? '';
        assert.strictEqual(usePurposes(descriptor), usePurposes(reference));

        const formXml = fs.readFileSync(path.join(root, 'CommonForms/Тест/Ext/Form.xml'), 'utf-8');
        assert.strictEqual(formXml, formatNewExportText('Form.xml', buildManagedFormXml(version)));
        assert.strictEqual(secondLine(formXml), secondLine(readNormalized(path.join(generationRoot(version), ALKO_FORM))));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

suite('FormToolsService на реальных объектах обеих генераций формата (#56)', () => {
  suiteSetup(function () {
    skipWithoutCorpus(this, EXAMPLE_GENERATIONS.cf20, EXAMPLE_GENERATIONS.cf21);
  });

  const OBJECTS = ['Catalogs/Контрагенты.xml', 'Documents/Заказ.xml', 'InformationRegisters/КурсыВалют.xml'];
  let roots: string[] = [];

  /** Временная конфигурация: Configuration.xml и XML объектов из эталона версии. */
  function copyConfig(version: Version): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-form-fmt-'));
    roots.push(root);
    for (const rel of ['Configuration.xml', ...OBJECTS]) {
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(generationRoot(version), rel), target);
    }
    return root;
  }

  teardown(() => {
    for (const root of roots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    roots = [];
  });

  const CASES = [
    { object: 'Catalogs/Контрагенты', purpose: 'Choice' },
    { object: 'Documents/Заказ', purpose: 'Choice' },
    { object: 'InformationRegisters/КурсыВалют', purpose: 'Record' },
  ] as const;

  for (const version of VERSIONS) {
    const lockOwner = version === '2.21' ? 'LockOwner' : 'LockOwnerWindow';
    const corpusRoot = (): string => secondLine(readNormalized(path.join(generationRoot(version), ALKO_FORM)));

    for (const { object, purpose } of CASES) {
      test(`addForm ${purpose} на ${object} ${version}: WindowOpeningMode ${lockOwner}, корень и дескриптор по версии`, () => {
        const root = copyConfig(version);
        const service = new FormToolsService();
        service.addForm({ objectPath: path.join(root, `${object}.xml`), formName: 'Новая', purpose });

        const formXmlPath = path.join(root, object, 'Forms/Новая/Ext/Form.xml');
        const formXml = fs.readFileSync(formXmlPath, 'utf-8');
        assert.ok(formXml.includes(`\r\n\t<WindowOpeningMode>${lockOwner}</WindowOpeningMode>\r\n`));
        assert.strictEqual(secondLine(formXml), corpusRoot());

        const descriptor = fs.readFileSync(path.join(root, object, 'Forms/Новая.xml'), 'utf-8');
        assert.strictEqual(descriptor.includes(UIC_LINE), version === '2.21');
        assert.strictEqual(service.validate({ formPath: formXmlPath }).errors, 0);
      });
    }

    test(`addForm List на Catalogs/Контрагенты ${version}: без WindowOpeningMode/Group`, () => {
      const root = copyConfig(version);
      new FormToolsService().addForm({ objectPath: path.join(root, 'Catalogs/Контрагенты.xml'), formName: 'Новая', purpose: 'List' });
      const formXml = fs.readFileSync(path.join(root, 'Catalogs/Контрагенты/Forms/Новая/Ext/Form.xml'), 'utf-8');
      assert.ok(!formXml.includes('<WindowOpeningMode>'));
      assert.ok(!formXml.includes('\r\n\t<Group>'));
      assert.strictEqual(secondLine(formXml), corpusRoot());
    });

    test(`addForm без автозаполнения на Catalogs/Контрагенты ${version}: корень по версии`, () => {
      const root = copyConfig(version);
      new FormToolsService().addForm({
        objectPath: path.join(root, 'Catalogs/Контрагенты.xml'),
        formName: 'Новая',
        purpose: 'Object',
        autoFill: false,
      });
      const formXml = fs.readFileSync(path.join(root, 'Catalogs/Контрагенты/Forms/Новая/Ext/Form.xml'), 'utf-8');
      assert.strictEqual(secondLine(formXml), corpusRoot());
    });
  }

  test('compile fromObject 2.21: корень формы и дескриптор с pal и UseInInterfaceCompatibilityMode', () => {
    const root = copyConfig('2.21');
    const outputPath = path.join(root, 'Catalogs/Контрагенты/Forms/Новая/Ext/Form.xml');
    new FormToolsService().compile({ outputPath, fromObject: true });
    const formXml = fs.readFileSync(outputPath, 'utf-8');
    assert.strictEqual(secondLine(formXml), secondLine(readNormalized(path.join(EXAMPLE_GENERATIONS.cf21, ALKO_FORM))));
    const descriptor = fs.readFileSync(path.join(root, 'Catalogs/Контрагенты/Forms/Новая.xml'), 'utf-8');
    assert.ok(descriptor.includes(' xmlns:pal="http://v8.1c.ru/8.1/data/ui/colors/palette"'));
    assert.ok(descriptor.includes(UIC_LINE));
  });
});
