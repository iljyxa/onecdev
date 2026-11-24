import * as path from 'path';
import { getObjectLocationFromXml } from '../../../infra/fs/ObjectLocation';
import { pathKey } from '../../../infra/fs/PathKey';
import type { MetadataNode } from '../../tree/TreeNode';

export function isRemovedNode(activeNode: MetadataNode, removedNode: MetadataNode): boolean {
  if (activeNode === removedNode) {
    return true;
  }

  if (isSameTreeNode(activeNode, removedNode)) {
    return true;
  }

  if (removedNode.metaContext) {
    return isSameRemovedChild(activeNode, removedNode);
  }

  const removedXmlPath = removedNode.xmlPath;
  if (!removedXmlPath) {
    return false;
  }

  const activeXmlPath = activeNode.metaContext?.ownerObjectXmlPath ?? activeNode.xmlPath;
  if (!activeXmlPath) {
    return false;
  }

  // Некоторые дочерние узлы читают свойства непосредственно из XML владельца.
  if (pathKey(activeXmlPath) === pathKey(removedXmlPath)) {
    return true;
  }
  const removedObjectDir = getObjectLocationFromXml(removedXmlPath).objectDir;
  return isInsidePath(activeXmlPath, removedObjectDir);
}

function isSameTreeNode(left: MetadataNode, right: MetadataNode): boolean {
  return left.nodeKind === right.nodeKind
    && left.textLabel === right.textLabel
    && left.xmlPath === right.xmlPath
    && left.metaContext?.ownerObjectXmlPath === right.metaContext?.ownerObjectXmlPath
    && left.metaContext?.tabularSectionName === right.metaContext?.tabularSectionName;
}

function isSameRemovedChild(activeNode: MetadataNode, removedNode: MetadataNode): boolean {
  return activeNode.nodeKind === removedNode.nodeKind
    && activeNode.textLabel === removedNode.textLabel
    && activeNode.metaContext?.ownerObjectXmlPath === removedNode.metaContext?.ownerObjectXmlPath
    && activeNode.metaContext?.tabularSectionName === removedNode.metaContext?.tabularSectionName;
}

function isInsidePath(childPath: string, parentPath: string): boolean {
  const child = pathKey(childPath);
  const parent = pathKey(parentPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}
