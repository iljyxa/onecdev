import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BslDocumentSymbolProvider } from '../../lsp/BslDocumentSymbolProvider';
import { FallbackDocumentSymbols } from '../../lsp/FallbackDocumentSymbols';

suite('Резервные символы для «Структуры» (#206)', () => {
  test('регистрирует провайдер при остановке LSP, снимает при запуске и освобождает при деактивации', () => {
    const events: string[] = [];
    const fallback = new FallbackDocumentSymbols(() => {
      events.push('register');
      return { dispose: () => { events.push('dispose'); } };
    });

    fallback.setAnalyzerRunning(false);
    fallback.setAnalyzerRunning(false);
    fallback.setAnalyzerRunning(true);
    fallback.setAnalyzerRunning(true);
    fallback.setAnalyzerRunning(false);
    fallback.dispose();
    fallback.setAnalyzerRunning(false);

    assert.deepStrictEqual(events, ['register', 'dispose', 'register', 'dispose']);
  });

  test('показывает процедуры, функции и переменные модуля после завершения областей и процедур', async () => {
    const document = await vscode.workspace.openTextDocument({
      language: 'bsl',
      content: [
        '#Область Группа',
        'Процедура ПроцедураМодуля() Экспорт',
        '    Перем Локальная;',
        'КонецПроцедуры// комментарий к завершению процедуры',
        '#КонецОбласти// комментарий к завершению области',
        'Перем Пер, Другое Экспорт;',
        'Функция Вычислить(Аргумент)',
        'КонецФункции',
        'Var Counter Export;',
        '#Region Group',
        'Function Compute()',
        'EndFunction// комментарий к завершению функции',
        '#EndRegion// комментарий к завершению области',
      ].join('\n'),
    });
    const symbols = new BslDocumentSymbolProvider().provideDocumentSymbols(document);

    assert.deepStrictEqual(symbols.map(({ name, kind }) => [name, kind]), [
      ['Группа', vscode.SymbolKind.Namespace],
      ['Пер', vscode.SymbolKind.Variable],
      ['Другое', vscode.SymbolKind.Variable],
      ['Вычислить', vscode.SymbolKind.Function],
      ['Counter', vscode.SymbolKind.Variable],
      ['Group', vscode.SymbolKind.Namespace],
    ]);
    assert.strictEqual(symbols[0].range.end.line, 4);
    assert.strictEqual(symbols[1].selectionRange.start.character, 'Перем '.length);
    const [procedure] = symbols[0].children;
    assert.strictEqual(procedure.name, 'ПроцедураМодуля');
    assert.strictEqual(procedure.kind, vscode.SymbolKind.Method);
    assert.strictEqual(procedure.range.end.line, 3);
    assert.strictEqual(document.getText(procedure.selectionRange), 'ПроцедураМодуля');
    assert.deepStrictEqual(procedure.children, []);
    assert.strictEqual(symbols[5].range.end.line, 12);
    assert.strictEqual(symbols[5].children[0].name, 'Compute');
    assert.strictEqual(symbols[5].children[0].range.end.line, 11);
  });

  test('VS Code получает резервные символы файлов .bsl и .os без рабочей папки', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-outline-'));
    try {
      const extension = vscode.extensions.getExtension('iljyxa.onecdev');
      assert.ok(extension);
      await extension.activate();

      for (const fileName of ['Module.bsl', 'Module.os']) {
        const filePath = path.join(tempRoot, fileName);
        fs.writeFileSync(filePath, 'Перем Счетчик;\nПроцедура Запустить()\nКонецПроцедуры\n');
        const document = await vscode.workspace.openTextDocument(filePath);
        assert.strictEqual(document.languageId, 'bsl');
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider', document.uri,
        );
        assert.deepStrictEqual(symbols.map(({ name }) => name), ['Счетчик', 'Запустить']);
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
