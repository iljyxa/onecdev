// Снятие истории хранилища со всей тестовой конфигурацией (issue #84): версия 1 хранилища из
// example/crs/config содержит объект каждого вида (issue #49), поэтому её отчёт — это набор classID всех
// видов объектов и их дочерних элементов (измерения, ресурсы). Имена объектов (`Тест<Вид>`) задают вид,
// так что таблицу classID → вид можно сверять без внешних источников.
// Отдельно от capture-history.mjs: у того хранилище собирается из шести версий на прежних объектах, и
// пересъёмка поменяла бы все снятые там сценарии.
//
//   node example/tools/crs/capture-history-classes.mjs [каталог рабочих файлов, по умолчанию /tmp/crs-stand/work]
// Артефакты — example/crs/<версия платформы>/tcp/history-full-config/ и tcp/history-classes-summary.json.
/* global process */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { admin } from './history-repository.mjs';
import { CORPUS_CONFIG, corpusDir, createStand } from './stand.mjs';

const outRoot = corpusDir('tcp');
const work = path.resolve(process.argv[2] ?? '/tmp/crs-stand/work');

const stand = createStand(work);
try {
  const { baseA } = await stand.prepareRepository(CORPUS_CONFIG, []);
  const results = {};
  const file = path.join(work, 'report-history-full-config.txt');
  const result = await stand.record(outRoot, results, 'history-full-config', baseA, admin, ['/ConfigurationRepositoryReport', file, '-ReportFormat', 'txt']);
  if (result.status === 0) writeFileSync(path.join(outRoot, 'history-full-config', 'report.txt'), readFileSync(file));
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(path.join(outRoot, 'history-classes-summary.json'), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  await stand.stop();
}
process.exit(0);
