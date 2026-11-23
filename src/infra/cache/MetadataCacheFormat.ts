import * as path from 'path';
import { CHILD_TAG_CONFIG, type ChildTag } from '../../domain/ChildTag';
import type { ConfigEntry } from '../../domain/Configuration';
import { getMetaFolder, getMetaType, type MetaKind } from '../../domain/MetaTypes';
import { getObjectLocationFromXml } from '../fs/ObjectLocation';
import type { MetadataCacheNode, MetadataCacheSingleClickAction } from './MetadataCache';

/** Исходные данные узла. Наличие каталога рядом с плоским XML фиксируем при обходе ФС. */
export interface CompactNode {
  type: MetaKind;
  name: string;
  label?: string;
  xml?: string;
  directory?: boolean;
  tooltip?: string;
  ownershipTag?: MetadataCacheNode['ownershipTag'];
  removable?: boolean;
  action?: MetadataCacheSingleClickAction;
  prefix?: string;
  children?: CompactNode[];
}

interface Owner {
  type: MetaKind;
  xmlPath: string;
}

export function relativeCachePath(root: string, xml: string): string {
  return path.relative(root, xml).split(path.sep).join('/');
}

export function packNode(node: MetadataCacheNode, rootPath: string): CompactNode {
  const { type, name, label, xmlPath, metaContext, addMetadataTarget } = node;
  const isObject = xmlPath && !metaContext && type !== 'configuration' && type !== 'extension';
  return {
    type, name, label: label === name || type === 'group-type' ? undefined : label,
    xml: xmlPath && (isObject || (metaContext && xmlPath !== metaContext.ownerObjectXmlPath))
      ? relativeCachePath(rootPath, xmlPath) : undefined,
    directory: isObject && node.decorationPath !== xmlPath ? true : undefined,
    removable: isObject && node.canRemoveMetadata ? true : undefined,
    prefix: addMetadataTarget?.kind === 'root' ? addMetadataTarget.namePrefix : undefined,
    tooltip: node.tooltip, ownershipTag: node.ownershipTag, action: node.singleClickAction,
    children: node.children.length ? node.children.map(child => packNode(child, rootPath)) : undefined,
  };
}

/** Общий конструктор для обхода XML и чтения снимка. Использует только сохранённые факты. */
export function restoreNode(data: CompactNode, entry: ConfigEntry, owner?: Owner, parentName?: string): MetadataCacheNode {
  const { type, name } = data;
  const node: MetadataCacheNode = {
    type, name, label: data.label ?? name, tooltip: data.tooltip,
    singleClickAction: data.action, ownershipTag: data.ownershipTag, children: [],
  };
  if (type === 'configuration' || type === 'extension') {
    node.xmlPath = path.join(entry.rootPath, 'Configuration.xml');
    node.decorationPath = entry.rootPath;
  } else if (type === 'group-common') {
    node.decorationPath = entry.rootPath;
    node.hidePropertiesCommand = true;
  } else if (owner && type !== 'Subsystem') {
    restoreChild(node, data, entry, owner, parentName);
  } else if (data.xml) {
    const xmlPath = path.join(entry.rootPath, data.xml);
    const objectDir = getObjectLocationFromXml(xmlPath).objectDir;
    owner = { type, xmlPath };
    node.xmlPath = xmlPath;
    node.decorationPath = data.directory ? objectDir : xmlPath;
    if (data.directory && path.dirname(xmlPath) !== objectDir) {
      node.gitDecorationTarget = { kind: 'paths', ownerXmlPath: xmlPath, childKind: type, paths: [xmlPath, objectDir] };
    }
    if (data.removable) {
      node.canRemoveMetadata = true;
    }
    const def = getMetaType(type);
    if (def.flatChildren && def.childTags?.length === 1) {
      node.addMetadataTarget = { kind: 'child', ownerObjectXmlPath: xmlPath, childTag: def.childTags[0] };
    }
  } else {
    const targetKind = type === 'NumeratorsBranch' ? 'DocumentNumerator' : type === 'SequencesBranch' ? 'Sequence' : type;
    if (targetKind !== type) {
      node.hidePropertiesCommand = true;
    }
    const folder = getMetaFolder(targetKind);
    if (folder) {
      node.decorationPath = path.join(entry.rootPath, folder);
      node.addMetadataTarget = { kind: 'root', targetKind, configRoot: entry.rootPath, configKind: entry.kind, namePrefix: data.prefix };
    }
  }
  node.children = data.children?.map(child => restoreNode(child, entry, owner, name)) ?? [];
  return node;
}

function restoreChild(node: MetadataCacheNode, data: CompactNode, entry: ConfigEntry, owner: Owner, parentName?: string): void {
  const objectXmlPath = owner.xmlPath;
  if (node.type === 'group-type') {
    const tag = node.name as ChildTag;
    node.label = CHILD_TAG_CONFIG[tag].label;
    node.hidePropertiesCommand = true;
    const folder = externalChildFolder(tag);
    node.gitDecorationTarget = !folder
      ? { kind: 'group', ownerXmlPath: objectXmlPath, childKind: tag }
      : { kind: 'paths', ownerXmlPath: objectXmlPath, childKind: tag, paths: [path.join(getObjectLocationFromXml(objectXmlPath).objectDir, folder)] };
    if (tag !== 'StandardAttribute') {
      node.addMetadataTarget = { kind: 'child', ownerObjectXmlPath: objectXmlPath, childTag: tag };
    }
    return;
  }
  const tag = node.type as ChildTag | 'Column';
  node.xmlPath = data.xml ? path.join(entry.rootPath, data.xml) : objectXmlPath;
  const context = { rootMetaKind: owner.type, ownerObjectXmlPath: objectXmlPath };
  const target = { ownerXmlPath: objectXmlPath, childKind: tag, name: node.name };
  node.metaContext = context;
  const folder = externalChildFolder(tag);
  node.gitDecorationTarget = !folder
    ? { kind: 'child', ...target }
    : { kind: 'paths', ...target, paths: externalChildPaths(objectXmlPath, folder, node.name) };
  node.canRemoveMetadata = tag !== 'StandardAttribute';
  if (tag === 'StandardAttribute') {
    node.metaContext.standardAttributeName = node.name;
  }
  if (tag === 'Column') {
    node.metaContext.tabularSectionName = parentName;
    node.gitDecorationTarget.tabularSectionName = parentName;
  }
  if (tag === 'Method') {
    node.metaContext.urlTemplateName = parentName;
    node.gitDecorationTarget.urlTemplateName = parentName;
  }
  if (tag === 'TabularSection') {
    node.addMetadataTarget = { kind: 'child', ownerObjectXmlPath: objectXmlPath, childTag: 'Column', tabularSectionName: node.name };
  }
  if (tag === 'URLTemplate') {
    node.addMetadataTarget = { kind: 'child', ownerObjectXmlPath: objectXmlPath, childTag: 'Method', urlTemplateName: node.name };
  }
}

function externalChildFolder(tag: ChildTag | 'Column'): string | undefined {
  if (tag === 'Form' || tag === 'Command' || tag === 'Template') {
    return `${tag}s`;
  }
  return undefined;
}

function externalChildPaths(objectXmlPath: string, folder: string, name: string): string[] {
  const base = path.join(getObjectLocationFromXml(objectXmlPath).objectDir, folder, name);
  return [`${base}.xml`, base];
}
