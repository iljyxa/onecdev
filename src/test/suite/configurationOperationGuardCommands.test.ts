/**
 * Issue #10 — интеграция общего `ConfigurationOperationGuard` с реальной
 * регистрацией команд `ExtensionCommands`/`RepositoryCommands`.
 *
 * Тестовый хост запускается БЕЗ workspace-папки (см. `src/test/runTests.ts` —
 * `launchArgs` не содержит открываемой папки), поэтому `extension.ts.activate()`
 * возвращает `undefined` до вызова `Container.bootstrap`, и ни один
 * `onecdev.*` command не зарегистрирован реальным расширением — проверено:
 * ни один существующий тест не строит workspaceFolders и не полагается на
 * реальную регистрацию `onecdev.*` (`rg "workspaceFolders" src/test/suite`
 * пусто). Поэтому регистрация тех же id вручную через
 * `registerExtensionCommands`/`registerRepositoryCommands`/`registerDbCommands`
 * с фейковым `context = { subscriptions: [] }` не конфликтует с уже
 * существующими командами. Команды регистрируются один раз на весь suite
 * (`suiteSetup`) с прокси на подменяемый `CommandServices`/`ExtensionCommandsDeps`,
 * чтобы каждый тест мог задать свой набор стабов, не пересоздавая регистрацию
 * (VS Code не позволяет повторно зарегистрировать тот же id без dispose
 * предыдущей регистрации).
 *
 * `RepositoryService`, `standaloneServerService`, `repositoryCommitViewProvider`
 * и остальные внешние по отношению к guard'у сервисы — записывающие стабы;
 * реальный смысл проверки — что при занятом guard соответствующие runner'ы
 * НЕ вызываются, а не бизнес-логика самих runner'ов (она уже покрыта другими
 * suite). Пути узлов — реальные фикстуры `example/2.21/src/cf` и
 * `example/2.21/src/cfe/EVOLC`.
 *
 * Issue #39 — команды `importConfigurations`/`updateChangedConfigurations`
 * возвращают явный `ConfigurationCommandOutcome` вместо `boolean`. Запуск
 * Конфигуратора (`decompileMainConfiguration`/`updateMainConfiguration`/
 * `updateExtension`/`decompileExtension`) и модальный выбор конфигураций
 * (`pickImportTargets`/`pickChangedConfigurations`) вынесены из тела команды
 * в `ExtensionCommandsDeps` (переименован из `ConnectExtensionDeps` — общая
 * точка внедрения для всех запусков Конфигуратора и модальных диалогов этой
 * команды), поэтому обе ветки успеха/провала/отмены/гонки с guard'ом
 * проверяются без реального процесса 1С и без реального QuickPick UI.
 * `registerDbCommands`/`registerConfigLifecycleTools` (MCP-мост
 * `onecdev_execute_command`) добавлены в тот же harness: обе точки идут
 * через `vscode.commands.executeCommand`, поэтому используют ОДНИ и те же
 * зарегистрированные на `servicesBox`/`depsProxy` команды.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ExtensionCommandsDeps, registerExtensionCommands } from '../../ui/commands/ext/ExtensionCommands';
import { disposeCachedAgentOperationServices } from '../../ui/commands/ext/ExtensionCommandRunner';
import { CONFIGURATION_OPERATION_BUSY_MESSAGE } from '../../ui/commands/ext/configurationOperationBusy';
import { registerRepositoryCommands } from '../../ui/commands/repository/RepositoryCommands';
import { registerDbCommands } from '../../ui/commands/db/DbCommands';
import { registerConfigLifecycleTools } from '../../ui/mcp/registration/McpConfigLifecycleTools';
import { McpMutationGate } from '../../ui/mcp/registration/McpMutationGate';
import type { McpCommandServices, McpRegistrationDeps } from '../../ui/mcp/registration/McpRegistrationDeps';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import type { CommandServices, NodeArg } from '../../ui/commands/_shared';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { createArgsRecordingDesigner } from './support/argsRecordingDesigner';
import { installFakeWebviewPanels } from './support/fakeWebviewPanel';
import { RepositoryCommitViewProvider } from '../../ui/views/RepositoryCommitViewProvider';
import type {
  RepositoryConnectionFormData,
  RepositoryConnectionSubmitOutcome,
} from '../../ui/views/RepositoryConnectionViewProvider';
import {
  DEFAULT_REPOSITORY_FILE_SYNC_DEPS,
  type RepositoryFileSyncDeps,
} from '../../ui/commands/repository/RepositoryFileSyncShared';
import type { RepositoryCliRequest, RepositoryCliResult } from '../../ui/commands/repository/RepositoryCommandRunner';

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const EXAMPLE_CFE_EVOLC = path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC');

// Имена — реальный <Name> из Configuration.xml соответствующей фикстуры
// (readConfigName/parseConfigXml), а не метка узла дерева (та отдельно
// задаётся полем label в CF_NODE/CFE_NODE ниже и используется только
// командами, работающими с уже смонтированным узлом дерева).
const CF_NAME = 'ТорговыйУчет';
const CFE_NAME = 'EVOLC';

const CF_NODE: NodeArg = {
  xmlPath: path.join(EXAMPLE_CF, 'Configuration.xml'),
  nodeKind: 'configuration',
  label: 'Основная конфигурация',
};
const CFE_NODE: NodeArg = {
  xmlPath: path.join(EXAMPLE_CFE_EVOLC, 'Configuration.xml'),
  nodeKind: 'extension',
  label: 'EVOLC',
};

function notCalled(name: string): () => never {
  return () => {
    throw new Error(`"${name}" не должен вызываться в этом сценарии`);
  };
}

/**
 * Минимальный набор `CommandServices`, достаточный для тела обеих регистраций.
 * Поля, не участвующие в проверяемом сценарии, — throw-стабы: случайный вызов
 * должен провалить тест громко, а не тихо превратиться в no-op.
 */
function createServices(overrides: Partial<CommandServices> = {}): CommandServices {
  const base: Partial<CommandServices> = {
    treeProvider: {
      getEntries: notCalled('treeProvider.getEntries'),
      refresh: notCalled('treeProvider.refresh'),
    } as unknown as CommandServices['treeProvider'],
    workspaceFolder: { uri: vscode.Uri.file(EXAMPLE_CF), name: 'fixture', index: 0 },
    outputChannel: { appendLine: () => undefined } as unknown as vscode.OutputChannel,
    standaloneServerService: {
      refreshHealth: notCalled('standaloneServerService.refreshHealth'),
      stop: notCalled('standaloneServerService.stop'),
      start: notCalled('standaloneServerService.start'),
    } as unknown as CommandServices['standaloneServerService'],
    getChangedConfigurations: notCalled('getChangedConfigurations'),
    markConfigurationsClean: notCalled('markConfigurationsClean'),
    setTreeProcessingState: notCalled('setTreeProcessingState'),
    reloadEntries: notCalled('reloadEntries'),
    refreshActionsView: notCalled('refreshActionsView'),
    repositoryService: {
      resolveTargetByXmlPath: notCalled('repositoryService.resolveTargetByXmlPath'),
      hasBinding: notCalled('repositoryService.hasBinding'),
      isConnected: notCalled('repositoryService.isConnected'),
      resolveFullName: notCalled('repositoryService.resolveFullName'),
      isLocked: notCalled('repositoryService.isLocked'),
    } as unknown as RepositoryService,
    repositoryCommitViewProvider: {
      show: notCalled('repositoryCommitViewProvider.show'),
    } as unknown as CommandServices['repositoryCommitViewProvider'],
    configurationOperationGuard: new ConfigurationOperationGuard(),
  };
  return { ...base, ...overrides } as unknown as CommandServices;
}

/**
 * Регистрация вызывается один раз на suite с объектом-прокси: сами команды
 * не пересоздаются между тестами (VS Code не разрешает повторную регистрацию
 * того же id без dispose), а каждый тест подменяет реальный набор через
 * `currentServices`, на который прокси делегирует чтение свойств.
 */
const servicesBox: { current: CommandServices } = { current: createServices() };

function createServicesProxy(): CommandServices {
  return new Proxy(
    {},
    {
      get(_target, prop: PropertyKey) {
        const value: unknown = Reflect.get(servicesBox.current, prop);
        return value;
      },
    }
  ) as CommandServices;
}

/**
 * Запуск Конфигуратора (декомпиляция/обновление) и модальные диалоги выбора
 * конфигураций — единственная точка внедрения для `importConfigurations`/
 * `updateChangedConfigurations`/`connectExtension`. По умолчанию — throw-стабы:
 * сценарии, не касающиеся соответствующей ветки, не должны до них доходить.
 */
function createDeps(overrides: Partial<ExtensionCommandsDeps> = {}): ExtensionCommandsDeps {
  return {
    listDatabaseExtensions: notCalled('listDatabaseExtensions'),
    decompileExtension: notCalled('decompileExtension'),
    decompileMainConfiguration: notCalled('decompileMainConfiguration'),
    updateMainConfiguration: notCalled('updateMainConfiguration'),
    updateExtension: notCalled('updateExtension'),
    pickImportTargets: notCalled('pickImportTargets'),
    pickChangedConfigurations: notCalled('pickChangedConfigurations'),
    ...overrides,
  };
}

const depsBox: { current: ExtensionCommandsDeps } = { current: createDeps() };

const depsProxy: ExtensionCommandsDeps = {
  listDatabaseExtensions: (...args) => depsBox.current.listDatabaseExtensions(...args),
  decompileExtension: (...args) => depsBox.current.decompileExtension(...args),
  decompileMainConfiguration: (...args) => depsBox.current.decompileMainConfiguration(...args),
  updateMainConfiguration: (...args) => depsBox.current.updateMainConfiguration(...args),
  updateExtension: (...args) => depsBox.current.updateExtension(...args),
  pickImportTargets: (...args) => depsBox.current.pickImportTargets(...args),
  pickChangedConfigurations: (...args) => depsBox.current.pickChangedConfigurations(...args),
};

/**
 * Точки внешнего мира потоков хранилища (процесс 1С, выгрузка, диалоги) — тем же
 * приёмом прокси: по умолчанию настоящие, конкретный тест подменяет на заглушки.
 */
const repositoryDepsBox: { current: RepositoryFileSyncDeps } = { current: DEFAULT_REPOSITORY_FILE_SYNC_DEPS };

const repositoryDepsProxy = new Proxy(
  {},
  {
    get(_target, prop: PropertyKey) {
      const value: unknown = Reflect.get(repositoryDepsBox.current, prop);
      return value;
    },
  }
) as RepositoryFileSyncDeps;

/**
 * Диалоги `vscode.window.show*Message` подменяются на весь suite (а не только
 * внутри вложенного issue #38), чтобы новые сценарии issue #39 могли
 * детерминированно проверить факт/количество уведомлений и — для no-targets —
 * то, что предупреждение показывается БЕЗ ожидания его закрытия (запрет
 * CLAUDE.md №18). Вложенный suite issue #38 ниже переопределяет те же методы
 * локально и восстанавливает их обратно на эти общие для suite стабы в своём
 * teardown — стек подмен корректен.
 */
type WindowMessageStubs = Pick<typeof vscode.window, 'showInformationMessage' | 'showWarningMessage' | 'showErrorMessage'>;
const windowRef = vscode.window as WindowMessageStubs;
let originalWindowMessageStubs: WindowMessageStubs;
let bridgeInformationMessages: string[];
let bridgeWarningMessages: string[];
let bridgeErrorMessages: string[];
/** По умолчанию разрешается сразу; конкретный тест может подменить на «никогда не разрешается». */
let bridgeWarningMessageResolver: () => Thenable<string | undefined>;

