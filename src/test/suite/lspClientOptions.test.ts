import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RevealOutputChannelOn } from 'vscode-languageclient/node';
import { BslAnalyzerConfigService } from '../../infra/environment/BslAnalyzerConfigService';
import { BslAnalyzerService, type BslAnalyzerBinary } from '../../lsp/analyzer/BslAnalyzerService';
import { buildBslAnalyzerDocumentOptions, LspManager } from '../../lsp/LspManager';

/**
 * Issue #104 — клиент не подписывает bsl-analyzer на workspace/didChangeWatchedFiles:
 * сервер это уведомление не обрабатывает и следит за файлами сам.
 */
suite('LspManager — параметры документов клиента bsl-analyzer (issue #104)', () => {
  test('synchronize отсутствует, documentSelector — только file-документы bsl', () => {
    const result = buildBslAnalyzerDocumentOptions();
    assert.strictEqual('synchronize' in result, false);
    assert.deepStrictEqual(result.documentSelector, [{ scheme: 'file', language: 'bsl' }]);
  });

  test('revealOutputChannelOn = Never: сбои запросов не всплывают уведомлениями (#105)', () => {
    assert.strictEqual(buildBslAnalyzerDocumentOptions().revealOutputChannelOn, RevealOutputChannelOn.Never);
  });
});

/**
 * Минимальный LSP-сервер по stdio: настоящего bsl-analyzer в тестовой среде нет (внешний
 * бинарник скачивается с GitHub), поэтому он подменяется процессом, который отвечает на
 * запросы и пишет имена полученных методов в журнал — так проверяется реальный обмен клиента.
 */
const FAKE_SERVER_SOURCE = `
const fs = require('fs');
const journal = process.argv[2];
let buffer = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd < 0) return;
    const match = /Content-Length: (\\d+)/i.exec(buffer.slice(0, headerEnd).toString('ascii'));
    const length = Number(match[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const message = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString('utf8'));
    buffer = buffer.slice(headerEnd + 4 + length);
    fs.appendFileSync(journal, message.method + '\\n');
    if (message.method === 'exit') process.exit(0);
    if (message.id !== undefined && message.method === 'textDocument/documentHighlight') {
      // Как bsl-analyzer при рассинхроне текста (#105): внутренняя ошибка на фоновый запрос.
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'UTF-16 column 19 is out of bounds on line 25' } });
    } else if (message.id !== undefined && message.method !== undefined) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: message.method === 'initialize' ? { capabilities: { textDocumentSync: 1, documentHighlightProvider: true } } : null,
      });
    }
  }
});
`;

