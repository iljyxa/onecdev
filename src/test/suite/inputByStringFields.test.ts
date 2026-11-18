import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BasedOnXmlService } from '../../infra/xml/BasedOnXmlService';
import { ConfigurationXmlEditor } from '../../infra/xml/ConfigurationXmlEditor';
import { ExchangePlanContentService } from '../../infra/xml/ExchangePlanContentService';
import { SubsystemXmlService } from '../../infra/xml/SubsystemXmlService';
import { isInputByStringFieldIndexed } from '../../infra/xml/properties/InputByStringFields';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { PropertiesViewController } from '../../ui/views/properties/PropertiesViewController';
import { TypeRegistryService } from '../../ui/views/properties/TypeRegistryService';
import { EXAMPLE_GENERATIONS, skipWithoutCorpus } from './support/corpus';

/**
 * Поля «ввода по строке»: допустимы только индексируемые поля объекта (#145).
 *
 * У стандартного реквизита `xr:Indexing` в выгрузке не бывает (0 вхождений в
 * шаблонах и корпусе) — индексация берётся из умолчаний домена; у реквизита,
 * измерения и ресурса — из собственного `<Indexing>`.
 */

const BANKS = path.join(EXAMPLE_GENERATIONS.cf21, 'Catalogs/Банки.xml');
const RATES = path.join(EXAMPLE_GENERATIONS.cf21, 'InformationRegisters/КурсыВалют.xml');

suite('isInputByStringFieldIndexed (#145)', () => {
  suiteSetup(function () {
    skipWithoutCorpus(this, BANKS, RATES);
  });

  test('StandardAttribute: индексируемые по умолчанию Code/Description — да, Ref — нет', () => {
    const xml = fs.readFileSync(BANKS, 'utf-8');
    assert.strictEqual(isInputByStringFieldIndexed(xml, 'Catalog', 'StandardAttribute', 'Description'), true);
    assert.strictEqual(isInputByStringFieldIndexed(xml, 'Catalog', 'StandardAttribute', 'Code'), true);
    assert.strictEqual(isInputByStringFieldIndexed(xml, 'Catalog', 'StandardAttribute', 'Ref'), false);
  });

  test('StandardAttribute у вида без умолчаний индексации (Enum) — нет', () => {
    const xml = fs.readFileSync(BANKS, 'utf-8');
    assert.strictEqual(isInputByStringFieldIndexed(xml, 'Enum', 'StandardAttribute', 'Description'), false);
  });

  test('Attribute: DontIndex — нет, Index — да, отсутствующий — нет', () => {
    const xml = fs.readFileSync(BANKS, 'utf-8');
    assert.ok(xml.includes('<Indexing>DontIndex</Indexing>'), 'фикстура: КоррСчет без индекса');
    assert.strictEqual(isInputByStringFieldIndexed(xml, 'Catalog', 'Attribute', 'КоррСчет'), false);
    const indexed = xml.replace('<Indexing>DontIndex</Indexing>', '<Indexing>Index</Indexing>');
    assert.strictEqual(isInputByStringFieldIndexed(indexed, 'Catalog', 'Attribute', 'КоррСчет'), true);
    assert.strictEqual(isInputByStringFieldIndexed(xml, 'Catalog', 'Attribute', 'НетТакого'), false);
  });

  test('Attribute с пустым <Indexing/> — нет', () => {
    const xml = fs.readFileSync(BANKS, 'utf-8').replace('<Indexing>DontIndex</Indexing>', '<Indexing></Indexing>');
    assert.strictEqual(isInputByStringFieldIndexed(xml, 'Catalog', 'Attribute', 'КоррСчет'), false);
  });

  for (const tag of ['Dimension', 'Resource'] as const) {
    test(`${tag} регистра сведений КурсыВалют: DontIndex — нет, Index — да`, () => {
      const xml = fs.readFileSync(RATES, 'utf-8');
      const name = tag === 'Dimension' ? 'Валюта' : 'Курс';
      assert.strictEqual(isInputByStringFieldIndexed(xml, 'InformationRegister', tag, name), false);
      const start = xml.indexOf(`<${tag} uuid=`);
      const end = xml.indexOf(`</${tag}>`, start);
      const indexed = xml.slice(0, start) + xml.slice(start, end).replace('<Indexing>DontIndex</Indexing>', '<Indexing>Index</Indexing>') + xml.slice(end);
      assert.strictEqual(isInputByStringFieldIndexed(indexed, 'InformationRegister', tag, name), true);
    });
  }
});

suite('PropertiesViewController.getInputByStringFieldOptions (#145)', () => {
  suiteSetup(function () {
    skipWithoutCorpus(this, BANKS);
  });

  test('Catalog Банки: в опциях только индексируемые стандартные реквизиты', () => {
    const controller = new PropertiesViewController(
      new SubsystemXmlService(),
      new ExchangePlanContentService(),
      new TypeRegistryService(),
      new ConfigurationXmlEditor(),
      new BasedOnXmlService(),
      { refreshActiveView: () => undefined, replaceActiveNode: () => undefined }
    );
    controller.setActiveNode(new MetadataNode(
      { label: 'Банки', nodeKind: 'Catalog', xmlPath: BANKS },
      vscode.TreeItemCollapsibleState.None
    ));

    // Приватный метод — тот же приём, что в propertiesViewControllerCharacterization.test.ts.
    const options = (controller as unknown as {
      getInputByStringFieldOptions(): { canonical: string; display: string }[];
    }).getInputByStringFieldOptions();

    assert.deepStrictEqual(
      options.map((item) => item.canonical).sort(),
      ['Catalog.Банки.StandardAttribute.Code', 'Catalog.Банки.StandardAttribute.Description']
    );
  });
});
