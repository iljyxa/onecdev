import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ChildTag } from '../../domain/ChildTag';
import type { ConfigEntry, ConfigInfo } from '../../domain/Configuration';
import type { MetaChild } from '../../domain/MetaObject';
import { type MetaKind, getMetaFolder, getMetaType, getMetaTypesByGroup } from '../../domain/MetaTypes';
import { buildScopeKey } from './HashCache';
import type { MetadataGitDecorationTarget } from '../git/GitMetadataStatusService';
import { writeFileAtomic } from '../fs/AtomicFileWriter';
import { getObjectLocationFromXml, resolveObjectXmlPath } from '../fs/MetaPathResolver';
import { findObjectXmlInFolder } from '../fs/ObjectLocation';
import { parseConfigXml, parseObjectXml, readTemplateTypeFromXml } from '../xml';
import { pathKey } from '../fs/PathKey';
import { mkdirInsideServiceDir } from '../fs/WorkspaceTempDir';
import { packNode, restoreNode, relativeCachePath, type CompactNode } from './MetadataCacheFormat';

export type MetadataCacheSingleClickAction = 'openTemplateContent';

export interface MetadataCacheNode {
  type: MetaKind;
  name: string;
  label: string;
  xmlPath?: string;
  decorationPath?: string;
  gitDecorationTarget?: MetadataGitDecorationTarget;
  tooltip?: string;
  ownershipTag?: 'OWN' | 'BORROWED';
  hidePropertiesCommand?: boolean;
  metaContext?: {
    rootMetaKind: MetaKind;
    tabularSectionName?: string;
    urlTemplateName?: string;
    standardAttributeName?: string;
    ownerObjectXmlPath?: string;
  };
  addMetadataTarget?: MetadataCacheAddTarget;
  canRemoveMetadata?: boolean;
  singleClickAction?: MetadataCacheSingleClickAction;
  children: MetadataCacheNode[];
}

export type MetadataCacheAddTarget =
  | {
    kind: 'root';
    configRoot: string;
    configKind: 'cf' | 'cfe';
    targetKind: MetaKind;
    namePrefix?: string;
  }
  | {
    kind: 'child';
    ownerObjectXmlPath: string;
    childTag: ChildTag | 'Column';
    tabularSectionName?: string;
    urlTemplateName?: string;
  };

/**
 * Отпечаток состояния ФС на момент сохранения снимка.
 * Используется для инвалидации кэша при любом внешнем изменении выгрузки
 * (правка Configuration.xml или изменение состава корневого каталога),
 * которое произошло в обход перехваченных операций добавления/переименования.
 */
export interface MetadataCacheFingerprint {
  configurationXml: { mtimeMs: number; size: number };
  rootDir: { mtimeMs: number };
}

export interface MetadataCacheSnapshot {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  scopeKey: string;
  generatedAt: string;
  rootPath: string;
  configKind: 'cf' | 'cfe';
  fingerprint: MetadataCacheFingerprint;
  root: MetadataCacheNode;
}

export interface MetadataCacheUpdateResult {
  snapshot: MetadataCacheSnapshot;
  updatedPartially: boolean;
}

const METADATA_CACHE_DIR = path.join('.onecdev', 'meta');
const CACHE_SCHEMA_VERSION = 18;

/**
 * Строит полный снимок дерева метаданных без ленивых загрузчиков, чтобы UI мог восстановить дерево из JSON.
 * Отпечаток ФС при первичной сборке проставляется заглушкой и пересчитывается в saveMetadataCache
 * из snapshot.rootPath — единая точка гарантирует актуальность отпечатка после любых мутаций.
 */
export function buildMetadataCacheSnapshot(scopeKey: string, entry: ConfigEntry): MetadataCacheSnapshot {
  const info = parseConfigXml(path.join(entry.rootPath, 'Configuration.xml'));
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    scopeKey,
    generatedAt: new Date().toISOString(),
    rootPath: entry.rootPath,
    configKind: entry.kind,
    fingerprint: computeFingerprint(entry.rootPath),
    root: restoreNode(buildConfigNode(entry, info), entry),
  };
}

