import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { collectSnapshotProjectFiles, syncDirectorySnapshot } from '../../../infra/agent/DirectorySnapshot';
import { buildHashSnapshot, buildScopeKey, saveHashCache } from '../../../infra/cache/HashCache';
import { saveMetadataCacheForEntry } from '../../../infra/cache/MetadataCache';
import { describeFsError } from '../../../infra/fs/PathRemoval';
import { resolveXmlPathByFullName } from '../../../infra/repository/RepositoryDumpPlan';
import { expandSubordinateUnits } from '../../../infra/repository/RepositoryDumpRounds';
import { inspectRepositoryReplacement } from '../../../infra/repository/RepositoryReplacement';
import { resolveObjectScope } from '../../../infra/repository/RepositoryObjectScope';
import type { RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { CommandServices } from '../_shared';
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
export type RepositoryFullUpdateServices = RepositoryFileSyncServices & Pick<CommandServices, 'markConfigurationsClean' | 'scanUnloadedChanges'>;

export interface RepositoryFullUpdateDeps {
  confirm(message: string): Promise<boolean>;
  saveHashCache: typeof saveHashCache;
}

/* c8 ignore start -- адаптер модального окна */
const DEFAULT_FULL_UPDATE_DEPS: RepositoryFullUpdateDeps = {
  confirm: async (message) => {
    const replace = 'Заменить файлы';
    return await vscode.window.showWarningMessage(REPOSITORY_FULL_UPDATE_TITLE, { modal: true, detail: message }, replace) === replace;
  },
  saveHashCache,
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
    const changes = await inspectRepositoryReplacement(
      target, services.workspaceFolder.uri.fsPath, services.repositoryService, services.scanUnloadedChanges, deps.getDirtyFilePaths()
    );
    if (!await fullUpdateDeps.confirm(describeReplacement(changes))) {
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

function describeReplacement(
  { relativeRoot, unloadedCount, modifiedUnits, dirtyFiles }: Awaited<ReturnType<typeof inspectRepositoryReplacement>>
): string {
  const details = [
    `Файлы «${relativeRoot}» будут полностью заменены выгрузкой из базы после получения из хранилища.`,
    'Изменения в файлах, не помещённые в хранилище, будут потеряны.',
  ];
  if (unloadedCount > 0) {
    details.push(`Не загружено в базу файлов: ${String(unloadedCount)}.`);
  }
  if (modifiedUnits > 0) {
    details.push(`Захваченные объекты с локальными правками: ${String(modifiedUnits)}.`);
  }
  if (dirtyFiles > 0) {
    details.push(`Файлы с несохранёнными правками в редакторах: ${String(dirtyFiles)}.`);
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
  const projectRoot = services.workspaceFolder.uri.fsPath;
  const scopeKey = buildScopeKey(target.configKind, target.configRoot, target.extensionName);
  // Снимок должен описывать выгрузку из базы, даже если пользователь сохранит файл сразу после замены каталога.
  const baseline = buildHashSnapshot(scopeKey, dumpDir);
  const changedFiles = collectSnapshotProjectFiles(dumpDir, target.configRoot);
  services.suppressConfigurationReloadForFiles(changedFiles);
  syncDirectorySnapshot(dumpDir, target.configRoot);
  const snapshotFailures = refreshLockSnapshots(target, services);
  try {
    fullUpdateDeps.saveHashCache(projectRoot, baseline);
    services.markConfigurationsClean([target.configRoot]);
    saveMetadataCacheForEntry(projectRoot, scopeKey, { kind: target.configKind, rootPath: target.configRoot });
  } catch (error) {
    services.outputChannel.appendLine(`[repository][file-sync][warn] ${describeFsError(error)}`);
    deps.notifyWarning(`«${target.displayName}»: файлы проекта заменены, не удалось обновить кэши. Подробности в журнале.`);
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
