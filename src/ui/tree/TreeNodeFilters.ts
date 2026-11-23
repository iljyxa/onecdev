import * as path from 'path';
import * as vscode from 'vscode';
import type { WorkingSetIndex } from '../../infra/repository/WorkingSetIndex';
import { MetadataNode } from './TreeNode';

/**
 * Фильтры видимого дерева навигатора. Оба строят копии узлов с отобранными детьми и
 * сохраняют иерархию до совпавших узлов; исходная модель дерева не меняется.
 */

/** Текстовый поиск: узлы, в подписи которых есть `query` (без учёта регистра), с родителями. */
export function filterTreeBySearch(nodes: readonly MetadataNode[], query: string): MetadataNode[] {
  return filterBySearchText(nodes, normalizeSearchText(query));
}

/**
 * Рабочий набор: изменённые и захваченные единицы с родителями. В ветку объекта
 * фильтр заходит, только если под объектом есть отмеченные единицы, поэтому
 * `childrenLoader` неотмеченных объектов не вызывается. Отмеченный узел без
 * отмеченных потомков остаётся свёрнутым со всеми своими детьми.
 */
export function filterTreeByWorkingSet(nodes: readonly MetadataNode[], index: WorkingSetIndex): MetadataNode[] {
  return filterByWorkingSet(nodes, index, undefined);
}

function filterByWorkingSet(
  nodes: readonly MetadataNode[],
  index: WorkingSetIndex,
  configRoot: string | undefined
): MetadataNode[] {
  const result: MetadataNode[] = [];
  for (const node of nodes) {
    let nodeConfigRoot = configRoot;
    if (node.nodeKind === 'configuration' || node.nodeKind === 'extension') {
      // XML корня — `<корень выгрузки>/Configuration.xml`, задаётся при построении дерева всегда.
      nodeConfigRoot = path.dirname(node.xmlPath ?? '');
      if (!index.hasUnits(nodeConfigRoot)) {
        continue;
      }
    }

    // Выше корней конфигураций (узел «Расширения») единиц нет — только спуск.
    const match = nodeConfigRoot ? index.matchNode(nodeConfigRoot, node.model) : undefined;
    if (match && !match.hasMarkedDescendants) {
      if (match.marked) {
        result.push(cloneTreeNode(node, node.collapsibleState ?? vscode.TreeItemCollapsibleState.None, node.childrenLoader));
      }
      continue;
    }

    const children = node.childrenLoader ? filterByWorkingSet(node.childrenLoader(), index, nodeConfigRoot) : [];
    if (children.length > 0) {
      result.push(cloneTreeNode(node, vscode.TreeItemCollapsibleState.Expanded, () => children));
    } else if (match?.marked) {
      result.push(cloneTreeNode(node, node.collapsibleState ?? vscode.TreeItemCollapsibleState.None, node.childrenLoader));
    }
  }
  return result;
}

function filterBySearchText(nodes: readonly MetadataNode[], normalizedQuery: string): MetadataNode[] {
  const result: MetadataNode[] = [];

  for (const node of nodes) {
    const nodeMatches = normalizeSearchText(node.textLabel).includes(normalizedQuery);
    if (nodeMatches && node.xmlPath) {
      result.push(cloneTreeNode(node, vscode.TreeItemCollapsibleState.None));
      continue;
    }

    const children = node.childrenLoader ? filterBySearchText(node.childrenLoader(), normalizedQuery) : [];
    if (children.length > 0) {
      result.push(cloneTreeNode(
        node,
        vscode.TreeItemCollapsibleState.Expanded,
        () => children
      ));
      continue;
    }

    if (nodeMatches) {
      result.push(cloneTreeNode(
        node,
        node.collapsibleState ?? vscode.TreeItemCollapsibleState.None
      ));
    }
  }

  return result;
}

function cloneTreeNode(
  node: MetadataNode,
  collapsibleState: vscode.TreeItemCollapsibleState,
  childrenLoader?: () => MetadataNode[]
): MetadataNode {
  const clone = new MetadataNode({
    ...node.model,
    childrenLoader,
  }, collapsibleState);

  clone.command = node.command;
  clone.tooltip = node.tooltip;
  clone.resourceUri = node.resourceUri;
  return clone;
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase('ru-RU');
}
