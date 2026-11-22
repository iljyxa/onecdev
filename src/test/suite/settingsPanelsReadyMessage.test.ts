/**
 * Issue #182: Vue-приложения после монтирования шлют хосту `{ type: 'ready' }`, а провайдеры
 * панелей настроек считали любое сообщение, кроме `refresh`, действием панели:
 * - «Настройки проекта» — сохранением `env.json` (ложная ошибка «база не найдена» и лишний скан ИБ);
 * - «Автономный сервер» — сохранением настроек сервера без полей (ошибка в канале вывода);
 * - «ИИ и MCP» — запуском установки ИИ-ролей.
 *
 * HTML собирает настоящий `WebviewHtmlFactory` по реальному `dist/ui/manifest.json` (сборка шагом
 * pretest), сервисы — настоящие, во временном каталоге; подменена только панель — см. `fakeWebviewPanel`.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigurationXmlEditor } from '../../infra/xml';
import { AiSecretStorage } from '../../infra/ai/AiSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { parseV8iContent } from '../../infra/environment/InfoBaseRegistryService';
import { ProjectEnvironmentService } from '../../infra/environment/ProjectEnvironmentService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { StandaloneServerService } from '../../infra/standalone/StandaloneServerService';
import type { Logger } from '../../infra/support/Logger';
import type { CommandServices } from '../../ui/commands/_shared';
import { BslAnalyzerMcpService } from '../../ui/mcp/BslAnalyzerMcpService';
import { V8McpServer } from '../../ui/mcp/V8McpServer';
import { AiMcpViewProvider } from '../../ui/views/ai/AiMcpViewProvider';
import { ProjectEnvironmentViewProvider } from '../../ui/views/environment/ProjectEnvironmentViewProvider';
import { StandaloneServerViewProvider } from '../../ui/views/standalone/StandaloneServerViewProvider';
import { type FakeWebviewPanelFactory, installFakeWebviewPanels } from './support/fakeWebviewPanel';

const EXTENSION_ROOT = path.resolve(__dirname, '../../../');
const EXTENSION_URI = vscode.Uri.file(EXTENSION_ROOT);

/** Канал вывода, запоминающий строки: настоящий `OutputChannel` прочитать нельзя. */
function createRecordingOutput(): { readonly channel: vscode.OutputChannel; readonly lines: string[] } {
  const lines: string[] = [];
  const channel = { appendLine: (line: string) => { lines.push(line); } } as unknown as vscode.OutputChannel;
  return { channel, lines };
}

function createMemorySecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

