import * as assert from 'assert';
import { buildPropertyValueBlock, updateLocalizedPropertyContent } from '../../infra/xml/properties/PropertyValueBlock';

/**
 * Значение приходит из MCP/панели нетипизированным (`string | boolean | string[]`),
 * поэтому вид значения и его форма могут не совпасть; построитель обязан дать
 * корректный XML, а не упасть или записать `[object]`.
 */
suite('PropertyValueBlock — несовпадение вида и формы значения (#145)', () => {
  for (const kind of ['metadataReferenceList', 'metadataFieldList'] as const) {
    test(`${kind}: не-список трактуется как пустой список`, () => {
      assert.strictEqual(buildPropertyValueBlock('Prop', kind, 'Справочник.X', '\t\t\t'), '<Prop/>');
      assert.strictEqual(buildPropertyValueBlock('Prop', kind, true, '\t\t\t'), '<Prop/>');
    });
  }

  test('localizedString: логическое значение пишется строкой в v8:content', () => {
    assert.strictEqual(
      buildPropertyValueBlock('xr:ToolTip', 'localizedString', true, '\t\t\t\t\t'),
      [
        '<xr:ToolTip>',
        '\t\t\t\t\t\t<v8:item>',
        '\t\t\t\t\t\t\t<v8:lang>ru</v8:lang>',
        '\t\t\t\t\t\t\t<v8:content>true</v8:content>',
        '\t\t\t\t\t\t</v8:item>',
        '\t\t\t\t\t</xr:ToolTip>',
      ].join('\n')
    );
  });

  test('updateLocalizedPropertyContent: строка экранируется, логическое значение пишется строкой', () => {
    const block = '<Synonym>\n\t<v8:item>\n\t\t<v8:lang>ru</v8:lang>\n\t\t<v8:content>Старое</v8:content>\n\t</v8:item>\n</Synonym>';
    assert.strictEqual(
      updateLocalizedPropertyContent(block, 'A & B'),
      block.replace('Старое', 'A &amp; B')
    );
    assert.strictEqual(updateLocalizedPropertyContent(block, false), block.replace('Старое', 'false'));
  });
});
