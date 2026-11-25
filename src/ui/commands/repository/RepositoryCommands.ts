import * as path from 'path';
import * as vscode from 'vscode';
import type { RepositoryNodeRef, RepositoryService, RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { CommandServices, NodeArg } from '../_shared';
import {
  ensureTargetUpdatedBeforeCommit,
  refreshRepositoryUi,
} from './RepositoryDatabaseSync';
import { DEFAULT_REPOSITORY_BIND_DEPS, type RepositoryBindDeps } from './RepositoryBindFlow';
import {
  askRecursiveMode,
  pickDisconnectForce,
  promptRepositoryVersion,
} from './RepositoryCommandDialogs';
import { type RepositoryCliCommandServices, runRepositoryCliCommand } from './RepositoryCommandRunner';
import { runRepositoryConnectionCommand } from './RepositoryConnectionCommands';
import {
  DEFAULT_REPOSITORY_FILE_SYNC_DEPS,
  ensureRepositoryGuardFree,
  type RepositoryFileSyncDeps,
} from './RepositoryFileSyncShared';
import { runRepositoryFullUpdate } from './RepositoryFullUpdate';
import { runRepositoryLockFlow, runRepositoryUpdateFlow } from './RepositoryLockSync';
import { runRepositoryCommitFlow, runRepositoryUnlockFlow } from './RepositoryUnlockSync';

interface BooleanPickItem extends vscode.QuickPickItem {
  value: boolean;
}

interface ReportFlagItem extends vscode.QuickPickItem {
  flag:
    | 'GroupByObject'
    | 'GroupByComment'
    | 'DoNotIncludeVersionsWithLabels'
    | 'IncludeOnlyVersionsWithLabels'
    | 'IncludeCommentLinesWithDoubleSlash';
}

interface RightsPickItem extends vscode.QuickPickItem {
  value: 'ReadOnly' | 'LockObjects' | 'ManageConfigurationVersions' | 'Administration';
}

type RepositoryCommandNode = NodeArg & RepositoryNodeRef;

/**
 * Регистрирует команды работы с хранилищем конфигурации.
 */
export function registerRepositoryCommands(
  context: vscode.ExtensionContext,
  services: CommandServices,
  deps: RepositoryFileSyncDeps = DEFAULT_REPOSITORY_FILE_SYNC_DEPS,
  bindDeps: RepositoryBindDeps = DEFAULT_REPOSITORY_BIND_DEPS
): void {
  context.subscriptions.push(
    ...(['connect', 'create'] as const).map((mode) =>
      vscode.commands.registerCommand(`onecdev.repository.${mode}`, async (node: NodeArg) => {
        const resolved = requireFreeRootTarget(services, deps, node,
          mode === 'connect' ? 'Подключение к хранилищу' : 'Создание хранилища', false);
        if (resolved) {
          await runRepositoryConnectionCommand(mode, resolved, services, deps, bindDeps);
        }
      })),

    vscode.commands.registerCommand('onecdev.repository.disconnect', async (node: NodeArg) => {
      const resolved = requireFreeRootTarget(services, deps, node, 'Отключение от хранилища', true);
      if (!resolved) {
        return;
      }
      const { target, title } = resolved;

      const force = await pickDisconnectForce(target.displayName);
      if (force === undefined) {
        return;
      }

      await runRepositoryCliCommand({
        command: 'repository-unbind',
        target,
        extraArgs: force ? ['-Force'] : [],
        progressTitle: title,
        progressStartMessage: 'Отключаю конфигурацию от хранилища...',
        successMessage: `Конфигурация "${target.displayName}" отключена от хранилища.`,
        errorTitle: `Ошибка отключения "${target.displayName}" от хранилища.`,
        failureOperation: 'отключении от хранилища',
        afterSuccess: async () => {
          await services.repositoryService.clearBinding(target);
          refreshRepositoryUi(services);
        },
      }, toCliServices(services), deps.runRepositoryCli, deps.notifyBusy);
    }),

    vscode.commands.registerCommand('onecdev.repository.lock', async (node: NodeArg) => {
      const repositoryNode = requireRepositoryNode(services, node);
      if (!repositoryNode) {
        return;
      }
      const label = repositoryNode.label ?? 'выбранный узел';
      // Занятость проверяется до вопросов пользователю: иначе он отвечал бы на них
      // ради операции, которая всё равно не стартует.
      if (!ensureRepositoryGuardFree(services, deps, `Захват «${label}»`)) {
        return;
      }

      const recursive = await askRecursiveMode(
        'Захват объектов',
        label,
        services.repositoryService.canApplyRecursively(repositoryNode)
      );
      if (recursive === undefined) {
        return;
      }

      if (await runRepositoryLockFlow(repositoryNode, recursive, services, deps) === 'done') {
        refreshRepositoryUi(services);
      }
    }),

    vscode.commands.registerCommand('onecdev.repository.unlock', async (node: NodeArg) => {
      const repositoryNode = requireRepositoryNode(services, node);
      if (!repositoryNode) {
        return;
      }
      const label = repositoryNode.label ?? 'выбранный узел';
      if (!ensureRepositoryGuardFree(services, deps, `Освобождение «${label}»`)) {
        return;
      }

      const recursive = await askRecursiveMode(
        'Освобождение объектов',
        label,
        services.repositoryService.canApplyRecursively(repositoryNode)
      );
      if (recursive === undefined) {
        return;
      }

      // Правки живут в файлах выгрузки, а не в базе: для пользователя освобождение — всегда
      // «отпустить объект». Без -force Конфигуратор лишь отказывает на изменённом в базе объекте (#190).
      if (await runRepositoryUnlockFlow(repositoryNode, { recursive, force: true }, services, deps) === 'done') {
        refreshRepositoryUi(services);
      }
    }),

    vscode.commands.registerCommand('onecdev.repository.commit', async (node: NodeArg) => {
      const repositoryNode = requireRepositoryNode(services, node);
      if (!repositoryNode) {
        return;
      }
      if (!ensureRepositoryGuardFree(services, deps, `Помещение «${repositoryNode.label ?? 'выбранный узел'}»`)) {
        return;
      }

      const target = requireTarget(services.repositoryService, repositoryNode);
      if (!target) {
        return;
      }

      const updatedBeforeCommit = await ensureTargetUpdatedBeforeCommit(target, services);
      if (!updatedBeforeCommit) {
        return;
      }

      const fullName = services.repositoryService.resolveFullName(repositoryNode);
      const initiallyLocked = fullName ? services.repositoryService.isLocked(target, fullName) : false;
      const formData = await services.repositoryCommitViewProvider.show(
        repositoryNode.label ?? target.displayName,
        initiallyLocked
      );
      if (!formData) {
        return;
      }
      if (!formData.comment.trim()) {
        await vscode.window.showWarningMessage('Для помещения требуется комментарий.');
        return;
      }

      if (await runRepositoryCommitFlow(repositoryNode, formData, services, deps) === 'done') {
        refreshRepositoryUi(services);
      }
    }),

    vscode.commands.registerCommand('onecdev.repository.update', (node: NodeArg) =>
      runRepositoryUpdateCommand(services, deps, node, false)
    ),

    vscode.commands.registerCommand('onecdev.repository.updateToVersion', (node: NodeArg) =>
      runRepositoryUpdateCommand(services, deps, node, true)
    ),

    vscode.commands.registerCommand('onecdev.repository.fullUpdate', (node: NodeArg) => {
      const target = requireRootTarget(services, node);
      if (target && ensureConnected(services.repositoryService, target)) {
        return runRepositoryFullUpdate(target, services, deps);
      }
    }),

    vscode.commands.registerCommand('onecdev.repository.addUser', async (node: NodeArg) => {
      const resolved = requireFreeRootTarget(services, deps, node, 'Пользователь хранилища', true);
      if (!resolved) {
        return;
      }
      const { target, title } = resolved;

      const userName = await promptRequiredText('Добавление пользователя', 'Имя пользователя хранилища');
      if (!userName) {
        return;
      }
      const password = await promptRequiredText('Добавление пользователя', 'Пароль пользователя', true);
      if (!password) {
        return;
      }
      const rights = await pickRights();
      if (!rights) {
        return;
      }
      const restoreDeletedUser = await pickBoolean(
        'Добавление пользователя',
        'Восстанавливать пользователя, если он был удалён?',
        'Да, восстановить',
        'Нет'
      );
      if (restoreDeletedUser === undefined) {
        return;
      }

      await runRepositoryCliCommand({
        command: 'repository-add-user',
        target,
        extraArgs: [
          '-User', userName,
          '-Pwd', password,
          '-Rights', rights,
          ...(restoreDeletedUser ? ['-RestoreDeletedUser'] : []),
        ],
        progressTitle: title,
        progressStartMessage: 'Добавляю пользователя в хранилище...',
        successMessage: `Пользователь "${userName}" добавлен в хранилище.`,
        errorTitle: `Ошибка добавления пользователя в хранилище "${target.displayName}".`,
        failureOperation: 'добавлении пользователя в хранилище',
      }, toCliServices(services), deps.runRepositoryCli, deps.notifyBusy);
    }),

    vscode.commands.registerCommand('onecdev.repository.copyUsers', async (node: NodeArg) => {
      const resolved = requireFreeRootTarget(services, deps, node, 'Копирование пользователей', true);
      if (!resolved) {
        return;
      }
      const { target, title } = resolved;

      const sourcePath = await promptRequiredText('Копирование пользователей', 'Путь к исходному хранилищу или его каталогу');
      if (!sourcePath) {
        return;
      }
      const userName = await promptRequiredText('Копирование пользователей', 'Имя пользователя исходного хранилища');
      if (!userName) {
        return;
      }
      const password = await promptRequiredText('Копирование пользователей', 'Пароль пользователя исходного хранилища', true);
      if (!password) {
        return;
      }
      const restoreDeletedUser = await pickBoolean(
        'Копирование пользователей',
        'Восстанавливать удалённых пользователей?',
        'Да, восстанавливать',
        'Нет'
      );
      if (restoreDeletedUser === undefined) {
        return;
      }

      await runRepositoryCliCommand({
        command: 'repository-copy-users',
        target,
        extraArgs: [
          '-Path', sourcePath,
          '-User', userName,
          '-Pwd', password,
          ...(restoreDeletedUser ? ['-RestoreDeletedUser'] : []),
        ],
        progressTitle: title,
        progressStartMessage: 'Копирую пользователей из другого хранилища...',
        successMessage: `Пользователи для "${target.displayName}" скопированы.`,
        errorTitle: `Ошибка копирования пользователей в хранилище "${target.displayName}".`,
        failureOperation: 'копировании пользователей хранилища',
      }, toCliServices(services), deps.runRepositoryCli, deps.notifyBusy);
    }),

    vscode.commands.registerCommand('onecdev.repository.dump', async (node: NodeArg) => {
      const resolved = requireFreeRootTarget(services, deps, node, 'Выгрузка версии', true);
      if (!resolved) {
        return;
      }
      const { target, title } = resolved;

      const fileUri = await vscode.window.showSaveDialog({
        title: 'Выгрузка версии из хранилища',
        defaultUri: vscode.Uri.file(path.join(
          services.workspaceFolder.uri.fsPath,
          '.onecdev',
          `${sanitizeFileName(target.displayName)}.cf`
        )),
        filters: {
          'Файл конфигурации 1С': ['cf'],
          'Все файлы': ['*'],
        },
      });
      if (!fileUri) {
        return;
      }

      const version = await vscode.window.showInputBox({
        title: 'Выгрузка версии из хранилища',
        prompt: 'Версия для выгрузки. Оставьте пустым для актуальной.',
        placeHolder: 'Например: 125',
        ignoreFocusOut: true,
      });
      if (version === undefined) {
        return;
      }

      await runRepositoryCliCommand({
        command: 'repository-dump',
        target,
        extraArgs: [
          '-File', fileUri.fsPath,
          ...(version.trim() ? ['-Version', version.trim()] : []),
        ],
        progressTitle: title,
        progressStartMessage: 'Выгружаю конфигурацию из хранилища...',
        successMessage: `Версия хранилища "${target.displayName}" выгружена в "${fileUri.fsPath}".`,
        errorTitle: `Ошибка выгрузки версии хранилища "${target.displayName}".`,
        failureOperation: 'выгрузке версии из хранилища',
      }, toCliServices(services), deps.runRepositoryCli, deps.notifyBusy);
    }),

    vscode.commands.registerCommand('onecdev.repository.report', async (node: NodeArg) => {
      const resolved = requireFreeRootTarget(services, deps, node, 'Отчёт по хранилищу', true);
      if (!resolved) {
        return;
      }
      const { target, title } = resolved;

      const format = await pickReportFormat();
      if (!format) {
        return;
      }
      const defaultExtension = format === 'mxl' ? 'mxl' : 'txt';
      const fileUri = await vscode.window.showSaveDialog({
        title: 'Отчёт по хранилищу',
        defaultUri: vscode.Uri.file(path.join(
          services.workspaceFolder.uri.fsPath,
          '.onecdev',
          `repository-report-${sanitizeFileName(target.displayName)}.${defaultExtension}`
        )),
        filters: {
          'Файлы отчёта': [defaultExtension],
          'Все файлы': ['*'],
        },
      });
      if (!fileUri) {
        return;
      }

      const nBegin = await promptOptionalText('Отчёт по хранилищу', 'Начальная версия');
      if (nBegin === undefined) {
        return;
      }
      const nEnd = await promptOptionalText('Отчёт по хранилищу', 'Конечная версия');
      if (nEnd === undefined) {
        return;
      }
      const dateBegin = await promptOptionalText('Отчёт по хранилищу', 'Начальная дата');
      if (dateBegin === undefined) {
        return;
      }
      const dateEnd = await promptOptionalText('Отчёт по хранилищу', 'Конечная дата');
      if (dateEnd === undefined) {
        return;
      }
      const configurationVersion = await promptOptionalText(
        'Отчёт по хранилищу',
        'Фильтр по номеру версии конфигурации'
      );
      if (configurationVersion === undefined) {
        return;
      }

      const flags = await pickReportFlags();
      if (!flags) {
        return;
      }

      await runRepositoryCliCommand({
        command: 'repository-report',
        target,
        extraArgs: [
          '-File', fileUri.fsPath,
          ...(nBegin.trim() ? ['-NBegin', nBegin.trim()] : []),
          ...(nEnd.trim() ? ['-NEnd', nEnd.trim()] : []),
          ...(dateBegin.trim() ? ['-DateBegin', dateBegin.trim()] : []),
          ...(dateEnd.trim() ? ['-DateEnd', dateEnd.trim()] : []),
          ...(configurationVersion.trim() ? ['-ConfigurationVersion', configurationVersion.trim()] : []),
          '-ReportFormat', format,
          ...flags.flatMap((flag) => [`-${flag}`]),
        ],
        progressTitle: title,
        progressStartMessage: 'Строю отчёт по истории хранилища...',
        successMessage: `Отчёт по хранилищу "${target.displayName}" сформирован.`,
        errorTitle: `Ошибка построения отчёта по хранилищу "${target.displayName}".`,
        failureOperation: 'построении отчёта по хранилищу',
      }, toCliServices(services), deps.runRepositoryCli, deps.notifyBusy);
    }),

    vscode.commands.registerCommand('onecdev.repository.setLabel', async (node: NodeArg) => {
      const resolved = requireFreeRootTarget(services, deps, node, 'Установка метки', true);
      if (!resolved) {
        return;
      }
      const { target, title } = resolved;

      const labelName = await promptRequiredText('Установка метки', 'Имя метки');
      if (!labelName) {
        return;
      }
      const version = await promptOptionalText('Установка метки', 'Версия. Оставьте пустым для текущей.');
      if (version === undefined) {
        return;
      }
      const comment = await promptOptionalText('Установка метки', 'Комментарий к метке');
      if (comment === undefined) {
        return;
      }

      await runRepositoryCliCommand({
        command: 'repository-set-label',
        target,
        extraArgs: [
          '-LabelName', labelName,
          ...(version.trim() ? ['-Version', version.trim()] : []),
          ...(comment.trim() ? ['-Comment', comment.trim()] : []),
        ],
        progressTitle: title,
        progressStartMessage: 'Устанавливаю метку версии в хранилище...',
        successMessage: `Метка "${labelName}" установлена для "${target.displayName}".`,
        errorTitle: `Ошибка установки метки для "${target.displayName}".`,
        failureOperation: 'установке метки хранилища',
      }, toCliServices(services), deps.runRepositoryCli, deps.notifyBusy);
    })
  );
}

/**
 * Получение из хранилища: актуальной версии или указанной (`withVersion`). Номер
 * версии спрашивается раньше режимов — без него остальные ответы не нужны.
 */
async function runRepositoryUpdateCommand(
  services: CommandServices,
  deps: RepositoryFileSyncDeps,
  node: NodeArg,
  withVersion: boolean
): Promise<void> {
  const repositoryNode = requireRepositoryNode(services, node);
  if (!repositoryNode) {
    return;
  }
  const label = repositoryNode.label ?? 'выбранный узел';
  if (!ensureRepositoryGuardFree(services, deps, `Получение «${label}»`)) {
    return;
  }

  const title = withVersion ? 'Получение версии из хранилища' : 'Получение из хранилища';
  const version = withVersion ? await promptRepositoryVersion(title) : undefined;
  if (withVersion && version === undefined) {
    return;
  }
  const recursive = await askRecursiveMode(title, label, services.repositoryService.canApplyRecursively(repositoryNode));
  if (recursive === undefined) {
    return;
  }
  // `-Force` всегда: на стенде 8.5.1 он не меняет результат (новые и удалённые объекты
  // применяются и без него), а по документации платформы подтверждает их получение —
  // вопрос пользователю ничего бы не решал (issue #80).
  if (await runRepositoryUpdateFlow(repositoryNode, { recursive, force: true, version }, services, deps) === 'done') {
    refreshRepositoryUi(services);
  }
}

function toCliServices(services: CommandServices): RepositoryCliCommandServices {
  return {
    workspaceFolder: services.workspaceFolder,
    outputChannel: services.outputChannel,
    repositoryService: services.repositoryService,
    projectSecretStorage: services.projectSecretStorage,
    configurationOperationGuard: services.configurationOperationGuard,
  };
}

function requireRootTarget(services: CommandServices, node: NodeArg): RepositoryTarget | null {
  const repositoryNode = node as RepositoryCommandNode | undefined;
  if (!repositoryNode?.xmlPath || (repositoryNode.nodeKind !== 'configuration' && repositoryNode.nodeKind !== 'extension')) {
    void vscode.window.showWarningMessage('Команда хранилища доступна только для корня основной конфигурации или расширения.');
    return null;
  }

  return requireTarget(services.repositoryService, repositoryNode);
}

/**
 * Корень конфигурации для команды Конфигуратора и заголовок её аренды guard'а.
 * Занятость проверяется до форм и диалогов: иначе пользователь заполнял бы их ради
 * процесса, который всё равно не стартует.
 */
function requireFreeRootTarget(
  services: CommandServices,
  deps: RepositoryFileSyncDeps,
  node: NodeArg,
  operation: string,
  requireConnection: boolean
): { target: RepositoryTarget; title: string } | null {
  const target = requireRootTarget(services, node);
  if (!target || (requireConnection && !ensureConnected(services.repositoryService, target))) {
    return null;
  }
  const title = `${operation}: ${target.displayName}`;
  return ensureRepositoryGuardFree(services, deps, title) ? { target, title } : null;
}

function requireRepositoryNode(services: CommandServices, node: NodeArg): RepositoryCommandNode | null {
  const repositoryNode = node as RepositoryCommandNode | undefined;
  if (!repositoryNode?.xmlPath) {
    void vscode.window.showWarningMessage('Команда хранилища доступна только для узлов конфигурации с XML.');
    return null;
  }

  const target = requireTarget(services.repositoryService, repositoryNode);
  if (!target || !ensureConnected(services.repositoryService, target)) {
    return null;
  }

  return repositoryNode;
}

function requireTarget(repositoryService: RepositoryService, node: RepositoryNodeRef): RepositoryTarget | null {
  if (!node.xmlPath) {
    return null;
  }
  return repositoryService.resolveTargetByXmlPath(node.xmlPath);
}

function ensureConnected(repositoryService: RepositoryService, target: RepositoryTarget): boolean {
  if (!repositoryService.hasBinding(target) || !repositoryService.isConnected(target)) {
    void vscode.window.showWarningMessage(`Для "${target.displayName}" нет активного подключения к хранилищу.`);
    return false;
  }
  return true;
}

async function pickBoolean(
  title: string,
  placeHolder: string,
  trueLabel: string,
  falseLabel: string
): Promise<boolean | undefined> {
  const items: BooleanPickItem[] = [
    { label: trueLabel, value: true },
    { label: falseLabel, value: false },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder,
    ignoreFocusOut: true,
  });
  return picked?.value;
}