/** Даёт провайдеру дообработать сообщение: обработчики завершаются цепочкой микрозадач. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Не дождались: ${what}`);
}

function statusKinds(posted: readonly unknown[]): string[] {
  return posted
    .filter((message): message is { type: 'status'; kind: string } =>
      (message as { type?: unknown }).type === 'status')
    .map((message) => message.kind);
}

suite('Панели настроек — сообщение ready от webview (issue #182)', () => {
  let panels: FakeWebviewPanelFactory;
  let workspaceRoot: string;

  setup(() => {
    panels = installFakeWebviewPanels();
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-ready-'));
  });

  teardown(() => {
    panels.restore();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  suite('«Настройки проекта»', () => {
    let scans: number;
    let output: ReturnType<typeof createRecordingOutput>;
    let provider: ProjectEnvironmentViewProvider;

    setup(async () => {
      scans = 0;
      output = createRecordingOutput();
      const service = new ProjectEnvironmentService(
        workspaceRoot,
        new ProjectSecretStorage(createMemorySecretStore(), workspaceRoot),
        {
          scanInfoBases: () => {
            scans += 1;
            return {
              bases: parseV8iContent('[Разработка]\nConnect=File="/srv/bases/dev";\n', '/tmp/ibases.v8i'),
              sources: [],
              warnings: [],
            };
          },
          scanPlatforms: () => [],
        }
      );
      provider = new ProjectEnvironmentViewProvider(service, output.channel, EXTENSION_URI);
      await provider.show();
      const [panel] = panels.panels;
      await waitFor(() => statusKinds(panel.posted).includes('idle'), 'загрузка списков баз и платформ');
    });

    teardown(() => provider.dispose());

    test('ready и неизвестный тип не сохраняют, не пишут ошибку и не пересканируют базы', async () => {
      const [panel] = panels.panels;
      const scansAfterOpen = scans;

      panel.receive({ type: 'ready' });
      panel.receive({ type: 'неизвестное' });
      await settle();

      assert.deepStrictEqual(output.lines, []);
      assert.ok(!statusKinds(panel.posted).includes('error'), 'панель не получила статус ошибки');
      assert.strictEqual(scans, scansAfterOpen);
      assert.strictEqual(fs.existsSync(path.join(workspaceRoot, 'env.json')), false);
    });

    test('save с неизвестной базой по-прежнему даёт ошибку', async () => {
      const [panel] = panels.panels;

      panel.receive({ type: 'save', platformPath: '', baseId: 'нет-такой', dbUser: '', dbPassword: '' });
      await waitFor(() => statusKinds(panel.posted).includes('error'), 'статус ошибки сохранения');

      assert.deepStrictEqual(output.lines, [
        '[environment][error] Выбранная информационная база не найдена в системном списке 1С.',
      ]);
    });
  });

  suite('«Автономный сервер»', () => {
    let saves: number;
    let logLines: string[];
    let output: ReturnType<typeof createRecordingOutput>;
    let provider: StandaloneServerViewProvider;
    let service: StandaloneServerService;

    setup(() => {
      saves = 0;
      logLines = [];
      const logger: Logger = { appendLine: (line: string) => { logLines.push(line); } };
      service = new StandaloneServerService(workspaceRoot, logger);
      output = createRecordingOutput();
      provider = new StandaloneServerViewProvider(
        service,
        output.channel,
        () => { saves += 1; },
        EXTENSION_URI
      );
      provider.show();
    });

    teardown(() => provider.dispose());

    test('ready и неизвестный тип не сохраняют настройки, save — сохраняет', async () => {
      const [panel] = panels.panels;

      panel.receive({ type: 'ready' });
      panel.receive({ type: 'неизвестное' });
      await settle();

      assert.strictEqual(saves, 0);
      assert.deepStrictEqual(logLines, []);
      assert.deepStrictEqual(output.lines, []);
      assert.deepStrictEqual(statusKinds(panel.posted), []);

      const { settings } = service.getSettingsSnapshot();
      panel.receive({
        type: 'save',
        ibsrvPath: '',
        platformPath: '',
        databasePath: path.join(workspaceRoot, 'db'),
        httpAddress: settings.httpAddress,
        httpPort: settings.httpPort,
        httpBase: settings.httpBase,
        name: settings.name,
        distributeLicenses: settings.distributeLicenses,
        scheduleJobs: settings.scheduleJobs,
      });
      await waitFor(() => saves === 1, 'сохранение настроек сервера');
    });
  });

  suite('«ИИ и MCP»', () => {
    let executed: string[];
    let originalExecute: typeof vscode.commands.executeCommand;
    let provider: AiMcpViewProvider;

    setup(async () => {
      executed = [];
      const commandsRef = vscode.commands as { executeCommand: typeof vscode.commands.executeCommand };
      originalExecute = commandsRef.executeCommand;
      // Перехват только записывает команду: настоящая установка ролей открыла бы выбор платформы.
      commandsRef.executeCommand = <T>(command: string): Thenable<T> => {
        executed.push(command);
        return Promise.resolve(undefined as T);
      };

      const logger: Logger = { appendLine: () => undefined };
      // Сервер не запускается: панели нужен только его статус, сервисы команд не вызываются.
      const mcpServer = new V8McpServer(
        { outputChannel: logger } as unknown as CommandServices,
        new ConfigurationXmlEditor(),
        workspaceRoot,
        '0.0.0-test'
      );
      provider = new AiMcpViewProvider(
        EXTENSION_URI,
        { uri: vscode.Uri.file(workspaceRoot), name: 'ready-test', index: 0 },
        createRecordingOutput().channel,
        mcpServer,
        new BslAnalyzerMcpService(logger, () => Promise.resolve(true), () => ''),
        new AiSecretStorage(createMemorySecretStore()),
        () => undefined,
        () => Promise.resolve()
      );
      await provider.show();
    });

    teardown(() => {
      provider.dispose();
      (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = originalExecute;
    });

    test('ready и неизвестный тип не запускают установку ролей, installAiSkills — запускает', async () => {
      const [panel] = panels.panels;

      panel.receive({ type: 'ready' });
      panel.receive({ type: 'неизвестное' });
      await settle();

      assert.deepStrictEqual(executed, []);

      panel.receive({ type: 'installAiSkills' });
      await settle();

      assert.deepStrictEqual(executed, ['onecdev.installAiSkills']);
    });
  });
});
