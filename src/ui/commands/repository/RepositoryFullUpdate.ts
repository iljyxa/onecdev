import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { collectSnapshotProjectFiles, syncDirectorySnapshot } from '../../../infra/agent/DirectorySnapshot';
import { UnloadedChangesScanner } from '../../../infra/cache/UnloadedChangesScanner';
import { describeFsError } from '../../../infra/fs/PathRemoval';
import { resolveXmlPathByFullName } from '../../../infra/repository/RepositoryDumpPlan';
import { expandSubordinateUnits } from '../../../infra/repository/RepositoryDumpRounds';
import { hashScopeFiles } from '../../../infra/repository/RepositoryLockSnapshotStore';
import { resolveLockUnitByRelativePath, resolveObjectScope } from '../../../infra/repository/RepositoryObjectScope';
import type { RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { CommandServices } from '../_shared';
import { refreshConfigurationHashCache } from '../ext/ExtensionCommandRunner';
import { buildRepositoryUpdateRequest } from './RepositoryCommandRunner';
import {
  ensureRepositoryGuardFree,
  finishPostMutation,
  reportCliOutcome,
  reportFlowError,
  runRepositoryExclusive,
  type RepositoryFileSyncDeps,
  type RepositoryFileSyncServices,
  type RepositoryDumpToTempResult,
} from './RepositoryFileSyncShared';
import {
  captureRootManifestStep,
  captureUnitSnapshotStep,
  reportSnapshotFailures,
  type SnapshotStepFailure,
} from './RepositorySnapshotSteps';

const REPOSITORY_FULL_UPDATE_TITLE = 'Обновить конфигурацию из хранилища';
export type RepositoryFullUpdateServices = RepositoryFileSyncServices & Pick<CommandServices, 'markConfigurationsClean'>;

export interface RepositoryFullUpdateDeps {
  confirm(message: string): Promise<boolean>;
  refreshHashCache(target: RepositoryTarget, services: RepositoryFullUpdateServices): Promise<boolean>;
}

/* c8 ignore start -- адаптеры модального окна и процесса CLI */
const DEFAULT_FULL_UPDATE_DEPS: RepositoryFullUpdateDeps = {
  confirm: async (message) => {
    const replace = 'Заменить файлы';
    return await vscode.window.showWarningMessage(REPOSITORY_FULL_UPDATE_TITLE, { modal: true, detail: message }, replace) === replace;
  },
  refreshHashCache: (target, services) => refreshConfigurationHashCache(
    target.configKind, target.extensionName ?? '', target.configRoot, services.workspaceFolder, services.outputChannel
  ),
};
/* c8 ignore stop */

export async function runRepositoryFullUpdate(
  target: RepositoryTarget,
  services: RepositoryFullUpdateServices,
  deps: RepositoryFileSyncDeps,
  fullUpdateDeps: RepositoryFullUpdateDeps = DEFAULT_FULL_UPDATE_DEPS
): Promise<void> {
  const label = `Обновление «${target.displayName}» из хранилища`;
  if (!ensureRepositoryGuardFree(services, deps, label)) {
    return;
  }
  try {
    const detail = await describeReplacement(target, services, deps);
    if (!await fullUpdateDeps.confirm(detail)) {
      return;
    }
    const leased = await runRepositoryExclusive(services, deps, label, async () => {
      const cli = await deps.runRepositoryCli(buildRepositoryUpdateRequest(target, undefined, target.displayName, { force: true }), services);
      if (cli.status !== 'done') {
        return { cli };
      }
      return { dump: await acquireFullDump(target, services, deps) };
    });
    if (!leased.acquired) {
      return;
    }
    const { cli, dump } = leased.value;
    if (cli) {
      reportCliOutcome(cli, label, deps);
      return;
    }
    if (!dump.ok) {
      deps.notifyError(`«${target.displayName}»: база уже обновлена, файлы проекта остались прежними. ` +
        `Выгрузка не выполнена (${dump.reason}). Выполните «Импортировать из базы».`);
      return;
    }
    try {
      if (!fs.existsSync(path.join(dump.dir, 'Configuration.xml'))) {
        deps.notifyError(`«${target.displayName}»: база уже обновлена, файлы проекта остались прежними. ` +
          'В выгрузке нет Configuration.xml. Выполните «Импортировать из базы».');
        return;
      }
      await applyFullDump(target, dump.dir, services, deps, fullUpdateDeps);
    } finally {
      dump.dispose();
    }
  } catch (error) {
    reportFlowError(services, deps, label, error);
  }
}

async function acquireFullDump(
  target: RepositoryTarget,
  services: RepositoryFullUpdateServices,
  deps: RepositoryFileSyncDeps
): Promise<RepositoryDumpToTempResult> {
  try {
    return await deps.dumpToTemp(target, { mode: 'full' }, services);
  } catch (error) {
    return { ok: false, reason: describeFsError(error) };
  }
}

async function describeReplacement(
  target: RepositoryTarget,
  services: RepositoryFullUpdateServices,
  deps: RepositoryFileSyncDeps
): Promise<string> {
  const projectRoot = services.workspaceFolder.uri.fsPath;
  const repository = services.repositoryService;
  const relativeRoot = path.relative(projectRoot, target.configRoot);
  const unloaded = await new UnloadedChangesScanner(projectRoot).scan({ kind: target.configKind, rootPath: target.configRoot });
  const dirtyFiles = new Set(deps.getDirtyFilePaths()
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
  const details = [
    `Файлы «${relativeRoot}» будут полностью заменены выгрузкой из базы после получения из хранилища.`,
    'Изменения в файлах, не помещённые в хранилище, будут потеряны.',
  ];
  const unloadedCount = unloaded.changed.size + unloaded.deleted.size;
  if (unloadedCount > 0) {
    details.push(`Не загружено в базу файлов: ${String(unloadedCount)}.`);
  }
  if (modifiedUnits.size > 0) {
    details.push(`Захваченные объекты с локальными правками: ${String(modifiedUnits.size)}.`);
  }
  if (dirtyFiles.size > 0) {
    details.push(`Файлы с несохранёнными правками в редакторах: ${String(dirtyFiles.size)}.`);
  }
  return details.join('\n');
}

async function applyFullDump(
  target: RepositoryTarget,
  dumpDir: string,
  services: RepositoryFullUpdateServices,
  deps: RepositoryFileSyncDeps,
  fullUpdateDeps: RepositoryFullUpdateDeps
): Promise<void> {
  const changedFiles = collectSnapshotProjectFiles(dumpDir, target.configRoot);
  services.suppressConfigurationReloadForFiles(changedFiles);
  syncDirectorySnapshot(dumpDir, target.configRoot);
  const snapshotFailures = refreshLockSnapshots(target, services);
  const refreshed = await fullUpdateDeps.refreshHashCache(target, services).catch((error: unknown) => {
    services.outputChannel.appendLine(`[repository][file-sync][warn] ${describeFsError(error)}`);
    return false;
  });
  if (refreshed) {
    services.markConfigurationsClean([target.configRoot]);
  } else {
    deps.notifyWarning(`«${target.displayName}»: файлы проекта заменены, не удалось обновить хеш-кэш. Подробности в журнале.`);
  }
  services.supportService?.loadConfig(target.configRoot, { invalidateCache: true });
  await finishPostMutation(services, { changedFiles, keptDivergentFiles: [], structural: true });
  reportSnapshotFailures(deps, target.displayName, snapshotFailures);
  deps.notifyInfo(`Конфигурация «${target.displayName}» обновлена из хранилища, файлы проекта заменены.`);
}

function refreshLockSnapshots(target: RepositoryTarget, services: RepositoryFullUpdateServices): SnapshotStepFailure[] {
  const repository = services.repositoryService;
  const { snapshots } = repository;
  const failures = repository.lockState.isRootRecursiveLocked(target)
    ? captureRootManifestStep(services, target, () => snapshots.captureRootManifest(target))
    : [];
  for (const unit of repository.listOwnLockedFullNames(target)) {
    failures.push(...captureUnitSnapshotStep(services, target, unit, () => {
      const scope = resolveObjectScope(target.configRoot, unit, target, 'unit');
      if (!scope) {
        snapshots.captureEmpty(target, unit);
        return;
      }
      const xml = resolveXmlPathByFullName(target.configRoot, unit);
      const subordinates = xml ? expandSubordinateUnits(unit, xml) : undefined;
      snapshots.captureFromProject(target, unit, scope, 'unit', subordinates);
    }));
  }
  return failures;
}
