import * as path from 'path';
import type { UnloadedChangesScanner } from '../cache/UnloadedChangesScanner';
import { hashScopeFiles } from './RepositoryLockSnapshotStore';
import { resolveLockUnitByRelativePath, resolveObjectScope } from './RepositoryObjectScope';
import type { RepositoryService, RepositoryTarget } from './RepositoryService';

/** Изменения проекта относительно базы и сохранённых эталонов захвата. */
export async function inspectRepositoryReplacement(
  target: RepositoryTarget,
  projectRoot: string,
  repository: RepositoryService,
  scanUnloadedChanges: UnloadedChangesScanner['scan'],
  dirtyPaths: readonly string[]
): Promise<{ relativeRoot: string; unloadedCount: number; modifiedUnits: number; dirtyFiles: number }> {
  const relativeRoot = path.relative(projectRoot, target.configRoot);
  const unloaded = await scanUnloadedChanges({ kind: target.configKind, rootPath: target.configRoot });
  const dirtyFiles = new Set(dirtyPaths
    .map((file) => path.relative(target.configRoot, file))
    .filter((relative) => relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)));
  const modifiedUnits = new Set<string>();
  for (const relative of [...unloaded.changed, ...unloaded.deleted, ...dirtyFiles]) {
    const owner = resolveLockUnitByRelativePath(relative, target);
    if (owner && repository.isLocked(target, owner)) {
      modifiedUnits.add(owner);
    }
  }
  if (repository.lockState.isRootRecursiveLocked(target)) {
    for (const owner of repository.snapshots.diffRootManifest(target).owners) {
      if (repository.isLocked(target, owner)) {
        modifiedUnits.add(owner);
      }
    }
  }
  for (const unit of repository.listOwnLockedFullNames(target)) {
    if (modifiedUnits.has(unit)) {
      continue;
    }
    const baseline = repository.snapshots.readSnapshotHashes(target, unit);
    if (!baseline) {
      continue;
    }
    const scope = resolveObjectScope(target.configRoot, unit, target, 'unit');
    const current = scope ? hashScopeFiles(target.configRoot, scope) : {};
    if (Object.keys(current).length !== Object.keys(baseline).length
      || Object.keys(current).some((relative) => current[relative] !== baseline[relative])) {
      modifiedUnits.add(unit);
    }
  }
  return {
    relativeRoot,
    unloadedCount: unloaded.changed.size + unloaded.deleted.size,
    modifiedUnits: modifiedUnits.size,
    dirtyFiles: dirtyFiles.size,
  };
}
