/**
 * #174: MCP-инструменты записи не создают и не меняют файлы вне папки workspace.
 *
 * Регистрируются настоящие фабрики `registerExternalObjectTools`/`registerConfigLifecycleTools`
 * с настоящими сервисами (`ExternalObjectService`, `ConfigurationScaffoldService`,
 * `CfeBorrowService`) и настоящим `McpMutationGate` на временных каталогах. Подменён только
 * UI-хвост post-mutation (дерево, панель действий) — он записывает, какие файлы ему переданы.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CfeBorrowService } from '../../infra/cfe/CfeBorrowService';
import { ConfigurationScaffoldService } from '../../infra/xml/ConfigurationScaffoldService';
import { ExternalObjectService } from '../../infra/xml/ExternalObjectService';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import { registerConfigLifecycleTools } from '../../ui/mcp/registration/McpConfigLifecycleTools';
import { registerExternalObjectTools } from '../../ui/mcp/registration/McpExternalObjectTools';
import { McpMutationGate } from '../../ui/mcp/registration/McpMutationGate';
import type { McpRegistrationDeps } from '../../ui/mcp/registration/McpRegistrationDeps';

const EXAMPLE_ROOT = path.resolve(__dirname, '../../../example');

type ToolHandler = (args: Record<string, unknown>) => unknown;

interface Harness {
  readonly tools: Map<string, ToolHandler>;
  readonly mutatedFiles: string[];
}

function createHarness(workspaceRoot: string): Harness {
  const tools = new Map<string, ToolHandler>();
  const mutatedFiles: string[] = [];
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  const workspaceFolder: vscode.WorkspaceFolder = { uri: vscode.Uri.file(workspaceRoot), name: 'mcp-write-paths', index: 0 };
  const services = {
    workspaceFolder,
    outputChannel: { appendLine: () => undefined },
    configurationOperationGuard: new ConfigurationOperationGuard(),
    externalObjectService: new ExternalObjectService(),
    configurationScaffoldService: new ConfigurationScaffoldService(),
    cfeBorrowService: new CfeBorrowService(),
    suppressConfigurationReloadForFiles: () => undefined,
    markChangedConfigurationByFiles: (files: string[]) => {
      mutatedFiles.push(...files);
    },
    treeProvider: { refreshCacheForFiles: () => true, refresh: () => undefined },
    refreshActionsView: () => undefined,
  };
  const deps = { services, gate: new McpMutationGate(services as never) } as unknown as McpRegistrationDeps;
  registerExternalObjectTools(server as never, deps);
  registerConfigLifecycleTools(server as never, deps);
  return { tools, mutatedFiles };
}

async function call(harness: Harness, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const handler = harness.tools.get(name);
  assert.ok(handler, `инструмент ${name} не зарегистрирован`);
  return await handler(args) as CallToolResult;
}

function text(result: CallToolResult): string {
  const part = result.content[0];
  return part.type === 'text' ? part.text : '';
}

function assertRejectedOutside(result: CallToolResult): void {
  assert.strictEqual(result.isError, true, `ожидался отказ, реально: ${text(result)}`);
  assert.match(text(result), /вне рабочего пространства/);
}

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

suite('MCP-инструменты записи — только внутри workspace (#174)', () => {
  let sandbox: string;
  let workspace: string;
  let outside: string;
  let harness: Harness;

  setup(() => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-mcp-write-')));
    workspace = path.join(sandbox, 'ws');
    outside = path.join(sandbox, 'outside');
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    harness = createHarness(workspace);
  });

  teardown(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const OUTPUT_DIR_TOOLS: readonly [string, Record<string, unknown>][] = [
    ['onecdev_create_epf', { name: 'Обработка1' }],
    ['onecdev_create_erf', { name: 'Отчет1', withSkd: true }],
    ['onecdev_create_configuration', { name: 'Конфигурация1' }],
    ['onecdev_create_extension', { name: 'Расширение1', noRole: true }],
  ];

  for (const [toolName, args] of OUTPUT_DIR_TOOLS) {
    test(`${toolName}: outputDir вне workspace — отказ, снаружи ничего не создано`, async () => {
      const result = await call(harness, toolName, { ...args, outputDir: path.join(outside, 'target') });
      assertRejectedOutside(result);
      assert.deepStrictEqual(listFiles(outside), []);
      assert.deepStrictEqual(harness.mutatedFiles, []);
    });

    test(`${toolName}: относительный outputDir создаёт файлы внутри workspace`, async () => {
      const result = await call(harness, toolName, { ...args, outputDir: path.join('src', 'target') });
      assert.notStrictEqual(result.isError, true, text(result));
      assert.ok(harness.mutatedFiles.length > 0);
      for (const file of harness.mutatedFiles) {
        assert.ok(file.startsWith(path.join(workspace, 'src', 'target') + path.sep), file);
        assert.ok(fs.existsSync(file), file);
      }
    });
  }

  test('onecdev_create_epf: выход из workspace через «..» — отказ', async () => {
    assertRejectedOutside(await call(harness, 'onecdev_create_epf', { name: 'Обработка1', outputDir: path.join('..', 'outside') }));
    assert.deepStrictEqual(listFiles(outside), []);
  });

  suite('БСП-инструменты по objectPath', () => {
    let outsideModule: string;
    let outsideRoot: string;

    setup(() => {
      // Обработка вне workspace создаётся сервисом напрямую — так её мог бы подложить кто угодно.
      outsideRoot = new ExternalObjectService().createExternalDataProcessor({ name: 'Чужая', outputDir: outside }).rootPath;
      outsideModule = path.join(outside, 'Чужая', 'Ext', 'ObjectModule.bsl');
    });

    test('onecdev_epf_bsp_init: objectPath вне workspace — отказ, модуль не изменён', async () => {
      const before = fs.readFileSync(outsideModule, 'utf-8');
      assertRejectedOutside(await call(harness, 'onecdev_epf_bsp_init', { objectPath: outsideRoot, kind: 'ДополнительнаяОбработка' }));
      assert.strictEqual(fs.readFileSync(outsideModule, 'utf-8'), before);
    });

    test('onecdev_epf_bsp_add_command: objectPath вне workspace — отказ, модуль не изменён', async () => {
      const before = fs.readFileSync(outsideModule, 'utf-8');
      assertRejectedOutside(await call(harness, 'onecdev_epf_bsp_add_command', { objectPath: outsideRoot, identifier: 'Команда1' }));
      assert.strictEqual(fs.readFileSync(outsideModule, 'utf-8'), before);
    });

    test('onecdev_epf_bsp_add_command: formModulePath вне workspace — отказ даже при объекте внутри', async () => {
      const created = await call(harness, 'onecdev_create_epf', { name: 'Своя', outputDir: workspace });
      assert.notStrictEqual(created.isError, true, text(created));
      const objectPath = path.join(workspace, 'Своя.xml');
      const formModulePath = path.join(outside, 'Module.bsl');
      assertRejectedOutside(await call(harness, 'onecdev_epf_bsp_add_command', { objectPath, identifier: 'Команда1', formModulePath }));
      assert.ok(!fs.existsSync(formModulePath));
    });

    test('внутри workspace (относительные пути) БСП-инструменты работают', async () => {
      await call(harness, 'onecdev_create_epf', { name: 'Своя', outputDir: '.' });
      const init = await call(harness, 'onecdev_epf_bsp_init', { objectPath: 'Своя.xml', kind: 'ДополнительнаяОбработка' });
      assert.notStrictEqual(init.isError, true, text(init));
      const command = await call(harness, 'onecdev_epf_bsp_add_command', {
        objectPath: 'Своя.xml',
        identifier: 'Команда1',
        formModulePath: path.join('Своя', 'Forms', 'Форма', 'Ext', 'Form', 'Module.bsl'),
      });
      assert.notStrictEqual(command.isError, true, text(command));
      const second = await call(harness, 'onecdev_epf_bsp_add_command', { objectPath: 'Своя.xml', identifier: 'Команда2', commandType: 'ВызовСерверногоМетода' });
      assert.notStrictEqual(second.isError, true, text(second));
      assert.match(fs.readFileSync(path.join(workspace, 'Своя', 'Ext', 'ObjectModule.bsl'), 'utf-8'), /Команда1/);
    });
  });

  test('onecdev_cfe_borrow: extensionRoot вне workspace — отказ до обращения к сервису', async () => {
    const result = await call(harness, 'onecdev_cfe_borrow', {
      configRoot: workspace,
      extensionRoot: outside,
      typeName: 'Catalog',
      objectName: 'Контрагенты',
    });
    assertRejectedOutside(result);
    assert.deepStrictEqual(listFiles(outside), []);
  });

  test('onecdev_cfe_borrow: относительный extensionRoot внутри workspace — объект заимствуется', async () => {
    // Основная конфигурация только читается — берётся прямо из example/; расширение, в которое
    // идёт запись, копируется в workspace (тест не пишет в example/).
    const configRoot = path.join(EXAMPLE_ROOT, '2.21', 'src', 'cf');
    fs.cpSync(path.join(EXAMPLE_ROOT, '2.21', 'src', 'cfe', 'EVOLC'), path.join(workspace, 'EVOLC'), { recursive: true });
    const result = await call(harness, 'onecdev_cfe_borrow', {
      configRoot,
      extensionRoot: 'EVOLC',
      typeName: 'Catalog',
      objectName: 'Банки',
    });
    assert.notStrictEqual(result.isError, true, text(result));
    assert.ok(fs.existsSync(path.join(workspace, 'EVOLC', 'Catalogs', 'Банки.xml')));
    assert.ok(harness.mutatedFiles.length > 0);
    for (const file of harness.mutatedFiles) {
      assert.ok(file.startsWith(path.join(workspace, 'EVOLC') + path.sep), file);
    }
  });

  test('onecdev_dump_cf: outputFile вне workspace — отказ, конфигуратор не запускается', async () => {
    const outputFile = path.join(outside, 'out.cf');
    assertRejectedOutside(await call(harness, 'onecdev_dump_cf', { outputFile }));
    assert.ok(!fs.existsSync(outputFile));
  });

  test('onecdev_dump_all_cfe: outputDir вне workspace — отказ, каталог пуст', async () => {
    assertRejectedOutside(await call(harness, 'onecdev_dump_all_cfe', { outputDir: outside }));
    assert.deepStrictEqual(listFiles(outside), []);
  });
});
