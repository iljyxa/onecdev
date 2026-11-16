// Снятие трафика истории версий хранилища (issue #10).
// Сначала в хранилище помещается несколько версий с комментариями от двух авторов (в том числе пустым и
// со спецсимволами XML, issue #21) и ставятся метки (history-repository.mjs, трафик подготовки не сохраняется), затем каждый вариант отчёта /ConfigurationRepositoryReport
// снимается через записывающий tcp-прокси в example/crs/<версия платформы>/tcp/<сценарий>/.
// Формат отчёта — txt: mxl — двоичный, а разбираемый клиентом протокол от него не зависит.
//
//   node example/tools/crs/capture-history.mjs [--transport=tcp|http] [каталог рабочих файлов, по умолчанию /tmp/crs-stand/work]
// http (issue #82): отчёты те же, но Конфигуратор ходит через прокси на собственный apache с wsap24.so и
// публикацией .1ccr; кадры — в example/crs/<версия>/http/. Подготовка хранилища идёт по tcp.
/* global process */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { admin, buildHistoryRepository } from './history-repository.mjs';
import { corpusDir, createStand } from './stand.mjs';

const args = process.argv.slice(2);
const transport = args.find((a) => a.startsWith('--transport='))?.slice('--transport='.length) ?? 'tcp';
if (transport !== 'tcp' && transport !== 'http') throw new Error(`неизвестный транспорт: ${transport}`);
const outRoot = corpusDir(transport);
const work = path.resolve(args.find((a) => !a.startsWith('--')) ?? '/tmp/crs-stand/work');

const stand = createStand(work);
try {
  const { baseA } = await buildHistoryRepository(stand, work);
  if (transport === 'http') await stand.startApache();

  const results = {};
  const report = async (name, ...options) => {
    const file = path.join(work, `report-${name}.txt`);
    const result = await stand.record(outRoot, results, name, baseA, admin, ['/ConfigurationRepositoryReport', file, '-ReportFormat', 'txt', ...options], transport);
    if (result.status === 0) writeFileSync(path.join(outRoot, name, 'report.txt'), readFileSync(file));
    return result;
  };

  await report('history-all');
  await report('history-range', '-NBegin', '2', '-NEnd', '3');
  await report('history-by-object', '-GroupByObject');
  await report('history-by-comment', '-GroupByComment');
  await report('history-only-labels', '-IncludeOnlyVersionsWithLabels');
  await report('history-no-labels', '-DoNotIncludeVersionsWithLabels');
  await report('history-by-date', '-DateBegin', '2000-01-01', '-DateEnd', '2100-01-01');
  await report('history-by-date-future', '-DateBegin', '2100-01-01');
  await report('history-empty-comment', '-NBegin', '5', '-NEnd', '5');
  await report('history-special-comment', '-NBegin', '6', '-NEnd', '6');
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(path.join(outRoot, 'history-summary.json'), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  await stand.stop();
}
process.exit(0);
