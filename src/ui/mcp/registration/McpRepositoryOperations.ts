import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { getRootLockName, isRootLockName } from '../../../infra/repository/RepositoryObjectNames';
import { isRepositoryUnitNode, type RepositoryNodeRef } from '../../../infra/repository/RepositoryService';
import { confirmRepositoryOperation } from '../../commands/repository/RepositoryCommandDialogs';
import { resolveRepositoryTarget } from '../../commands/repository/RepositoryCommandRunner';
import { refreshRepositoryUi } from '../../commands/repository/RepositoryDatabaseSync';
import {
  DEFAULT_REPOSITORY_FILE_SYNC_DEPS,
  ensureRepositoryGuardFree,
  type RepositoryFileSyncDeps,
  type RepositoryFlowOutcome,
} from '../../commands/repository/RepositoryFileSyncShared';
import { runRepositoryLockFlow, runRepositoryUpdateFlow } from '../../commands/repository/RepositoryLockSync';
import { syncTargets } from '../../commands/repository/RepositoryLockStatusCommands';
import { runRepositoryUnlockFlow } from '../../commands/repository/RepositoryUnlockSync';
import type { McpRegistrationDeps } from './McpRegistrationDeps';

interface RepositoryOperationInput {
  path: string;
  configuration?: string;
  recursive?: boolean;
  version?: number;
  force?: boolean;
  rollbackFiles?: boolean;
}

type RepositoryOperation = 'lock' | 'unlock' | 'update';

interface McpRepositoryOperationDeps {
  flow: RepositoryFileSyncDeps;
  confirmOperation(message: string, button: string): Promise<boolean>;
}

const DEFAULT_DEPS: McpRepositoryOperationDeps = {
  flow: DEFAULT_REPOSITORY_FILE_SYNC_DEPS,
  confirmOperation: confirmRepositoryOperation,
};

const subjectInput = {
  path: z.string(),
  configuration: z.string().optional(),
  recursive: z.boolean().optional(),
};

export function registerRepositoryOperations(
  server: McpServer,
  deps: McpRegistrationDeps,
  repositoryDeps: McpRepositoryOperationDeps = DEFAULT_DEPS,
): void {
  const { gate } = deps;
  server.registerTool('onecdev_repository_lock', {
    title: 'Захватить в хранилище',
    description: 'Захватывает единицу хранилища по каноническому пути перед редактированием. Запуск Конфигуратора требует подтверждения в редакторе.',
    inputSchema: z.object(subjectInput),
  }, (input, { signal }) => gate.wrapAsync(() => runOperation('lock', input, deps, repositoryDeps, signal)));

  server.registerTool('onecdev_repository_unlock', {
    title: 'Освободить захват',
    description: 'Освобождает единицу хранилища. force: true отменяет непомещённые правки в базе. rollbackFiles: true разрешает откат файлов проекта. Оба флага по умолчанию false.',
    inputSchema: z.object({ ...subjectInput, force: z.boolean().optional(), rollbackFiles: z.boolean().optional() }),
  }, (input, { signal }) => gate.wrapAsync(() => runOperation('unlock', input, deps, repositoryDeps, signal)));

  server.registerTool('onecdev_repository_status', {
    title: 'Статусы захватов',
    description: 'Показывает статус захвата для одного канонического пути или массива путей. refresh: true обновляет статусы из хранилища перед чтением.',
    inputSchema: z.object({
      path: z.union([z.string(), z.array(z.string()).min(1)]),
      configuration: z.string().optional(),
      refresh: z.boolean().optional(),
    }),
  }, ({ path, configuration, refresh }) => gate.wrapAsync(async () => {
    const { services } = deps;
    const subjects = (typeof path === 'string' ? [path] : path).map((item) => resolveSubject(item, configuration, deps));
    const warnings: string[] = [];
    const errors: string[] = [];
    if (refresh) {
      const targets = new Map(subjects.map(({ target }) => [target.configRoot, target]));
      await syncTargets([...targets.values()], services, (level, message) => {
        switch (level) {
          case 'error': errors.push(message); break;
          case 'warning': warnings.push(message); break;
        }
      });
    }
    if (errors.length > 0) {
      throw new Error(errors.join('\n'));
    }
    return {
      items: subjects.map(({ path, target, fullName }) => ({
        path,
        target: target.displayName,
        ...services.repositoryService.getLockInfo(target, fullName),
      })),
      warnings,
    };
  }));

  server.registerTool('onecdev_repository_update', {
    title: 'Получить из хранилища',
    description: 'Получает актуальную или указанную версию единицы хранилища. Требует подтверждения пользователя в редакторе до запуска.',
    inputSchema: z.object({ ...subjectInput, version: z.number().int().positive().optional() }),
  }, (input, { signal }) => gate.wrapAsync(() => runOperation('update', input, deps, repositoryDeps, signal)));
}

