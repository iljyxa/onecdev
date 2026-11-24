import * as vscode from 'vscode';

export function registerBslDocumentSymbols(): vscode.Disposable {
  return vscode.languages.registerDocumentSymbolProvider(['bsl', 'os'], new BslDocumentSymbolProvider());
}

/** Резервная структура модуля для встроенного Outline. */
export class BslDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const lines = document.getText().split(/\r?\n/);
    const root: vscode.DocumentSymbol[] = [];
    const regionStack: vscode.DocumentSymbol[] = [];

    const procRe = /^\s*(Процедура|Функция|Procedure|Function)\s+([A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*)\s*\(([^)]*)\)\s*(Экспорт|Export)?/i;
    const procEndRe = /^\s*(КонецПроцедуры|КонецФункции|EndProcedure|EndFunction)(?=\s|;|\/\/|$)/i;
    const varRe = /^\s*(Перем|Var)\s+([A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_,\s]*)\s*(Экспорт|Export)?\s*;/i;
    const regionStartRe = /^\s*#(Область|Region)\s+(.+?)\s*$/i;
    const regionEndRe = /^\s*#(КонецОбласти|EndRegion)(?=\s|\/\/|$)/i;

    let currentRoutine: vscode.DocumentSymbol | undefined;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const regionMatch = regionStartRe.exec(line);
      if (regionMatch) {
        const name = regionMatch[2].trim();
        const range = new vscode.Range(i, 0, i, line.length);
        const symbol = new vscode.DocumentSymbol(name, 'Область', vscode.SymbolKind.Namespace, range, range);
        this.appendSymbol(regionStack, root, symbol);
        regionStack.push(symbol);
        continue;
      }

      if (regionEndRe.test(line)) {
        const region = regionStack.pop();
        if (region) {
          region.range = new vscode.Range(region.range.start, new vscode.Position(i, line.length));
        }
        continue;
      }

      const procMatch = procRe.exec(line);
      if (procMatch && !currentRoutine) {
        const keyword = procMatch[1];
        const name = procMatch[2];
        const params = procMatch[3].trim();
        const isExport = Boolean(procMatch[4]);
        const isFunction = /Функция|Function/i.test(keyword);
        const kind = isFunction ? vscode.SymbolKind.Function : vscode.SymbolKind.Method;
        const detail = `${params ? `(${params})` : '()'}${isExport ? ' Экспорт' : ''}`;
        const headerRange = new vscode.Range(i, 0, i, line.length);
        const nameStart = line.indexOf(name, line.indexOf(keyword) + keyword.length);
        const selectionRange = new vscode.Range(i, nameStart, i, nameStart + name.length);
        const symbol = new vscode.DocumentSymbol(name, detail, kind, headerRange, selectionRange);
        currentRoutine = symbol;
        this.appendSymbol(regionStack, root, symbol);
        continue;
      }

      if (currentRoutine && procEndRe.test(line)) {
        currentRoutine.range = new vscode.Range(
          currentRoutine.range.start,
          new vscode.Position(i, line.length)
        );
        currentRoutine = undefined;
        continue;
      }

      if (!currentRoutine) {
        const varMatch = varRe.exec(line);
        if (varMatch) {
          const names = varMatch[2].split(',').map((part) => part.trim()).filter(Boolean);
          let offset = line.indexOf(varMatch[1]) + varMatch[1].length;
          for (const name of names) {
            const nameOnly = name.replace(/\s+/g, ' ').split(/\s+/)[0];
            const nameStart = line.indexOf(nameOnly, offset);
            offset = nameStart + nameOnly.length;
            const selectionRange = new vscode.Range(i, nameStart, i, offset);
            const symbol = new vscode.DocumentSymbol(
              nameOnly,
              'Перем',
              vscode.SymbolKind.Variable,
              new vscode.Range(i, 0, i, line.length),
              selectionRange,
            );
            this.appendSymbol(regionStack, root, symbol);
          }
        }
      }
    }

    return root;
  }

  private appendSymbol(
    regionStack: readonly vscode.DocumentSymbol[],
    root: vscode.DocumentSymbol[],
    symbol: vscode.DocumentSymbol
  ): void {
    if (regionStack.length > 0) {
      regionStack[regionStack.length - 1].children.push(symbol);
    } else {
      root.push(symbol);
    }
  }
}