/**
 * Вычисляет отпечаток ФС по корню выгрузки: mtime+size у Configuration.xml и mtime корневого каталога.
 * Отсутствие Configuration.xml трактуется как «нулевой» отпечаток — он не совпадёт ни с одним реальным
 * снимком, поэтому кэш будет инвалидирован при загрузке.
 */
function computeFingerprint(rootPath: string): MetadataCacheFingerprint {
  const configXmlPath = path.join(rootPath, 'Configuration.xml');
  const configStat = statSafe(configXmlPath);
  const rootStat = statSafe(rootPath);
  return {
    configurationXml: {
      mtimeMs: configStat?.mtimeMs ?? 0,
      size: configStat?.size ?? -1,
    },
    rootDir: {
      mtimeMs: rootStat?.mtimeMs ?? 0,
    },
  };
}

function statSafe(targetPath: string): fs.Stats | null {
  try {
    return fs.statSync(targetPath);
  } catch {
    return null;
  }
}

/** Глубоко-частичный вид отпечатка: читается из JSON старого/чужого формата, где полей может не быть. */
interface PartialFingerprint {
  configurationXml?: { mtimeMs?: number; size?: number };
  rootDir?: { mtimeMs?: number };
}

function fingerprintMatches(saved: PartialFingerprint | undefined, current: MetadataCacheFingerprint): boolean {
  return (
    saved?.configurationXml?.mtimeMs === current.configurationXml.mtimeMs &&
    saved.configurationXml.size === current.configurationXml.size &&
    saved.rootDir?.mtimeMs === current.rootDir.mtimeMs
  );
}

export function saveMetadataCache(projectRoot: string, snapshot: MetadataCacheSnapshot): void {
  const filePath = getMetadataCacheFilePath(projectRoot, snapshot.scopeKey);
  mkdirInsideServiceDir(projectRoot, path.dirname(filePath));
  // Отпечаток пересчитываем здесь, в единой точке, уже ПОСЛЕ того как мутации ФС применены
  // (объект добавлен/переименован/удалён), чтобы updateMetadataCacheAfter* писали актуальное состояние.
  const persisted = { ...snapshot, root: packNode(snapshot.root, snapshot.rootPath), fingerprint: computeFingerprint(snapshot.rootPath) };
  // Общий примитив temp+rename (infra/fs/AtomicFileWriter), тот же, что у
  // HashCache: прерывание записи не должно оставить битый JSON в кэше.
  writeFileAtomic(filePath, JSON.stringify(persisted));
  // Держим переданный снимок согласованным с тем, что записано на диск.
  snapshot.fingerprint = persisted.fingerprint;
}

export function loadMetadataCache(projectRoot: string, scopeKey: string): MetadataCacheSnapshot | null {
  const filePath = getMetadataCacheFilePath(projectRoot, scopeKey);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<Omit<MetadataCacheSnapshot, 'root'>> & { root?: CompactNode };
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION || parsed.scopeKey !== scopeKey || !parsed.root) {
      return null;
    }
    // Свежесть: отпечаток снимка обязан совпасть с текущим состоянием ФС выгрузки,
    // иначе кэш устарел (внешняя правка Configuration.xml или изменение состава каталога).
    if (typeof parsed.rootPath !== 'string' || (parsed.configKind !== 'cf' && parsed.configKind !== 'cfe')) {
      return null;
    }
    const current = computeFingerprint(parsed.rootPath);
    if (!fingerprintMatches(parsed.fingerprint, current)) {
      return null;
    }
    return { ...parsed, root: restoreNode(parsed.root, { rootPath: parsed.rootPath, kind: parsed.configKind }) } as MetadataCacheSnapshot;
  } catch {
    return null;
  }
}

