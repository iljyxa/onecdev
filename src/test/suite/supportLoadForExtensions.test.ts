import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SupportInfoService } from '../../infra/support/SupportInfoService';
import type { Logger } from '../../infra/support/Logger';
import { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import type { ConfigEntry } from '../../domain/Configuration';
import { skipWithoutCorpus } from './support/corpus';

/**
 * Режима поддержки у расширения (CFE) не бывает, `Ext/ParentConfigurations.bin` у него нет по
 * определению: дерево не должно загружать для него данные поддержки и писать в лог «поддержка
 * отсутствует», вводящее в заблуждение (#60). Для основной конфигурации без `.bin` сообщение
 * осмысленно (снята с поддержки) и остаётся.
 */
const EXTENSION_ROOT = path.resolve(__dirname, '../../../');
const EXAMPLE_21 = path.resolve(__dirname, '../../../example/2.21/src');

class TestLogger implements Logger {
  readonly messages: string[] = [];

  appendLine(message: string): void {
    this.messages.push(message);
  }
}

function buildTreeLog(entries: ConfigEntry[]): string[] {
  const logger = new TestLogger();
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-support-cfe-'));
  try {
    const treeProvider = new MetadataTreeProvider(entries, vscode.Uri.file(EXTENSION_ROOT), cacheRoot, undefined, new SupportInfoService(logger));
    treeProvider.dispose();
    return logger.messages;
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
}

suite('MetadataTreeProvider — данные поддержки грузятся только для основной конфигурации (#60)', () => {
  suiteSetup(function () {
    skipWithoutCorpus(this);
  });

  test('расширение EVOLC: ни строки [support] о нём; основная конфигурация рядом загружена', () => {
    const messages = buildTreeLog([
      { rootPath: path.join(EXAMPLE_21, 'cf'), kind: 'cf' },
      { rootPath: path.join(EXAMPLE_21, 'cfe', 'EVOLC'), kind: 'cfe' },
    ]);
    assert.deepStrictEqual(messages.filter((line) => line.includes('EVOLC')), []);
    assert.ok(messages.some((line) => line.startsWith('[support] cf:')), `данные поддержки CF должны быть загружены: ${messages.join(' | ')}`);
  });

  test('основная конфигурация без ParentConfigurations.bin: сообщение «поддержка отсутствует» остаётся', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-support-cf-nobin-'));
    try {
      const configRoot = path.join(root, 'cf');
      fs.mkdirSync(configRoot);
      fs.copyFileSync(path.join(EXAMPLE_21, 'cf', 'Configuration.xml'), path.join(configRoot, 'Configuration.xml'));
      const messages = buildTreeLog([{ rootPath: configRoot, kind: 'cf' }]);
      assert.ok(messages.includes('[support] cf: ParentConfigurations.bin не найден — поддержка отсутствует'), messages.join(' | '));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
