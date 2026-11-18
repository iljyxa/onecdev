import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildTypedFieldProperties } from '../../ui/views/properties/PropertyBuilder';
import { COMPOSITE_VALUE_PROPERTY_TAGS } from '../../infra/xml/PropertySchema';
import { skipWithoutCorpus } from './support/corpus';

const CATALOG_XML_PATH = path.resolve(__dirname, '../../../example/2.20/src/cf/Catalogs/Контрагенты.xml');

/** Вырезает полный XML реквизита `Регион` — пустые составные свойства хранятся в нём самозакрытыми. */
function readRegionAttributeXml(): string {
  const xml = fs.readFileSync(CATALOG_XML_PATH, 'utf-8');
  const nameAt = xml.indexOf('<Name>Регион</Name>');
  assert.ok(nameAt > 0, 'фикстура должна содержать реквизит Регион');
  const start = xml.lastIndexOf('<Attribute ', nameAt);
  const end = xml.indexOf('</Attribute>', nameAt) + '</Attribute>'.length;
  return xml.slice(start, end);
}

/** #151: панель не должна давать править пустые составные свойства строкой. */
suite('PropertyBuilder — составные свойства только для чтения (#151)', () => {
  suiteSetup(function () {
    skipWithoutCorpus(this);
  });

  for (const key of ['LinkByType', 'ChoiceParameterLinks', 'ChoiceParameters']) {
    test(`${key} пустой самозакрытый → readonly`, () => {
      const attributeXml = readRegionAttributeXml();
      assert.ok(attributeXml.includes(`<${key}/>`), `в фикстуре ${key} должен быть самозакрытым`);
      assert.ok(COMPOSITE_VALUE_PROPERTY_TAGS.has(key));

      const item = buildTypedFieldProperties(attributeXml).find((p) => p.key === key);
      assert.ok(item, `свойство ${key} должно присутствовать в панели`);
      assert.strictEqual(item.readonly, true);
    });
  }
});
