// Независимый оракул истории: разбор report.txt, который Конфигуратор построил из того же ответа
// devDepotReport. Production-код не импортируется: тест сверяет разбор расширения с тем, что показала
// сама платформа.
import * as assert from 'assert';
import { readFixture } from './crsFixtures';

export interface ReportVersion {
  verNum: number;
  configVersion: string;
  user: string;
  /** Дата и время создания, как в отчёте: `29.09.2026`, `17:12:44`. */
  date: string;
  time: string;
  label?: { name: string; comment: string };
  /** Строки комментария через \n; пустой комментарий — ''. */
  comment: string;
  /** Заголовки объектов по группам отчёта: «Добавлены», «Изменены», «Удалены». */
  groups: Record<string, string[]>;
}

const FIELD = /^([^\t]+):\t(.*)$/;
// Заголовок группы объектов: `\tИзменены\t2`; строка объекта — `\t<заголовок>` без второго таба.
const GROUP = /^\t[^\t]+\t\d+$/;

/** Версии отчёта «по версиям» (формат txt) в порядке отчёта. */
export function reportVersions(transport: 'tcp' | 'http', scenario: string): ReportVersion[] {
  const lines = readFixture(transport, scenario, 'report.txt').toString('utf-8').replace(/^\uFEFF/, '').split(/\r?\n/);
  assert.ok(lines[0].startsWith('Отчет по версиям хранилища:'), `${scenario}: не отчёт по версиям`);
  const versions: ReportVersion[] = [];
  let i = lines.findIndex((l) => l.startsWith('Версия:\t'));
  const field = (name: string): string => {
    const m = FIELD.exec(lines[i]);
    assert.ok(m?.[1] === name, `${scenario}:${String(i + 1)}: ожидалось «${name}», получено «${lines[i]}»`);
    i += 1;
    return m[2];
  };
  // Текст до пустой строки или до одной из строк-ограничителей.
  const text = (stops: string[]): string => {
    const out: string[] = [];
    while (i < lines.length && lines[i] !== '' && !stops.includes(lines[i])) {
      out.push(lines[i]);
      i += 1;
    }
    return out.join('\n');
  };
  while (i >= 0 && i < lines.length && lines[i].startsWith('Версия:\t')) {
    const version: ReportVersion = {
      verNum: Number(field('Версия')),
      configVersion: field('Версия конфигурации'),
      user: field('Пользователь'),
      date: field('Дата создания'),
      time: field('Время создания'),
      comment: '',
      groups: {},
    };
    if (lines[i].startsWith('Метка:\t')) {
      const name = field('Метка');
      assert.strictEqual(lines[i], 'Комментарий метки:');
      i += 1;
      version.label = { name, comment: text(['Комментарий:']) };
    }
    if (lines[i] === 'Комментарий:') {
      i += 1;
      version.comment = text([]);
    }
    assert.strictEqual(lines[i], '', `${scenario}:${String(i + 1)}: после шапки версии ожидалась пустая строка`);
    i += 1;
    while (i < lines.length && lines[i].startsWith('\t')) {
      const [, group, count] = lines[i].split('\t');
      i += 1;
      const titles: string[] = [];
      while (i < lines.length && lines[i].startsWith('\t') && !GROUP.test(lines[i])) {
        titles.push(lines[i].slice(1));
        i += 1;
      }
      assert.strictEqual(titles.length, Number(count), `${scenario}: группа ${group}`);
      version.groups[group] = titles;
    }
    versions.push(version);
    while (i < lines.length && lines[i] === '') {
      i += 1;
    }
  }
  assert.ok(versions.length > 0, `${scenario}: в отчёте нет версий`);
  return versions;
}

/** Все заголовки объектов версии без групп, по коду символа. */
export function reportTitles(version: ReportVersion): string[] {
  return Object.values(version.groups)
    .flat()
    .sort((a, b) => Number(a > b) - Number(a < b));
}
