import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BasedOnXmlService } from '../../infra/xml/BasedOnXmlService';
import { ConfigurationXmlEditor } from '../../infra/xml/ConfigurationXmlEditor';
import { ExchangePlanContentService } from '../../infra/xml/ExchangePlanContentService';
import { SubsystemXmlService } from '../../infra/xml/SubsystemXmlService';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { PropertiesViewController } from '../../ui/views/properties/PropertiesViewController';
import { TypeRegistryService } from '../../ui/views/properties/TypeRegistryService';
import { EXAMPLE_GENERATIONS, skipWithoutCorpus } from './support/corpus';

suite('Поиск и пояснения в панели свойств (#207)', () => {
  const cf = EXAMPLE_GENERATIONS.cf21;
  const cfe = EXAMPLE_GENERATIONS.cfe21;
  const name = 'Номенклатура';
  const cfCatalog = path.join(cf, 'Catalogs', name + '.xml');
  const cfeCatalog = path.join(cfe, 'Catalogs', name + '.xml');

  function getState(node: MetadataNode) {
    const controller = new PropertiesViewController(
      new SubsystemXmlService(),
      new ExchangePlanContentService(),
      new TypeRegistryService(),
      new ConfigurationXmlEditor(),
      new BasedOnXmlService(),
      { refreshActiveView: () => undefined, replaceActiveNode: () => undefined },
    );
    controller.setActiveNode(node);
    const state = controller.getViewState({ includeAuxiliaryBlocks: false });
    assert.ok(state);
    return state;
  }

  test('отдаёт те же свойства CF и CFE по алфавиту, сохраняя контрол выбора формы', function () {
    skipWithoutCorpus(this, cfCatalog, cfeCatalog);
    for (const xmlPath of [cfCatalog, cfeCatalog]) {
      const node = new MetadataNode({ label: name, nodeKind: 'Catalog', xmlPath }, vscode.TreeItemCollapsibleState.None);
      const { title, sections, alphabeticalControls } = getState(node);
      assert.equal(title, 'Номенклатура — Справочник');
      const grouped = sections.flatMap((section) => section.controls);
      assert.ok(grouped.length > 20);
      assert.equal(alphabeticalControls.length, grouped.length);
      assert.deepEqual(new Set(alphabeticalControls), new Set(grouped));
      assert.deepEqual(alphabeticalControls.map(({ label }) => label),
        grouped.map(({ label }) => label).sort((a, b) => a.localeCompare(b, 'ru')));
      assert.equal(alphabeticalControls.find(({ id }) => id === 'DefaultFolderForm')?.formPicker, true);
      assert.equal(alphabeticalControls.find(({ id }) => id === 'Comment')?.formPicker, undefined);
    }
  });

  test('отличает пустой тег в XML, заимствованное значение и значение расширения', function () {
    skipWithoutCorpus(this, cfCatalog, cfeCatalog);
    const own = new MetadataNode({ label: name, nodeKind: 'Catalog', xmlPath: cfCatalog },
      vscode.TreeItemCollapsibleState.None);
    const borrowed = new MetadataNode({ label: name, nodeKind: 'Catalog', xmlPath: cfeCatalog, ownershipTag: 'BORROWED' },
      vscode.TreeItemCollapsibleState.None);
    const ownControls = getState(own).alphabeticalControls;
    const borrowedControls = getState(borrowed).alphabeticalControls;
    assert.match(ownControls.find(({ id }) => id === 'Comment')?.hint ?? '', /Значение записано в XML/);
    assert.match(borrowedControls.find(({ id }) => id === 'Hierarchical')?.hint ?? '', /Унаследовано из основной конфигурации/);
    assert.match(borrowedControls.find(({ id }) => id === 'ObjectBelonging')?.hint ?? '', /Собственное значение расширения/);
    assert.match(ownControls.find(({ id }) => id === 'BasedFor')?.hint ?? '', /Список объектов/);
  });

  test('различает собственное, унаследованное и достроенное значения без внешнего корпуса', () => {
    const label = 'АвансовыйОтчетПрисоединенныеФайлы';
    const fixture = path.resolve(__dirname, '../../..', 'src/test/fixtures/borrowed-object/2.21/Catalogs', label + '.xml');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-property-hints-'));
    try {
      const base = path.join(temp, 'cf');
      const extension = path.join(temp, 'cfe', 'EVOLC');
      const xmlPath = path.join(extension, 'Catalogs', label + '.xml');
      fs.mkdirSync(path.join(base, 'Catalogs'), { recursive: true });
      fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
      fs.writeFileSync(path.join(base, 'Configuration.xml'), '<Configuration/>');
      fs.writeFileSync(path.join(base, 'Catalogs', label + '.xml'),
        `<MetaDataObject><Catalog><Properties><Name>${label}</Name><Hierarchical>true</Hierarchical></Properties></Catalog></MetaDataObject>`);
      fs.copyFileSync(fixture, xmlPath);

      const node = new MetadataNode({ label, nodeKind: 'Catalog', xmlPath, ownershipTag: 'BORROWED' },
        vscode.TreeItemCollapsibleState.None);
      const { alphabeticalControls } = getState(node);
      assert.match(alphabeticalControls.find(({ id }) => id === 'Hierarchical')?.hint ?? '', /Унаследовано из основной конфигурации/);
      assert.match(alphabeticalControls.find(({ id }) => id === 'DefaultFolderForm')?.hint ?? '', /значение по умолчанию/);
      assert.match(alphabeticalControls.find(({ id }) => id === 'ObjectBelonging')?.hint ?? '', /Собственное значение расширения/);
      assert.match(alphabeticalControls.find(({ id }) => id === 'BasedFor')?.hint ?? '', /Список объектов/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  test('показывает источник у свойств, которые читаются специализированными обработчиками', function () {
    const cases = [
      ['CommonModule', 'CommonModules', 'ОбщегоНазначения', 'Global', 'Значение записано в XML'],
      ['SessionParameter', 'SessionParameters', 'ТекущаяОрганизация', 'Type', 'Значение записано в XML'],
      ['EventSubscription', 'EventSubscriptions', 'ПриЗаписиКонтрагента', 'Source', 'Значение записано в XML'],
      ['Role', 'Roles', 'Администратор', 'setForNewObjects', 'Значение записано в XML'],
      ['Subsystem', 'Subsystems', 'Продажи', 'IncludeHelpInContents', 'Значение записано в XML'],
      ['Subsystem', 'Subsystems', 'Продажи', 'PictureLoadTransparent', 'значение по умолчанию'],
    ] as const;
    skipWithoutCorpus(this, ...cases.map(([, folder, label]) => path.join(cf, folder, label + '.xml')));
    for (const [nodeKind, folder, label, property, hint] of cases) {
      const xmlPath = path.join(cf, folder, label + '.xml');
      const state = getState(new MetadataNode({ label, nodeKind, xmlPath }, vscode.TreeItemCollapsibleState.None));
      assert.ok(state.alphabeticalControls.find(({ id }) => id === property)?.hint?.includes(hint), label + ' / ' + property);
    }
  });

  test('учитывает вложенные теги картинки и отсутствие флагов в пустом файле прав', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-special-property-hints-'));
    try {
      const subsystemPath = path.join(temp, 'Продажи.xml');
      fs.writeFileSync(subsystemPath, [
        '<MetaDataObject xmlns:xr="http://v8.1c.ru/8.3/xcf/readable"><Subsystem><Properties>',
        '<Name>Продажи</Name><Picture><xr:Ref>CommonPicture.Продажи</xr:Ref>',
        '<xr:LoadTransparent>true</xr:LoadTransparent></Picture>',
        '</Properties></Subsystem></MetaDataObject>',
      ].join(''));
      const subsystem = getState(new MetadataNode({ label: 'Продажи', nodeKind: 'Subsystem', xmlPath: subsystemPath },
        vscode.TreeItemCollapsibleState.None));
      for (const key of ['PictureRef', 'PictureLoadTransparent']) {
        assert.match(subsystem.alphabeticalControls.find(({ id }) => id === key)?.hint ?? '', /Значение записано в XML/);
      }

      const rolePath = path.join(temp, 'Продавец.xml');
      fs.writeFileSync(rolePath, '<MetaDataObject><Role><Properties><Name>Продавец</Name></Properties></Role></MetaDataObject>');
      const rightsDirectory = path.join(temp, 'Продавец', 'Ext');
      fs.mkdirSync(rightsDirectory, { recursive: true });
      fs.writeFileSync(path.join(rightsDirectory, 'Rights.xml'), '<Rights/>');
      const role = getState(new MetadataNode({ label: 'Продавец', nodeKind: 'Role', xmlPath: rolePath },
        vscode.TreeItemCollapsibleState.None));
      assert.match(role.alphabeticalControls.find(({ id }) => id === 'setForNewObjects')?.hint ?? '', /значение по умолчанию/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  test('использует виды метаданных в заголовках корней CF и CFE', function () {
    skipWithoutCorpus(this, path.join(cf, 'Configuration.xml'), path.join(cfe, 'Configuration.xml'));
    for (const [directory, nodeKind, label, kindLabel] of [
      [cf, 'configuration', 'Управление торговлей', 'Конфигурация'],
      [cfe, 'extension', 'EVOLC', 'Расширение'],
    ] as const) {
      const xmlPath = path.join(directory, 'Configuration.xml');
      const state = getState(new MetadataNode({ label, nodeKind, xmlPath }, vscode.TreeItemCollapsibleState.None));
      assert.equal(state.title, label + ' — ' + kindLabel);
      assert.match(state.alphabeticalControls.find(({ id }) => id === 'Name')?.hint ?? '', /Значение записано в XML/);
    }
  });
});