export function saveMetadataCacheForEntry(projectRoot: string, scopeKey: string, entry: ConfigEntry): void {
  saveMetadataCache(projectRoot, buildMetadataCacheSnapshot(scopeKey, entry));
}

/**
 * Обновляет JSON-кэш после интерактивного добавления одного объекта без полного пересоздания снимка.
 * Полная сборка остаётся только аварийным путём, когда кэш ещё не создан или в нём нет ожидаемой ветки.
 */
export function updateMetadataCacheAfterAdd(
  projectRoot: string,
  entry: ConfigEntry,
  target: MetadataCacheAddTarget,
  name: string
): MetadataCacheUpdateResult {
  const info = parseConfigXml(path.join(entry.rootPath, 'Configuration.xml'));
  const scopeKey = buildMetadataCacheScopeKey(entry, info);
  const cached = loadMetadataCache(projectRoot, scopeKey);
  if (!cached) {
    const snapshot = buildMetadataCacheSnapshot(scopeKey, entry);
    saveMetadataCache(projectRoot, snapshot);
    return { snapshot, updatedPartially: false };
  }

  const updated = target.kind === 'root'
    ? updateRootObjectCache(cached, entry, info, target.targetKind, name)
    : updateChildObjectCache(cached, target.ownerObjectXmlPath);

  if (!updated) {
    const snapshot = buildMetadataCacheSnapshot(scopeKey, entry);
    saveMetadataCache(projectRoot, snapshot);
    return { snapshot, updatedPartially: false };
  }

  cached.generatedAt = new Date().toISOString();
  saveMetadataCache(projectRoot, cached);
  return { snapshot: cached, updatedPartially: true };
}

/**
 * Точечно обновляет JSON-кэш после переименования корневого объекта метаданных.
 * Находит узел по oldXmlPath, перестраивает его из newXmlPath и сохраняет кэш.
 * Намного быстрее полного пересоздания снимка — не читает остальные XML-файлы.
 */
export function updateMetadataCacheAfterRename(
  projectRoot: string,
  entry: ConfigEntry,
  oldXmlPath: string,
  newXmlPath: string
): MetadataCacheUpdateResult | null {
  const info = parseConfigXml(path.join(entry.rootPath, 'Configuration.xml'));
  const scopeKey = buildMetadataCacheScopeKey(entry, info);
  const cached = loadMetadataCache(projectRoot, scopeKey);

  if (!cached) {
    const snapshot = buildMetadataCacheSnapshot(scopeKey, entry);
    saveMetadataCache(projectRoot, snapshot);
    return { snapshot, updatedPartially: false };
  }

  const target = findObjectNodeByChangedPath(cached.root, oldXmlPath);
  if (!target) {
    const snapshot = buildMetadataCacheSnapshot(scopeKey, entry);
    saveMetadataCache(projectRoot, snapshot);
    return { snapshot, updatedPartially: false };
  }

  // Патчим xmlPath перед вызовом rebuildObjectNodeFromXml — он перечитает XML с нового пути
  target.node.xmlPath = newXmlPath;
  const refreshed = rebuildObjectNodeFromXml(entry, info, target.node);

  if (!refreshed) {
    const snapshot = buildMetadataCacheSnapshot(scopeKey, entry);
    saveMetadataCache(projectRoot, snapshot);
    return { snapshot, updatedPartially: false };
  }

  target.parent.children[target.index] = refreshed;
  cached.generatedAt = new Date().toISOString();
  saveMetadataCache(projectRoot, cached);
  return { snapshot: cached, updatedPartially: true };
}

/**
 * Обновляет JSON-кэш дерева по внешним изменениям файлов выгрузки.
 * Hash-кэш загрузки в 1С не трогается: он должен отражать последнее успешное
 * состояние синхронизации, а не каждое локальное редактирование.
 */
