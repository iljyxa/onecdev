import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigurationXmlEditor } from '../../infra/xml/ConfigurationXmlEditor';
import { ObjectXmlReader } from '../../infra/xml/ObjectXmlReader';
import { McpPropertyService } from '../../ui/mcp/McpPropertyService';
import { skipWithoutCorpus } from './support/corpus';
import * as vscode from 'vscode';
import { MetadataNode } from '../../ui/tree/TreeNode';

type ModifyOptions = Parameters<ConfigurationXmlEditor['modifyObjectProperty']>[1];

const CF = path.resolve(__dirname, '../../../example/2.21/src/cf');

/** Один реальный элемент каждого вида дочернего узла, у которого есть <Properties>. */
const TARGETS: readonly { readonly file: string; readonly options: Omit<ModifyOptions, 'propertyKey' | 'valueKind' | 'value'> }[] = [
  { file: 'Catalogs/Регионы.xml', options: { targetKind: 'Self', targetName: 'Регионы' } },
  { file: 'Documents/Заказ.xml', options: { targetKind: 'Attribute', targetName: 'Реквизит1' } },
  { file: 'Documents/Заказ.xml', options: { targetKind: 'TabularSection', targetName: 'ТабличнаяЧасть1' } },
  { file: 'Documents/Заказ.xml', options: { targetKind: 'Column', targetName: 'Реквизит1', tabularSectionName: 'ТабличнаяЧасть1' } },
  { file: 'InformationRegisters/КурсыВалют.xml', options: { targetKind: 'Dimension', targetName: 'Валюта' } },
  { file: 'InformationRegisters/КурсыВалют.xml', options: { targetKind: 'Resource', targetName: 'Курс' } },
  { file: 'Enums/PushУведомления.xml', options: { targetKind: 'EnumValue', targetName: 'ЗначениеПеречисления1' } },
  { file: 'HTTPServices/Chatbot.xml', options: { targetKind: 'URLTemplate', targetName: 'telegram' } },
  { file: 'HTTPServices/Chatbot.xml', options: { targetKind: 'Method', targetName: 'POST', urlTemplateName: 'telegram' } },
];

suite('Писатель свойств: повтор того же значения — успех без изменений (#147)', () => {
  const roots: string[] = [];
  teardown(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function copy(relative: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-property-outcome-'));
    roots.push(root);
    const target = path.join(root, path.basename(relative));
    fs.copyFileSync(path.join(CF, relative), target);
    return target;
  }

  for (const { file, options } of TARGETS) {
    test(`${options.targetKind} ${options.targetName}: первая правка changed, повтор — success без записи`, function () {
      skipWithoutCorpus(this);
      const xmlPath = copy(file);
      const editor = new ConfigurationXmlEditor();
      const edit: ModifyOptions = { ...options, propertyKey: 'Comment', valueKind: 'string', value: 'Комментарий #147' };

      const first = editor.modifyObjectProperty(xmlPath, edit);
      assert.deepStrictEqual(first, { success: true, changed: true, changedFiles: [xmlPath], warnings: [], errors: [] });
      const afterFirst = fs.readFileSync(xmlPath);

      const second = editor.modifyObjectProperty(xmlPath, edit);
      assert.deepStrictEqual(second, { success: true, changed: false, changedFiles: [], warnings: [], errors: [] });
      assert.ok(fs.readFileSync(xmlPath).equals(afterFirst), 'повтор переписал файл');
      assert.deepStrictEqual(new ObjectXmlReader().writePropertyInObject(xmlPath, edit), { status: 'unchanged' });
    });
  }

  test('элемент не найден — отказ с причиной, файл не тронут', function () {
    skipWithoutCorpus(this);
    const xmlPath = copy('Documents/Заказ.xml');
    const before = fs.readFileSync(xmlPath);
    const result = new ConfigurationXmlEditor().modifyObjectProperty(xmlPath, {
      targetKind: 'Attribute', targetName: 'НетТакого', propertyKey: 'Comment', valueKind: 'string', value: 'x',
    });
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(result.errors, ['Элемент "НетТакого" не найден в XML объекта.']);
    assert.ok(fs.readFileSync(xmlPath).equals(before));
  });

  test('у элемента нет <Properties> — отказ no-properties, файл не тронут', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-property-outcome-'));
    roots.push(root);
    const xmlPath = path.join(root, 'Битый.xml');
    fs.writeFileSync(xmlPath, '<MetaDataObject><Catalog><Properties/></Catalog></MetaDataObject>', 'utf-8');
    const outcome = new ObjectXmlReader().writePropertyInObject(xmlPath, {
      targetKind: 'Self', targetName: 'Битый', propertyKey: 'Comment', valueKind: 'string', value: 'x',
    });
    assert.deepStrictEqual(outcome, {
      status: 'refused', reason: 'no-properties', message: 'У выбранного элемента нет блока свойств <Properties>.',
    });
    assert.strictEqual(fs.readFileSync(xmlPath, 'utf-8'), '<MetaDataObject><Catalog><Properties/></Catalog></MetaDataObject>');
  });

  test('файл не читается — отказ read-failed; булев фасад даёт false', () => {
    const missing = path.join(os.tmpdir(), 'onecdev-нет-такого-файла-147.xml');
    const options: ModifyOptions = { targetKind: 'Self', targetName: 'X', propertyKey: 'Comment', valueKind: 'string', value: 'x' };
    assert.deepStrictEqual(new ObjectXmlReader().writePropertyInObject(missing, options), {
      status: 'refused', reason: 'read-failed', message: 'Не удалось прочитать файл объекта.',
    });
    assert.strictEqual(new ObjectXmlReader().updatePropertyInObject(missing, options), false);
  });

  test('MCP setProperty: повтор того же значения — success без changedFiles', function () {
    skipWithoutCorpus(this);
    const xmlPath = copy('Documents/Заказ.xml');
    const service = new McpPropertyService(new ConfigurationXmlEditor());
    const node = new MetadataNode({
      label: 'Реквизит1',
      nodeKind: 'Attribute',
      xmlPath,
      metaContext: { rootMetaKind: 'Document', ownerObjectXmlPath: xmlPath },
    }, vscode.TreeItemCollapsibleState.None);

    const first = service.setProperty(node, 'Comment', 'Комментарий #147');
    const second = service.setProperty(node, 'Comment', 'Комментарий #147');

    assert.strictEqual(first.success, true);
    assert.deepStrictEqual(first.changedFiles, [xmlPath]);
    assert.strictEqual(second.success, true, JSON.stringify(second));
    assert.strictEqual(second.changed, false);
    assert.deepStrictEqual(second.changedFiles, []);
  });
});
