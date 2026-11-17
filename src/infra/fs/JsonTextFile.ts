import * as fs from 'fs';
import * as path from 'path';
import { preserveBomAndEol } from '../xml/LineEndings';
import { writeFileAtomic } from './AtomicFileWriter';

/**
 * Чтение и перезапись JSON-файлов настроек проекта (env.json, autumn-properties.json)
 * без потери их формата.
 *
 * Почему не `JSON.stringify(value, null, 2)`: эти файлы правят руками и редактором
 * профиля Platform Tools (табуляция, CRLF на Windows, BOM от «Блокнота»). Перезапись
 * в одном стиле превращала бы смену одного ключа в diff всего файла.
 */

const BOM = '﻿';
const DEFAULT_INDENT = '  ';

/** снимает BOM; пустой/пробельный → {}; не-JSON → Error(`${fileLabel} повреждён (${filePath}): ${reason}`, {cause}); не-объект → `…: ожидался объект` */
export function parseJsonObjectText(text: string, fileLabel: string, filePath: string): Record<string, unknown> {
  const body = stripBom(text);
  // Пустой файл — легитимное состояние (создан инициализацией, но не заполнен).
  if (body.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    // JSON.parse бросает только SyntaxError; ветка String(error) — страховка типа unknown.
    /* c8 ignore next */
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${fileLabel} повреждён (${filePath}): ${reason}`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${fileLabel} повреждён (${filePath}): ожидался объект`);
  }
  return parsed as Record<string, unknown>;
}

/** '\t' | ' '.repeat(n) | '' (однострочный); по умолчанию '  ' */
export function detectJsonIndent(text: string): string {
  const body = stripBom(text).trim();
  // Пустой объект не несёт стиля: записанное в него поле получит отступ по умолчанию,
  // а не «однострочный» стиль.
  if (body.length === 0 || /^\{\s*\}$/.test(body)) {
    return DEFAULT_INDENT;
  }
  const indented = /(?:\r\n|\r|\n)([ \t]+)\S/.exec(body);
  if (indented) {
    const indent = indented[1];
    return indent.startsWith('\t') ? '\t' : ' '.repeat(indent.length);
  }
  return /[\r\n]/.test(body) ? DEFAULT_INDENT : '';
}

/** original undefined/пустой → 2 пробела + '\n'; иначе отступ/завершающий EOL исходника + preserveBomAndEol(original, next) */
export function formatJsonPreservingStyle(original: string | undefined, value: unknown): string {
  if (original === undefined || stripBom(original).trim().length === 0) {
    return `${JSON.stringify(value, null, DEFAULT_INDENT)}\n`;
  }
  const trailingEol = /(?:\r\n|\r|\n)$/.test(original) ? '\n' : '';
  // Стиль переводов строк и BOM переносит preserveBomAndEol: эталон — текст ДО изменения.
  return preserveBomAndEol(original, `${JSON.stringify(value, null, detectJsonIndent(original))}${trailingEol}`);
}

/** mkdir родителя + writeFileAtomic; возвращает записанный текст */
export function writeJsonPreservingStyle(filePath: string, original: string | undefined, value: unknown): string {
  const text = formatJsonPreservingStyle(original, value);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, text);
  return text;
}

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}