export function updateMetadataCacheForChangedFiles(
  projectRoot: string,
  entry: ConfigEntry,
  filePaths: string[]
): MetadataCacheUpdateResult | null {
  const relatedFiles = filePaths.filter((filePath) => isPathInside(filePath, entry.rootPath));
  if (relatedFiles.length === 0) {
    return null;
  }

  const info = parseConfigXml(path.join(entry.rootPath, 'Configuration.xml'));
  const scopeKey = buildMetadataCacheScopeKey(entry, info);
  const cached = loadMetadataCache(projectRoot, scopeKey);
  if (!cached) {
    const snapshot = buildMetadataCacheSnapshot(scopeKey, entry);
    saveMetadataCache(projectRoot, snapshot);
    return { snapshot, updatedPartially: false };
  }

  if (relatedFiles.some((filePath) => isConfigurationXml(filePath))) {
    const snapshot = buildMetadataCacheSnapshot(scopeKey, entry);
    saveMetadataCache(projectRoot, snapshot);
    return { snapshot, updatedPartially: false };
  }

  // Несколько relatedFiles одной пары (Object.xml + Ext/ObjectModule.bsl) резолвятся в ОДИН
  // и тот же узел дерева. Дедуплицируем по идентичности узла, чтобы не задваивать перестройку
  // и не бить splice'ом по устаревшим индексам соседей.
  const targetsByNode = new Map<MetadataCacheNode, { parent: MetadataCacheNode; node: MetadataCacheNode }>();
  for (const filePath of relatedFiles) {
    if (path.extname(filePath).toLowerCase() !== '.xml') {
      continue;
    }

    const target = findObjectNodeByChangedPath(cached.root, filePath);
    if (!target || targetsByNode.has(target.node)) {
      continue;
    }
    targetsByNode.set(target.node, { parent: target.parent, node: target.node });
  }

  if (targetsByNode.size === 0) {
    return null;
  }

  // Разделяем операции: перестройка узла заменяет его на месте; удаление — вырезает из родителя.
  // Удаления собираем по родителю и применяем по убыванию индекса за один проход, чтобы
  // индексы соседних удаляемых узлов не смещались.
  // Каждый targetNode получен как parent.children[index] в findObjectNodeByChangedPath,
  // а перестройка заменяет узел на месте (длина массива не меняется), поэтому indexOf
  // гарантированно ≥ 0 — дополнительные guard'ы и флаг "было ли изменение" не нужны:
  // непустой targetsByNode уже гарантирует ≥1 перестройку или удаление.
  const removalsByParent = new Map<MetadataCacheNode, MetadataCacheNode[]>();
  for (const { parent, node: targetNode } of targetsByNode.values()) {
    const refreshed = rebuildObjectNodeFromXml(entry, info, targetNode);
    if (refreshed) {
      parent.children[parent.children.indexOf(targetNode)] = refreshed;
      continue;
    }
    const removals = removalsByParent.get(parent) ?? [];
    removals.push(targetNode);
    removalsByParent.set(parent, removals);
  }

  for (const [parent, nodesToRemove] of removalsByParent) {
    const indices = nodesToRemove
      .map((removed) => parent.children.indexOf(removed))
      .sort((left, right) => right - left);
    for (const index of indices) {
      parent.children.splice(index, 1);
    }
  }

  cached.generatedAt = new Date().toISOString();
  saveMetadataCache(projectRoot, cached);
  return { snapshot: cached, updatedPartially: true };
}

export function buildMetadataCacheScopeKey(entry: ConfigEntry, info: ConfigInfo): string {
  return buildScopeKey(entry.kind, entry.rootPath, entry.kind === 'cfe' ? info.name : '');
}

function getMetadataCacheFilePath(projectRoot: string, scopeKey: string): string {
  const hash = crypto.createHash('sha1').update(scopeKey).digest('hex');
  return path.join(projectRoot, METADATA_CACHE_DIR, `${hash}.json`);
}

function buildConfigNode(entry: ConfigEntry, info: ConfigInfo): CompactNode {
  const type: MetaKind = entry.kind === 'cf' ? 'configuration' : 'extension';
  return { type, name: info.name, tooltip: info.synonym || undefined, children: buildConfigChildren(entry, info) };
}