suite('ConfigurationOperationGuard — интеграция ExtensionCommands/RepositoryCommands (issue #10)', () => {
  let context: vscode.ExtensionContext;

  suiteSetup(() => {
    context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    registerExtensionCommands(context, createServicesProxy(), depsProxy);
    registerRepositoryCommands(context, createServicesProxy(), repositoryDepsProxy);
    registerDbCommands(context, createServicesProxy());

    originalWindowMessageStubs = {
      showInformationMessage: vscode.window.showInformationMessage,
      showWarningMessage: vscode.window.showWarningMessage,
      showErrorMessage: vscode.window.showErrorMessage,
    };
    windowRef.showInformationMessage = (message: string) => {
      bridgeInformationMessages.push(message);
      return Promise.resolve(undefined);
    };
    windowRef.showWarningMessage = (message: string) => {
      bridgeWarningMessages.push(message);
      return bridgeWarningMessageResolver();
    };
    windowRef.showErrorMessage = (message: string) => {
      bridgeErrorMessages.push(message);
      return Promise.resolve(undefined);
    };
  });

  suiteTeardown(async () => {
    (context.subscriptions as vscode.Disposable[]).forEach((subscription) => { subscription.dispose(); });
    await disposeCachedAgentOperationServices();
    windowRef.showInformationMessage = originalWindowMessageStubs.showInformationMessage;
    windowRef.showWarningMessage = originalWindowMessageStubs.showWarningMessage;
    windowRef.showErrorMessage = originalWindowMessageStubs.showErrorMessage;
  });

  setup(() => {
    servicesBox.current = createServices();
    depsBox.current = createDeps();
    bridgeInformationMessages = [];
    bridgeWarningMessages = [];
    bridgeErrorMessages = [];
    bridgeWarningMessageResolver = () => Promise.resolve(undefined);
  });

  test('guard занят «Хранилище: синхронизация» — updateChangedConfigurations сразу возвращает busy с heldBy, getChangedConfigurations/setTreeProcessingState не вызваны, одно уведомление, аренда цела', async () => {
    const guard = new ConfigurationOperationGuard();
    const lease = guard.tryAcquire('Хранилище: синхронизация');
    let getChangedCalls = 0;
    let setTreeCalls = 0;
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      getChangedConfigurations: () => { getChangedCalls += 1; return []; },
      setTreeProcessingState: () => { setTreeCalls += 1; },
    });

    const result = await vscode.commands.executeCommand('onecdev.updateChangedConfigurations');

    assert.deepStrictEqual(result, { status: 'busy', heldBy: 'Хранилище: синхронизация' });
    assert.strictEqual(getChangedCalls, 0);
    assert.strictEqual(setTreeCalls, 0);
    assert.strictEqual(guard.isBusy, true);
    assert.strictEqual(guard.heldBy, 'Хранилище: синхронизация');
    assert.deepStrictEqual(bridgeInformationMessages, [CONFIGURATION_OPERATION_BUSY_MESSAGE]);
    lease?.release();
  });

  test('guard занят «Хранилище: синхронизация» — importConfigurations сразу возвращает busy с heldBy, treeProvider.getEntries не вызван, одно уведомление', async () => {
    const guard = new ConfigurationOperationGuard();
    const lease = guard.tryAcquire('Хранилище: синхронизация');
    let getEntriesCalls = 0;
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      treeProvider: { getEntries: () => { getEntriesCalls += 1; return []; } } as unknown as CommandServices['treeProvider'],
    });

    const result = await vscode.commands.executeCommand('onecdev.importConfigurations');

    assert.deepStrictEqual(result, { status: 'busy', heldBy: 'Хранилище: синхронизация' });
    assert.strictEqual(getEntriesCalls, 0);
    assert.strictEqual(guard.isBusy, true);
    assert.strictEqual(guard.heldBy, 'Хранилище: синхронизация');
    assert.deepStrictEqual(bridgeInformationMessages, [CONFIGURATION_OPERATION_BUSY_MESSAGE]);
    lease?.release();
  });

  const RUN_EXCLUSIVE_CASES: { command: string; node: NodeArg; label: string }[] = [
    { command: 'onecdev.importConfigurationFromDb', node: CF_NODE, label: 'importConfigurationFromDb (cf)' },
    { command: 'onecdev.updateConfigurationInDb', node: CF_NODE, label: 'updateConfigurationInDb (cf)' },
    { command: 'onecdev.updateConfigurationInDb', node: CFE_NODE, label: 'updateConfigurationInDb (cfe)' },
    { command: 'onecdev.decompileExtensionSources', node: CFE_NODE, label: 'decompileExtensionSources (extension)' },
    { command: 'onecdev.updateExtensionInDb', node: CFE_NODE, label: 'updateExtensionInDb (extension)' },
    { command: 'onecdev.compileAndUpdateExtensionInDb', node: CFE_NODE, label: 'compileAndUpdateExtensionInDb (extension)' },
  ];

  RUN_EXCLUSIVE_CASES.forEach(({ command, node, label }) => {
    test(`guard занят «Хранилище: синхронизация» — ${label} не вызывает standaloneServerService.refreshHealth/setTreeProcessingState`, async () => {
      const guard = new ConfigurationOperationGuard();
      const lease = guard.tryAcquire('Хранилище: синхронизация');
      let refreshHealthCalls = 0;
      let setTreeCalls = 0;
      servicesBox.current = createServices({
        configurationOperationGuard: guard,
        standaloneServerService: {
          refreshHealth: () => { refreshHealthCalls += 1; return Promise.resolve({ configured: false, state: 'stopped' }); },
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => { setTreeCalls += 1; },
      });

      await vscode.commands.executeCommand(command, node);

      assert.strictEqual(refreshHealthCalls, 0);
      assert.strictEqual(setTreeCalls, 0);
      assert.strictEqual(guard.isBusy, true);
      assert.strictEqual(guard.heldBy, 'Хранилище: синхронизация');
      lease?.release();
    });
  });

  // Issue #42: выбор целей идёт до аренды, поэтому «изменений нет» больше не
  // захватывает guard и не трогает индикатор обработки дерева.
  [undefined, { mode: 'auto' }].forEach((request) => {
    test(`guard свободен: updateChangedConfigurations без изменений (запрос ${JSON.stringify(request)}) → no-changes без аренды, событий guard нет, setTreeProcessingState/markConfigurationsClean не вызваны`, async () => {
      const guard = new ConfigurationOperationGuard();
      const events: boolean[] = [];
      guard.onDidChangeBusy((busy) => events.push(busy));
      let getChangedCalls = 0;
      let observedDuringGetChanged: boolean | undefined;
      servicesBox.current = createServices({
        configurationOperationGuard: guard,
        getChangedConfigurations: () => {
          getChangedCalls += 1;
          observedDuringGetChanged = guard.isBusy;
          return [];
        },
      });

      const result = await vscode.commands.executeCommand('onecdev.updateChangedConfigurations', request);

      assert.deepStrictEqual(result, { status: 'no-changes' });
      assert.strictEqual(getChangedCalls, 1);
      assert.strictEqual(observedDuringGetChanged, false);
      assert.deepStrictEqual(events, []);
      assert.deepStrictEqual(bridgeInformationMessages, ['Изменений в конфигурациях не обнаружено.']);
    });
  });

  test('guard свободен: одна изменённая cf, updateMainConfiguration → true — done, picker не вызван, флаг «одна цель»===true, markConfigurationsClean([[cf]])', async () => {
    const guard = new ConfigurationOperationGuard();
    const markCleanCalls: string[][] = [];
    let pickCalls = 0;
    let observedShowSuccessMessage: boolean | undefined;
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      getChangedConfigurations: () => [{ kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 }],
      standaloneServerService: {
        refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
      } as unknown as CommandServices['standaloneServerService'],
      setTreeProcessingState: () => undefined,
      markConfigurationsClean: (roots: string[]) => { markCleanCalls.push(roots); },
    });
    depsBox.current = createDeps({
      pickChangedConfigurations: () => { pickCalls += 1; return Promise.resolve(undefined); },
      updateMainConfiguration: (_name, _root, _workspaceFolder, _outputChannel, showSuccessMessage) => {
        observedShowSuccessMessage = showSuccessMessage;
        return Promise.resolve(true);
      },
    });

    const result = await vscode.commands.executeCommand('onecdev.updateChangedConfigurations');

    assert.deepStrictEqual(result, { status: 'done', completed: [CF_NAME] });
    assert.strictEqual(pickCalls, 0, 'единственная изменённая конфигурация не должна открывать picker');
    assert.strictEqual(observedShowSuccessMessage, true);
    assert.deepStrictEqual(markCleanCalls, [[EXAMPLE_CF]]);
    assert.strictEqual(guard.isBusy, false);
  });

  [undefined, []].forEach((cancelledSelection) => {
    test(`guard свободен: cf+cfe изменены, pickChangedConfigurations вернул ${JSON.stringify(cancelledSelection)} — cancelled, runner'ы не вызваны`, async () => {
      const guard = new ConfigurationOperationGuard();
      const events: boolean[] = [];
      guard.onDidChangeBusy((busy) => events.push(busy));
      servicesBox.current = createServices({
        configurationOperationGuard: guard,
        getChangedConfigurations: () => [
          { kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 },
          { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC, name: CFE_NAME, changedFilesCount: 1 },
        ],
      });
      depsBox.current = createDeps({
        pickChangedConfigurations: () => Promise.resolve(cancelledSelection),
      });

      const result = await vscode.commands.executeCommand('onecdev.updateChangedConfigurations');

      assert.deepStrictEqual(result, { status: 'cancelled' });
      assert.strictEqual(guard.isBusy, false);
      assert.deepStrictEqual(events, [], 'отмена выбора до аренды не должна захватывать guard');
    });
  });

  test('guard свободен: cf+cfe выбраны обе, cf→true, cfe→false — failed stoppedAt "EVOLC", completed только cf, порядок cf раньше cfe', async () => {
    const guard = new ConfigurationOperationGuard();
    const callOrder: string[] = [];
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      getChangedConfigurations: () => [
        { kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 },
        { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC, name: CFE_NAME, changedFilesCount: 1 },
      ],
      standaloneServerService: {
        refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
      } as unknown as CommandServices['standaloneServerService'],
      setTreeProcessingState: () => undefined,
      markConfigurationsClean: () => undefined,
    });
    depsBox.current = createDeps({
      pickChangedConfigurations: (changed) => Promise.resolve(changed),
      updateMainConfiguration: () => { callOrder.push('cf'); return Promise.resolve(true); },
      updateExtension: () => { callOrder.push('cfe'); return Promise.resolve(false); },
    });

    const result = await vscode.commands.executeCommand('onecdev.updateChangedConfigurations');

    assert.deepStrictEqual(result, { status: 'failed', completed: [CF_NAME], stoppedAt: CFE_NAME });
    assert.deepStrictEqual(callOrder, ['cf', 'cfe']);
    assert.strictEqual(guard.isBusy, false);
  });

  test('guard свободен: updateMainConfiguration бросил исключение — failed с error, showErrorMessage показан, guard свободен', async () => {
    const guard = new ConfigurationOperationGuard();
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      getChangedConfigurations: () => [{ kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 }],
      standaloneServerService: {
        refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
      } as unknown as CommandServices['standaloneServerService'],
      setTreeProcessingState: () => undefined,
      markConfigurationsClean: () => undefined,
    });
    depsBox.current = createDeps({
      updateMainConfiguration: () => Promise.reject(new Error('Конфигуратор упал')),
    });

    const result = await vscode.commands.executeCommand('onecdev.updateChangedConfigurations');

    assert.deepStrictEqual(result, { status: 'failed', completed: [], error: 'Конфигуратор упал' });
    assert.strictEqual(bridgeErrorMessages.length, 1);
    assert.strictEqual(guard.isBusy, false);
  });

  test('временная рабочая область без src/cf: importConfigurations — no-targets без ожидания закрытия предупреждения', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-import-no-targets-'));
    try {
      let getEntriesCalls = 0;
      servicesBox.current = createServices({
        workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'no-targets-fixture', index: 0 },
        treeProvider: { getEntries: () => { getEntriesCalls += 1; return []; } } as unknown as CommandServices['treeProvider'],
      });
      // Заглушка никогда не разрешается: если бы команда ждала закрытия
      // предупреждения (await вместо void), executeCommand здесь зависла бы
      // навсегда, и тест не завершился бы (а не просто дал неверный результат) —
      // детерминированное доказательство отсутствия await.
      bridgeWarningMessageResolver = () => new Promise<string | undefined>(() => undefined);

      const result = await vscode.commands.executeCommand('onecdev.importConfigurations');

      assert.deepStrictEqual(result, { status: 'no-targets' });
      assert.strictEqual(getEntriesCalls, 1);
      assert.strictEqual(bridgeWarningMessages.length, 1);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  [undefined, []].forEach((cancelledSelection) => {
    test(`guard свободен: pickImportTargets вернул ${JSON.stringify(cancelledSelection)} — cancelled, событий guard нет`, async () => {
      const guard = new ConfigurationOperationGuard();
      const events: boolean[] = [];
      guard.onDidChangeBusy((busy) => events.push(busy));
      servicesBox.current = createServices({
        configurationOperationGuard: guard,
        treeProvider: { getEntries: () => [{ kind: 'cf', rootPath: EXAMPLE_CF }] } as unknown as CommandServices['treeProvider'],
      });
      depsBox.current = createDeps({
        pickImportTargets: () => Promise.resolve(cancelledSelection),
      });

      const result = await vscode.commands.executeCommand('onecdev.importConfigurations');

      assert.deepStrictEqual(result, { status: 'cancelled' });
      assert.deepStrictEqual(events, []);
    });
  });

  test('guard заняли, пока был открыт выбор конфигураций для импорта — busy с чужим heldBy, runner\'ы не вызваны, чужая аренда цела', async () => {
    const guard = new ConfigurationOperationGuard();
    let foreignLease: ReturnType<ConfigurationOperationGuard['tryAcquire']>;
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      treeProvider: { getEntries: () => [{ kind: 'cf', rootPath: EXAMPLE_CF }] } as unknown as CommandServices['treeProvider'],
    });
    depsBox.current = createDeps({
      pickImportTargets: (targets) => {
        foreignLease = guard.tryAcquire('Синхронизация с хранилищем: Основная конфигурация');
        return Promise.resolve(targets);
      },
    });

    const result = await vscode.commands.executeCommand('onecdev.importConfigurations');

    assert.deepStrictEqual(result, { status: 'busy', heldBy: 'Синхронизация с хранилищем: Основная конфигурация' });
    assert.strictEqual(guard.heldBy, 'Синхронизация с хранилищем: Основная конфигурация');
    foreignLease?.release();
  });

  test('guard свободен: cf+EVOLC выбраны все — done completed [cf, EVOLC], reloadEntries вызван 1 раз, markConfigurationsClean([[cf, cfe]])', async () => {
    const guard = new ConfigurationOperationGuard();
    const markCleanCalls: string[][] = [];
    let reloadCalls = 0;
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      treeProvider: {
        getEntries: () => [
          { kind: 'cf', rootPath: EXAMPLE_CF },
          { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC },
        ],
      } as unknown as CommandServices['treeProvider'],
      standaloneServerService: {
        refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
      } as unknown as CommandServices['standaloneServerService'],
      setTreeProcessingState: () => undefined,
      markConfigurationsClean: (roots: string[]) => { markCleanCalls.push(roots); },
      reloadEntries: () => { reloadCalls += 1; return Promise.resolve(); },
    });
    depsBox.current = createDeps({
      pickImportTargets: (targets) => Promise.resolve(targets),
      decompileMainConfiguration: () => Promise.resolve(true),
      decompileExtension: () => Promise.resolve(true),
    });

    const result = await vscode.commands.executeCommand('onecdev.importConfigurations');

    assert.deepStrictEqual(result, { status: 'done', completed: [CF_NAME, CFE_NAME] });
    assert.strictEqual(reloadCalls, 1);
    assert.deepStrictEqual(markCleanCalls, [[EXAMPLE_CF, EXAMPLE_CFE_EVOLC]]);
  });

  test('guard свободен: cf→true, cfe→false — failed stoppedAt "EVOLC", reloadEntries не вызван', async () => {
    const guard = new ConfigurationOperationGuard();
    let reloadCalls = 0;
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      treeProvider: {
        getEntries: () => [
          { kind: 'cf', rootPath: EXAMPLE_CF },
          { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC },
        ],
      } as unknown as CommandServices['treeProvider'],
      standaloneServerService: {
        refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
      } as unknown as CommandServices['standaloneServerService'],
      setTreeProcessingState: () => undefined,
      markConfigurationsClean: () => undefined,
      reloadEntries: () => { reloadCalls += 1; return Promise.resolve(); },
    });
    depsBox.current = createDeps({
      pickImportTargets: (targets) => Promise.resolve(targets),
      decompileMainConfiguration: () => Promise.resolve(true),
      decompileExtension: () => Promise.resolve(false),
    });

    const result = await vscode.commands.executeCommand('onecdev.importConfigurations');

    assert.deepStrictEqual(result, { status: 'failed', completed: [CF_NAME], stoppedAt: CFE_NAME });
    assert.strictEqual(reloadCalls, 0);
  });

  test('guard свободен: decompileMainConfiguration бросил исключение — failed с error', async () => {
    const guard = new ConfigurationOperationGuard();
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      treeProvider: { getEntries: () => [{ kind: 'cf', rootPath: EXAMPLE_CF }] } as unknown as CommandServices['treeProvider'],
      standaloneServerService: {
        refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
      } as unknown as CommandServices['standaloneServerService'],
      setTreeProcessingState: () => undefined,
      markConfigurationsClean: () => undefined,
    });
    depsBox.current = createDeps({
      pickImportTargets: (targets) => Promise.resolve(targets),
      decompileMainConfiguration: () => Promise.reject(new Error('Конфигуратор упал')),
    });

    const result = await vscode.commands.executeCommand('onecdev.importConfigurations');

    assert.deepStrictEqual(result, { status: 'failed', completed: [], error: 'Конфигуратор упал' });
  });

  /**
   * Issue #42: MCP-мост передаёт командам запрос выбора целей
   * (`ConfigurationTargetRequest`), и они не открывают QuickPick. Выбор идёт
   * ДО аренды guard'а, интерактивный путь (без запроса или с узлом дерева)
   * сохраняется для UI. Runner'ы и picker'ы по умолчанию — throw-стабы
   * (`createDeps`), поэтому «не вызван» проверяется самим фактом прохождения.
   */
  suite('Issue #42 — неинтерактивный выбор целей', () => {
    const STOPPED_SERVER = {
      refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
    } as unknown as CommandServices['standaloneServerService'];
    const CF_ENTRY = { kind: 'cf', rootPath: EXAMPLE_CF };
    const CFE_ENTRY = { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC };
    const CF_CHANGED = { kind: 'cf' as const, rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 };
    const CFE_CHANGED = { kind: 'cfe' as const, rootPath: EXAMPLE_CFE_EVOLC, name: CFE_NAME, changedFilesCount: 1 };

    function entriesProvider(entries: readonly unknown[]): CommandServices['treeProvider'] {
      return { getEntries: () => [...entries] } as unknown as CommandServices['treeProvider'];
    }

    function withoutMessage(result: unknown): Record<string, unknown> {
      const { message, ...rest } = result as Record<string, unknown>;
      assert.strictEqual(typeof message, 'string');
      return rest;
    }

    suite('importConfigurations', () => {
      test('auto, одна конфигурация → done [cf], picker не вызван', async () => {
        const markCleanCalls: string[][] = [];
        servicesBox.current = createServices({
          treeProvider: entriesProvider([CF_ENTRY]),
          standaloneServerService: STOPPED_SERVER,
          setTreeProcessingState: () => undefined,
          markConfigurationsClean: (roots: string[]) => { markCleanCalls.push(roots); },
          reloadEntries: () => Promise.resolve(),
        });
        depsBox.current = createDeps({ decompileMainConfiguration: () => Promise.resolve(true) });

        const result = await vscode.commands.executeCommand('onecdev.importConfigurations', { mode: 'auto' });

        assert.deepStrictEqual(result, { status: 'done', completed: [CF_NAME] });
        assert.deepStrictEqual(markCleanCalls, [[EXAMPLE_CF]]);
      });

      test('auto, cf+cfe → invalid-selection selection-required, событий guard нет, runner\'ы не вызваны', async () => {
        const guard = new ConfigurationOperationGuard();
        const events: boolean[] = [];
        guard.onDidChangeBusy((busy) => events.push(busy));
        servicesBox.current = createServices({
          configurationOperationGuard: guard,
          treeProvider: entriesProvider([CF_ENTRY, CFE_ENTRY]),
        });

        const result = await vscode.commands.executeCommand('onecdev.importConfigurations', { mode: 'auto' });

        assert.deepStrictEqual(withoutMessage(result), {
          status: 'invalid-selection',
          reason: 'selection-required',
          available: [CF_NAME, CFE_NAME],
        });
        assert.deepStrictEqual(events, []);
      });

      test('all → done [cf, EVOLC], reloadEntries вызван 1 раз', async () => {
        let reloadCalls = 0;
        servicesBox.current = createServices({
          treeProvider: entriesProvider([CFE_ENTRY, CF_ENTRY]),
          standaloneServerService: STOPPED_SERVER,
          setTreeProcessingState: () => undefined,
          markConfigurationsClean: () => undefined,
          reloadEntries: () => { reloadCalls += 1; return Promise.resolve(); },
        });
        depsBox.current = createDeps({
          decompileMainConfiguration: () => Promise.resolve(true),
          decompileExtension: () => Promise.resolve(true),
        });

        const result = await vscode.commands.executeCommand('onecdev.importConfigurations', { mode: 'all' });

        assert.deepStrictEqual(result, { status: 'done', completed: [CF_NAME, CFE_NAME] });
        assert.strictEqual(reloadCalls, 1);
      });

      test('names ["evolc"] → done [EVOLC], только decompileExtension, markConfigurationsClean([[EVOLC]])', async () => {
        const markCleanCalls: string[][] = [];
        const decompiled: string[] = [];
        servicesBox.current = createServices({
          treeProvider: entriesProvider([CF_ENTRY, CFE_ENTRY]),
          standaloneServerService: STOPPED_SERVER,
          setTreeProcessingState: () => undefined,
          markConfigurationsClean: (roots: string[]) => { markCleanCalls.push(roots); },
          reloadEntries: () => Promise.resolve(),
        });
        depsBox.current = createDeps({
          decompileExtension: (name) => { decompiled.push(name); return Promise.resolve(true); },
        });

        const result = await vscode.commands.executeCommand('onecdev.importConfigurations', { mode: 'names', names: ['evolc'] });

        assert.deepStrictEqual(result, { status: 'done', completed: [CFE_NAME] });
        assert.deepStrictEqual(decompiled, [CFE_NAME]);
        assert.deepStrictEqual(markCleanCalls, [[EXAMPLE_CFE_EVOLC]]);
      });

      test('names ["Нет"] → invalid-selection unknown-names с unknown и available', async () => {
        servicesBox.current = createServices({ treeProvider: entriesProvider([CF_ENTRY, CFE_ENTRY]) });

        const result = await vscode.commands.executeCommand('onecdev.importConfigurations', { mode: 'names', names: ['Нет'] });

        assert.deepStrictEqual(withoutMessage(result), {
          status: 'invalid-selection',
          reason: 'unknown-names',
          available: [CF_NAME, CFE_NAME],
          unknown: ['Нет'],
        });
      });

      test('guard заняли во время сбора целей → busy с чужим heldBy, чужая аренда цела', async () => {
        const guard = new ConfigurationOperationGuard();
        let foreignLease: ReturnType<ConfigurationOperationGuard['tryAcquire']>;
        servicesBox.current = createServices({
          configurationOperationGuard: guard,
          treeProvider: {
            getEntries: () => {
              foreignLease = guard.tryAcquire('Синхронизация с хранилищем: Основная конфигурация');
              return [CF_ENTRY];
            },
          } as unknown as CommandServices['treeProvider'],
        });

        const result = await vscode.commands.executeCommand('onecdev.importConfigurations', { mode: 'auto' });

        assert.deepStrictEqual(result, { status: 'busy', heldBy: 'Синхронизация с хранилищем: Основная конфигурация' });
        assert.strictEqual(guard.heldBy, 'Синхронизация с хранилищем: Основная конфигурация');
        foreignLease?.release();
      });

      test('временная рабочая область без src/cf, auto → no-targets', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-import-auto-no-targets-'));
        try {
          servicesBox.current = createServices({
            workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'no-targets-fixture', index: 0 },
            treeProvider: entriesProvider([]),
          });

          const result = await vscode.commands.executeCommand('onecdev.importConfigurations', { mode: 'auto' });

          assert.deepStrictEqual(result, { status: 'no-targets' });
        } finally {
          fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
      });

      test('аргумент — узел дерева (не запрос) → интерактивный путь, pickImportTargets вызван', async () => {
        let pickCalls = 0;
        servicesBox.current = createServices({ treeProvider: entriesProvider([CF_ENTRY]) });
        depsBox.current = createDeps({
          pickImportTargets: () => { pickCalls += 1; return Promise.resolve(undefined); },
        });

        const result = await vscode.commands.executeCommand('onecdev.importConfigurations', CF_NODE);

        assert.deepStrictEqual(result, { status: 'cancelled' });
        assert.strictEqual(pickCalls, 1);
      });
    });

    suite('updateChangedConfigurations', () => {
      test('guard занят, auto → busy, getChangedConfigurations не вызван', async () => {
        const guard = new ConfigurationOperationGuard();
        const lease = guard.tryAcquire('Хранилище: синхронизация');
        servicesBox.current = createServices({ configurationOperationGuard: guard });

        const result = await vscode.commands.executeCommand('onecdev.updateChangedConfigurations', { mode: 'auto' });

        assert.deepStrictEqual(result, { status: 'busy', heldBy: 'Хранилище: синхронизация' });
        assert.deepStrictEqual(bridgeInformationMessages, [CONFIGURATION_OPERATION_BUSY_MESSAGE]);
        lease?.release();
      });

      [{ mode: 'auto' }, { mode: 'names', names: [CF_NAME] }].forEach((request) => {
        test(`одна изменённая cf, ${JSON.stringify(request)} → done [cf], флаг «одна цель»===true`, async () => {
          let observedShowSuccessMessage: boolean | undefined;
          servicesBox.current = createServices({
            getChangedConfigurations: () => [CF_CHANGED],
            standaloneServerService: STOPPED_SERVER,
            setTreeProcessingState: () => undefined,
            markConfigurationsClean: () => undefined,
          });
          depsBox.current = createDeps({
            updateMainConfiguration: (_name, _root, _workspaceFolder, _outputChannel, showSuccessMessage) => {
              observedShowSuccessMessage = showSuccessMessage;
              return Promise.resolve(true);
            },
          });

          const result = await vscode.commands.executeCommand('onecdev.updateChangedConfigurations', request);

          assert.deepStrictEqual(result, { status: 'done', completed: [CF_NAME] });
          assert.strictEqual(observedShowSuccessMessage, true);
        });
      });

      test('две изменённых без аргумента → picker открыт при свободном guard, выбранная cf обновлена', async () => {
        const guard = new ConfigurationOperationGuard();
        const observedBusy: boolean[] = [];
        servicesBox.current = createServices({
          configurationOperationGuard: guard,
          getChangedConfigurations: () => [CF_CHANGED, CFE_CHANGED],
          standaloneServerService: STOPPED_SERVER,
          setTreeProcessingState: () => undefined,
          markConfigurationsClean: () => undefined,
        });
        depsBox.current = createDeps({
          pickChangedConfigurations: (changed) => {
            observedBusy.push(guard.isBusy);
            return Promise.resolve(changed.filter((target) => target.kind === 'cf'));
          },
          updateMainConfiguration: () => Promise.resolve(true),
        });

        const result = await vscode.commands.executeCommand('onecdev.updateChangedConfigurations');

        assert.deepStrictEqual(result, { status: 'done', completed: [CF_NAME] });
        assert.deepStrictEqual(observedBusy, [false]);
      });

      test('guard заняли, пока был открыт picker → busy с чужим heldBy, чужая аренда цела', async () => {
        const guard = new ConfigurationOperationGuard();
        let foreignLease: ReturnType<ConfigurationOperationGuard['tryAcquire']>;
        servicesBox.current = createServices({
          configurationOperationGuard: guard,
          getChangedConfigurations: () => [CF_CHANGED, CFE_CHANGED],
        });
        depsBox.current = createDeps({
          pickChangedConfigurations: (changed) => {
            foreignLease = guard.tryAcquire('Синхронизация с хранилищем: Основная конфигурация');
            return Promise.resolve(changed);
          },
        });

        const result = await vscode.commands.executeCommand('onecdev.updateChangedConfigurations');

        assert.deepStrictEqual(result, { status: 'busy', heldBy: 'Синхронизация с хранилищем: Основная конфигурация' });
        assert.strictEqual(guard.heldBy, 'Синхронизация с хранилищем: Основная конфигурация');
        foreignLease?.release();
      });

      test('auto, две изменённых → invalid-selection selection-required, picker не вызван, событий guard нет', async () => {
        const guard = new ConfigurationOperationGuard();
        const events: boolean[] = [];
        guard.onDidChangeBusy((busy) => events.push(busy));
        servicesBox.current = createServices({
          configurationOperationGuard: guard,
          getChangedConfigurations: () => [CF_CHANGED, CFE_CHANGED],
        });

        const result = await vscode.commands.executeCommand('onecdev.updateChangedConfigurations', { mode: 'auto' });

        assert.deepStrictEqual(withoutMessage(result), {
          status: 'invalid-selection',
          reason: 'selection-required',
          available: [CF_NAME, CFE_NAME],
        });
        assert.deepStrictEqual(events, []);
      });

      test('all → done [cf, EVOLC], порядок запуска cf, cfe', async () => {
        const callOrder: string[] = [];
        servicesBox.current = createServices({
          getChangedConfigurations: () => [CFE_CHANGED, CF_CHANGED],
          standaloneServerService: STOPPED_SERVER,
          setTreeProcessingState: () => undefined,
          markConfigurationsClean: () => undefined,
        });
        depsBox.current = createDeps({
          updateMainConfiguration: () => { callOrder.push('cf'); return Promise.resolve(true); },
          updateExtension: () => { callOrder.push('cfe'); return Promise.resolve(true); },
        });

        const result = await vscode.commands.executeCommand('onecdev.updateChangedConfigurations', { mode: 'all' });

        assert.deepStrictEqual(result, { status: 'done', completed: [CF_NAME, CFE_NAME] });
        assert.deepStrictEqual(callOrder, ['cf', 'cfe']);
      });

      test('names ["EVOLC"] → done [EVOLC], updateMainConfiguration не вызван', async () => {
        servicesBox.current = createServices({
          getChangedConfigurations: () => [CF_CHANGED, CFE_CHANGED],
          standaloneServerService: STOPPED_SERVER,
          setTreeProcessingState: () => undefined,
          markConfigurationsClean: () => undefined,
        });
        depsBox.current = createDeps({ updateExtension: () => Promise.resolve(true) });

        const result = await vscode.commands.executeCommand('onecdev.updateChangedConfigurations', { mode: 'names', names: ['EVOLC'] });

        assert.deepStrictEqual(result, { status: 'done', completed: [CFE_NAME] });
      });

      test('изменена только cf, names ["EVOLC"] → unknown-names, available только изменённые', async () => {
        servicesBox.current = createServices({ getChangedConfigurations: () => [CF_CHANGED] });

        const result = await vscode.commands.executeCommand('onecdev.updateChangedConfigurations', { mode: 'names', names: ['EVOLC'] });

        assert.deepStrictEqual(withoutMessage(result), {
          status: 'invalid-selection',
          reason: 'unknown-names',
          available: [CF_NAME],
          unknown: ['EVOLC'],
        });
      });
    });
  });

  test('RepositoryCommands: guard занят «Хранилище: синхронизация» — repository.commit не доходит до show/resolveFullName, чужая аренда цела', async () => {
    const guard = new ConfigurationOperationGuard();
    const lease = guard.tryAcquire('Хранилище: синхронизация');
    const target: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'Основная конфигурация' };
    let showCalls = 0;
    let resolveFullNameCalls = 0;
    const repositoryService = {
      resolveTargetByXmlPath: () => target,
      hasBinding: () => true,
      isConnected: () => true,
      resolveFullName: () => { resolveFullNameCalls += 1; return null; },
    } as unknown as RepositoryService;

    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      repositoryService,
      getChangedConfigurations: () => [
        { kind: 'cf', rootPath: EXAMPLE_CF, name: 'Основная конфигурация', changedFilesCount: 1 },
      ],
      repositoryCommitViewProvider: {
        show: () => { showCalls += 1; return Promise.resolve(undefined); },
      } as unknown as CommandServices['repositoryCommitViewProvider'],
    });

    await vscode.commands.executeCommand('onecdev.repository.commit', CF_NODE);

    assert.strictEqual(showCalls, 0);
    assert.strictEqual(resolveFullNameCalls, 0);
    assert.strictEqual(guard.isBusy, true);
    assert.strictEqual(guard.heldBy, 'Хранилище: синхронизация');
    lease?.release();
  });

  test('repository.fullUpdate (#192): у подключённого расширения запрашивает подтверждение до аренды', async () => {
    const guard = new ConfigurationOperationGuard();
    const target: RepositoryTarget = {
      configRoot: EXAMPLE_CFE_EVOLC, configKind: 'cfe', displayName: CFE_NAME, extensionName: CFE_NAME,
    };
    const repositoryService = {
      resolveTargetByXmlPath: () => target,
      hasBinding: () => true,
      isConnected: () => true,
      listOwnLockedFullNames: () => [],
      lockState: { isRootRecursiveLocked: () => false },
    } as unknown as RepositoryService;
    servicesBox.current = createServices({ configurationOperationGuard: guard, repositoryService });
    repositoryDepsBox.current = {
      ...DEFAULT_REPOSITORY_FILE_SYNC_DEPS,
      runRepositoryCli: notCalled('repository.fullUpdate: CLI'),
    };
    bridgeWarningMessageResolver = () => {
      assert.strictEqual(guard.isBusy, false);
      return Promise.resolve(undefined);
    };

    try {
      await vscode.commands.executeCommand('onecdev.repository.fullUpdate', CFE_NODE);
      assert.deepStrictEqual(bridgeWarningMessages, ['Обновить конфигурацию из хранилища']);
      assert.deepStrictEqual(bridgeErrorMessages, []);
    } finally {
      repositoryDepsBox.current = DEFAULT_REPOSITORY_FILE_SYNC_DEPS;
    }
  });

  test('repository.fullUpdate (#192): команда отклоняет узел объекта', async () => {
    await vscode.commands.executeCommand('onecdev.repository.fullUpdate', {
      ...CF_NODE, nodeKind: 'Catalog',
    });

    assert.deepStrictEqual(bridgeWarningMessages, [
      'Команда хранилища доступна только для корня основной конфигурации или расширения.',
    ]);
  });

  /**
   * Issue #1 — `RepositoryCommands.lock/unlock/update` теперь начинают с
   * `ensureRepositoryGuardFree` (план архитектора, критерий приёмки №2):
   * занятость guard'а проверяется ДО `askRecursiveMode`/`pickBoolean`
   * (`vscode.window.showQuickPick`), поэтому при занятом guard'е диалог выбора
   * режима не должен появляться вовсе, а чужая аренда — оставаться нетронутой.
   */
  suite('RepositoryCommands: repository.lock/unlock/update/updateToVersion — guard занят до диалогов (issue #1, #61)', () => {
    let originalShowQuickPick: typeof vscode.window.showQuickPick;
    let originalShowInputBox: typeof vscode.window.showInputBox;
    let quickPickCalls: number;
    let inputBoxCalls: number;

    setup(() => {
      quickPickCalls = 0;
      inputBoxCalls = 0;
      originalShowQuickPick = vscode.window.showQuickPick;
      originalShowInputBox = vscode.window.showInputBox;
      (vscode.window as Pick<typeof vscode.window, 'showQuickPick'>).showQuickPick = ((...args: unknown[]) => {
        quickPickCalls += 1;
        return (originalShowQuickPick as (...a: unknown[]) => Thenable<unknown>)(...args);
      }) as typeof vscode.window.showQuickPick;
      (vscode.window as Pick<typeof vscode.window, 'showInputBox'>).showInputBox = (() => {
        inputBoxCalls += 1;
        return Promise.resolve(undefined);
      });
    });

    teardown(() => {
      (vscode.window as Pick<typeof vscode.window, 'showQuickPick'>).showQuickPick = originalShowQuickPick;
      (vscode.window as Pick<typeof vscode.window, 'showInputBox'>).showInputBox = originalShowInputBox;
    });

    function repositoryServiceStub(target: RepositoryTarget): RepositoryService {
      return {
        resolveTargetByXmlPath: () => target,
        hasBinding: () => true,
        isConnected: () => true,
        resolveFullName: () => 'Справочник.Тест',
        isLocked: () => false,
      } as unknown as RepositoryService;
    }

    [
      'onecdev.repository.lock',
      'onecdev.repository.unlock',
      'onecdev.repository.update',
      'onecdev.repository.updateToVersion',
    ].forEach((command) => {
      test(`${command}: guard занят «Хранилище: синхронизация» — ни showQuickPick, ни showInputBox, чужая аренда цела`, async () => {
        const guard = new ConfigurationOperationGuard();
        const lease = guard.tryAcquire('Хранилище: синхронизация');
        const target: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'Основная конфигурация' };

        servicesBox.current = createServices({
          configurationOperationGuard: guard,
          repositoryService: repositoryServiceStub(target),
        });

        await vscode.commands.executeCommand(command, CF_NODE);

        assert.strictEqual(quickPickCalls, 0, `${command}: showQuickPick не должен вызываться при занятом guard'е.`);
        assert.strictEqual(inputBoxCalls, 0, `${command}: showInputBox не должен вызываться при занятом guard'е.`);
        assert.strictEqual(guard.isBusy, true);
        assert.strictEqual(guard.heldBy, 'Хранилище: синхронизация');
        lease?.release();
      });
    });

    ['onecdev.repository.update', 'onecdev.repository.updateToVersion'].forEach((command) => {
      test(`${command}: узел без XML — предупреждение, ни диалогов, ни аренды guard'а`, async () => {
        const guard = new ConfigurationOperationGuard();
        servicesBox.current = createServices({ configurationOperationGuard: guard });

        await vscode.commands.executeCommand(command, { nodeKind: 'Catalog', label: 'БезXml' });

        assert.deepStrictEqual(bridgeWarningMessages, ['Команда хранилища доступна только для узлов конфигурации с XML.']);
        assert.strictEqual(quickPickCalls, 0);
        assert.strictEqual(inputBoxCalls, 0);
        assert.strictEqual(guard.isBusy, false);
      });
    });
  });

  /**
   * Issue #1: guard свободен, пользователь ответил на все вопросы — команда доходит
   * до потока хранилища и при исходе `done` обновляет дерево и панель действий, при
   * любом другом исходе — нет. Сервис хранилища настоящий (копия фикстуры с привязкой
   * в env.json), процесс 1С — внедрённый `runRepositoryCli`; синхронизация файлов
   * выключена, чтобы проверялась именно проводка команды, а не слияние (оно покрыто
   * наборами RepositoryLockSync/RepositoryUnlockSync).
   */
  suite('RepositoryCommands: guard свободен — ответы на диалоги доходят до потока и обновления UI (issue #1)', () => {
    type Stubs = Pick<typeof vscode.window, 'showQuickPick' | 'showInputBox'>;
    const stubsRef = vscode.window as Stubs;
    let originals: Stubs;
    let workspaceRoot: string;
    let repositoryService: RepositoryService;
    /** Ответы QuickPick «да/нет» по порядку; `undefined` — пользователь закрыл выбор. */
    let pickAnswers: (boolean | undefined)[];
    let inputAnswer: string | undefined;
    let quickPickCalls: number;
    let inputBoxCalls: number;
    let cliRequests: RepositoryCliRequest[];
    /** Содержимое `-ObjectsFile` в момент запуска: после потока файл удаляется. */
    let cliObjectsXml: string[];
    let cliResult: RepositoryCliResult;
    let treeRefreshes: number;
    let actionsRefreshes: number;
    let infoNotices: string[];
    let errorNotices: string[];

    function catalogNode(withLabel: boolean): NodeArg {
      return {
        xmlPath: path.join(workspaceRoot, 'src', 'cf', 'Catalogs', 'Контрагенты.xml'),
        nodeKind: 'Catalog',
        ...(withLabel ? { label: 'Контрагенты' } : {}),
      };
    }

    setup(() => {
      workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-repo-commands-'));
      fs.cpSync(EXAMPLE_CF, path.join(workspaceRoot, 'src', 'cf'), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, 'env.json'), JSON.stringify({
        default: { '--ibconnection': '/F/tmp/база', '--repo-path': '/tmp/хранилище', '--repo-user': 'Admin' },
      }), 'utf-8');
      const secrets = new Map<string, string>();
      const secretStore = {
        get: (key: string) => Promise.resolve(secrets.get(key)),
        store: (key: string, value: string) => { secrets.set(key, value); return Promise.resolve(); },
        delete: (key: string) => { secrets.delete(key); return Promise.resolve(); },
      };
      repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(secretStore, workspaceRoot));
      pickAnswers = [];
      inputAnswer = '';
      quickPickCalls = 0;
      inputBoxCalls = 0;
      cliRequests = [];
      cliObjectsXml = [];
      cliResult = { status: 'done' };
      treeRefreshes = 0;
      actionsRefreshes = 0;
      infoNotices = [];
      errorNotices = [];

      originals = { showQuickPick: vscode.window.showQuickPick, showInputBox: vscode.window.showInputBox };
      stubsRef.showQuickPick = ((items: readonly { value: boolean }[]) => {
        quickPickCalls += 1;
        const answer = pickAnswers.shift();
        return Promise.resolve(answer === undefined ? undefined : items.find((item) => item.value === answer));
      }) as unknown as typeof vscode.window.showQuickPick;
      stubsRef.showInputBox = (() => {
        inputBoxCalls += 1;
        return Promise.resolve(inputAnswer);
      });

      repositoryDepsBox.current = {
        ...DEFAULT_REPOSITORY_FILE_SYNC_DEPS,
        runRepositoryCli: (request) => {
          cliRequests.push(request);
          const objectsFileIndex = request.extraArgs.indexOf('-ObjectsFile');
          if (objectsFileIndex >= 0) {
            cliObjectsXml.push(fs.readFileSync(request.extraArgs[objectsFileIndex + 1], 'utf-8'));
          }
          return Promise.resolve(cliResult);
        },
        dumpToTemp: notCalled('dumpToTemp'),
        chooseConflictResolution: notCalled('chooseConflictResolution'),
        confirmRollback: notCalled('confirmRollback'),
        openDiffs: notCalled('openDiffs'),
        notifyBusy: () => undefined,
        notifyInfo: (message) => { infoNotices.push(message); },
        notifyWarning: () => undefined,
        notifyError: (message) => { errorNotices.push(message); },
        isFileSyncEnabled: () => false,
        getDirtyFilePaths: () => [],
      };
      servicesBox.current = createServices({
        workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'repo', index: 0 },
        repositoryService,
        configurationOperationGuard: new ConfigurationOperationGuard(),
        treeProvider: {
          getEntries: notCalled('treeProvider.getEntries'),
          refresh: () => { treeRefreshes += 1; },
        } as unknown as CommandServices['treeProvider'],
        refreshActionsView: () => { actionsRefreshes += 1; },
        getChangedConfigurations: () => [],
        repositoryCommitViewProvider: {
          show: () => Promise.resolve({ comment: 'Правка контрагентов', recursive: false, keepLocked: false, force: false }),
        } as unknown as CommandServices['repositoryCommitViewProvider'],
      });
    });

    teardown(() => {
      stubsRef.showQuickPick = originals.showQuickPick;
      stubsRef.showInputBox = originals.showInputBox;
      repositoryDepsBox.current = DEFAULT_REPOSITORY_FILE_SYNC_DEPS;
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    const cases: { command: string; cli: string; answers: boolean[]; input?: string }[] = [
      { command: 'onecdev.repository.lock', cli: 'repository-lock', answers: [false] },
      { command: 'onecdev.repository.unlock', cli: 'repository-unlock', answers: [false] },
      { command: 'onecdev.repository.update', cli: 'repository-update', answers: [true] },
      { command: 'onecdev.repository.updateToVersion', cli: 'repository-update', answers: [true], input: ' 125 ' },
      { command: 'onecdev.repository.commit', cli: 'repository-commit', answers: [] },
    ];

    cases.forEach(({ command, cli, answers, input }) => {
      [true, false].forEach((withLabel) => {
        test(`${command} (метка узла ${withLabel ? 'есть' : 'нет'}): поток завершён → CLI «${cli}», дерево и панель действий обновлены`, async () => {
          pickAnswers = [...answers];
          inputAnswer = input ?? '';

          await vscode.commands.executeCommand(command, catalogNode(withLabel));

          assert.deepStrictEqual(cliRequests.map((request) => request.command), [cli]);
          assert.strictEqual(treeRefreshes, 1);
          assert.strictEqual(actionsRefreshes, 1);
        });
      });

      test(`${command}: Конфигуратор вернул ошибку → UI не обновляется`, async () => {
        pickAnswers = [...answers];
        inputAnswer = input ?? '';
        cliResult = { status: 'failed', message: 'Ошибка захвата объектов в хранилище' };

        await vscode.commands.executeCommand(command, catalogNode(true));

        assert.deepStrictEqual(cliRequests.map((request) => request.command), [cli]);
        assert.strictEqual(treeRefreshes, 0);
        assert.strictEqual(actionsRefreshes, 0);
      });
    });

    /**
     * Issue #102: с настоящим провайдером формы команда доходит до Конфигуратора.
     * Webview после загрузки шлёт `ready` — раньше провайдер принимал его за отмену
     * и закрывал форму, не дав пользователю её заполнить.
     */
    test('repository.commit с настоящей формой: ready не отменяет помещение, submit доводит до CLI «repository-commit» (issue #102)', async () => {
      const panels = installFakeWebviewPanels();
      const commitView = new RepositoryCommitViewProvider(vscode.Uri.file(path.resolve(__dirname, '../../../')));
      panels.onHtml = (panel) => {
        setTimeout(() => {
          panel.receive({ type: 'ready' });
          panel.receive({
            type: 'command',
            command: 'submit',
            payload: { comment: 'Правка формы элемента', recursive: false, keepLocked: true, force: false },
          });
        }, 0);
      };
      servicesBox.current = { ...servicesBox.current, repositoryCommitViewProvider: commitView };
      try {
        await vscode.commands.executeCommand('onecdev.repository.commit', catalogNode(true));
      } finally {
        commitView.dispose();
        panels.restore();
      }

      assert.strictEqual(panels.panels.length, 1);
      assert.deepStrictEqual(cliRequests.map((request) => request.command), ['repository-commit']);
      const args = cliRequests[0].extraArgs;
      assert.strictEqual(args[args.indexOf('-Comment') + 1], 'Правка формы элемента');
      assert.strictEqual(treeRefreshes, 1);
    });

    test('repository.lock: захват без рекурсии записан в состояние, объект захвачен', async () => {
      pickAnswers = [false];
      const target = repositoryService.resolveTargetByXmlPath(path.join(workspaceRoot, 'src', 'cf', 'Configuration.xml'));
      assert.ok(target);

      await vscode.commands.executeCommand('onecdev.repository.lock', catalogNode(true));

      assert.strictEqual(repositoryService.isLocked(target, 'Справочник.Контрагенты'), true);
    });

    test('repository.update: номер версии не запрашивается и не передаётся (issue #61)', async () => {
      pickAnswers = [false];
      inputAnswer = '125';

      await vscode.commands.executeCommand('onecdev.repository.update', catalogNode(true));

      assert.strictEqual(inputBoxCalls, 0);
      assert.strictEqual(cliRequests.length, 1);
      assert.ok(!cliRequests[0].extraArgs.includes('-Version'), cliRequests[0].extraArgs.join(' '));
    });

    test('repository.updateToVersion: версия из поля ввода передаётся парой «-Version», «125» без пробелов (issue #61)', async () => {
      pickAnswers = [false];
      inputAnswer = ' 125 ';

      await vscode.commands.executeCommand('onecdev.repository.updateToVersion', catalogNode(true));

      assert.strictEqual(inputBoxCalls, 1);
      assert.strictEqual(cliRequests.length, 1);
      const args = cliRequests[0].extraArgs;
      const versionIndex = args.indexOf('-Version');
      assert.ok(versionIndex >= 0, args.join(' '));
      assert.strictEqual(args[versionIndex + 1], '125');
    });

    /**
     * Issue #80: на стенде 8.5.1 `-force` у UpdateCfg не меняет результат — новые и удалённые
     * объекты применяются и без него, — поэтому вопрос не задаётся, ключ передаётся всегда.
     */
    [
      { command: 'onecdev.repository.update', input: '' },
      { command: 'onecdev.repository.updateToVersion', input: '9' },
    ].forEach(({ command, input }) => {
      test(`${command}: единственный вопрос — рекурсия, «-Force» передаётся всегда (issue #80)`, async () => {
        pickAnswers = [false];
        inputAnswer = input;

        await vscode.commands.executeCommand(command, catalogNode(true));

        assert.strictEqual(quickPickCalls, 1);
        assert.strictEqual(cliRequests.length, 1);
        assert.ok(cliRequests[0].extraArgs.includes('-Force'), cliRequests[0].extraArgs.join(' '));
      });
    });

    /**
     * Issue #190: правки живут в файлах выгрузки, поэтому освобождение для пользователя — всегда
     * «отпустить объект»; вариант без ключа давал только отказ Конфигуратора.
     */
    test('repository.unlock: единственный вопрос — рекурсия, «-Force» передаётся всегда, уведомление об отмене изменений в базе (issue #190)', async () => {
      pickAnswers = [false];

      await vscode.commands.executeCommand('onecdev.repository.unlock', catalogNode(true));

      assert.strictEqual(quickPickCalls, 1);
      assert.strictEqual(cliRequests.length, 1);
      assert.ok(cliRequests[0].extraArgs.includes('-Force'), cliRequests[0].extraArgs.join(' '));
      assert.deepStrictEqual(infoNotices, ['Объекты «Контрагенты» освобождены, непомещённые изменения в базе отменены.']);
      assert.deepStrictEqual(errorNotices, []);
    });

    test('repository.unlock: отказ Конфигуратора сообщается ошибкой, об освобождении не сообщается (issue #190)', async () => {
      pickAnswers = [false];
      cliResult = { status: 'failed', message: 'Ошибка освобождения объектов в хранилище' };

      await vscode.commands.executeCommand('onecdev.repository.unlock', catalogNode(true));

      assert.ok(cliRequests[0].extraArgs.includes('-Force'), cliRequests[0].extraArgs.join(' '));
      assert.strictEqual(errorNotices.length, 1);
      assert.ok(errorNotices[0].includes('Ошибка освобождения объектов в хранилище'), errorNotices[0]);
      assert.deepStrictEqual(infoNotices, []);
    });

    ([
      { command: 'onecdev.repository.lock', answers: [undefined], input: '' },
      { command: 'onecdev.repository.unlock', answers: [undefined], input: '' },
      { command: 'onecdev.repository.update', answers: [undefined], input: '' },
      { command: 'onecdev.repository.updateToVersion', answers: [], input: undefined },
      { command: 'onecdev.repository.updateToVersion', answers: [undefined], input: '5' },
    ] as { command: string; answers: (boolean | undefined)[]; input: string | undefined }[]).forEach(({ command, answers, input }, index) => {
      test(`${command}: пользователь отменил диалог (вариант ${String(index + 1)}) → Конфигуратор не запускается`, async () => {
        pickAnswers = [...answers];
        inputAnswer = input;

        await vscode.commands.executeCommand(command, catalogNode(true));

        assert.deepStrictEqual(cliRequests, []);
        assert.strictEqual(treeRefreshes, 0);
        // Диалоги после отменённого не показываются; для updateToVersion номер версии
        // спрашивается раньше режимов, поэтому отмена ввода не доходит до QuickPick.
        assert.strictEqual(quickPickCalls, answers.length);
      });
    });

    /** Узлы фикстуры, у единиц которых нет подчинённых объектов хранилища (issue #61). */
    function leafNodes(): { name: string; node: NodeArg }[] {
      const cfRoot = path.join(workspaceRoot, 'src', 'cf');
      const counterpartiesXml = path.join(cfRoot, 'Catalogs', 'Контрагенты.xml');
      const banksXml = path.join(cfRoot, 'Catalogs', 'Банки.xml');
      return [
        { name: 'справочник Банки', node: { xmlPath: banksXml, nodeKind: 'Catalog', label: 'Банки' } },
        {
          name: 'общий модуль ОбщегоНазначения',
          node: { xmlPath: path.join(cfRoot, 'CommonModules', 'ОбщегоНазначения.xml'), nodeKind: 'CommonModule', label: 'ОбщегоНазначения' },
        },
        {
          name: 'форма Контрагенты.ФормаЭлемента',
          node: {
            xmlPath: counterpartiesXml,
            nodeKind: 'Form',
            label: 'ФормаЭлемента',
            metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: counterpartiesXml },
          },
        },
        {
          name: 'реквизит справочника Банки',
          node: {
            xmlPath: banksXml,
            nodeKind: 'Attribute',
            label: 'КоррСчет',
            metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: banksXml },
          },
        },
      ];
    }

    /** Команда и ответы на её вопросы, кроме вопроса о рекурсии. */
    const leafCommands: { command: string; answers: boolean[]; input?: string }[] = [
      { command: 'onecdev.repository.lock', answers: [] },
      { command: 'onecdev.repository.unlock', answers: [] },
      { command: 'onecdev.repository.update', answers: [] },
      { command: 'onecdev.repository.updateToVersion', answers: [], input: '7' },
    ];

    leafCommands.forEach(({ command, answers, input }) => {
      test(`${command}: у единицы нет подчинённых — о рекурсии не спрашивает, includeChildObjects="false" (issue #61)`, async () => {
        for (const { name, node } of leafNodes()) {
          pickAnswers = [...answers];
          inputAnswer = input ?? '';
          quickPickCalls = 0;
          cliObjectsXml = [];

          await vscode.commands.executeCommand(command, node);

          assert.strictEqual(quickPickCalls, answers.length, `${name}: лишний QuickPick`);
          assert.strictEqual(cliObjectsXml.length, 1, `${name}: Конфигуратор не запущен`);
          assert.ok(cliObjectsXml[0].includes('includeChildObjects="false"'), `${name}: ${cliObjectsXml[0]}`);
          assert.ok(!cliObjectsXml[0].includes('includeChildObjects="true"'), `${name}: ${cliObjectsXml[0]}`);
        }
      });

      test(`${command}: у единицы есть подчинённые — вопрос о рекурсии задаётся, «рекурсивно» даёт includeChildObjects="true" (issue #61)`, async () => {
        const counterpartiesXml = path.join(workspaceRoot, 'src', 'cf', 'Catalogs', 'Контрагенты.xml');
        const nodes: { name: string; node: NodeArg }[] = [
          { name: 'справочник Контрагенты', node: catalogNode(true) },
          {
            name: 'реквизит справочника Контрагенты',
            node: {
              xmlPath: counterpartiesXml,
              nodeKind: 'Attribute',
              label: 'ИНН',
              metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: counterpartiesXml },
            },
          },
        ];
        for (const { name, node } of nodes) {
          pickAnswers = [true, ...answers];
          inputAnswer = input ?? '';
          quickPickCalls = 0;
          cliObjectsXml = [];

          await vscode.commands.executeCommand(command, node);

          assert.strictEqual(quickPickCalls, answers.length + 1, `${name}: вопрос о рекурсии не задан`);
          assert.strictEqual(cliObjectsXml.length, 1, `${name}: Конфигуратор не запущен`);
          assert.ok(cliObjectsXml[0].includes('includeChildObjects="true"'), `${name}: ${cliObjectsXml[0]}`);
        }
      });
    });
  });

  test('RepositoryCommands: guard свободен и изменений для конфигурации нет — repository.commit доходит до show, событий guard нет', async () => {
    const guard = new ConfigurationOperationGuard();
    const events: boolean[] = [];
    guard.onDidChangeBusy((busy) => events.push(busy));
    const target: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'Основная конфигурация' };
    let showCalls = 0;
    const repositoryService = {
      resolveTargetByXmlPath: () => target,
      hasBinding: () => true,
      isConnected: () => true,
      resolveFullName: () => null,
      isLocked: () => false,
    } as unknown as RepositoryService;

    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      repositoryService,
      getChangedConfigurations: () => [],
      repositoryCommitViewProvider: {
        show: () => { showCalls += 1; return Promise.resolve(undefined); },
      } as unknown as CommandServices['repositoryCommitViewProvider'],
    });

    await vscode.commands.executeCommand('onecdev.repository.commit', CF_NODE);

    assert.strictEqual(showCalls, 1);
    assert.deepStrictEqual(events, []);
  });

  /**
   * Issue #38: каталог `src/cfe/<имя>` создаётся только внутри захваченной
   * операции. Иначе при занятом guard он оставался пустым, и повторное
   * подключение того же расширения становилось невозможным.
   */
  suite('connectExtension — каталог расширения и общий guard (issue #38)', () => {
    type WindowStubs = Pick<typeof vscode.window, 'showQuickPick' | 'showInformationMessage' | 'showErrorMessage'>;
    const windowStubsRef = vscode.window as WindowStubs;
    let originals: WindowStubs;
    let workspaceRoot: string;
    let extensionRoot: string;
    let informationMessages: string[];
    let errorMessages: string[];
    let quickPickCalls: number;
    /** Что делает «пользователь» в QuickPick выбора расширения; по умолчанию выбирает EVOLC. */
    let onQuickPick: () => void;

    function createWorkspaceServices(overrides: Partial<CommandServices>): CommandServices {
      return createServices({
        workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'connect-fixture', index: 0 },
        ...overrides,
      });
    }

    setup(() => {
      workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-connect-extension-'));
      extensionRoot = path.join(workspaceRoot, 'src', 'cfe', 'EVOLC');
      informationMessages = [];
      errorMessages = [];
      quickPickCalls = 0;
      onQuickPick = () => undefined;
      originals = {
        showQuickPick: vscode.window.showQuickPick,
        showInformationMessage: vscode.window.showInformationMessage,
        showErrorMessage: vscode.window.showErrorMessage,
      };
      windowStubsRef.showQuickPick = ((items: readonly string[]) => {
        quickPickCalls += 1;
        onQuickPick();
        return Promise.resolve(items.find((item) => item === 'EVOLC'));
      }) as WindowStubs['showQuickPick'];
      windowStubsRef.showInformationMessage = ((message: string) => {
        informationMessages.push(message);
        return Promise.resolve(undefined);
      });
      windowStubsRef.showErrorMessage = ((message: string) => {
        errorMessages.push(message);
        return Promise.resolve(undefined);
      });
    });

    teardown(() => {
      windowStubsRef.showQuickPick = originals.showQuickPick;
      windowStubsRef.showInformationMessage = originals.showInformationMessage;
      windowStubsRef.showErrorMessage = originals.showErrorMessage;
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test('guard занят до команды — список расширений из базы не запрашивается, каталог не создаётся', async () => {
      const guard = new ConfigurationOperationGuard();
      const lease = guard.tryAcquire('Импорт конфигураций');
      let listCalls = 0;
      servicesBox.current = createWorkspaceServices({ configurationOperationGuard: guard });
      depsBox.current = createDeps({
        listDatabaseExtensions: () => { listCalls += 1; return Promise.resolve(['EVOLC']); },
      });

      await vscode.commands.executeCommand('onecdev.connectExtension');

      assert.strictEqual(listCalls, 0);
      assert.strictEqual(quickPickCalls, 0);
      assert.deepStrictEqual(informationMessages, ['Операция с конфигурацией уже выполняется. Дождитесь её завершения.']);
      assert.strictEqual(fs.existsSync(extensionRoot), false);
      assert.strictEqual(guard.heldBy, 'Импорт конфигураций');
      lease?.release();
    });

    test('guard заняли, пока был открыт выбор расширения — каталог не создаётся, повторное подключение не блокируется', async () => {
      const guard = new ConfigurationOperationGuard();
      let foreignLease: ReturnType<ConfigurationOperationGuard['tryAcquire']>;
      servicesBox.current = createWorkspaceServices({ configurationOperationGuard: guard });
      depsBox.current = createDeps({
        listDatabaseExtensions: () => Promise.resolve(['EVOLC']),
      });
      onQuickPick = () => { foreignLease = guard.tryAcquire('Синхронизация с хранилищем: Основная конфигурация'); };

      await vscode.commands.executeCommand('onecdev.connectExtension');

      assert.strictEqual(quickPickCalls, 1);
      assert.deepStrictEqual(informationMessages, ['Операция с конфигурацией уже выполняется. Дождитесь её завершения.']);
      assert.strictEqual(fs.existsSync(extensionRoot), false, 'пустой каталог расширения не должен оставаться');
      assert.strictEqual(guard.heldBy, 'Синхронизация с хранилищем: Основная конфигурация');
      foreignLease?.release();

      // Каталог не остался, поэтому EVOLC снова предлагается к подключению,
      // а не отбивается как «уже подключённое».
      onQuickPick = () => undefined;
      depsBox.current = createDeps({
        listDatabaseExtensions: () => Promise.resolve(['EVOLC']),
        decompileExtension: () => Promise.resolve(false),
      });
      servicesBox.current = createWorkspaceServices({
        configurationOperationGuard: guard,
        standaloneServerService: {
          refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => undefined,
        reloadEntries: () => Promise.resolve(),
      });

      await vscode.commands.executeCommand('onecdev.connectExtension');

      assert.strictEqual(quickPickCalls, 2);
      assert.deepStrictEqual(errorMessages, []);
    });

    test('guard свободен, выгрузка удалась — каталог создан до запуска Конфигуратора и остаётся, конфигурация помечена чистой', async () => {
      const guard = new ConfigurationOperationGuard();
      const markCleanCalls: string[][] = [];
      const updateSourceCalls: string[][] = [];
      let observedDuringDecompile: { dirExists: boolean; heldBy: string | undefined } | undefined;
      servicesBox.current = createWorkspaceServices({
        configurationOperationGuard: guard,
        standaloneServerService: {
          refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => undefined,
        markConfigurationsClean: (roots: string[]) => { markCleanCalls.push(roots); },
        reloadEntries: () => Promise.resolve(),
        treeProvider: { getEntries: () => [] } as unknown as CommandServices['treeProvider'],
        bslAnalyzerConfigService: {
          updateSource: (roots: string[]) => { updateSourceCalls.push(roots); },
        } as unknown as CommandServices['bslAnalyzerConfigService'],
      });
      depsBox.current = createDeps({
        listDatabaseExtensions: () => Promise.resolve(['EVOLC']),
        decompileExtension: (name, root) => {
          observedDuringDecompile = { dirExists: fs.existsSync(root), heldBy: guard.heldBy };
          // Результат выгрузки Конфигуратора — настоящее расширение EVOLC из example/.
          fs.cpSync(EXAMPLE_CFE_EVOLC, root, { recursive: true });
          assert.strictEqual(name, 'EVOLC');
          return Promise.resolve(true);
        },
      });

      await vscode.commands.executeCommand('onecdev.connectExtension');

      assert.deepStrictEqual(observedDuringDecompile, { dirExists: true, heldBy: 'Подключение расширения EVOLC' });
      assert.strictEqual(fs.existsSync(path.join(extensionRoot, 'Configuration.xml')), true);
      assert.deepStrictEqual(markCleanCalls, [[extensionRoot]]);
      assert.deepStrictEqual(updateSourceCalls, [[extensionRoot]]);
      assert.strictEqual(guard.isBusy, false);
    });

    const FAILURE_CASES: { label: string; decompile: ExtensionCommandsDeps['decompileExtension'] }[] = [
      { label: 'выгрузка вернула false', decompile: () => Promise.resolve(false) },
      { label: 'выгрузка бросила исключение', decompile: () => Promise.reject(new Error('Конфигуратор завершился с ошибкой')) },
    ];

    FAILURE_CASES.forEach(({ label, decompile }) => {
      test(`guard свободен, ${label} — созданный каталог удаляется, guard освобождён`, async () => {
        const guard = new ConfigurationOperationGuard();
        let reloadCalls = 0;
        let dirExistedDuringDecompile = false;
        servicesBox.current = createWorkspaceServices({
          configurationOperationGuard: guard,
          standaloneServerService: {
            refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
          } as unknown as CommandServices['standaloneServerService'],
          setTreeProcessingState: () => undefined,
          reloadEntries: () => { reloadCalls += 1; return Promise.resolve(); },
        });
        depsBox.current = createDeps({
          listDatabaseExtensions: () => Promise.resolve(['EVOLC']),
          decompileExtension: (...args) => {
            dirExistedDuringDecompile = fs.existsSync(args[1]);
            return decompile(...args);
          },
        });

        await vscode.commands.executeCommand('onecdev.connectExtension');

        assert.strictEqual(dirExistedDuringDecompile, true);
        assert.strictEqual(fs.existsSync(extensionRoot), false);
        assert.strictEqual(reloadCalls, 1);
        assert.strictEqual(guard.isBusy, false);
      });
    });

    test('выгрузка не удалась, а каталог удалить нельзя — сбой в журнал кодом ФС, дерево всё равно перезагружается (#111)', async function () {
      // Каталог src/cfe без права записи — удаление вложенного каталога расширения отбивается EACCES,
      // как на Windows при чужом дескрипторе. От root права не действуют — проверка теряет смысл.
      if (process.platform === 'win32' || process.getuid?.() === 0) {
        this.skip();
      }
      const guard = new ConfigurationOperationGuard();
      const lines: string[] = [];
      let reloadCalls = 0;
      const cfeDir = path.dirname(extensionRoot);
      servicesBox.current = createWorkspaceServices({
        configurationOperationGuard: guard,
        standaloneServerService: {
          refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => undefined,
        reloadEntries: () => { reloadCalls += 1; return Promise.resolve(); },
        outputChannel: { appendLine: (line: string) => { lines.push(line); } } as unknown as vscode.OutputChannel,
      });
      depsBox.current = createDeps({
        listDatabaseExtensions: () => Promise.resolve(['EVOLC']),
        decompileExtension: (_name, root) => {
          fs.cpSync(EXAMPLE_CFE_EVOLC, root, { recursive: true });
          fs.chmodSync(cfeDir, 0o500);
          return Promise.resolve(false);
        },
      });

      try {
        await vscode.commands.executeCommand('onecdev.connectExtension');
      } finally {
        fs.chmodSync(cfeDir, 0o700);
      }

      assert.strictEqual(reloadCalls, 1);
      assert.strictEqual(guard.isBusy, false);
      assert.strictEqual(fs.existsSync(extensionRoot), true);
      assert.ok(
        lines.includes(`[actions][warn] Не удалось удалить каталог расширения ${extensionRoot}: EACCES`),
        lines.join('\n')
      );
    });
  });

  /**
   * Issue #39: `onecdev.runThinClient` (DbCommands) должен пропускать запуск
   * тонкого клиента, когда предварительное обновление конфигураций отбилось
   * `busy`. `DbRunCommandRunner` не инжектируется (архитектор не выносил его в
   * deps для этой задачи) — наблюдаемый эффект «была ли реальная попытка
   * запуска» берётся из `outputChannel`: при отсутствующем `env.json`
   * `resolveConnectionFromSettings` синхронно бросает ДО спавна процесса, и
   * `runDbClientFromWorkspace` перехватывает это в `[db-run][error]` —
   * достаточно детерминированное и безопасное (без реального процесса 1С)
   * доказательство факта попытки запуска.
   */
  suite('registerDbCommands — runThinClient через общий guard (issue #39)', () => {
    let originalShowQuickPick: typeof vscode.window.showQuickPick;
    let workspaceRoot: string;
    let outputLines: string[];

    setup(() => {
      workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-db-run-'));
      outputLines = [];
      originalShowQuickPick = vscode.window.showQuickPick;
      (vscode.window as Pick<typeof vscode.window, 'showQuickPick'>).showQuickPick =
        (() => Promise.resolve({ id: 'update' })) as unknown as typeof vscode.window.showQuickPick;
    });

    teardown(() => {
      (vscode.window as Pick<typeof vscode.window, 'showQuickPick'>).showQuickPick = originalShowQuickPick;
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    function createDbServices(overrides: Partial<CommandServices>): CommandServices {
      return createServices({
        workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'db-run-fixture', index: 0 },
        projectSecretStorage: {} as unknown as CommandServices['projectSecretStorage'],
        outputChannel: { appendLine: (line: string) => { outputLines.push(line); } } as unknown as vscode.OutputChannel,
        ...overrides,
      });
    }

    test('guard занят «Хранилище: синхронизация» — тонкий клиент не запускается', async () => {
      const guard = new ConfigurationOperationGuard();
      const lease = guard.tryAcquire('Хранилище: синхронизация');
      servicesBox.current = createDbServices({
        configurationOperationGuard: guard,
        getChangedConfigurations: () => [{ kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 2 }],
      });

      await vscode.commands.executeCommand('onecdev.runThinClient');

      assert.strictEqual(
        outputLines.some((line) => line.includes('[db-run]')),
        false,
        'при busy тонкий клиент не должен даже пытаться разрешить подключение'
      );
      assert.strictEqual(guard.heldBy, 'Хранилище: синхронизация');
      lease?.release();
    });

    test('есть изменённая cf, QuickPick подтвердил обновление, updateMainConfiguration → true (done) — тонкий клиент пытается запуститься', async () => {
      let updateRunnerCalls = 0;
      servicesBox.current = createDbServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        getChangedConfigurations: () => [{ kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 }],
        standaloneServerService: {
          refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => undefined,
        markConfigurationsClean: () => undefined,
      });
      depsBox.current = createDeps({
        updateMainConfiguration: () => { updateRunnerCalls += 1; return Promise.resolve(true); },
      });

      await vscode.commands.executeCommand('onecdev.runThinClient');

      assert.strictEqual(updateRunnerCalls, 1, 'исход "done" обязан быть получен через реальный вызов runner\'а обновления');
      assert.strictEqual(
        outputLines.some((line) => line.includes('[db-run][error]') && line.includes('env.json')),
        true,
        'при успешном исходе (done) confirmUpdateBeforeThinClient тонкий клиент обязан попытаться запуститься'
      );
    });

    test('есть изменённая cf, QuickPick подтвердил обновление, updateMainConfiguration → false (failed) — тонкий клиент не запускается', async () => {
      let updateRunnerCalls = 0;
      servicesBox.current = createDbServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        getChangedConfigurations: () => [{ kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 }],
        standaloneServerService: {
          refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => undefined,
        markConfigurationsClean: () => undefined,
      });
      depsBox.current = createDeps({
        updateMainConfiguration: () => { updateRunnerCalls += 1; return Promise.resolve(false); },
      });

      await vscode.commands.executeCommand('onecdev.runThinClient');

      assert.strictEqual(updateRunnerCalls, 1, 'исход "failed" обязан быть получен через реальный вызов runner\'а обновления');
      assert.strictEqual(
        outputLines.some((line) => line.includes('[db-run]')),
        false,
        'при неуспешном исходе (failed) тонкий клиент не должен даже пытаться запуститься'
      );
    });

    test('runConfigurator: хранилище подключённой cf из дерева передаётся конфигуратору (issue #8)', async function () {
      if (process.platform === 'win32') {
        // Процесс-заглушка — shell-скрипт; на Windows запускать нечем.
        this.skip();
      }
      const designer = createArgsRecordingDesigner(workspaceRoot);
      fs.writeFileSync(path.join(workspaceRoot, 'env.json'), JSON.stringify({
        default: {
          '--ibconnection': '/F/tmp/v8-db-run-база',
          '--path': designer.executablePath,
          '--repo-path': '/srv/хранилище',
          '--repo-user': 'Разработчик',
        },
      }), 'utf-8');
      const secretMap = new Map<string, string>();
      const projectSecretStorage = new ProjectSecretStorage({
        get: (key: string) => Promise.resolve(secretMap.get(key)),
        store: (key: string, value: string) => { secretMap.set(key, value); return Promise.resolve(); },
        delete: (key: string) => { secretMap.delete(key); return Promise.resolve(); },
      }, workspaceRoot);
      const repositoryService = new RepositoryService(workspaceRoot, projectSecretStorage);
      const target = repositoryService.resolveTargetByConfigRoot(EXAMPLE_CF);
      assert.ok(target);
      repositoryService.setConnected(target, true);
      servicesBox.current = createDbServices({
        projectSecretStorage,
        repositoryService,
        treeProvider: { getEntries: () => [{ kind: 'cf', rootPath: EXAMPLE_CF }] } as unknown as CommandServices['treeProvider'],
      });
      const originalShowInformationMessage = vscode.window.showInformationMessage;
      (vscode.window as Pick<typeof vscode.window, 'showInformationMessage'>).showInformationMessage =
        () => Promise.resolve(undefined);
      try {
        await vscode.commands.executeCommand('onecdev.runConfigurator');
      } finally {
        (vscode.window as Pick<typeof vscode.window, 'showInformationMessage'>).showInformationMessage = originalShowInformationMessage;
      }

      assert.deepStrictEqual(await designer.waitForArgs(), [
        'DESIGNER', '/F', '/tmp/v8-db-run-база',
        '/ConfigurationRepositoryF', '/srv/хранилище',
        '/ConfigurationRepositoryN', 'Разработчик',
      ]);
    });
  });

  /**
   * Issue #39: MCP-мост `onecdev_execute_command` идёт через
   * `vscode.commands.executeCommand`, поэтому попадает в ТЕ ЖЕ команды,
   * зарегистрированные выше на `servicesBox`/`depsProxy`. `registerConfigLifecycleTools`
   * читает из `McpRegistrationDeps` только `services`/`gate` для этого
   * конкретного tool'а (остальные поля используются другими tools того же
   * домена) — реальный `McpMutationGate` строится без внешних систем
   * (`ok`/`wrap`/`wrapAsync`/`toolError` не обращаются к `services`), а
   * `paths`/`properties`/`mutations`/`xmlEditor`/`services` — структурные
   * заглушки, которых этот tool не касается.
   */
  suite('MCP-мост onecdev_execute_command — общий guard и явный исход (issue #39)', () => {
    let executeCommandTool: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

    suiteSetup(() => {
      const tools = new Map<string, { handler: (args: Record<string, unknown>) => unknown }>();
      const mockServer = {
        registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => unknown) => {
          tools.set(name, { handler });
        },
      };
      const deps: McpRegistrationDeps = {
        services: {} as unknown as McpCommandServices,
        xmlEditor: {} as unknown as McpRegistrationDeps['xmlEditor'],
        paths: {} as unknown as McpRegistrationDeps['paths'],
        properties: {} as unknown as McpRegistrationDeps['properties'],
        mutations: {} as unknown as McpRegistrationDeps['mutations'],
        gate: new McpMutationGate({} as unknown as McpCommandServices),
      };
      registerConfigLifecycleTools(mockServer as unknown as McpServer, deps);
      const tool = tools.get('onecdev_execute_command');
      assert.ok(tool, 'onecdev_execute_command должен быть зарегистрирован');
      executeCommandTool = tool.handler as typeof executeCommandTool;
    });

    function extractResponse(result: unknown): Record<string, unknown> {
      const content = (result as { content: { type: string; text: string }[] }).content;
      return JSON.parse(content[0].text) as Record<string, unknown>;
    }
    function isErrorResult(result: unknown): boolean {
      return (result as { isError?: boolean }).isError === true;
    }

    ['onecdev.importConfigurations', 'onecdev.updateChangedConfigurations'].forEach((command) => {
      test(`busy: "${command}" — {command, outcome:'busy', heldBy, result:false}, аренда цела`, async () => {
        const guard = new ConfigurationOperationGuard();
        const lease = guard.tryAcquire('Синхронизация с хранилищем: Основная конфигурация');
        servicesBox.current = createServices({ configurationOperationGuard: guard });

        const result = await executeCommandTool({ command });

        assert.strictEqual(isErrorResult(result), false);
        assert.deepStrictEqual(extractResponse(result), {
          command,
          outcome: 'busy',
          heldBy: 'Синхронизация с хранилищем: Основная конфигурация',
          result: false,
        });
        assert.strictEqual(guard.heldBy, 'Синхронизация с хранилищем: Основная конфигурация');
        lease?.release();
      });
    });

    test('update: нет изменений — {outcome:"no-changes", result:true}', async () => {
      servicesBox.current = createServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        getChangedConfigurations: () => [],
        setTreeProcessingState: () => undefined,
        markConfigurationsClean: () => undefined,
      });

      const result = await executeCommandTool({ command: 'onecdev.updateChangedConfigurations' });

      assert.deepStrictEqual(extractResponse(result), {
        command: 'onecdev.updateChangedConfigurations',
        outcome: 'no-changes',
        result: true,
      });
    });

    test('update: одна изменённая cf, успешный runner — {outcome:"done", completed:[cf], result:true}', async () => {
      servicesBox.current = createServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        getChangedConfigurations: () => [{ kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 }],
        standaloneServerService: {
          refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => undefined,
        markConfigurationsClean: () => undefined,
      });
      depsBox.current = createDeps({ updateMainConfiguration: () => Promise.resolve(true) });

      const result = await executeCommandTool({ command: 'onecdev.updateChangedConfigurations' });

      assert.deepStrictEqual(extractResponse(result), {
        command: 'onecdev.updateChangedConfigurations',
        outcome: 'done',
        completed: [CF_NAME],
        result: true,
      });
    });

    test('update all:true: cf успешно, cfe провалилось — {outcome:"failed", completed:[cf], stoppedAt:cfe, result:false}', async () => {
      servicesBox.current = createServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        getChangedConfigurations: () => [
          { kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 },
          { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC, name: CFE_NAME, changedFilesCount: 1 },
        ],
        standaloneServerService: {
          refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => undefined,
        markConfigurationsClean: () => undefined,
      });
      depsBox.current = createDeps({
        updateMainConfiguration: () => Promise.resolve(true),
        updateExtension: () => Promise.resolve(false),
      });

      const result = await executeCommandTool({ command: 'onecdev.updateChangedConfigurations', all: true });

      assert.deepStrictEqual(extractResponse(result), {
        command: 'onecdev.updateChangedConfigurations',
        outcome: 'failed',
        completed: [CF_NAME],
        stoppedAt: CFE_NAME,
        result: false,
      });
    });

    test('update без аргументов, две изменённых — invalid-selection selection-required, picker не вызван', async () => {
      servicesBox.current = createServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        getChangedConfigurations: () => [
          { kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 },
          { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC, name: CFE_NAME, changedFilesCount: 1 },
        ],
      });

      const result = await executeCommandTool({ command: 'onecdev.updateChangedConfigurations' });

      const { message, ...rest } = extractResponse(result);
      assert.deepStrictEqual(rest, {
        command: 'onecdev.updateChangedConfigurations',
        outcome: 'invalid-selection',
        reason: 'selection-required',
        available: [CF_NAME, CFE_NAME],
        result: false,
      });
      assert.strictEqual(typeof message, 'string');
    });

    test('update configurations [EVOLC] при изменённой только cf — invalid-selection unknown-names', async () => {
      servicesBox.current = createServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        getChangedConfigurations: () => [{ kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 }],
      });

      const result = await executeCommandTool({ command: 'onecdev.updateChangedConfigurations', configurations: [CFE_NAME] });

      const { message, ...rest } = extractResponse(result);
      assert.deepStrictEqual(rest, {
        command: 'onecdev.updateChangedConfigurations',
        outcome: 'invalid-selection',
        reason: 'unknown-names',
        available: [CF_NAME],
        unknown: [CFE_NAME],
        result: false,
      });
      assert.strictEqual(typeof message, 'string');
    });

    test('import: нет каталога src/cf — {outcome:"no-targets", result:false}', async () => {
      servicesBox.current = createServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        treeProvider: { getEntries: () => [] } as unknown as CommandServices['treeProvider'],
      });

      const result = await executeCommandTool({ command: 'onecdev.importConfigurations' });

      assert.deepStrictEqual(extractResponse(result), {
        command: 'onecdev.importConfigurations',
        outcome: 'no-targets',
        result: false,
      });
    });

    function importServices(entries: readonly unknown[]): CommandServices {
      return createServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        treeProvider: { getEntries: () => [...entries] } as unknown as CommandServices['treeProvider'],
        standaloneServerService: {
          refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => undefined,
        markConfigurationsClean: () => undefined,
        reloadEntries: () => Promise.resolve(),
      });
    }

    // Главный регресс issue #42: без аргументов при нескольких конфигурациях
    // мост раньше открывал QuickPick и ждал человека. pickImportTargets —
    // throw-стаб из createDeps: его вызов провалил бы тест.
    test('import без аргументов, cf+cfe — invalid-selection selection-required, picker не вызван', async () => {
      servicesBox.current = importServices([
        { kind: 'cf', rootPath: EXAMPLE_CF },
        { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC },
      ]);

      const result = await executeCommandTool({ command: 'onecdev.importConfigurations' });

      assert.strictEqual(isErrorResult(result), false);
      const { message, ...rest } = extractResponse(result);
      assert.deepStrictEqual(rest, {
        command: 'onecdev.importConfigurations',
        outcome: 'invalid-selection',
        reason: 'selection-required',
        available: [CF_NAME, CFE_NAME],
        result: false,
      });
      assert.ok(typeof message === 'string' && message.includes('configurations'), String(message));
    });

    test('import без аргументов, одна конфигурация — done [cf]', async () => {
      servicesBox.current = importServices([{ kind: 'cf', rootPath: EXAMPLE_CF }]);
      depsBox.current = createDeps({ decompileMainConfiguration: () => Promise.resolve(true) });

      const result = await executeCommandTool({ command: 'onecdev.importConfigurations' });

      assert.deepStrictEqual(extractResponse(result), {
        command: 'onecdev.importConfigurations',
        outcome: 'done',
        completed: [CF_NAME],
        result: true,
      });
    });

    test('import configurations [EVOLC] — done [EVOLC]', async () => {
      servicesBox.current = importServices([
        { kind: 'cf', rootPath: EXAMPLE_CF },
        { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC },
      ]);
      depsBox.current = createDeps({ decompileExtension: () => Promise.resolve(true) });

      const result = await executeCommandTool({ command: 'onecdev.importConfigurations', configurations: [CFE_NAME] });

      assert.deepStrictEqual(extractResponse(result), {
        command: 'onecdev.importConfigurations',
        outcome: 'done',
        completed: [CFE_NAME],
        result: true,
      });
    });

    test('import all:true, cf+EVOLC, оба успешны — {outcome:"done", completed:[cf, EVOLC], result:true}', async () => {
      servicesBox.current = importServices([
        { kind: 'cf', rootPath: EXAMPLE_CF },
        { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC },
      ]);
      depsBox.current = createDeps({
        decompileMainConfiguration: () => Promise.resolve(true),
        decompileExtension: () => Promise.resolve(true),
      });

      const result = await executeCommandTool({ command: 'onecdev.importConfigurations', all: true });

      assert.deepStrictEqual(extractResponse(result), {
        command: 'onecdev.importConfigurations',
        outcome: 'done',
        completed: [CF_NAME, CFE_NAME],
        result: true,
      });
    });

    test('import configurations [Нет] — invalid-selection unknown-names с unknown', async () => {
      servicesBox.current = importServices([
        { kind: 'cf', rootPath: EXAMPLE_CF },
        { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC },
      ]);

      const result = await executeCommandTool({ command: 'onecdev.importConfigurations', configurations: ['Нет'] });

      const { message, ...rest } = extractResponse(result);
      assert.deepStrictEqual(rest, {
        command: 'onecdev.importConfigurations',
        outcome: 'invalid-selection',
        reason: 'unknown-names',
        available: [CF_NAME, CFE_NAME],
        unknown: ['Нет'],
        result: false,
      });
      assert.strictEqual(typeof message, 'string');
    });

    const MALFORMED_SELECTIONS: readonly { label: string; args: Record<string, unknown> }[] = [
      { label: 'configurations вместе с all:true', args: { configurations: [CF_NAME], all: true } },
      { label: 'пустой configurations', args: { configurations: [] } },
      { label: 'пробельное имя', args: { configurations: ['  '] } },
    ];
    ['onecdev.importConfigurations', 'onecdev.updateChangedConfigurations'].forEach((command) => {
      MALFORMED_SELECTIONS.forEach(({ label, args }) => {
        test(`${command}: ${label} — isError, команда не вызвана`, async () => {
          // createServices: getEntries/getChangedConfigurations — throw-стабы,
          // вызов команды дал бы исход failed/исключение, а не ошибку входа.
          servicesBox.current = createServices({ configurationOperationGuard: new ConfigurationOperationGuard() });

          const result = await executeCommandTool({ command, ...args });

          assert.strictEqual(isErrorResult(result), true);
          assert.ok(result.content[0].text.length > 0);
        });
      });
    });

    test('busy: updateChangedConfigurations с configurations [cf] — busy с heldBy, аренда цела', async () => {
      const guard = new ConfigurationOperationGuard();
      const lease = guard.tryAcquire('Синхронизация с хранилищем: Основная конфигурация');
      servicesBox.current = createServices({ configurationOperationGuard: guard });

      const result = await executeCommandTool({ command: 'onecdev.updateChangedConfigurations', configurations: [CF_NAME] });

      assert.deepStrictEqual(extractResponse(result), {
        command: 'onecdev.updateChangedConfigurations',
        outcome: 'busy',
        heldBy: 'Синхронизация с хранилищем: Основная конфигурация',
        result: false,
      });
      assert.strictEqual(guard.heldBy, 'Синхронизация с хранилищем: Основная конфигурация');
      lease?.release();
    });

    suite('refresh — фейковая регистрация команды на время теста', () => {
      let disposable: vscode.Disposable | undefined;

      teardown(() => {
        disposable?.dispose();
        disposable = undefined;
      });

      test('успешный refresh — {outcome:"done", completed:[], result:true}, команда вызвана 1 раз', async () => {
        let calls = 0;
        disposable = vscode.commands.registerCommand('onecdev.refresh', () => { calls += 1; });

        const result = await executeCommandTool({ command: 'onecdev.refresh' });

        assert.deepStrictEqual(extractResponse(result), {
          command: 'onecdev.refresh',
          outcome: 'done',
          completed: [],
          result: true,
        });
        assert.strictEqual(calls, 1);
      });

      [{ configurations: ['X'] }, { all: true }, { all: false }].forEach((args) => {
        test(`refresh с ${JSON.stringify(args)} — isError, команда не вызвана`, async () => {
          let calls = 0;
          disposable = vscode.commands.registerCommand('onecdev.refresh', () => { calls += 1; });

          const result = await executeCommandTool({ command: 'onecdev.refresh', ...args });

          assert.strictEqual(isErrorResult(result), true);
          assert.ok(result.content[0].text.includes('onecdev.refresh'));
          assert.strictEqual(calls, 0);
        });
      });

      test('refresh бросил исключение — isError:true, текст ошибки', async () => {
        disposable = vscode.commands.registerCommand('onecdev.refresh', () => {
          throw new Error('x');
        });

        const result = await executeCommandTool({ command: 'onecdev.refresh' });

        assert.strictEqual(isErrorResult(result), true);
        assert.strictEqual(result.content[0].text, 'x');
      });
    });
  });

  /**
   * Issue #40: подключение, создание, отключение, пользователи, выгрузка версии,
   * отчёт и метка запускают Конфигуратор на той же базе, что импорт и обновление.
   * Занятость проверяется до форм и диалогов, а сам процесс идёт под арендой guard'а.
   * Процесс 1С внедрён через `runRepositoryCli`; исход «ошибка» выбран, чтобы
   * успешное подключение не запускало настоящую синхронизацию с базой.
   */
  suite('RepositoryCommands: подключение, пользователи, отчёты — под guard\'ом (issue #40)', () => {
    type Stubs = Pick<typeof vscode.window, 'showQuickPick' | 'showInputBox' | 'showSaveDialog'>;
    const stubsRef = vscode.window as Stubs;
    let originals: Stubs;
    let dialogCalls: string[];
    let connectionFormCalls: number;
    /** Ошибки, которые форма подключения/создания показала бы у себя (issue #184). */
    let formErrors: string[];
    let cliCalls: { command: string; heldBy: string | undefined }[];
    let busyMessages: string[];

    const target: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'Основная конфигурация' };

    const cases: { command: string; cli: string; title: string }[] = [
      { command: 'onecdev.repository.connect', cli: 'repository-bind', title: 'Подключение к хранилищу: Основная конфигурация' },
      { command: 'onecdev.repository.create', cli: 'repository-create', title: 'Создание хранилища: Основная конфигурация' },
      { command: 'onecdev.repository.disconnect', cli: 'repository-unbind', title: 'Отключение от хранилища: Основная конфигурация' },
      { command: 'onecdev.repository.addUser', cli: 'repository-add-user', title: 'Пользователь хранилища: Основная конфигурация' },
      { command: 'onecdev.repository.copyUsers', cli: 'repository-copy-users', title: 'Копирование пользователей: Основная конфигурация' },
      { command: 'onecdev.repository.dump', cli: 'repository-dump', title: 'Выгрузка версии: Основная конфигурация' },
      { command: 'onecdev.repository.report', cli: 'repository-report', title: 'Отчёт по хранилищу: Основная конфигурация' },
      { command: 'onecdev.repository.setLabel', cli: 'repository-set-label', title: 'Установка метки: Основная конфигурация' },
    ];

    setup(() => {
      dialogCalls = [];
      connectionFormCalls = 0;
      formErrors = [];
      cliCalls = [];
      busyMessages = [];
      originals = {
        showQuickPick: vscode.window.showQuickPick,
        showInputBox: vscode.window.showInputBox,
        showSaveDialog: vscode.window.showSaveDialog,
      };
      // Первый пункт одиночного выбора и пустой множественный — достаточно, чтобы
      // каждая команда дошла до запуска Конфигуратора.
      stubsRef.showQuickPick = ((items: readonly unknown[], options?: vscode.QuickPickOptions) => {
        dialogCalls.push('showQuickPick');
        return Promise.resolve(options?.canPickMany ? [] : items[0]);
      }) as unknown as typeof vscode.window.showQuickPick;
      stubsRef.showInputBox = () => {
        dialogCalls.push('showInputBox');
        return Promise.resolve('значение');
      };
      stubsRef.showSaveDialog = () => {
        dialogCalls.push('showSaveDialog');
        return Promise.resolve(vscode.Uri.file(path.join(os.tmpdir(), 'onecdev-repo-dump.cf')));
      };

      const guard = new ConfigurationOperationGuard();
      repositoryDepsBox.current = {
        ...DEFAULT_REPOSITORY_FILE_SYNC_DEPS,
        runRepositoryCli: (request) => {
          cliCalls.push({ command: request.command, heldBy: guard.heldBy });
          return Promise.resolve({ status: 'failed', message: 'хранилище недоступно' });
        },
        notifyBusy: (message) => { busyMessages.push(message); },
      };
      servicesBox.current = createServices({
        configurationOperationGuard: guard,
        repositoryService: {
          resolveTargetByXmlPath: () => target,
          hasBinding: () => true,
          isConnected: () => true,
          loadBinding: () => Promise.resolve(undefined),
          hasStoredRepoPassword: () => Promise.resolve(false),
          findCommandSectionStorages: () => [],
        } as unknown as RepositoryService,
        repositoryConnectionViewProvider: {
          // Форма отправлена один раз; исход операции решает, чем разрешится show() (issue #184).
          show: async (_mode: string, _target: string, _initial: unknown,
            onSubmit: (data: RepositoryConnectionFormData) => Promise<RepositoryConnectionSubmitOutcome<unknown>>) => {
            connectionFormCalls += 1;
            const outcome = await onSubmit({ repoPath: '/tmp/хранилище', repoUser: 'Admin', repoPassword: '' });
            if (!outcome.ok) {
              formErrors.push(outcome.error);
              return undefined;
            }
            return outcome.value;
          },
        } as unknown as CommandServices['repositoryConnectionViewProvider'],
      });
    });

    teardown(() => {
      stubsRef.showQuickPick = originals.showQuickPick;
      stubsRef.showInputBox = originals.showInputBox;
      stubsRef.showSaveDialog = originals.showSaveDialog;
      repositoryDepsBox.current = DEFAULT_REPOSITORY_FILE_SYNC_DEPS;
    });

    cases.forEach(({ command, cli, title }) => {
      test(`${command}: guard занят импортом — ни форм, ни диалогов, ни Конфигуратора; одно уведомление, чужая аренда цела`, async () => {
        const guard = servicesBox.current.configurationOperationGuard;
        const lease = guard.tryAcquire('Импорт конфигураций');

        await vscode.commands.executeCommand(command, CF_NODE);

        assert.deepStrictEqual(dialogCalls, []);
        assert.strictEqual(connectionFormCalls, 0);
        assert.deepStrictEqual(cliCalls, []);
        assert.deepStrictEqual(busyMessages, [
          `${title}: уже выполняется операция "Импорт конфигураций". Дождитесь её завершения.`,
        ]);
        assert.strictEqual(guard.heldBy, 'Импорт конфигураций');
        lease?.release();
      });

      test(`${command}: guard свободен — «${cli}» выполняется под арендой «${title}», после ошибки guard свободен`, async () => {
        const guard = servicesBox.current.configurationOperationGuard;

        await vscode.commands.executeCommand(command, CF_NODE);

        assert.deepStrictEqual(cliCalls, [{ command: cli, heldBy: title }]);
        assert.deepStrictEqual(busyMessages, []);
        // Подключение и создание показывают ошибку в своей форме, остальные команды — уведомлением.
        const inForm = cli === 'repository-bind' || cli === 'repository-create';
        const shown = inForm ? formErrors : bridgeErrorMessages;
        assert.deepStrictEqual([shown.length, (inForm ? bridgeErrorMessages : formErrors).length], [1, 0]);
        assert.ok(shown[0].includes('хранилище недоступно'), shown[0]);
        assert.strictEqual(guard.isBusy, false);
      });
    });

    test('узел не корень конфигурации — предупреждение, guard не проверяется, Конфигуратор не запускается', async () => {
      const lease = servicesBox.current.configurationOperationGuard.tryAcquire('Импорт конфигураций');

      await vscode.commands.executeCommand('onecdev.repository.report', {
        xmlPath: path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml'),
        nodeKind: 'Catalog',
      });

      assert.strictEqual(bridgeWarningMessages.length, 1);
      assert.deepStrictEqual(busyMessages, []);
      assert.deepStrictEqual(dialogCalls, []);
      assert.deepStrictEqual(cliCalls, []);
      lease?.release();
    });

    [
      { command: 'onecdev.repository.report', cli: 'repository-report', ran: false },
      { command: 'onecdev.repository.connect', cli: 'repository-bind', ran: true },
    ].forEach(({ command, cli, ran }) => {
      test(`${command}: подключения к хранилищу нет — ${ran ? 'подключение его и не требует, «' + cli + '» выполняется' : 'предупреждение, Конфигуратор не запускается'}`, async () => {
        servicesBox.current = {
          ...servicesBox.current,
          repositoryService: {
            ...(servicesBox.current.repositoryService as unknown as Record<string, unknown>),
            hasBinding: () => false,
            isConnected: () => false,
          } as unknown as RepositoryService,
        };

        await vscode.commands.executeCommand(command, CF_NODE);

        assert.deepStrictEqual(cliCalls.map((call) => call.command), ran ? [cli] : []);
        assert.strictEqual(bridgeWarningMessages.length, ran ? 0 : 1);
      });
    });

    /** Issue #61: первым пунктом стоит штатное отключение, «-Force» — только явным выбором. */
    [
      { choice: 'первый пункт', pick: (items: readonly { value: boolean }[]) => items[0], extraArgs: [] as string[] },
      { choice: 'пункт «принудительно»', pick: (items: readonly { value: boolean }[]) => items.find((item) => item.value), extraArgs: ['-Force'] },
    ].forEach(({ choice, pick, extraArgs }) => {
      test(`repository.disconnect: ${choice} → аргументы «${extraArgs.join(' ')}»`, async () => {
        const requests: RepositoryCliRequest[] = [];
        repositoryDepsBox.current = {
          ...repositoryDepsBox.current,
          runRepositoryCli: (request) => {
            requests.push(request);
            return Promise.resolve({ status: 'failed', message: 'хранилище недоступно' });
          },
        };
        stubsRef.showQuickPick = ((items: readonly { value: boolean }[]) => Promise.resolve(pick(items))) as unknown as typeof vscode.window.showQuickPick;

        await vscode.commands.executeCommand('onecdev.repository.disconnect', CF_NODE);

        assert.strictEqual(requests.length, 1);
        assert.deepStrictEqual(requests[0].extraArgs, extraArgs);
      });
    });
  });
});
