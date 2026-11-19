import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ObjectXmlReader } from '../../infra/xml/ObjectXmlReader';
import * as vscode from 'vscode';
import { STANDARD_ATTRIBUTES_BLOCKS } from '../../infra/xml/format/standardAttributes';
import { structuredMetaChildHandler } from '../../ui/tree/nodeBuilders/structuredMetaChildHandler';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { buildRootMetaObjectProperties } from '../../ui/views/properties/PropertyBuilder';
import { EXAMPLE_GENERATIONS, skipWithoutCorpus } from './support/corpus';

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.20/src/cf');
const objectReader = new ObjectXmlReader();

// Возвращает путь к первому Catalog в example/2.20/src/cf без блока StandardAttributes.
function findFirstCatalogWithoutStandardAttributes(): string | null {
  const catalogsDir = path.join(EXAMPLE_CF, 'Catalogs');
  if (!fs.existsSync(catalogsDir)) {
    return null;
  }
  for (const entry of fs.readdirSync(catalogsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.xml')) {
      continue;
    }
    const file = path.join(catalogsDir, entry.name);
    const xml = fs.readFileSync(file, 'utf-8');
    if (!xml.includes('<StandardAttributes>')) {
      return file;
    }
  }
  return null;
}

suite('Properties — справочник', () => {
  // `example/` не отслеживается git — без корпуса сьют пропускается, а не падает
  // (единый гейт: support/corpus.ts).
  suiteSetup(function () {
    skipWithoutCorpus(this);
  });

  test('Показывает свойства справочника по разделам конфигуратора', () => {
    // Тест проверяет наличие ключевых свойств, общих для любого справочника;
    // конкретные значения зависят от выгрузки и не проверяются.
    const catalogPath = findFirstCatalogWithoutStandardAttributes()
      ?? path.join(EXAMPLE_CF, 'Catalogs', 'Товары.xml');
    const xml = fs.readFileSync(catalogPath, 'utf-8');
    const props = buildRootMetaObjectProperties(xml, 'Catalog');

    const keys = props.map((item) => item.key);
    assert.ok(keys.includes('Hierarchical'), 'Hierarchical не найден');
    assert.ok(keys.includes('Owners'), 'Owners не найден');
    assert.ok(keys.includes('DescriptionLength'), 'DescriptionLength не найден');
    assert.ok(keys.includes('DefaultFolderForm'), 'DefaultFolderForm не найден');
    assert.ok(keys.includes('InputByString'), 'InputByString не найден');
    assert.ok(keys.includes('UseStandardCommands'), 'UseStandardCommands не найден');
    assert.ok(keys.includes('BasedOn'), 'BasedOn не найден');
    assert.ok(keys.includes('PredefinedDataUpdate'), 'PredefinedDataUpdate не найден');
    assert.ok(!keys.includes('Characteristics'), 'Characteristics не должен выводиться в свойствах справочника');

    const owners = props.find((item) => item.key === 'Owners');
    assert.ok(owners, 'Owners не найден');
    assert.strictEqual(owners.section, 'Владельцы');

    const codeType = props.find((item) => item.key === 'CodeType');
    assert.ok(codeType, 'CodeType не найден');
    assert.strictEqual(codeType.kind, 'enum');

    const inputByString = props.find((item) => item.key === 'InputByString');
    assert.ok(inputByString, 'InputByString не найден');
    assert.strictEqual(inputByString.kind, 'metadataReferenceList');
  });

  test('Показывает стандартные реквизиты корневого объекта с русскими представлениями', () => {
    // Используем любой доступный Catalog из example/2.20/src/cf — в нём всегда есть
    // дефолтные стандартные реквизиты (PredefinedDataName, Ref, ...), даже если
    // блока StandardAttributes нет в XML, парсер добавляет их по умолчанию.
    const catalogsDir = path.join(EXAMPLE_CF, 'Catalogs');
    const entry = fs.readdirSync(catalogsDir, { withFileTypes: true })
      .find((item) => item.isFile() && item.name.endsWith('.xml'));
    assert.ok(entry, 'В example/2.20/src/cf/Catalogs нет ни одного справочника');
    const objectInfo = objectReader.read(path.join(catalogsDir, entry.name));

    const standardAttributes = objectInfo?.children.filter((item) => item.tag === 'StandardAttribute') ?? [];
    assert.ok(standardAttributes.length > 0, 'Стандартные реквизиты не найдены');
    const expectedTriple = ['PredefinedDataName', 'Predefined', 'Ref'];
    const presentations: Record<string, string> = {
      PredefinedDataName: 'Имя предопределенных данных',
      Predefined: 'Предопределенный',
      Ref: 'Ссылка',
    };
    for (const name of expectedTriple) {
      const item = standardAttributes.find((attr) => attr.name === name);
      assert.ok(item, `Стандартный реквизит ${name} не найден`);
      assert.strictEqual(item.presentation, presentations[name]);
    }
  });

  test('Выводит стандартные реквизиты из поля ввода по строке, если блока StandardAttributes нет', function () {
    // Берём любой справочник без блока StandardAttributes; если такого нет — тест не применим.
    const catalogPath = findFirstCatalogWithoutStandardAttributes();
    if (!catalogPath) {
      this.skip();
    }
    const objectInfo = objectReader.read(catalogPath);

    const standardAttributes = objectInfo?.children.filter((item) => item.tag === 'StandardAttribute') ?? [];
    assert.ok(standardAttributes.length > 0, 'Стандартные реквизиты не материализованы');
    // Проверяем хотя бы наличие ключевых стандартных реквизитов справочника по умолчанию.
    const names = standardAttributes.map((item) => item.name);
    for (const required of ['Ref', 'DeletionMark', 'Code', 'Description']) {
      assert.ok(names.includes(required), `Стандартный реквизит ${required} не материализован`);
    }
  });

  test('Показ свойств стандартного реквизита не пишет файл и берёт значения из шаблона вида', () => {
    // Раньше показ свойств вставлял в XML разреженный блок StandardAttributes
    // (запреты 10/11 CLAUDE.md, #16). Копия — чтобы не зависеть от example/.
    const sourcePath = findFirstCatalogWithoutStandardAttributes();
    assert.ok(sourcePath, 'в корпусе нет справочника без блока StandardAttributes');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-catalog-prop-'));
    try {
      const targetPath = path.join(tempRoot, path.basename(sourcePath));
      fs.copyFileSync(sourcePath, targetPath);
      const before = fs.readFileSync(targetPath);

      const properties = standardAttributeProperties(targetPath, 'Description');

      assert.ok(fs.readFileSync(targetPath).equals(before), 'файл объекта изменён показом свойств');
      assert.strictEqual(
        fillCheckingCurrent(properties),
        templateValue('Description', 'FillChecking')
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('Стандартный реквизит табличной части показывается без записи в файл', () => {
    const sourcePath = path.join(EXAMPLE_GENERATIONS.cf21, 'Catalogs', 'Контрагенты.xml');
    const xml = fs.readFileSync(sourcePath, 'utf-8');
    const tsName = /<TabularSection uuid="[^"]+">[\s\S]*?<Properties>\s*<Name>([^<]+)<\/Name>/.exec(xml)?.[1];
    assert.ok(tsName, 'у справочника нет табличной части');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-catalog-ts-prop-'));
    try {
      const targetPath = path.join(tempRoot, path.basename(sourcePath));
      fs.copyFileSync(sourcePath, targetPath);
      const before = fs.readFileSync(targetPath);

      const properties = standardAttributeProperties(targetPath, 'LineNumber', tsName);

      assert.ok(properties.length > 0);
      assert.ok(fs.readFileSync(targetPath).equals(before), 'файл объекта изменён показом свойств');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

suite('Properties — стандартный реквизит заимствованного справочника', () => {
  const extensionSource = path.join(EXAMPLE_GENERATIONS.cfe21, 'Catalogs', 'Номенклатура.xml');
  const baseSource = path.join(EXAMPLE_GENERATIONS.cf21, 'Catalogs', 'Номенклатура.xml');
  suiteSetup(function () {
    skipWithoutCorpus(this, extensionSource, baseSource);
  });

  test('показ свойств не меняет ни файл расширения, ни файл базовой конфигурации', () => {
    // Раскладка как в проекте: <root>/cf и <root>/cfe/<Имя> — по ней
    // BorrowedPropertiesResolver находит объект базовой конфигурации.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-borrowed-sa-'));
    try {
      const cfRoot = path.join(tempRoot, 'cf');
      const cfeRoot = path.join(tempRoot, 'cfe', 'EVOLC');
      fs.mkdirSync(path.join(cfRoot, 'Catalogs'), { recursive: true });
      fs.mkdirSync(path.join(cfeRoot, 'Catalogs'), { recursive: true });
      fs.copyFileSync(path.join(EXAMPLE_GENERATIONS.cf21, 'Configuration.xml'), path.join(cfRoot, 'Configuration.xml'));
      fs.copyFileSync(path.join(EXAMPLE_GENERATIONS.cfe21, 'Configuration.xml'), path.join(cfeRoot, 'Configuration.xml'));
      const basePath = path.join(cfRoot, 'Catalogs', 'Номенклатура.xml');
      const extensionPath = path.join(cfeRoot, 'Catalogs', 'Номенклатура.xml');
      fs.copyFileSync(baseSource, basePath);
      fs.copyFileSync(extensionSource, extensionPath);
      const baseBefore = fs.readFileSync(basePath);
      const extensionBefore = fs.readFileSync(extensionPath);

      const properties = standardAttributeProperties(extensionPath, 'Description');
      // Ветка ТЧ у заимствованного объекта: ТЧ нет ни в расширении, ни в базе — свойств нет.
      assert.deepStrictEqual(standardAttributeProperties(extensionPath, 'LineNumber', 'НетТакойТЧ'), []);

      assert.ok(fs.readFileSync(extensionPath).equals(extensionBefore), 'файл расширения изменён показом свойств');
      assert.ok(fs.readFileSync(basePath).equals(baseBefore), 'файл базовой конфигурации изменён');
      assert.ok(properties.some((item) => item.key === 'FillChecking'));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('ключ, которого нет в элементе расширения, показывается значением базовой конфигурации (#146)', () => {
    // В расширении элемента Description нет вовсе — синтезированный пустой элемент
    // не должен перекрывать базу умолчаниями enum/boolean (FillChecking = DontCheck).
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-borrowed-sa-'));
    try {
      const cfRoot = path.join(tempRoot, 'cf');
      const cfeRoot = path.join(tempRoot, 'cfe', 'EVOLC');
      fs.mkdirSync(path.join(cfRoot, 'Catalogs'), { recursive: true });
      fs.mkdirSync(path.join(cfeRoot, 'Catalogs'), { recursive: true });
      fs.copyFileSync(path.join(EXAMPLE_GENERATIONS.cf21, 'Configuration.xml'), path.join(cfRoot, 'Configuration.xml'));
      fs.copyFileSync(path.join(EXAMPLE_GENERATIONS.cfe21, 'Configuration.xml'), path.join(cfeRoot, 'Configuration.xml'));
      fs.copyFileSync(baseSource, path.join(cfRoot, 'Catalogs', 'Номенклатура.xml'));
      const extensionPath = path.join(cfeRoot, 'Catalogs', 'Номенклатура.xml');
      fs.copyFileSync(extensionSource, extensionPath);

      const properties = standardAttributeProperties(extensionPath, 'Description');

      assert.strictEqual(fillCheckingCurrent(properties), templateValue('Description', 'FillChecking'));
      const fillChecking = properties.find((item) => item.key === 'FillChecking');
      assert.strictEqual(fillChecking?.inherited, true, 'FillChecking должен быть унаследованным');
      // Собственных значений у реквизита в расширении нет — локальным не может быть ни один пункт.
      assert.deepStrictEqual(properties.filter((item) => !item.inherited).map((item) => item.key), []);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

function standardAttributeProperties(xmlPath: string, name: string, tabularSectionName?: string) {
  const node = new MetadataNode({
    label: name,
    nodeKind: 'StandardAttribute',
    xmlPath,
    metaContext: {
      rootMetaKind: 'Catalog',
      ownerObjectXmlPath: xmlPath,
      standardAttributeName: name,
      ...(tabularSectionName ? { tabularSectionName } : {}),
    },
  }, vscode.TreeItemCollapsibleState.None);
  if (!structuredMetaChildHandler.getProperties) {
    assert.fail('обработчик свойств дочерних элементов не найден');
  }
  return structuredMetaChildHandler.getProperties(node);
}

/** Текущее значение enum-свойства FillChecking из коллекции свойств панели. */
function fillCheckingCurrent(properties: ReturnType<typeof standardAttributeProperties>): unknown {
  const value = properties.find((item) => item.key === 'FillChecking')?.value;
  return typeof value === 'object' && 'current' in value ? value.current : value;
}

/** Значение свойства реквизита в шаблоне Catalog — ожидание берётся из ruleset, а не литералом. */
function templateValue(attributeName: string, key: string): string {
  const block = STANDARD_ATTRIBUTES_BLOCKS.Catalog ?? '';
  const element = new RegExp(`<xr:StandardAttribute name="${attributeName}">[\\s\\S]*?</xr:StandardAttribute>`).exec(block)?.[0] ?? '';
  const value = new RegExp(`<xr:${key}>([^<]*)</xr:${key}>`).exec(element)?.[1];
  assert.ok(value, `в шаблоне нет ${attributeName}.${key}`);
  return value;
}