function buildConfigChildren(entry: ConfigEntry, info: ConfigInfo): CompactNode[] {
  return [
    {
      type: 'group-common',
      name: 'common',
      label: 'Общие',
      children: buildCommonSubgroups(entry, info),
    },
    ...buildTopGroups(entry, info),
  ];
}

function buildTopGroups(entry: ConfigEntry, info: ConfigInfo): CompactNode[] {
  const result: CompactNode[] = [];

  for (const def of getMetaTypesByGroup('top')) {
    if (def.kind === 'DocumentNumerator' || def.kind === 'Sequence') {
      continue;
    }

    if (def.kind === 'Document') {
      const children = buildDocumentsBranchChildren(entry, info);
      result.push({
        type: 'Document',
        name: 'Document',
        label: def.pluralLabel,
        prefix: entry.kind === 'cfe' ? info.namePrefix : undefined,
        children,
      });
      continue;
    }

    const names = info.childObjects.get(def.kind) ?? [];
    result.push({
      type: def.kind,
      name: def.kind,
      label: def.pluralLabel,
      prefix: entry.kind === 'cfe' ? info.namePrefix : undefined,
      children: names.length > 0 ? buildObjectNodes(entry, info, def.kind, names) : [],
    });
  }

  return result;
}

function buildCommonSubgroups(entry: ConfigEntry, info: ConfigInfo): CompactNode[] {
  return getMetaTypesByGroup('common').map((def) => {
    const names = info.childObjects.get(def.kind) ?? [];
    return {
      type: def.kind,
      name: def.kind,
      label: def.pluralLabel,
      prefix: entry.kind === 'cfe' ? info.namePrefix : undefined,
      children: names.length > 0 ? buildObjectNodes(entry, info, def.kind, names) : [],
    };
  });
}

function buildDocumentsBranchChildren(entry: ConfigEntry, info: ConfigInfo): CompactNode[] {
  const numeratorNames = info.childObjects.get('DocumentNumerator') ?? [];
  const sequenceNames = info.childObjects.get('Sequence') ?? [];
  const documentNames = info.childObjects.get('Document') ?? [];

  return [
    {
      type: 'NumeratorsBranch',
      name: 'NumeratorsBranch',
      label: 'Нумераторы',
      prefix: entry.kind === 'cfe' ? info.namePrefix : undefined,
      children: buildObjectNodes(entry, info, 'DocumentNumerator', numeratorNames),
    },
    {
      type: 'SequencesBranch',
      name: 'SequencesBranch',
      label: 'Последовательности',
      prefix: entry.kind === 'cfe' ? info.namePrefix : undefined,
      children: buildObjectNodes(entry, info, 'Sequence', sequenceNames),
    },
    ...buildObjectNodes(entry, info, 'Document', documentNames),
  ];
}

function buildObjectNodes(entry: ConfigEntry, info: ConfigInfo, type: MetaKind, names: string[]): CompactNode[] {
  if (type === 'PaletteColor') {
    return [];
  }
  if (type === 'Subsystem') {
    return buildSubsystemNodes(entry, info, names);
  }

  const childTags = getMetaType(type).childTags ?? [];

  return names
    .map((name) => buildObjectNode(entry, info, type, name, childTags))
    .filter((item): item is CompactNode => Boolean(item));
}

function buildObjectNode(
  entry: ConfigEntry,
  info: ConfigInfo,
  type: MetaKind,
  name: string,
  childTags: readonly ChildTag[]
): CompactNode | undefined {
  const xmlPath = resolveObjectXmlPath(entry.rootPath, type, name) ?? undefined;
  if (!xmlPath) {
    return undefined;
  }

  const objectInfo = parseObjectXml(xmlPath);
  const label = objectInfo?.name ?? name;
  const ownershipTag = getOwnershipTag(entry, info, label);

  return {
    type, name: label, ...objectLocationFacts(entry.rootPath, xmlPath),
    tooltip: objectInfo?.synonym ?? undefined, ownershipTag, removable: true,
    action: resolveObjectSingleClickAction(type, xmlPath),
    children: buildObjectChildNodes(entry.rootPath, xmlPath, type, objectInfo?.children ?? [], childTags),
  };
}