async function pickRights(): Promise<RightsPickItem['value'] | undefined> {
  const items: RightsPickItem[] = [
    {
      label: 'Administration',
      description: 'Полный административный доступ к хранилищу',
      value: 'Administration',
    },
    {
      label: 'ManageConfigurationVersions',
      description: 'Управление версиями и метками',
      value: 'ManageConfigurationVersions',
    },
    {
      label: 'LockObjects',
      description: 'Захват, освобождение и помещение объектов',
      value: 'LockObjects',
    },
    {
      label: 'ReadOnly',
      description: 'Только чтение истории и версий',
      value: 'ReadOnly',
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Права пользователя хранилища',
    placeHolder: 'Выберите набор прав',
    ignoreFocusOut: true,
  });
  return picked?.value;
}

async function pickReportFormat(): Promise<'txt' | 'mxl' | undefined> {
  const picked = await vscode.window.showQuickPick([
    { label: 'txt', description: 'Текстовый отчёт' },
    { label: 'mxl', description: 'Табличный документ 1С' },
  ], {
    title: 'Формат отчёта по хранилищу',
    placeHolder: 'Выберите формат файла отчёта',
    ignoreFocusOut: true,
  });

  if (picked?.label === 'txt' || picked?.label === 'mxl') {
    return picked.label;
  }
  return undefined;
}

