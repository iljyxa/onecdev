import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BasedOnXmlService } from '../../infra/xml/BasedOnXmlService';
import { ConfigurationXmlEditor } from '../../infra/xml/ConfigurationXmlEditor';
import { ExchangePlanContentService } from '../../infra/xml/ExchangePlanContentService';
import { SubsystemXmlService } from '../../infra/xml/SubsystemXmlService';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { PropertiesViewController } from '../../ui/views/properties/PropertiesViewController';
import { buildTypedFieldProperties } from '../../ui/views/properties/PropertyBuilder';
import { TypeRegistryService } from '../../ui/views/properties/TypeRegistryService';
import { skipWithoutCorpus } from './support/corpus';

const CATALOG_XML_PATH = path.resolve(__dirname, '../../../example/2.20/src/cf/Catalogs/Контрагенты.xml');
const NIL_CATALOG_XML_PATH = path.resolve(__dirname, '../../../example/2.21/src/cf/Catalogs/АвтоматическиеСкидки.xml');

/** Пустые составные теги хранятся самозакрытыми и по форме не отличаются от пустой строки. */
const EMPTY_COMPOSITE_KEYS = ['LinkByType', 'ChoiceParameterLinks', 'ChoiceParameters'];
/** Типизированное значение с `xsi:nil`; MinValue/MaxValue панель показывает только для числа и даты. */
const NIL_TYPED_KEYS = ['FillValue'];

/** Вырезает полный XML реквизита, содержащего `marker`. */
function readAttributeXml(xmlPath: string, marker: string): string {
  const xml = fs.readFileSync(xmlPath, 'utf-8');
  const markerAt = xml.indexOf(marker);
  assert.ok(markerAt > 0, `фикстура должна содержать ${marker}`);
  const start = xml.lastIndexOf('<Attribute ', markerAt);
  const end = xml.indexOf('</Attribute>', markerAt) + '</Attribute>'.length;
  return xml.slice(start, end);
}

/** #151: панель не должна давать править пустые составные свойства строкой. */
suite('PropertyBuilder — составные свойства только для чтения (#151)', () => {
  suiteSetup(function () {
    skipWithoutCorpus(this);
  });

  for (const key of EMPTY_COMPOSITE_KEYS) {
    test(`${key} пустой самозакрытый → readonly`, () => {
      const attributeXml = readAttributeXml(CATALOG_XML_PATH, '<Name>Регион</Name>');
      assert.ok(attributeXml.includes(`<${key}/>`), `в фикстуре ${key} должен быть самозакрытым`);

      const item = buildTypedFieldProperties(attributeXml).find((p) => p.key === key);
      assert.ok(item, `свойство ${key} должно присутствовать в панели`);
      assert.strictEqual(item.readonly, true);
    });
  }

  for (const key of NIL_TYPED_KEYS) {
    test(`${key} с xsi:nil → readonly`, () => {
      const attributeXml = readAttributeXml(NIL_CATALOG_XML_PATH, `<${key} xsi:nil="true"/>`);

      const item = buildTypedFieldProperties(attributeXml).find((p) => p.key === key);
      assert.ok(item, `свойство ${key} должно присутствовать в панели`);
      assert.strictEqual(item.readonly, true);
    });
  }

  test('обычные скалярные строки остаются редактируемыми', () => {
    const attributeXml = readAttributeXml(CATALOG_XML_PATH, '<Name>Регион</Name>');

    const choiceForm = buildTypedFieldProperties(attributeXml).find((p) => p.key === 'ChoiceForm');
    assert.ok(choiceForm, 'свойство ChoiceForm должно присутствовать в панели');
    assert.strictEqual(choiceForm.kind, 'string');
    assert.notStrictEqual(choiceForm.readonly, true);
  });

  test('запись через путь панели не меняет файл', async function () {
    this.timeout(10000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-151-'));
    const xmlPath = path.join(dir, 'Контрагенты.xml');
    fs.copyFileSync(CATALOG_XML_PATH, xmlPath);
    const before = fs.readFileSync(xmlPath);

    const controller = new PropertiesViewController(
      new SubsystemXmlService(),
      new ExchangePlanContentService(),
      new TypeRegistryService(),
      new ConfigurationXmlEditor(),
      new BasedOnXmlService(),
      { refreshActiveView: () => undefined, replaceActiveNode: () => undefined }
    );
    const node = new MetadataNode(
      { label: 'Регион', nodeKind: 'Attribute', xmlPath },
      vscode.TreeItemCollapsibleState.None
    );
    const attributeXml = readAttributeXml(xmlPath, '<Name>Регион</Name>');
    controller.buildRenderContext(node, buildTypedFieldProperties(attributeXml));

    for (const key of EMPTY_COMPOSITE_KEYS) {
      controller.handlePropertyChange(key, 'X');
    }
    // Запись асинхронна: даём очереди операций отработать, прежде чем сравнивать файл.
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.ok(fs.readFileSync(xmlPath).equals(before), 'файл изменён записью составного свойства из панели');
  });
});
