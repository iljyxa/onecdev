import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import { MetadataNode } from '../../ui/tree/TreeNode';
import type { NodeKind } from '../../ui/tree/TreeNodeModel';
import { UniversalPanelViewProvider } from '../../ui/views/universal/UniversalPanelViewProvider';

/**
 * Issue #188: в меню объекта метаданных самые частые действия — открыть модуль — идут первыми,
 * а справочные «Структура / Валидировать» (вместе с видовыми info/validate) и «Свойства» — последними.
 * Остальные действия сохраняют взаимный порядок. Меню корня конфигурации этим порядком не затрагивается.
 * Меню строит приватный `getNodeActions`; узлы — над настоящими XML из `example/2.21/src/cf`.
 */

const EXTENSION_ROOT = path.resolve(__dirname, '../../../');
const CF_ROOT = path.join(EXTENSION_ROOT, 'example', '2.21', 'src', 'cf');

type UniversalServices = ConstructorParameters<typeof UniversalPanelViewProvider>[1];

interface NodeActionsApi {
  getNodeActions(node: MetadataNode): readonly { command: string }[];
}

function createProvider(): NodeActionsApi {
  const services = {
    state: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] },
    treeProvider: new MetadataTreeProvider([], vscode.Uri.file(EXTENSION_ROOT), EXTENSION_ROOT),
    setTreeMessage: () => undefined,
    isProjectInitialized: () => true,
    refreshActionsView: () => undefined,
  } as unknown as UniversalServices;
  return new UniversalPanelViewProvider(vscode.Uri.file(EXTENSION_ROOT), services) as unknown as NodeActionsApi;
}

function menu(nodeKind: NodeKind, relXml: string, contextValue: string): string[] {
  const node = new MetadataNode(
    { label: path.basename(relXml, '.xml'), nodeKind, xmlPath: path.join(CF_ROOT, relXml) },
    vscode.TreeItemCollapsibleState.None
  );
  node.contextValue = contextValue;
  return createProvider().getNodeActions(node).map((action) => action.command);
}

suite('UniversalPanelViewProvider — порядок меню объекта метаданных (issue #188)', () => {
  test('справочник в хранилище: модули сверху, хранилище посередине, «Структура/Валидировать/Свойства» в конце', () => {
    assert.deepStrictEqual(menu('Catalog', 'Catalogs/Контрагенты.xml', 'Catalog-hasXml-repoConnected-repoUnlocked'), [
      'onecdev.openObjectModule',
      'onecdev.openManagerModule',
      'onecdev.help.add',
      'onecdev.form.add',
      'onecdev.openXmlFile',
      'onecdev.repository.lock',
      'onecdev.repository.commit',
      'onecdev.repository.update',
      'onecdev.repository.updateToVersion',
      'onecdev.repository.objectHistory',
      'onecdev.metadata.info',
      'onecdev.metadata.validate',
      'onecdev.showProperties',
    ]);
  });

  test('регистр сведений: слоты модулей в порядке META_TYPES.modules', () => {
    assert.deepStrictEqual(menu('InformationRegister', 'InformationRegisters/КурсыВалют.xml', 'InformationRegister-hasXml'), [
      'onecdev.openManagerModule',
      'onecdev.openRecordSetModule',
      'onecdev.help.add',
      'onecdev.form.add',
      'onecdev.openXmlFile',
      'onecdev.metadata.info',
      'onecdev.metadata.validate',
      'onecdev.showProperties',
    ]);
  });

  test('константа: модуль константы первым', () => {
    assert.deepStrictEqual(menu('Constant', 'Constants/ИспользоватьВозвраты.xml', 'Constant-hasXml'), [
      'onecdev.openConstantModule',
      'onecdev.help.add',
      'onecdev.openXmlFile',
      'onecdev.metadata.info',
      'onecdev.metadata.validate',
      'onecdev.showProperties',
    ]);
  });

  test('общий модуль: «Открыть модуль» первым', () => {
    assert.deepStrictEqual(menu('CommonModule', 'CommonModules/GoogleПереводчик.xml', 'CommonModule-hasXml'), [
      'onecdev.openCommonModuleCode',
      'onecdev.help.add',
      'onecdev.openXmlFile',
      'onecdev.metadata.info',
      'onecdev.metadata.validate',
      'onecdev.showProperties',
    ]);
  });

  test('роль: видовые «Права роли / Валидировать роль» — в конечной группе перед «Свойства»', () => {
    assert.deepStrictEqual(menu('Role', 'Roles/Администратор.xml', 'Role-hasXml'), [
      'onecdev.openXmlFile',
      'onecdev.metadata.info',
      'onecdev.metadata.validate',
      'onecdev.role.info',
      'onecdev.role.validate',
      'onecdev.showProperties',
    ]);
  });

  test('подсистема: информация и обе валидации — в конечной группе перед «Свойства»', () => {
    assert.deepStrictEqual(menu('Subsystem', 'Subsystems/Закупки.xml', 'Subsystem-hasXml'), [
      'onecdev.help.add',
      'onecdev.openXmlFile',
      'onecdev.metadata.info',
      'onecdev.metadata.validate',
      'onecdev.subsystem.info',
      'onecdev.subsystem.validate',
      'onecdev.interface.validate',
      'onecdev.showProperties',
    ]);
  });

  test('общий макет: MXL/СКД — в конечной группе перед «Свойства»', () => {
    assert.deepStrictEqual(menu('CommonTemplate', 'CommonTemplates/Макет.xml', 'CommonTemplate-hasXml'), [
      'onecdev.openXmlFile',
      'onecdev.metadata.info',
      'onecdev.metadata.validate',
      'onecdev.mxl.info',
      'onecdev.mxl.validate',
      'onecdev.skd.info',
      'onecdev.skd.validate',
      'onecdev.showProperties',
    ]);
  });

  test('общая форма: модуль формы первым, «Форма: структура/валидировать» — перед «Свойства»', () => {
    assert.deepStrictEqual(menu('CommonForm', 'CommonForms/АЛКОВводРеквизитовОП.xml', 'CommonForm-hasXml'), [
      'onecdev.openFormModule',
      'onecdev.help.add',
      'onecdev.openXmlFile',
      'onecdev.metadata.info',
      'onecdev.metadata.validate',
      'onecdev.form.info',
      'onecdev.form.validate',
      'onecdev.showProperties',
    ]);
  });

  test('корень конфигурации — порядок прежний: «Свойства» перед командами хранилища', () => {
    const commands = menu('configuration', 'Configuration.xml', 'configuration-hasXml-repoConnected');
    assert.strictEqual(commands[0], 'onecdev.configuration.info', commands.join(', '));
    assert.ok(commands.indexOf('onecdev.showProperties') < commands.indexOf('onecdev.repository.commit'), commands.join(', '));
    assert.ok(!commands.includes('onecdev.metadata.info'), commands.join(', '));
  });
});