suite('LspManager — запуск клиента bsl-analyzer (issue #104)', () => {
  let tempRoot: string;
  let manager: LspManager | undefined;

  setup(function () {
    // Подменный сервер запускается shell-обёрткой; на Windows её не исполнить.
    if (process.platform === 'win32') {
      this.skip();
    }
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lsp-start-'));
  });

  teardown(async () => {
    await manager?.stop();
    manager = undefined;
    await vscode.workspace
      .getConfiguration('onecdev.bslAnalyzer')
      .update('path', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration('onecdev.lsp')
      .update('mode', undefined, vscode.ConfigurationTarget.Global);
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  interface StartOptions {
    readonly prepareStart?: (binary: BslAnalyzerBinary) => Promise<void>;
    /** Что обёртка печатает на `--version` (проба версии пользовательского бинарника, #112). */
    readonly version?: string;
  }

  async function startManager(lines: string[], options: StartOptions = {}): Promise<{ launcher: string; journal: string }> {
    const serverScript = path.join(tempRoot, 'server.js');
    const journal = path.join(tempRoot, 'journal.txt');
    const launcher = path.join(tempRoot, 'bsl-analyzer');
    fs.writeFileSync(serverScript, FAKE_SERVER_SOURCE);
    // Клиент передаёт процессу урезанное окружение, поэтому режим «Electron как Node»
    // включается в самой обёртке; аргумент `lsp` от клиента обёртка отбрасывает.
    fs.writeFileSync(
      launcher,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "bsl-analyzer ${options.version ?? '0.4.6'}"; exit 0; fi\n`
        + `ELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${serverScript}" "${journal}"\n`,
      { mode: 0o755 }
    );
    await vscode.workspace
      .getConfiguration('onecdev.bslAnalyzer')
      .update('path', launcher, vscode.ConfigurationTarget.Global);

    const outputChannel = { appendLine: (line: string) => lines.push(line) } as unknown as vscode.OutputChannel;
    const context = {
      subscriptions: [],
      globalStorageUri: vscode.Uri.file(path.join(tempRoot, 'global-storage')),
    } as unknown as vscode.ExtensionContext;
    manager = new LspManager(context, outputChannel, options.prepareStart);
    await manager.start();
    return { launcher, journal };
  }

  test('start() поднимает клиент по подменному серверу, stop() завершает его штатно', async () => {
    const lines: string[] = [];
    const { launcher, journal } = await startManager(lines);

    assert.ok(lines.includes(`[lsp] bsl-analyzer: ${launcher}`), lines.join('\n'));
    assert.ok(lines.includes('[lsp] bsl-analyzer запущен (custom)'), lines.join('\n'));
    assert.strictEqual(fs.readFileSync(journal, 'utf8').split('\n')[0], 'initialize');

    await manager?.stop();
    manager = undefined;
    assert.ok(fs.readFileSync(journal, 'utf8').split('\n').includes('shutdown'));
  });

  test('сбой фонового запроса (documentHighlight, -32603) — запись в канал без всплывающего уведомления (#105)', async () => {
    const lines: string[] = [];
    await startManager(lines);
    const windowRef = vscode.window as Pick<typeof vscode.window, 'showErrorMessage'>;
    const original = windowRef.showErrorMessage;
    const notifications: string[] = [];
    windowRef.showErrorMessage = ((message: string) => {
      notifications.push(message);
      return Promise.resolve(undefined);
    });
    try {
      const modulePath = path.join(tempRoot, 'Module.bsl');
      fs.writeFileSync(modulePath, 'Процедура Тест()\nКонецПроцедуры\n');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(modulePath));
      assert.strictEqual(document.languageId, 'bsl');
      await vscode.commands.executeCommand('vscode.executeDocumentHighlights', document.uri, new vscode.Position(0, 1));
    } finally {
      windowRef.showErrorMessage = original;
    }
    assert.deepStrictEqual(notifications, []);
    assert.ok(lines.some((line) => line.includes('Request textDocument/documentHighlight failed')), lines.join('\n'));
  });

  test('prepareStart вызывается ровно раз до initialize с описанием пользовательского бинарника (#112)', async () => {
    const lines: string[] = [];
    const calls: BslAnalyzerBinary[] = [];
    const journal = path.join(tempRoot, 'journal.txt');
    const { launcher } = await startManager(lines, {
      prepareStart: (binary) => {
        calls.push(binary);
        fs.appendFileSync(journal, 'prepareStart\n');
        return Promise.resolve();
      },
    });
    assert.deepStrictEqual(calls, [{ execPath: launcher, custom: true, installedVersion: undefined }]);
    assert.deepStrictEqual(fs.readFileSync(journal, 'utf8').split('\n').slice(0, 2), ['prepareStart', 'initialize']);
  });

  test('ошибка prepareStart логируется и не срывает старт клиента (#112)', async () => {
    const lines: string[] = [];
    await startManager(lines, { prepareStart: () => Promise.reject(new Error('EACCES: toml только для чтения')) });
    assert.ok(lines.some((line) => line.startsWith('[lsp][warn]') && line.includes('EACCES')), lines.join('\n'));
    assert.ok(lines.includes('[lsp] bsl-analyzer запущен (custom)'), lines.join('\n'));
  });

  test('ошибка prepareStart не-Error тоже логируется (#112)', async () => {
    const lines: string[] = [];
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- проверяется ветка не-Error причины
    await startManager(lines, { prepareStart: () => Promise.reject('строка') });
    assert.ok(lines.some((line) => line.startsWith('[lsp][warn]') && line.includes('строка')), lines.join('\n'));
  });

  test('lsp.mode = off — prepareStart не вызывается (#112)', async () => {
    await vscode.workspace.getConfiguration('onecdev.lsp').update('mode', 'off', vscode.ConfigurationTarget.Global);
    let called = 0;
    const lines: string[] = [];
    await startManager(lines, { prepareStart: () => { called++; return Promise.resolve(); } });
    assert.strictEqual(called, 0);
    assert.ok(!lines.some((line) => line.includes('bsl-analyzer запущен')), lines.join('\n'));
  });

  for (const [version, before, after] of [
    ['0.2.80', '[source]\nroot = "src/cf"\nexclude = [".onecdev"]\n', '[source]\nroot = "src/cf"\n'],
    ['0.4.6', '[source]\nroot = "src/cf"\n', '[source]\nroot = "src/cf"\nexclude = [".onecdev"]\n'],
  ] as const) {
    test(`сквозная сверка bsl-analyzer.toml по версии пользовательского бинарника ${version} до старта (#112)`, async () => {
      const project = path.join(tempRoot, 'project');
      fs.mkdirSync(project);
      const configService = new BslAnalyzerConfigService(project, { appendLine: () => undefined });
      fs.writeFileSync(configService.getConfigPath(), before);
      const lines: string[] = [];
      await startManager(lines, {
        version,
        prepareStart: async (binary) => {
          await configService.prepareForStart({ ...binary, projectInitialized: true });
        },
      });
      assert.strictEqual(fs.readFileSync(configService.getConfigPath(), 'utf8'), after);
      assert.ok(lines.includes('[lsp] bsl-analyzer запущен (custom)'), lines.join('\n'));
    });
  }
});

suite('BslAnalyzerService.describeBinary (issue #112)', () => {
  let tempRoot: string;

  setup(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lsp-describe-'));
    const storage = path.join(tempRoot, 'global-storage', 'bsl-analyzer');
    fs.mkdirSync(storage, { recursive: true });
    fs.writeFileSync(path.join(storage, 'version.txt'), 'v0.4.6\n');
  });

  teardown(async () => {
    await vscode.workspace
      .getConfiguration('onecdev.bslAnalyzer')
      .update('path', undefined, vscode.ConfigurationTarget.Global);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function createService(): BslAnalyzerService {
    const context = {
      subscriptions: [],
      globalStorageUri: vscode.Uri.file(path.join(tempRoot, 'global-storage')),
    } as unknown as vscode.ExtensionContext;
    return new BslAnalyzerService(context, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
  }

  test('путь из настройки — custom, версия из version.txt не берётся', async () => {
    const custom = path.join(tempRoot, 'my-bsl');
    await vscode.workspace.getConfiguration('onecdev.bslAnalyzer').update('path', custom, vscode.ConfigurationTarget.Global);
    assert.deepStrictEqual(createService().describeBinary(), { execPath: custom, custom: true, installedVersion: undefined });
  });

  test('пустая настройка — автоскачанный бинарник с версией из version.txt', () => {
    const service = createService();
    assert.deepStrictEqual(service.describeBinary(), {
      execPath: service.binaryPath,
      custom: false,
      installedVersion: 'v0.4.6',
    });
  });
});