async function pickReportFlags(): Promise<ReportFlagItem['flag'][] | undefined> {
  const items: ReportFlagItem[] = [
    {
      label: 'Группировать по объектам',
      description: 'Параметр GroupByObject',
      flag: 'GroupByObject',
    },
    {
      label: 'Группировать по комментариям',
      description: 'Параметр GroupByComment',
      flag: 'GroupByComment',
    },
    {
      label: 'Исключить версии с метками',
      description: 'Параметр DoNotIncludeVersionsWithLabels',
      flag: 'DoNotIncludeVersionsWithLabels',
    },
    {
      label: 'Включить только версии с метками',
      description: 'Параметр IncludeOnlyVersionsWithLabels',
      flag: 'IncludeOnlyVersionsWithLabels',
    },
    {
      label: 'Включать строки комментариев с //',
      description: 'Параметр IncludeCommentLinesWithDoubleSlash',
      flag: 'IncludeCommentLinesWithDoubleSlash',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Дополнительные параметры отчёта',
    placeHolder: 'Можно выбрать несколько флагов или не выбирать ни одного',
    canPickMany: true,
    ignoreFocusOut: true,
  });
  return picked?.map((item) => item.flag);
}

async function promptRequiredText(title: string, prompt: string, password = false): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title,
    prompt,
    password,
    ignoreFocusOut: true,
    validateInput: (input) => (input.trim() ? undefined : 'Значение обязательно'),
  });
  return value?.trim();
}

async function promptOptionalText(title: string, prompt: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    prompt,
    ignoreFocusOut: true,
  });
}

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_');
}
