/**
 * Реакция на события `<корень>/Ext/ParentConfigurations.bin`: после правки файла
 * поддержки кэш `SupportInfoService` обязан перечитаться, а дерево —
 * перерисоваться, иначе индикатор поддержки (он строится из `contextValue` узлов)
 * показывает устаревший режим. Обработчики проверяются напрямую на реальной
 * выгрузке, без ожидания событий файловой системы: их доставка зависит от
 * платформенного watcher'а и дала бы недетерминированный тест.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { mock } from 'node:test';
import * as vscode from 'vscode';
import { syncDirectorySnapshot } from '../../infra/agent/DirectorySnapshot';
import { buildSnapshotBackupDirName } from '../../infra/fs/WorkspaceTempDir';
import { SupportInfoService } from '../../infra/support/SupportInfoService';
import type { Logger } from '../../infra/support/Logger';
import {
  createParentConfigurationsHandlers,
  registerSupportWatcher,
} from '../../ui/support/SupportWatcher';
import { buildSupportFixtureRoot, CHANGES_FORBIDDEN_BIN_PATH } from './support/realConfigFixtures';

class TestLogger implements Logger {
  readonly lines: string[] = [];

  appendLine(line: string): void {
    this.lines.push(line);
  }
}

function binPathOf(configRoot: string): string {
  return path.join(configRoot, 'Ext', 'ParentConfigurations.bin');
}

function installTestClock(): (elapsedMs: number) => void {
  const timers = new Map<number, { due: number; run: () => void }>();
  let now = 0;
  let nextTimerId = 0;

  // MockTimers недоступен в extension host минимальной поддерживаемой версии VS Code.
  mock.method(globalThis, 'setTimeout', (run: () => void, delay: number) => {
    const id = --nextTimerId;
    timers.set(id, { due: now + delay, run });
    return id;
  });
  const realClearTimeout = clearTimeout;
  mock.method(globalThis, 'clearTimeout', (timer: Parameters<typeof clearTimeout>[0]) => {
    if (typeof timer === 'number' && timer < 0) {
      timers.delete(timer);
    } else {
      realClearTimeout(timer);
    }
  });

  return (elapsedMs) => {
    now += elapsedMs;
    for (const [id, { due, run }] of timers) {
      if (due <= now) {
        timers.delete(id);
        run();
      }
    }
  };
}

suite('SupportWatcher: реакция на ParentConfigurations.bin', () => {
  let tick: (elapsedMs: number) => void;
  setup(() => { tick = installTestClock(); });
  teardown(() => mock.reset());

  test('подмена выгрузки сбрасывает кэш и обновляет дерево один раз после последнего события', () => {
    const fixture = buildSupportFixtureRoot('normal');
    const snapshot = buildSupportFixtureRoot('forbidden');
    try {
      const logger = new TestLogger();
      const supportService = new SupportInfoService(logger);
      supportService.loadConfig(fixture.configRoot);
      logger.lines.length = 0;
      let refreshes = 0;
      const handlers = createParentConfigurationsHandlers(fixture.tempDir, supportService, () => { refreshes++; });
      assert.strictEqual(supportService.hasChangesForbidden(fixture.kontragentyXmlPath), false);

      const uri = vscode.Uri.file(binPathOf(fixture.configRoot));
      syncDirectorySnapshot(snapshot.configRoot, fixture.configRoot);
      handlers.onDelete(uri);
      tick(100);
      handlers.onChange(uri); // create
      tick(100);
      handlers.onChange(uri);
      // Запоздавшее удаление относится к старому каталогу.
      handlers.onDelete(uri);
      const backupName = buildSnapshotBackupDirName('cf', process.pid, Date.now());
      handlers.onDelete(vscode.Uri.file(binPathOf(path.join(fixture.tempDir, backupName))));
      handlers.onChange(vscode.Uri.file(binPathOf(path.join(fixture.tempDir, '.onecdev', 'import-temp', 'cf'))));
      tick(249);

      assert.strictEqual(supportService.hasChangesForbidden(fixture.kontragentyXmlPath), false);
      assert.strictEqual(refreshes, 0);
      assert.strictEqual(logger.lines.length, 0);

      tick(1);
      assert.strictEqual(supportService.hasChangesForbidden(fixture.kontragentyXmlPath), true);
      assert.strictEqual(refreshes, 1);
      assert.strictEqual(logger.lines.filter(line => line.endsWith('кэш сброшен')).length, 1);
      assert.strictEqual(logger.lines.filter(line => line.includes('загружено')).length, 1);
    } finally {
      snapshot.dispose();
      fixture.dispose();
    }
  });

  test('onChange на созданный .bin подключает данные поддержки корня', () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    try {
      const binPath = binPathOf(fixture.configRoot);
      const binContent = fs.readFileSync(binPath);
      fs.rmSync(binPath);
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      let refreshes = 0;
      const handlers = createParentConfigurationsHandlers(fixture.tempDir, supportService, () => { refreshes++; });
      assert.strictEqual(supportService.hasConfigData(fixture.kontragentyXmlPath), false);

      fs.writeFileSync(binPath, binContent);
      handlers.onChange(vscode.Uri.file(binPath));
      tick(250);

      assert.strictEqual(supportService.hasConfigData(fixture.kontragentyXmlPath), true);
      assert.strictEqual(supportService.hasChangesForbidden(fixture.kontragentyXmlPath), true);
      assert.strictEqual(refreshes, 1);
    } finally {
      fixture.dispose();
    }
  });

  test('удаление .bin сбрасывает данные поддержки даже при последнем событии change', () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      let refreshes = 0;
      const handlers = createParentConfigurationsHandlers(fixture.tempDir, supportService, () => { refreshes++; });
      assert.strictEqual(supportService.hasConfigData(fixture.kontragentyXmlPath), true);

      fs.rmSync(binPathOf(fixture.configRoot));
      handlers.onDelete(vscode.Uri.file(binPathOf(fixture.configRoot)));
      handlers.onChange(vscode.Uri.file(binPathOf(fixture.configRoot)));
      tick(250);

      assert.strictEqual(supportService.hasConfigData(fixture.kontragentyXmlPath), false);
      assert.strictEqual(supportService.hasChangesForbidden(fixture.kontragentyXmlPath), false);
      assert.strictEqual(refreshes, 1);
    } finally {
      fixture.dispose();
    }
  });

  test('события соседнего корня не сдвигают срок обновления', () => {
    const first = buildSupportFixtureRoot('forbidden');
    const second = buildSupportFixtureRoot('forbidden');
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(first.configRoot);
      supportService.loadConfig(second.configRoot);
      let refreshes = 0;
      const handlers = createParentConfigurationsHandlers(
        path.dirname(first.tempDir), supportService, () => { refreshes++; }
      );

      fs.rmSync(binPathOf(first.configRoot));
      fs.rmSync(binPathOf(second.configRoot));
      handlers.onDelete(vscode.Uri.file(binPathOf(first.configRoot)));
      tick(100);
      handlers.onDelete(vscode.Uri.file(binPathOf(second.configRoot)));
      tick(150);

      assert.strictEqual(supportService.hasConfigData(first.kontragentyXmlPath), false);
      assert.strictEqual(supportService.hasConfigData(second.kontragentyXmlPath), true);
      assert.strictEqual(refreshes, 1);

      tick(100);
      assert.strictEqual(supportService.hasConfigData(second.kontragentyXmlPath), false);
      assert.strictEqual(refreshes, 2);
    } finally {
      second.dispose();
      first.dispose();
    }
  });

  test('dispose отменяет ожидающее обновление поддержки', () => {
    const supportService = new SupportInfoService(new TestLogger());
    let refreshes = 0;
    const handlers = createParentConfigurationsHandlers(
      path.dirname(CHANGES_FORBIDDEN_BIN_PATH), supportService, () => { refreshes++; }
    );

    handlers.onChange(vscode.Uri.file(CHANGES_FORBIDDEN_BIN_PATH));
    handlers.dispose();
    tick(250);

    assert.strictEqual(refreshes, 0);
  });

  test('registerSupportWatcher отдаёт watcher и подписки на его события в context.subscriptions', () => {
    const fixture = buildSupportFixtureRoot('normal');
    const subscriptions: vscode.Disposable[] = [];
    try {
      const workspaceFolder: vscode.WorkspaceFolder = {
        uri: vscode.Uri.file(fixture.tempDir),
        name: path.basename(fixture.tempDir),
        index: 0,
      };
      // Из контекста расширения регистрации нужен только список подписок.
      const context = { subscriptions } as unknown as vscode.ExtensionContext;

      registerSupportWatcher(workspaceFolder, context, new SupportInfoService(new TestLogger()), () => undefined);

      // При деактивации также отменяются таймеры обработчиков.
      assert.strictEqual(subscriptions.length, 5);
      for (const subscription of subscriptions) {
        assert.strictEqual(typeof subscription.dispose, 'function');
      }
    } finally {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      fixture.dispose();
    }
  });
});