function resolveSubject(path: string, configuration: string | undefined, { paths, services }: McpRegistrationDeps) {
  const metadata = paths.resolveNode(path, configuration);
  const node: RepositoryNodeRef = {
    nodeKind: metadata.nodeKind, label: metadata.textLabel, xmlPath: metadata.xmlPath, metaContext: metadata.metaContext,
  };
  const repository = services.repositoryService;
  if (!isRepositoryUnitNode(node)) {
    throw new Error(`«${path}» не является единицей хранилища. Укажите канонический путь объекта-владельца, его формы или макета.`);
  }
  const target = resolveRepositoryTarget(repository, node);
  if (!target) {
    throw new Error(`Не удалось определить конфигурацию для пути «${path}».`);
  }
  if (!repository.isConnected(target)) {
    throw new Error(`Для "${target.displayName}" нет активного подключения к хранилищу.`);
  }
  const fullName = node.nodeKind === 'configuration' || node.nodeKind === 'extension'
    ? getRootLockName(target)
    : repository.resolveFullName(node);
  if (fullName === null) {
    throw new Error(`Для пути «${path}» не удалось сформировать полное имя объекта хранилища.`);
  }
  return { path, node, target, fullName };
}

async function runOperation(
  operation: RepositoryOperation,
  input: RepositoryOperationInput,
  deps: McpRegistrationDeps,
  repositoryDeps: McpRepositoryOperationDeps,
  signal: AbortSignal,
) {
  const { services } = deps;
  const { path, node, target, fullName } = resolveSubject(input.path, input.configuration, deps);
  const warnings: string[] = [];
  const messages: string[] = [];
  const conflicts = new Set<string>();
  const changedFiles = new Set<string>();
  const units = new Set<string>();
  const flow: RepositoryFileSyncDeps = {
    ...repositoryDeps.flow,
    notifyBusy: (message) => { messages.push(message); },
    notifyInfo: (message) => { messages.push(message); },
    notifyWarning: (message) => { warnings.push(message); },
    notifyError: (message) => { warnings.push(message); },
    chooseConflictResolution: ({ files }) => {
      files.forEach((file) => conflicts.add(file));
      warnings.push(operation === 'update'
        ? 'Появились конфликты с файлами проекта. Версия получена в базу, синхронизация файлов проекта остановлена.'
        : 'Конфликтующие файлы проекта сохранены.');
      return Promise.resolve(operation === 'update' ? 'skip' : 'keep-local');
    },
    confirmRollback: () => Promise.resolve(input.rollbackFiles === true),
    openDiffs: () => undefined,
    onChangedFiles: (files) => { files.forEach((file) => changedFiles.add(file)); },
    onAffectedUnits: (affected) => { affected.forEach((unit) => units.add(isRootLockName(unit) ? path : unit)); },
  };
  const recursive = input.recursive === true && services.repositoryService.canApplyRecursively(node);
  const version = input.version?.toString();
  const outcome = signal.aborted ? 'cancelled' : await execute();
  if (outcome === 'cancelled') {
    messages.push('Операция отменена.');
  } else if (outcome === 'done') {
    refreshRepositoryUi(services);
  }
  return {
    path, target: target.displayName, outcome, recursive, units: [...units], changedFiles: [...changedFiles],
    conflicts: [...conflicts], warnings, messages,
  };

  async function execute(): Promise<RepositoryFlowOutcome | 'cancelled'> {
    switch (operation) {
      case 'lock': {
        const current = services.repositoryService.getLockInfo(target, fullName);
        if (!recursive && current.state === 'own' && current.confirmed !== false) {
          messages.push(`«${path}» уже захвачен в этом проекте.`);
          units.add(isRootLockName(fullName) ? path : fullName);
          return 'done';
        }
        // Кэш не гарантирует, что единица свободна. Повторный -Revised может заменить правки в базе.
        return runAfterConfirmation(`Захват «${path}»`, 'Захватить', operationPrompt('Захватить'),
          () => runRepositoryLockFlow(node, recursive, services, flow));
      }
      case 'unlock':
        return runRepositoryUnlockFlow(node, { recursive, force: input.force ?? false }, services, flow);
      case 'update': {
        const versionLabel = version ? ` (версия ${version})` : ' (актуальная версия)';
        return runAfterConfirmation(`Получение «${path}»`, 'Получить', operationPrompt('Получить', versionLabel),
          () => runRepositoryUpdateFlow(node, { recursive, force: true, version }, services, flow));
      }
    }
  }

  async function runAfterConfirmation(
    label: string,
    button: string,
    message: string,
    run: () => Promise<RepositoryFlowOutcome>,
  ): Promise<RepositoryFlowOutcome | 'cancelled'> {
    if (!ensureRepositoryGuardFree(services, flow, label)) {
      return 'busy';
    }
    const confirmed = await repositoryDeps.confirmOperation(message, button);
    // Клиент мог отменить MCP-запрос, пока пользователь видел диалог редактора.
    return confirmed && !signal.aborted ? run() : 'cancelled';
  }

  function operationPrompt(verb: string, versionLabel = ''): string {
    const scope = recursive ? ' с подчинёнными объектами' : '';
    return `${verb} «${path}»${scope} для «${target.displayName}» из хранилища${versionLabel}? `
      + 'Операция может заменить непомещённые изменения в базе.';
  }
}
