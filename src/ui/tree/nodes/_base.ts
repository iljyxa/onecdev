import type * as vscode from 'vscode';
import type { MetadataGitDecorationTarget } from '../../../infra/git/GitMetadataStatusService';
import { type AddMetadataTarget, type MetaTreeNodeContext, MetadataNode, type NodeKind } from '../TreeNode';
import type { CommandId, NodeDescriptor } from './_types';

/** Параметры создания узла с применением дескриптора */
export interface BuildNodeParams {
  label: string;
  kind: NodeKind;
  collapsibleState: vscode.TreeItemCollapsibleState;
  xmlPath?: string;
  decorationPath?: string;
  gitDecorationTarget?: MetadataGitDecorationTarget;
  childrenLoader?: () => MetadataNode[];
  ownershipTag?: 'OWN' | 'BORROWED';
  hidePropertiesCommand?: boolean;
  /** Контекст для свойств дочерних узлов иерархии объекта метаданных */
  metaContext?: MetaTreeNodeContext;
  addMetadataTarget?: AddMetadataTarget;
  canRemoveMetadata?: boolean;
  singleClickCommand?: CommandId;
}

/**
 * Создаёт `MetadataNode` и применяет к нему настройки из `NodeDescriptor`
 * (команда по клику и т.п.).
 */
export function buildNode(descriptor: NodeDescriptor | undefined, params: BuildNodeParams): MetadataNode {
  const node = new MetadataNode({
    label: params.label,
    nodeKind: params.kind,
    xmlPath: params.xmlPath,
    decorationPath: params.decorationPath,
    gitDecorationTarget: params.gitDecorationTarget,
    childrenLoader: params.childrenLoader,
    ownershipTag: params.ownershipTag,
    hidePropertiesCommand: params.hidePropertiesCommand,
    metaContext: params.metaContext,
    addMetadataTarget: params.addMetadataTarget,
    canRemoveMetadata: params.canRemoveMetadata,
  }, params.collapsibleState);

  const singleClickCommand = params.singleClickCommand ?? descriptor?.singleClickCommand;
  if (singleClickCommand) {
    node.command = mapCommand(singleClickCommand, node);
  }

  return node;
}

/** Преобразует логический идентификатор команды в `vscode.Command` */
function mapCommand(commandId: CommandId, node: MetadataNode): vscode.Command {
  switch (commandId) {
    case 'openObjectModule':
      return {
        command: 'onecdev.openObjectModule',
        title: 'Открыть модуль объекта',
        arguments: [node],
      };
    case 'openManagerModule':
      return {
        command: 'onecdev.openManagerModule',
        title: 'Открыть модуль менеджера',
        arguments: [node],
      };
    case 'openConstantModule':
      return {
        command: 'onecdev.openConstantModule',
        title: 'Открыть модуль константы',
        arguments: [node],
      };
    case 'openFormModule':
      return {
        command: 'onecdev.openFormModule',
        title: 'Открыть модуль формы',
        arguments: [node],
      };
    case 'openCommandModule':
      return {
        command: 'onecdev.openCommandModule',
        title: 'Открыть модуль команды',
        arguments: [node],
      };
    case 'openServiceModule':
      return {
        command: 'onecdev.openServiceModule',
        title: 'Открыть модуль сервиса',
        arguments: [node],
      };
    case 'openCommonModuleCode':
      return {
        command: 'onecdev.openCommonModuleCode',
        title: 'Открыть модуль общего модуля',
        arguments: [node],
      };
    case 'openTemplateContent':
      return {
        command: 'onecdev.openTemplateContent',
        title: 'Открыть макет',
        arguments: [node],
      };
    default: {
      // Защита от несовпадений перечисления и реализации
      return {
        command: 'onecdev.openXmlFile',
        title: 'Открыть XML',
        arguments: [node],
      };
    }
  }
}