function buildObjectChildNodes(
  rootPath: string, objectXmlPath: string, type: MetaKind, children: MetaChild[], childTags: readonly ChildTag[]
): CompactNode[] {
  const groups: CompactNode[] = [];
  for (const tag of childTags) {
    const leaves = children.filter(item => item.tag === tag).map(item => {
      const xmlPath = resolveLeafXmlPath(objectXmlPath, tag, item.name);
      const nestedType = tag === 'URLTemplate' ? 'Method' : 'Column';
      return {
        type: tag, name: item.name, label: item.presentation, tooltip: item.synonym || undefined,
        xml: xmlPath === objectXmlPath ? undefined : relativeCachePath(rootPath, xmlPath),
        action: resolveLeafSingleClickAction(tag, xmlPath),
        children: item.columns?.map(child => ({ type: nestedType, name: child.name, tooltip: child.synonym || undefined })),
      } satisfies CompactNode;
    });
    if (getMetaType(type).flatChildren && childTags.length === 1) {
      return leaves;
    }
    if (tag !== 'StandardAttribute' || leaves.length) {
      groups.push({ type: 'group-type', name: tag, children: leaves });
    }
  }
  return groups;
}

function resolveObjectSingleClickAction(type: MetaKind, xmlPath: string): MetadataCacheSingleClickAction | undefined {
  if (type !== 'CommonTemplate') {
    return undefined;
  }

  return readTemplateTypeFromXml(xmlPath) === 'TextDocument' ? 'openTemplateContent' : undefined;
}

function resolveLeafSingleClickAction(tag: ChildTag, xmlPath: string): MetadataCacheSingleClickAction | undefined {
  if (tag !== 'Template') {
    return undefined;
  }

  return readTemplateTypeFromXml(xmlPath) === 'TextDocument' ? 'openTemplateContent' : undefined;
}

function buildSubsystemNodes(entry: ConfigEntry, info: ConfigInfo, names: string[]): CompactNode[] {
  // Фолбэк недостижим: у Subsystem папка задана в META_TYPES константой; `??` нужен только
  // из-за сигнатуры getMetaFolder (string | null).
  /* c8 ignore next */
  const subsystemsFolder = getMetaFolder('Subsystem') ?? 'Subsystems';
  return names
    .map((name) => {
      const xmlPath = findObjectXmlInFolder(entry.rootPath, subsystemsFolder, name);
      return xmlPath ? buildSubsystemNode(entry, info, name, xmlPath, getSubsystemHomeDir(xmlPath, name), new Set()) : undefined;
    })
    .filter((item): item is CompactNode => Boolean(item));
}

function buildSubsystemNode(
  entry: ConfigEntry,
  info: ConfigInfo,
  label: string,
  xmlPath: string,
  homeDir: string,
  visited: Set<string>
): CompactNode {
  const location = objectLocationFacts(entry.rootPath, xmlPath);
  if (visited.has(xmlPath)) {
    return { type: 'Subsystem', name: label, label: `${label} (цикл)`, ...location };
  }

  const nextVisited = new Set(visited);
  nextVisited.add(xmlPath);
  const objectInfo = parseObjectXml(xmlPath);
  const name = objectInfo?.name ?? label;
  const children = (objectInfo?.children ?? [])
    .filter((item) => item.tag === 'Subsystem' && item.name !== name)
    .map((item) => {
      const childXmlPath = findObjectXmlInFolder(homeDir, 'Subsystems', item.name);
      return childXmlPath
        ? buildSubsystemNode(entry, info, item.name, childXmlPath, getSubsystemHomeDir(childXmlPath, item.name), nextVisited)
        : undefined;
    })
    .filter((item): item is CompactNode => Boolean(item));

  return {
    type: 'Subsystem',
    name,
    ...location,
    tooltip: objectInfo?.synonym ?? undefined,
    ownershipTag: getOwnershipTag(entry, info, name),
    removable: true,
    children,
  };
}

