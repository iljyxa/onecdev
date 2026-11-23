import {
  buildRepositoryBindArgs,
  buildRepositoryCreateArgs,
  createBindsProject,
  type RepositoryConnectionMode,
} from '../../../infra/repository/RepositoryConnectionOptions';
import type { RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type {
  RepositoryConnectionFormData,
  RepositoryConnectionSubmitOutcome,
} from '../../views/RepositoryConnectionViewProvider';
import type { CommandServices } from '../_shared';
import {
  completeRepositoryBind,
  describeBindFailureHint,
  type RepositoryBindDeps,
  resolveConnectionInitialBinding,
  validateBindingForm,
} from './RepositoryBindFlow';
import { runRepositoryCliCommand } from './RepositoryCommandRunner';
import { refreshRepositoryUi } from './RepositoryDatabaseSync';
import type { RepositoryFileSyncDeps } from './RepositoryFileSyncShared';

/**
 * Команды «Подключить к хранилищу» и «Создать хранилище» (issues #184, #185). Форма остаётся
 * открытой, пока Конфигуратор не отработает: проверка полей и запуск команды идут из `onSubmit`
 * провайдера, неуспех возвращается в форму. Определение своих захватов (`completeRepositoryBind`,
 * issue #106) — уже после закрытия формы: это долгая пост-синхронизация, форма её не ждёт.
 */

interface BindSubmitted {
  readonly repoUser: string;
  readonly bindOutput: string;
  /** Привязан ли проект к хранилищу: создание с `-NoBind` его не привязывает. */
  readonly bound: boolean;
}

interface ModeSpec {
  readonly progressStartMessage: string;
  readonly successMessage: (name: string) => string;
  readonly errorTitle: (name: string) => string;
  readonly failureOperation: string;
  readonly command: string;
  readonly args: (form: RepositoryConnectionFormData) => string[];
  readonly binds: (form: RepositoryConnectionFormData) => boolean;
  readonly failureHint?: (output: string) => string | undefined;
}

const MODES: Record<RepositoryConnectionMode, ModeSpec> = {
  connect: {
    command: 'repository-bind',
    args: buildRepositoryBindArgs,
    binds: () => true,
    progressStartMessage: 'Подключаю конфигурацию к хранилищу...',
    successMessage: (name) => `Конфигурация "${name}" подключена к хранилищу.`,
    errorTitle: (name) => `Ошибка подключения "${name}" к хранилищу.`,
    failureOperation: 'подключении к хранилищу',
    failureHint: describeBindFailureHint,
  },
  create: {
    command: 'repository-create',
    args: buildRepositoryCreateArgs,
    binds: createBindsProject,
    progressStartMessage: 'Создаю хранилище конфигурации...',
    successMessage: (name) => `Хранилище для "${name}" создано.`,
    errorTitle: (name) => `Ошибка создания хранилища для "${name}".`,
    failureOperation: 'создании хранилища',
  },
};

export async function runRepositoryConnectionCommand(
  mode: RepositoryConnectionMode,
  request: { target: RepositoryTarget; title: string },
  services: CommandServices,
  deps: RepositoryFileSyncDeps,
  bindDeps: RepositoryBindDeps
): Promise<void> {
  const { target } = request;
  const submitted = await services.repositoryConnectionViewProvider.show<BindSubmitted>(
    mode,
    target.displayName,
    await resolveConnectionInitialBinding(target, services.repositoryService, bindDeps.notifyWarning),
    (form) => submitRepositoryConnection(MODES[mode], form, request, services, deps)
  );
  if (submitted?.bound) {
    await completeRepositoryBind({ target, repoUser: submitted.repoUser, bindOutput: submitted.bindOutput }, services, bindDeps);
  }
}

async function submitRepositoryConnection(
  spec: ModeSpec,
  form: RepositoryConnectionFormData,
  { target, title }: { target: RepositoryTarget; title: string },
  services: CommandServices,
  deps: RepositoryFileSyncDeps
): Promise<RepositoryConnectionSubmitOutcome<BindSubmitted>> {
  const validation = validateBindingForm(form);
  if (!validation.ok) {
    return { ok: false, error: validation.errorMessage };
  }
  const bound = spec.binds(form);
  let bindOutput = '';
  let failure = '';
  const ok = await runRepositoryCliCommand({
    command: spec.command,
    target,
    bindingOverride: validation.binding,
    extraArgs: spec.args(form),
    progressTitle: title,
    progressStartMessage: spec.progressStartMessage,
    successMessage: spec.successMessage(target.displayName),
    errorTitle: spec.errorTitle(target.displayName),
    failureOperation: spec.failureOperation,
    failureHint: spec.failureHint,
    reportFailure: (message) => { failure = message; },
    afterSuccess: async (output) => {
      bindOutput = output;
      await services.repositoryService.saveBinding(target, validation.binding);
      services.repositoryService.setConnected(target, bound);
      refreshRepositoryUi(services);
    },
  }, services, deps.runRepositoryCli, deps.notifyBusy);
  return ok
    ? { ok: true, value: { repoUser: validation.binding.repoUser, bindOutput, bound } }
    : { ok: false, error: failure };
}
