import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as vscode from 'vscode';
import { buildScopeKey, computeFileHash, saveHashCache } from '../../infra/cache/HashCache';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import { decodeLogFile, type RepositoryCliResult } from '../../ui/commands/repository/RepositoryCommandRunner';
import type { MergeDiffPair, NotificationAction } from '../../ui/commands/repository/RepositoryFileSyncDialogs';
import { DEFAULT_REPOSITORY_FILE_SYNC_DEPS } from '../../ui/commands/repository/RepositoryFileSyncShared';
import { McpMetadataPathService } from '../../ui/mcp/McpMetadataPathService';
import { McpMutationGate } from '../../ui/mcp/registration/McpMutationGate';
import type { McpCommandServices, McpRegistrationDeps } from '../../ui/mcp/registration/McpRegistrationDeps';
import { registerRepositoryOperations } from '../../ui/mcp/registration/McpRepositoryOperations';
import { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import { createPartialDumpFixture } from './support/partialDumpFixture';
import { createLockWorkspace, EXAMPLE_CF_221, lockFixturePath, PARTIAL_LOCKS_ROOT, scenarioFixturePath } from './support/repositoryLockFixtures';

const CATALOG = 'Справочники.Контрагенты';
const FORM = `${CATALOG}.Форма.ФормаЭлемента`;
const TEMPLATE = `${CATALOG}.Макет.ЗагрузкаИзФайла`;
const OWNER_XML = 'Catalogs/Контрагенты.xml';
const ROOT = 'Конфигурация';

interface OperationOutput {
  outcome: string;
  recursive: boolean;
  units: string[];
  changedFiles: string[];
  conflicts: string[];
  warnings: string[];
  messages: string[];
}

suite('MCP-операции хранилища (#191)', () => {
  let workspace: Awaited<ReturnType<typeof createLockWorkspace>>;
  let tree: MetadataTreeProvider;
  let gate: McpMutationGate;
  let guard: ConfigurationOperationGuard;
  let sync: boolean;
  let confirm: boolean | undefined;
  let request: AbortController;
  let cancelWhileConfirming: boolean;
  let cliResult: RepositoryCliResult;
  let dump: ReturnType<typeof createPartialDumpFixture>;
  let calls: { command: string; flags: string[]; objects: string }[];
  let prompts: string[];
  let notificationActions: NotificationAction[];
  let openedDiffs: MergeDiffPair[];
  let handlers: Map<string, (args: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<CallToolResult>>;

  setup(async () => {
    workspace = await createLockWorkspace({ repoPath: lockFixturePath('8.5.1'), repoUser: 'Admin', repoPassword: '' });
    const { configRoot, workspaceRoot, service, target } = workspace;
    service.setConnected(target, true);
    const uri = vscode.Uri.file(workspaceRoot);
    tree = new MetadataTreeProvider([{ rootPath: configRoot, kind: 'cf' }], uri, path.join(workspaceRoot, 'test-cache'));
    guard = new ConfigurationOperationGuard();
    const services = {
      repositoryService: service,
      treeProvider: tree,
      configurationOperationGuard: guard,
      workspaceFolder: { uri, index: 0, name: 'test' },
      outputChannel: { appendLine: () => undefined },
      suppressConfigurationReloadForFiles: () => undefined,
      markChangedConfigurationByFiles: () => undefined,
      refreshActionsView: () => undefined,
      reloadEntries: () => Promise.resolve(),
    } as unknown as McpCommandServices;
    gate = new McpMutationGate(services);
    handlers = new Map();
    calls = [];
    prompts = [];
    notificationActions = [];
    openedDiffs = [];
    sync = false;
    confirm = undefined;
    request = new AbortController();
    cancelWhileConfirming = false;
    cliResult = { status: 'done' };
    dump = createPartialDumpFixture(EXAMPLE_CF_221, target.displayName);
    const server = {
      registerTool: (name: string, _schema: unknown, handler: (args: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<CallToolResult>) => {
        handlers.set(name, handler);
      },
    };
    registerRepositoryOperations(server as never, {
      services, paths: new McpMetadataPathService(tree), gate,
    } as McpRegistrationDeps, {
      flow: {
        ...DEFAULT_REPOSITORY_FILE_SYNC_DEPS,
        runRepositoryCli: ({ command, extraArgs }) => {
          assert.strictEqual(guard.isBusy, true);
          const objects = fs.readFileSync(extraArgs[extraArgs.indexOf('-ObjectsFile') + 1], 'utf-8');
          calls.push({ command, flags: extraArgs, objects });
          return Promise.resolve(cliResult);
        },
        dumpToTemp: (target, request, services) => dump.dumpToTemp(target, request, services),
        notifyInfo: (_message, actions) => {
          assert.strictEqual(guard.isBusy, false);
          notificationActions.push(...actions ?? []);
        },
        openDiffs: (pairs) => {
          openedDiffs.push(...pairs);
          return Promise.resolve();
        },
        getDirtyFilePaths: () => [],
        isFileSyncEnabled: () => sync,
      },
      confirmOperation: (message, button) => {
        assert.strictEqual(guard.isBusy, false);
        assert.strictEqual(calls.length, 0);
        prompts.push(message);
        if (cancelWhileConfirming) {
          request.abort();
        }
        return Promise.resolve(confirm ?? button === 'Захватить');
      },
    });
  });

  teardown(() => {
    dump.disposeAll();
    tree.dispose();
    workspace.dispose();
  });

  async function invoke(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const call = handlers.get(`onecdev_repository_${tool}`);
    assert.ok(call);
    return await call(args, { signal: request.signal });
  }

  function textOf(result: CallToolResult): string {
    const first = result.content[0];
    assert.strictEqual(first.type, 'text');
    return first.text;
  }

  async function ok<T = OperationOutput>(tool: string, args: Record<string, unknown>): Promise<T> {
    const result = await invoke(tool, args);
    assert.notStrictEqual(result.isError, true, textOf(result));
    return JSON.parse(textOf(result)) as T;
  }

  async function rejects(tool: string, args: Record<string, unknown>, expected: RegExp): Promise<void> {
    const result = await invoke(tool, args);
    assert.strictEqual(result.isError, true);
    assert.match(textOf(result), expected);
  }

  for (const [canonical, unit] of [
    [CATALOG, 'Справочник.Контрагенты'],
    [FORM, 'Справочник.Контрагенты.Форма.ФормаЭлемента'],
    [TEMPLATE, 'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла'],
    [ROOT, ROOT],
  ]) {
    test(`захват, статус и освобождение: ${canonical}`, async () => {
      const xml = path.join(workspace.configRoot, OWNER_XML);
      const args = { path: canonical, ...(canonical === FORM ? { recursive: true } : {}) };
      if (canonical === CATALOG) {
        assert.throws(() => { gate.assertMetadataEditable(xml); }, /не захвачен/);
      }
      const locked = await ok('lock', args);
      assert.strictEqual(locked.outcome, 'done');
      assert.strictEqual(locked.recursive, false);
      assert.deepStrictEqual(locked.units, [unit]);
      assert.ok(calls[0].flags.includes('-Revised'));
      assert.deepStrictEqual(dump.calls, []);
      assert.deepStrictEqual(notificationActions, []);
      if (canonical === CATALOG) {
        gate.assertMetadataEditable(xml);
      }
      const status = await ok<{ items: { state: string }[] }>('status', { path: [canonical] });
      assert.strictEqual(status.items[0].state, 'own');
      const unlocked = await ok('unlock', args);
      assert.strictEqual(unlocked.outcome, 'done');
      assert.deepStrictEqual(unlocked.units, [unit]);
      assert.ok(!calls[1].flags.includes('-Force'));
      const free = await ok<{ items: { state: string }[] }>('status', args);
      assert.strictEqual(free.items[0].state, 'free');
    });
  }

  test('явный force освобождения передаётся Конфигуратору, серверный отказ возвращается в ответе', async () => {
    cliResult = { status: 'failed', message: 'объект изменён в базе' };
    const response = await ok('unlock', { path: CATALOG, force: true });
    assert.ok(calls[0].flags.includes('-Force'));
    assert.strictEqual(response.outcome, 'failed');
    assert.match(response.warnings.join('\n'), /объект изменён в базе/);
  });

  test('неканонический путь, часть объекта и отключённое хранилище отклоняются', async () => {
    await rejects('lock', { path: 'Catalog.Контрагенты' }, /Catalog/);
    await rejects('update', { path: `${CATALOG}.ИНН` }, /не является единицей/);
    workspace.service.setConnected(workspace.target, false);
    await rejects('status', { path: CATALOG }, /нет активного подключения/);
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(prompts, []);
  });

  test('запись не запускается, если XML из индекса исчез или больше не описывает единицу', async () => {
    await ok('status', { path: FORM });
    const file = path.join(workspace.configRoot, OWNER_XML);
    fs.writeFileSync(file, '<сломанный XML>');
    await rejects('lock', { path: FORM }, /полное имя объекта хранилища/);
    fs.unlinkSync(file);
    await rejects('lock', { path: FORM }, /определить конфигурацию/);
    assert.deepStrictEqual(calls, []);
  });

  test('занятый guard возвращает имя операции до вопроса пользователю', async () => {
    const lease = guard.tryAcquire('Импорт конфигурации');
    assert.ok(lease);
    try {
      for (const tool of ['update', 'lock']) {
        const result = await ok(tool, { path: ROOT });
        assert.strictEqual(result.outcome, 'busy');
        assert.match(result.messages.join('\n'), /Импорт конфигурации/);
      }
      assert.deepStrictEqual(prompts, []);
      assert.deepStrictEqual(calls, []);
    } finally {
      lease.release();
    }
  });

  test('отклонение подтверждения получения блокирует вызов Конфигуратора', async () => {
    const result = await ok('update', { path: ROOT, recursive: true });
    assert.strictEqual(result.outcome, 'cancelled');
    assert.match(prompts[0], /с подчинёнными объектами.*актуальная версия/);
    assert.deepStrictEqual(calls, []);
  });

  for (const canonical of [CATALOG, ROOT]) {
    test(`повторный одиночный захват ${canonical} не вызывает Конфигуратор с -Revised`, async () => {
      await ok('lock', { path: canonical });
      const repeated = await ok('lock', { path: canonical });
      assert.strictEqual(repeated.outcome, 'done');
      assert.match(repeated.messages.join('\n'), /уже захвачен/);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(prompts.length, 1);
    });
  }

  test('рекурсивный захват требует подтверждения до вызова Конфигуратора', async () => {
    confirm = false;
    const cancelled = await ok('lock', { path: ROOT, recursive: true });
    assert.strictEqual(cancelled.outcome, 'cancelled');
    assert.match(prompts[0], /Захватить.*с подчинёнными объектами/);
    assert.strictEqual(calls.length, 0);
    confirm = true;
    const locked = await ok('lock', { path: ROOT, recursive: true });
    assert.strictEqual(locked.outcome, 'done');
    assert.match(calls[0].objects, /includeChildObjects="true"/);
  });

  test('захват объекта своего пользователя вне проекта требует подтверждения', async () => {
    confirm = false;
    await ok('status', { path: CATALOG, refresh: true });
    const cancelled = await ok('lock', { path: CATALOG });
    assert.strictEqual(cancelled.outcome, 'cancelled');
    assert.match(prompts[0], /Захватить.*может заменить/);
    assert.deepStrictEqual(calls, []);
  });

  test('локальный захват, которого сервер больше не видит, требует подтверждения повторного захвата', async () => {
    confirm = false;
    const args = { path: 'Справочники.Товары' };
    workspace.service.setLocked(workspace.target, ['Справочник.Товары'], true);
    const status = await ok<{ items: { confirmed?: boolean }[] }>('status', { ...args, refresh: true });
    assert.strictEqual(status.items[0].confirmed, false);
    const cancelled = await ok('lock', args);
    assert.strictEqual(cancelled.outcome, 'cancelled');
    assert.strictEqual(calls.length, 0);
  });

  test('захват требует подтверждения даже при свободном статусе в локальном кэше', async () => {
    confirm = false;
    const args = { path: CATALOG };
    const cached = await ok<{ items: { state: string }[] }>('status', args);
    assert.strictEqual(cached.items[0].state, 'free');
    const result = await ok('lock', args);
    assert.strictEqual(result.outcome, 'cancelled');
    assert.match(prompts[0], /Захватить.*может заменить/);
    assert.strictEqual(calls.length, 0);
    const refreshed = await ok<{ items: { state: string }[] }>('status', { ...args, refresh: true });
    assert.strictEqual(refreshed.items[0].state, 'own-elsewhere');
  });

  for (const tool of ['update', 'lock']) {
    test(`отменённый MCP-запрос ${tool} не запускается после подтверждения в редакторе`, async () => {
      confirm = true;
      cancelWhileConfirming = true;
      const result = await ok(tool, { path: ROOT, recursive: true });
      assert.strictEqual(result.outcome, 'cancelled');
      const lock = await ok('lock', { path: CATALOG });
      assert.strictEqual(lock.outcome, 'cancelled');
      assert.strictEqual(prompts.length, 1);
      assert.deepStrictEqual(calls, []);
    });
  }

  for (const conflict of [false, true]) {
    test(`получение указанной версии, конфликт файлов: ${String(conflict)}`, async () => {
      sync = true;
      confirm = true;
      const file = path.join(workspace.configRoot, OWNER_XML);
      const original = fs.readFileSync(file, 'utf-8');
      fs.writeFileSync(file, original + '\n');
      const scopeKey = buildScopeKey('cf', workspace.configRoot, '');
      saveHashCache(workspace.workspaceRoot, {
        schemaVersion: 1, scopeKey, generatedAt: '',
        files: { [OWNER_XML]: conflict ? 'хеш предыдущей версии' : computeFileHash(file) },
      });
      const result = await ok('update', { path: CATALOG, version: 9 });
      assert.strictEqual(result.outcome, 'done');
      assert.match(prompts[0], /версия 9/);
      assert.deepStrictEqual(calls[0].flags.slice(-3), ['-Version', '9', '-Force']);
      assert.strictEqual(calls[0].command, 'repository-update');
      assert.ok(dump.calls.length > 0);
      assert.deepStrictEqual(result.conflicts, conflict ? [OWNER_XML] : []);
      assert.deepStrictEqual(result.changedFiles, conflict ? [] : [file]);
      assert.deepStrictEqual(notificationActions, []);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), conflict ? original + '\n' : original);
    });
  }

  test('после захвата сравнивает конфликтующий файл с выгрузкой и синхронизирует чистые файлы', async () => {
    sync = true;
    const file = path.join(workspace.configRoot, OWNER_XML);
    const moduleRel = 'Catalogs/Контрагенты/Ext/ObjectModule.bsl';
    const moduleFile = path.join(workspace.configRoot, moduleRel);
    const receivedXml = fs.readFileSync(file);
    const receivedModule = fs.readFileSync(moduleFile);
    const localXml = fs.readFileSync(file, 'utf-8') + '\n';
    fs.writeFileSync(file, localXml);
    fs.appendFileSync(moduleFile, '\n');
    saveHashCache(workspace.workspaceRoot, {
      schemaVersion: 1, scopeKey: buildScopeKey('cf', workspace.configRoot, ''), generatedAt: '',
      files: { [OWNER_XML]: 'хеш предыдущей версии', [moduleRel]: computeFileHash(moduleFile) },
    });

    const result = await ok('lock', { path: CATALOG });

    assert.strictEqual(result.outcome, 'done');
    assert.deepStrictEqual(result.units, ['Справочник.Контрагенты']);
    assert.deepStrictEqual(result.conflicts, [OWNER_XML]);
    assert.deepStrictEqual(result.changedFiles, [moduleFile]);
    assert.deepStrictEqual(fs.readFileSync(moduleFile), receivedModule);
    assert.match(result.warnings.join('\n'), /получены в базу/);
    assert.match(result.warnings.join('\n'), /Сравнить.*в уведомлении редактора/);
    assert.deepStrictEqual(notificationActions.map(({ label }) => label), ['Сравнить']);
    assert.strictEqual(openedDiffs.length, 0);
    notificationActions[0].run();
    assert.strictEqual(openedDiffs.length, 1);
    const [pair] = openedDiffs;
    assert.strictEqual(pair.local, file);
    assert.strictEqual(pair.projectSide, 'local');
    assert.deepStrictEqual(fs.readFileSync(pair.repository), receivedXml);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), localXml);
    assert.strictEqual(calls.length, 1);
  });

  test('при частичном рекурсивном захвате сравнение исключает отказанную форму', async () => {
    sync = true;
    const ownerRel = 'Catalogs/ПричиныВозврата.xml';
    const formRel = 'Catalogs/ПричиныВозврата/Forms/ФормаЭлемента/Ext/Form/Module.bsl';
    for (const rel of [ownerRel, formRel]) {
      fs.appendFileSync(path.join(workspace.configRoot, rel), '\n');
    }
    const log = scenarioFixturePath(PARTIAL_LOCKS_ROOT, '8.5.1', 'lock-recursive-subordinate-refused.out.txt');
    cliResult = { status: 'failed', message: 'Ошибка захвата объектов в хранилище', output: decodeLogFile(fs.readFileSync(log)) };

    const result = await ok('lock', { path: 'Справочники.ПричиныВозврата', recursive: true });

    assert.strictEqual(result.outcome, 'done');
    assert.deepStrictEqual(result.units, ['Справочник.ПричиныВозврата']);
    assert.deepStrictEqual(result.conflicts, [ownerRel]);
    assert.match(result.warnings.join('\n'), /захвачены частично/);
    assert.deepStrictEqual(notificationActions.map(({ label }) => label), ['Сравнить']);
    notificationActions[0].run();
    assert.deepStrictEqual(openedDiffs.map(({ local }) => local), [path.join(workspace.configRoot, ownerRel)]);
  });

  for (const rollbackFiles of [undefined, true]) {
    test(`захват сохраняет конфликтующую правку, откат при освобождении: ${String(rollbackFiles)}`, async () => {
      sync = true;
      const file = path.join(workspace.configRoot, OWNER_XML);
      const original = fs.readFileSync(file, 'utf-8');
      fs.writeFileSync(file, original + '\n');
      const scopeKey = buildScopeKey('cf', workspace.configRoot, '');
      saveHashCache(workspace.workspaceRoot, {
        schemaVersion: 1, scopeKey, generatedAt: '',
        files: { [OWNER_XML]: 'хеш предыдущей версии' },
      });
      const locked = await ok('lock', { path: CATALOG });
      assert.deepStrictEqual(locked.conflicts, [OWNER_XML]);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), original + '\n');
      const [compare] = notificationActions;
      assert.strictEqual(compare.label, 'Сравнить');
      const unlocked = await ok('unlock', { path: CATALOG, rollbackFiles });
      assert.deepStrictEqual(unlocked.changedFiles, rollbackFiles ? [file] : []);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), rollbackFiles ? original : original + '\n');
      compare.run();
      assert.deepStrictEqual(openedDiffs.map(({ writable }) => writable), [false]);
    });
  }

  test('обновление статусов читает реальное файловое хранилище один раз для набора путей', async () => {
    const result = await ok<{ items: { state: string }[]; warnings: string[] }>('status', { path: [ROOT, CATALOG], refresh: true });
    assert.deepStrictEqual(result.items.map(({ state }) => state), ['foreign', 'own-elsewhere']);
    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(calls, []);
  });

  test('обновление статусов возвращает причину ошибки чтения', async () => {
    fs.unlinkSync(path.join(workspace.configRoot, 'ConfigDumpInfo.xml'));
    await rejects('status', { path: ROOT, refresh: true }, /Нет ConfigDumpInfo.xml/);
  });

  test('из двух одновременных обновлений статусов устаревшее возвращает предупреждение', async () => {
    const args = { path: ROOT, refresh: true };
    const results = await Promise.all([
      ok<{ warnings: string[] }>('status', args),
      ok<{ warnings: string[] }>('status', args),
    ]);
    const warnings = results.flatMap((result) => result.warnings);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /изменились во время обновления/);
  });
});
