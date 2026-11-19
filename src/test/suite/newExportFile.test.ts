import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatNewExportText, writeNewExportFile } from '../../infra/fs/NewExportFile';

/**
 * #165: новый файл выгрузки пишется в формате платформы, чтобы цикл «загрузка в базу → выгрузка»
 * не давал дифф целиком. Формат снят с корпуса `example/` (настоящая выгрузка 8.3.27 и 8.5.1):
 *  - XML — BOM, CRLF в разметке, без завершающего EOL; перевод строки внутри текстового узла
 *    (текст запроса макета СКД) платформа оставляет голым LF;
 *  - прочий текст (BSL, HTML, TXT) — BOM и CRLF, завершающий EOL — как в тексте; пустой модуль —
 *    только BOM.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BOM = '\uFEFF';

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

suite('NewExportFile — формат нового файла как у выгрузки платформы (#165)', () => {
  test('XML: BOM, CRLF в разметке, без завершающего EOL', () => {
    assert.strictEqual(
      formatNewExportText('a.xml', '<?xml version="1.0"?>\n<A>\n\t<B/>\n</A>\n'),
      `${BOM}<?xml version="1.0"?>\r\n<A>\r\n\t<B/>\r\n</A>`
    );
  });

  test('XML: перевод строки внутри текстового узла остаётся LF', () => {
    assert.strictEqual(
      formatNewExportText('a.xml', '<A>\n\t<query>ВЫБРАТЬ\n\tX\n</query>\n</A>'),
      `${BOM}<A>\r\n\t<query>ВЫБРАТЬ\n\tX\n</query>\r\n</A>`
    );
    // Перевод строки сразу после открывающего тега, за которым идёт текст, — тоже текст.
    assert.strictEqual(formatNewExportText('a.xml', '<q>\nX</q>'), `${BOM}<q>\nX</q>`);
  });

  test('XML: перевод строки между атрибутами внутри тега — разметка, CRLF', () => {
    assert.strictEqual(
      formatNewExportText('a.xml', '<A x="1"\n\ty="2">\n\t<B/>\n</A>\n'),
      `${BOM}<A x="1"\r\n\ty="2">\r\n\t<B/>\r\n</A>`
    );
  });

  test('XML: BOM и CRLF во входе не удваиваются', () => {
    assert.strictEqual(formatNewExportText('A.XML', `${BOM}<A>\r\n</A>\r\n\r\n`), `${BOM}<A>\r\n</A>`);
  });

  test('BSL: BOM, CRLF, завершающий EOL как в тексте; пустой модуль — только BOM', () => {
    assert.strictEqual(formatNewExportText('Module.bsl', 'А\n\nБ\n'), `${BOM}А\r\n\r\nБ\r\n`);
    assert.strictEqual(formatNewExportText('Module.bsl', 'А\r\nБ'), `${BOM}А\r\nБ`);
    assert.strictEqual(formatNewExportText('Module.bsl', ''), BOM);
  });

  test('корпус example/: текст с LF-переводами превращается в файл платформы байт-в-байт', () => {
    let checked = 0;
    for (const format of ['2.20', '2.21']) {
      for (const file of walk(path.join(REPO_ROOT, 'example', format, 'src'))) {
        if (!/\.(xml|bsl)$/i.test(file)) {
          continue;
        }
        const platform = fs.readFileSync(file, 'utf-8');
        // Так текст собирают генераторы: без BOM, переводы — `\n`, у XML — завершающий `\n`.
        const generated = platform.slice(1).replace(/\r\n/g, '\n') + (file.endsWith('.xml') ? '\n' : '');
        assert.strictEqual(formatNewExportText(file, generated), platform, file);
        checked++;
      }
    }
    assert.ok(checked > 300, `проверено файлов: ${String(checked)}`);
  });

  test('writeNewExportFile создаёт каталоги и пишет отформатированный текст', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-new-export-file-'));
    try {
      const target = path.join(dir, 'Forms', 'Форма', 'Ext', 'Form.xml');
      writeNewExportFile(target, '<Form>\n</Form>\n');
      assert.deepStrictEqual(
        fs.readFileSync(target),
        Buffer.from(`${BOM}<Form>\r\n</Form>`, 'utf-8')
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
