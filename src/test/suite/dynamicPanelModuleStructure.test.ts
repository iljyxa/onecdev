import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DynamicPanelController } from '../../ui/views/dynamic-panel/DynamicPanelController';
import type { ModuleSymbolDto } from '../../ui/views/dynamic-panel/_types';

suite('Структура модуля в динамической панели (#205)', () => {
  test('показывает символы и переходит по ним в активном BSL-модуле', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-module-structure-'));
    const filename = path.join(tempDir, 'Module.bsl');
    fs.writeFileSync(filename, '\nПроцедура Проверка()\nКонецПроцедуры\n');
    const controller = new DynamicPanelController();
    try {
      const symbolFound = new Promise<ModuleSymbolDto>((resolve) => {
        controller.attachHost({
          postState: (state) => {
            if (state.kind === 'module-structure' && state.document.fileName === filename) {
              const symbol = state.symbols.find((item) => item.name === 'Проверка');
              if (symbol) {
                resolve(symbol);
              }
            }
          },
        });
      });
      const document = await vscode.workspace.openTextDocument(filename);
      const editor = await vscode.window.showTextDocument(document);
      const symbol = await symbolFound;
      assert.equal(symbol.range.start.line, 1);
      await controller.handleWebviewCommand('propertyChanged', { key: 'Name', value: 'Не меняем модуль' });
      assert.equal(editor.selection.start.line, 0);
      await controller.handleWebviewCommand('revealSymbol', { range: symbol.range });
      assert.equal(editor.selection.start.line, 1);
    } finally {
      controller.dispose();
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
