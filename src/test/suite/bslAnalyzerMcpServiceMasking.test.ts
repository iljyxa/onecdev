import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AiMcpSettings } from '../../infra/ai/AiMcpConfiguration';
import type { Logger } from '../../infra/support/Logger';
import { BslAnalyzerMcpService } from '../../ui/mcp/BslAnalyzerMcpService';

/**
 * `--onec-password <пароль базы>` попадает в командную строку профиля, которую
 * сервис показывает в статусе и пишет в журнал. Пароль не должен утекать ни туда,
 * ни туда — ни до запуска (расчётная строка), ни после (строка запущенного процесса).
 */

const PASSWORD = 'секрет-базы-123';

const settings: AiMcpSettings = {
  extensionAutoStart: false,
  extensionHost: '127.0.0.1',
  extensionPort: 0,
  bslAnalyzerAutoStart: false,
  bslAnalyzerReferenceEnabled: false,
  bslAnalyzerWorkspaceEnabled: true,
  bslAnalyzerWorkspaceSourceDir: os.tmpdir(),
  bslAnalyzerEmbeddingUrl: '',
  bslAnalyzerEmbeddingApiKey: '',
  bslAnalyzerEmbeddingModel: '',
  bslAnalyzerNaparnikToken: '',
  bslAnalyzerOnecUrl: 'http://localhost/base',
  bslAnalyzerOnecUser: 'Админ',
  bslAnalyzerOnecPassword: PASSWORD,
};

suite('BslAnalyzerMcpService — маскирование пароля базы', () => {
  let dir: string;
  let executable: string;
  let logLines: string[];
  let service: BslAnalyzerMcpService;

  suiteSetup(function () {
    if (process.platform === 'win32') {
      // Процесс-заглушка — shell-скрипт; на Windows запускать нечем.
      this.skip();
    }
  });

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-bsl-mcp-'));
    executable = path.join(dir, 'bsl-analyzer');
    fs.writeFileSync(executable, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    logLines = [];
    const logger: Logger = { appendLine: (line: string) => { logLines.push(line); } };
    service = new BslAnalyzerMcpService(logger, () => Promise.resolve(true), () => executable);
  });

  teardown(async () => {
    await service.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('статус до запуска: пароль замаскирован в расчётной командной строке', () => {
    const workspace = service.getStatus(settings).profiles.find((item) => item.profile === 'workspace');
    assert.ok(workspace);
    assert.strictEqual(workspace.running, false);
    assert.ok(workspace.commandLine.includes('--onec-password ********'), workspace.commandLine);
    assert.ok(!workspace.commandLine.includes(PASSWORD));
  });

  test('запущенный профиль: и статус, и журнал содержат маску вместо пароля', async () => {
    await service.startProfile('workspace', settings);

    const workspace = service.getStatus(settings).profiles.find((item) => item.profile === 'workspace');
    assert.ok(workspace);
    assert.strictEqual(workspace.running, true);
    assert.ok(workspace.commandLine.includes('--onec-password ********'), workspace.commandLine);
    assert.ok(!workspace.commandLine.includes(PASSWORD));
    const startLine = logLines.find((line) => line.startsWith('[bsl-mcp] Запуск workspace:'));
    assert.ok(startLine, logLines.join('\n'));
    assert.ok(!startLine.includes(PASSWORD));
  });
});