function objectLocationFacts(rootPath: string, xmlPath: string): Pick<CompactNode, 'xml' | 'directory'> {
  return {
    xml: relativeCachePath(rootPath, xmlPath),
    directory: fs.existsSync(getObjectLocationFromXml(xmlPath).objectDir),
  };
}

function resolveLeafXmlPath(objectXmlPath: string, tag: ChildTag, itemName: string): string {
  if (tag === 'Form' || tag === 'Command') {
    return objectXmlPath;
  }

  if (tag === 'Template') {
    const loc = getObjectLocationFromXml(objectXmlPath);
    const own = path.join(loc.objectDir, 'Templates', itemName, `${itemName}.xml`);
    if (fs.existsSync(own)) {
      return own;
    }
    const flat = path.join(loc.objectDir, 'Templates', `${itemName}.xml`);
    if (fs.existsSync(flat)) {
      return flat;
    }
  }

  return objectXmlPath;
}

function getSubsystemHomeDir(xmlPath: string, subsystemName: string): string {
  const dir = path.dirname(xmlPath);
  return path.basename(dir) === subsystemName ? dir : path.join(dir, subsystemName);
}

function getOwnershipTag(entry: ConfigEntry, info: ConfigInfo, name: string): 'OWN' | 'BORROWED' | undefined {
  if (entry.kind !== 'cfe' || !info.namePrefix) {
    return undefined;
  }
  return name.startsWith(info.namePrefix) ? 'OWN' : 'BORROWED';
}

function updateRootObjectCache(
  snapshot: MetadataCacheSnapshot,
  entry: ConfigEntry,
  info: ConfigInfo,
  targetKind: MetaKind,
  name: string
): boolean {
  const newNode = buildObjectNode(entry, info, targetKind, name, getMetaType(targetKind).childTags ?? []);
  const container = findRootAddContainer(snapshot.root, targetKind);
  if (!newNode || !container) {
    return false;
  }

  upsertSortedByLabel(container.children, restoreNode(newNode, entry), targetKind);
  return true;
}

function updateChildObjectCache(snapshot: MetadataCacheSnapshot, ownerObjectXmlPath: string): boolean {
  const ownerNode = findRootObjectNodeByXml(snapshot.root, ownerObjectXmlPath);
  if (!ownerNode) {
    return false;
  }

  const objectInfo = parseObjectXml(ownerObjectXmlPath);
  const childTags = getMetaType(ownerNode.type).childTags ?? [];
  ownerNode.tooltip = objectInfo?.synonym ?? undefined;
  // flatChildren-aware: иначе после добавления/удаления дочернего элемента у плоского
  // объекта (HTTP-сервис) при инкрементальном обновлении снова возникала бы группа.
  const entry = { rootPath: snapshot.rootPath, kind: snapshot.configKind };
  ownerNode.children = buildObjectChildNodes(entry.rootPath, ownerObjectXmlPath, ownerNode.type, objectInfo?.children ?? [], childTags)
    .map(child => restoreNode(child, entry, { type: ownerNode.type, xmlPath: ownerObjectXmlPath }, ownerNode.name));
  return true;
}

function rebuildObjectNodeFromXml(
  entry: ConfigEntry,
  info: ConfigInfo,
  existing: MetadataCacheNode
): MetadataCacheNode | null {
  if (!existing.xmlPath) {
    return null;
  }

  const objectInfo = parseObjectXml(existing.xmlPath);
  if (!objectInfo) {
    return null;
  }

  const childTags = getMetaType(existing.type).childTags ?? [];
  const label = objectInfo.name || existing.name;
  return restoreNode({
    type: existing.type, name: label, ...objectLocationFacts(entry.rootPath, existing.xmlPath),
    tooltip: objectInfo.synonym || undefined, ownershipTag: getOwnershipTag(entry, info, label),
    removable: existing.canRemoveMetadata,
    children: buildObjectChildNodes(entry.rootPath, existing.xmlPath, existing.type, objectInfo.children, childTags),
  }, entry);
}

