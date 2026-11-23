import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import { MetadataNode } from '../../ui/tree/TreeNode';
import type { NodeKind } from '../../ui/tree/TreeNodeModel';
import { getObjectHandler } from '../../ui/tree/nodeBuilders';
import { UniversalPanelViewProvider } from '../../ui/views/universal/UniversalPanelViewProvider';

/**
 * Issue #188: в меню объекта метаданных самые частые действия — открыть модуль — идут первыми,
 * а справочные «Структура / Валидировать» (вместе с видовыми info/validate) и «Свойства» — последними.
 * Остальные действия сохраняют взаимный порядок. Меню корня конфигурации этим порядком не затрагивается.
 * Меню строит приватный `getNodeActions`; узлы — над настоящими XML из `example/2.21/src/cf`.
 * Доступ к приватному методу — через приведение типа: публичный путь (`resolveWebviewView`) требует
 * собранного webview и не даёт подставить узел с нужным контекстом.
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

function actionsOf(node: MetadataNode): string[] {
  return createProvider().getNodeActions(node).map((action) => action.command);
}

function menu(nodeKind: NodeKind, relXml: string, contextValue: string): string[] {
  const node = new MetadataNode(
    { label: path.basename(relXml, '.xml'), nodeKind, xmlPath: path.join(CF_ROOT, relXml) },
    vscode.TreeItemCollapsibleState.None
  );
  node.contextValue = contextValue;
  return actionsOf(node);
}

/** Дочерние узлы справочника, собранные настоящим строителем дерева (контекст и команда клика — как в панели). */
function catalogChildren(): MetadataNode[] {
  const handler = getObjectHandler('Catalog');
  assert.ok(handler, 'нет строителя узлов справочника');
  const [catalog] = handler.buildTreeNodes({ configRoot: CF_ROOT, configKind: 'cf', namePrefix: '', names: ['Контрагенты'] });
  return (catalog.childrenLoader?.() ?? []).flatMap((group) => [group, ...(group.childrenLoader?.() ?? [])]);
}

function childOfKind(nodeKind: NodeKind): MetadataNode {
  const found = catalogChildren().find((child) => child.nodeKind === nodeKind);
  assert.ok(found, `у справочника Контрагенты нет дочернего узла ${nodeKind}`);
  return found;
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

  test('объект со скрытыми «Свойствами»: справочная группа последней, «Свойства» нет', () => {
    const node = new MetadataNode(
      { label: 'Контрагенты', nodeKind: 'Catalog', xmlPath: path.join(CF_ROOT, 'Catalogs/Контрагенты.xml'), hidePropertiesCommand: true },
      vscode.TreeItemCollapsibleState.None
    );
    node.contextValue = 'Catalog-hasXml';
    assert.deepStrictEqual(actionsOf(node), [
      'onecdev.openObjectModule',
      'onecdev.openManagerModule',
      'onecdev.help.add',
      'onecdev.form.add',
      'onecdev.openXmlFile',
      'onecdev.metadata.info',
      'onecdev.metadata.validate',
    ]);
  });

  test('реквизит справочника: справочная группа и «Свойства» в конце', () => {
    assert.deepStrictEqual(actionsOf(childOfKind('Attribute')), [
      'onecdev.help.add',
      'onecdev.openXmlFile',
      'onecdev.metadata.info',
      'onecdev.metadata.validate',
      'onecdev.showProperties',
    ]);
  });

  test('форма справочника: модуль формы (команда клика) первым', () => {
    assert.deepStrictEqual(actionsOf(childOfKind('Form')), [
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

  test('макет справочника: MXL/СКД перед «Свойства»', () => {
    assert.deepStrictEqual(actionsOf(childOfKind('Template')), [
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

  test('команда справочника: модуль команды (команда клика) первым', () => {
    assert.deepStrictEqual(actionsOf(childOfKind('Command')), [
      'onecdev.openCommandModule',
      'onecdev.help.add',
      'onecdev.openXmlFile',
      'onecdev.metadata.info',
      'onecdev.metadata.validate',
      'onecdev.showProperties',
    ]);
  });

  test('группа без XML: ни модулей, ни справочной группы, ни «Свойства»', () => {
    assert.deepStrictEqual(actionsOf(childOfKind('group-type')), []);
  });

  test('корень конфигурации — порядок прежний: «Свойства» сразу за «Открыть XML», до команд хранилища', () => {
    assert.deepStrictEqual(menu('configuration', 'Configuration.xml', 'configuration-hasXml-repoConnected'), [
      'onecdev.configuration.info',
      'onecdev.configuration.validate',
      'onecdev.showConfigActions',
      'onecdev.importConfigurationFromDb',
      'onecdev.updateConfigurationInDb',
      'onecdev.dumpConfigurationToCf',
      'onecdev.loadConfigurationFromCf',
      'onecdev.openXmlFile',
      'onecdev.showProperties',
      'onecdev.repository.create',
      'onecdev.repository.refreshLocks',
      'onecdev.repository.history',
      'onecdev.repository.disconnect',
      'onecdev.repository.addUser',
      'onecdev.repository.copyUsers',
      'onecdev.repository.dump',
      'onecdev.repository.report',
      'onecdev.repository.setLabel',
      'onecdev.repository.commit',
      'onecdev.repository.update',
      'onecdev.repository.updateToVersion',
    ]);
  });
});
