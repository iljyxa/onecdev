import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RevealOutputChannelOn } from 'vscode-languageclient/node';
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
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  async function startManager(lines: string[]): Promise<{ launcher: string; journal: string }> {
    const serverScript = path.join(tempRoot, 'server.js');
    const journal = path.join(tempRoot, 'journal.txt');
    const launcher = path.join(tempRoot, 'bsl-analyzer');
    fs.writeFileSync(serverScript, FAKE_SERVER_SOURCE);
    // Клиент передаёт процессу урезанное окружение, поэтому режим «Electron как Node»
    // включается в самой обёртке; аргумент `lsp` от клиента обёртка отбрасывает.
    fs.writeFileSync(
      launcher,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${serverScript}" "${journal}"\n`,
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
    manager = new LspManager(context, outputChannel);
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
});
