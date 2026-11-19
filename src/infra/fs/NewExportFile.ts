import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from './AtomicFileWriter';

/**
 * Единственная точка записи НОВОГО файла выгрузки (XML метаданных, модуль BSL, текст макета).
 *
 * Зачем: генераторы собирают текст через `\n` и без BOM, а платформа выгружает файлы с BOM и в
 * CRLF. Загрузку такой файл не ломает, но после цикла «загрузка в базу → выгрузка» каждый
 * созданный нами файл давал дифф целиком. Правка СУЩЕСТВУЮЩЕГО файла идёт другим путём —
 * `writeTextFilePreservingBomAndEol`, сохраняющим стиль исходника.
 *
 * Формат снят с корпуса `example/` (выгрузка 8.3.27 и 8.5.1) и проверяется на нём байт-в-байт:
 *  - XML — BOM, CRLF в разметке, без завершающего перевода строки. Перевод строки внутри
 *    текстового узла (текст запроса макета СКД) платформа оставляет голым LF, поэтому в CRLF
 *    превращается только перевод разметки — внутри тега или между `>` и следующим `<` (через
 *    пробельный отступ): литеральный `<` в тексте всегда экранирован, значит такой перевод — не текст;
 *  - прочий текст (BSL, HTML, TXT) — BOM и CRLF; завершающий перевод строки — как в тексте
 *    (у модулей платформы он есть не всегда), пустой модуль — один BOM.
 */

const BOM = '\uFEFF';

/** Текст нового файла `filePath` в формате выгрузки платформы. Чистая функция: ФС не трогается. */
export function formatNewExportText(filePath: string, content: string): string {
  const text = (content.startsWith(BOM) ? content.slice(1) : content).replace(/\r\n/g, '\n');
  if (path.extname(filePath).toLowerCase() !== '.xml') {
    return BOM + text.replace(/\n/g, '\r\n');
  }
  return BOM + trimTrailingLineBreaks(crlfMarkupLineBreaks(text));
}

/** Пишет новый файл выгрузки атомарно (каталоги создаются), в формате {@link formatNewExportText}. */
export function writeNewExportFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, formatNewExportText(filePath, content));
}

/**
 * `\n` → `\r\n` для переводов строки разметки: внутри тега (атрибуты на нескольких строках) и
 * между `>` и `<` через пробельный отступ. Остальные переводы — текст узла, они остаются LF.
 * Ручной сканер вместо регулярки с просмотром вперёд: проход линейный при любом входе.
 */
function crlfMarkupLineBreaks(text: string): string {
  const out: string[] = [];
  let start = 0;
  let inTag = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<' || ch === '>') {
      inTag = ch === '<';
    } else if (ch === '\n' && (inTag || isBetweenTags(text, i))) {
      out.push(text.slice(start, i), '\r\n');
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.join('');
}

/** Перевод строки `text[i]` стоит сразу после `>` и перед `<` (через пробелы и табы). */
function isBetweenTags(text: string, i: number): boolean {
  if (text[i - 1] !== '>') {
    return false;
  }
  let j = i + 1;
  while (text[j] === ' ' || text[j] === '\t') {
    j++;
  }
  return text[j] === '<';
}

function trimTrailingLineBreaks(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '\n' || text[end - 1] === '\r')) {
    end--;
  }
  return text.slice(0, end);
}