function findObjectNodeByChangedPath(
  root: MetadataCacheNode,
  changedPath: string
): { parent: MetadataCacheNode; index: number; node: MetadataCacheNode } | null {
  const normalizedChangedPath = pathKey(changedPath);
  return findObjectNodeByChangedPathInner(root, normalizedChangedPath);
}

function findObjectNodeByChangedPathInner(
  parent: MetadataCacheNode,
  normalizedChangedPath: string
): { parent: MetadataCacheNode; index: number; node: MetadataCacheNode } | null {
  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index];
    if (isObjectCacheNode(child) && child.xmlPath && isPathOwnedByObject(normalizedChangedPath, child.xmlPath)) {
      return { parent, index, node: child };
    }

    const found = findObjectNodeByChangedPathInner(child, normalizedChangedPath);
    if (found) {
      return found;
    }
  }

  return null;
}

function isObjectCacheNode(node: MetadataCacheNode): boolean {
  return Boolean(node.xmlPath && getMetaFolder(node.type));
}

function isPathOwnedByObject(normalizedChangedPath: string, objectXmlPath: string): boolean {
  const normalizedXmlPath = pathKey(objectXmlPath);
  if (normalizedChangedPath === normalizedXmlPath) {
    return true;
  }

  const loc = getObjectLocationFromXml(objectXmlPath);
  const normalizedObjectDir = pathKey(loc.objectDir);
  return normalizedChangedPath.startsWith(`${normalizedObjectDir}${path.sep}`);
}

function findRootAddContainer(node: MetadataCacheNode, targetKind: MetaKind): MetadataCacheNode | undefined {
  if (node.addMetadataTarget?.kind === 'root' && node.addMetadataTarget.targetKind === targetKind) {
    return node;
  }

  for (const child of node.children) {
    const found = findRootAddContainer(child, targetKind);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function findRootObjectNodeByXml(node: MetadataCacheNode, xmlPath: string): MetadataCacheNode | undefined {
  const normalizedXmlPath = pathKey(xmlPath);
  if (
    node.xmlPath &&
    pathKey(node.xmlPath) === normalizedXmlPath &&
    (getMetaType(node.type).childTags?.length ?? 0) > 0
  ) {
    return node;
  }

  for (const child of node.children) {
    const found = findRootObjectNodeByXml(child, xmlPath);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function upsertSortedByLabel(nodes: MetadataCacheNode[], next: MetadataCacheNode, targetKind: MetaKind): void {
  const existingIndex = nodes.findIndex((item) => item.type === next.type && item.name === next.name);
  if (existingIndex >= 0) {
    nodes[existingIndex] = next;
  } else {
    nodes.push(next);
  }

  const firstTargetIndex = nodes.findIndex((item) => item.type === targetKind);
  if (firstTargetIndex < 0) {
    return;
  }

  const targetNodes = nodes
    .filter((item) => item.type === targetKind)
    .sort((left, right) => left.label.localeCompare(right.label, 'ru'));
  nodes.splice(firstTargetIndex, targetNodes.length, ...targetNodes);
}

function isConfigurationXml(filePath: string): boolean {
  return path.basename(filePath).toLowerCase() === 'configuration.xml';
}

function isPathInside(filePath: string, rootPath: string): boolean {
  const normalizedFilePath = pathKey(filePath);
  const normalizedRootPath = pathKey(rootPath);
  return normalizedFilePath === normalizedRootPath ||
    normalizedFilePath.startsWith(`${normalizedRootPath}${path.sep}`);
}

