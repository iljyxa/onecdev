import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataNode } from '../../ui/tree/TreeNode';
import type { NodeKind } from '../../ui/tree/TreeNodeModel';
import { getObjectHandler } from '../../ui/tree/nodeBuilders';
import { buildNodeMenu } from '../../ui/views/universal/nodeContextMenu';
import { flattenMenu } from './support/universalPanelHarness';

/**
 * Issue #188: в меню объекта метаданных самые частые действия — открыть модуль — идут первыми,
 * а справочные «Структура / Валидировать» (вместе с видовыми info/validate) и «Свойства» — последними.
 * Остальные действия сохраняют взаимный порядок. Меню корня конфигурации этим порядком не затрагивается.
 * Проверяется порядок листьев меню с учётом групп и подменю.
 */

const EXTENSION_ROOT = path.resolve(__dirname, '../../../');
const CF_ROOT = path.join(EXTENSION_ROOT, 'example', '2.21', 'src', 'cf');

function actionsOf(node: MetadataNode): string[] {
  return flattenMenu(buildNodeMenu(node, { getEntries: () => [] })).map((action) => action.command);
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

suite('Навигатор — порядок меню объекта метаданных (issue #188)', () => {
  test('справочник в хранилище: модули сверху, хранилище посередине, «Структура/Валидировать/Свойства» в конце', () => {
    assert.deepStrictEqual(menu('Catalog', 'Catalogs/Контрагенты.xml', 'Catalog-hasXml-repoConnected-repoUnlocked'), [
      'onecdev.openObjectModule',
      'onecdev.openManagerModule',
      'onecdev.openXmlFile',
      'onecdev.form.add',
      'onecdev.help.add',
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
      'onecdev.openXmlFile',
      'onecdev.form.add',
      'onecdev.help.add',
      'onecdev.metadata.info',
      'onecdev.metadata.validate',
      'onecdev.showProperties',
    ]);
  });

  test('константа: модуль константы первым', () => {
    assert.deepStrictEqual(menu('Constant', 'Constants/ИспользоватьВозвраты.xml', 'Constant-hasXml'), [
      'onecdev.openConstantModule',
      'onecdev.openXmlFile',
      'onecdev.help.add',
      'onecdev.metadata.info',
      'onecdev.metadata.validate',
      'onecdev.showProperties',
    ]);
  });

  test('общий модуль: «Открыть модуль» первым', () => {
    assert.deepStrictEqual(menu('CommonModule', 'CommonModules/GoogleПереводчик.xml', 'CommonModule-hasXml'), [
      'onecdev.openCommonModuleCode',
      'onecdev.openXmlFile',
      'onecdev.help.add',
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
      'onecdev.openXmlFile',
      'onecdev.help.add',
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
      'onecdev.openXmlFile',
      'onecdev.help.add',
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
      'onecdev.openXmlFile',
      'onecdev.form.add',
      'onecdev.help.add',
      'onecdev.metadata.info',
      'onecdev.metadata.validate',
    ]);
  });

  test('реквизит справочника: справочная группа и «Свойства» в конце', () => {
    assert.deepStrictEqual(actionsOf(childOfKind('Attribute')), [
      'onecdev.openXmlFile',
      'onecdev.help.add',
      'onecdev.metadata.info',
      'onecdev.metadata.validate',
      'onecdev.showProperties',
    ]);
  });

  test('форма справочника: модуль формы (команда клика) первым', () => {
    assert.deepStrictEqual(actionsOf(childOfKind('Form')), [
      'onecdev.openFormModule',
      'onecdev.openXmlFile',
      'onecdev.help.add',
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
      'onecdev.openXmlFile',
      'onecdev.help.add',
      'onecdev.metadata.info',
      'onecdev.metadata.validate',
      'onecdev.showProperties',
    ]);
  });

  test('группа без XML: ни модулей, ни справочной группы, ни «Свойства»', () => {
    assert.deepStrictEqual(actionsOf(childOfKind('group-type')), []);
  });

});
