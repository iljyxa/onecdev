// Пробы методов чтения crserver (issue #14): нужна ли привязка (crs:bind) для devObjectsStatistic и что
// делает DevDepot_bind с незарегистрированным bindID. bindID выдаёт не сервер: его создаёт
// /ConfigurationRepositoryBindCfg и хранит привязанная база, расширению без платформы он неизвестен.
// Конвейер: хранилище из example/crs/config, Petrov и Sidorov (LockObjects), Reader (ReadOnly) → Petrov
// захватывает Справочник.Контрагенты и строит отчёт по истории (подготовка, потоки остаются во work) → из
// потоков берутся приветствие клиента, заголовок кадра, bindID Petrov и тела bind, полной статистики,
// devDepotReport и depotUsers (issue #21: нужна ли привязка истории и пользователям) → пробы: каждая
// на свежем соединении без openDevDepot и authenticate, тело — подстановка в снятое, ответ настоящий.
// Артефакты — example/crs/<версия платформы>/tcp/probe-*/ (request.xml, response.xml, result.json) и
// tcp/read-probes-summary.json. Имя машины и рабочий каталог заменяются (scrub).
//
//   node example/tools/crs/capture-read-probes.mjs [каталог рабочих файлов, по умолчанию /tmp/crs-stand/work]
/* global process */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { CORPUS_CONFIG, corpusDir, createStand, frameOf, setupConnection, substitute } from './stand.mjs';

const outRoot = corpusDir('tcp');
const work = path.resolve(process.argv[2] ?? '/tmp/crs-stand/work');

const petrov = { name: 'Petrov', password: '123' };
const sidorov = { name: 'Sidorov', password: '456' };
const reader = { name: 'Reader', password: '789' };
// Незарегистрированные bindID — постоянные, чтобы пересъёмка давала те же запросы.
const RANDOM_BIND_ID = '6f1c2d3e-4b5a-4c6d-8e7f-a0b1c2d3e4f5';
const NEW_BIND_ID = '0b7e5a1c-9d2f-4e3a-b4c5-d6e7f8091a2b';
const PROBE_BIND_STRING = 'Computer=&quot;crs-stand&quot;;Config=&quot;/tmp/crs-stand/work/ibProbe&quot;;';

// Хеш как у Конфигуратора (src/core/crs/secrets.ts): md5 от пароля в UTF-16LE.
const hash = (password) => createHash('md5').update(password, 'utf16le').digest('hex');

const stand = createStand(work);
try {
  const { bases } = await stand.prepareRepository(CORPUS_CONFIG,
    [{ user: petrov, rights: 'LockObjects' }, { user: sidorov, rights: 'LockObjects' }, { user: reader, rights: 'ReadOnly' }]);
  await stand.setup('petrov-holds-lock', bases.Petrov, petrov, ['/ConfigurationRepositoryLock', '-Objects', stand.objectList('Справочник.Контрагенты')]);
  // Отчёт по истории от Petrov (issue #21): из его потоков берутся тела devDepotReport и depotUsers.
  await stand.setup('petrov-report', bases.Petrov, petrov, ['/ConfigurationRepositoryReport', path.join(work, 'petrov-report.txt'), '-ReportFormat', 'txt']);

  const { hello, frames } = setupConnection(work, 'petrov-holds-lock', 'DevDepot_bind');
  const bodyOf = (method, source = frames) => frameOf(source, method);
  const { head, body: bindBody } = bodyOf('DevDepot_bind');
  const report = bodyOf('DevDepot_devDepotReport', setupConnection(work, 'petrov-report', 'DevDepot_devDepotReport').frames).body;
  const users = bodyOf('UserManager_depotUsers', setupConnection(work, 'petrov-report', 'UserManager_depotUsers').frames).body;
  // Первая статистика соединения — полная (<crs:objRefs/>), как в tcp/lock-one/06.
  const statistic = bodyOf('DevDepot_devObjectsStatistic').body;
  if (!statistic.includes('<crs:objRefs/>')) throw new Error('первая статистика соединения не полная');
  const bindId = /<crs:bindID value="([^"]+)"/.exec(bindBody)?.[1];
  if (bindId === undefined) throw new Error('в теле bind нет bindID');
  const bindElement = `<crs:bind bindID="${bindId}"/>`;
  const petrovAuth = `<crs:auth user="Petrov" password="${hash(petrov.password)}"/>`;
  const readerAuth = `<crs:auth user="Reader" password="${hash(reader.password)}"/>`;
  const wrongAuth = `<crs:auth user="Petrov" password="${hash('wrong')}"/>`;
  const bindString = /<crs:bindString value="[^"]*"\/>/.exec(bindBody)?.[0];

  // Порядок важен: probe-bind-new меняет состояние хранилища, поэтому идёт предпоследней.
  const probes = {
    'probe-statistic-own-bind': substitute(statistic),
    'probe-statistic-no-bind': substitute(statistic, [bindElement, '']),
    'probe-statistic-random-bind': substitute(statistic, [bindId, RANDOM_BIND_ID]),
    'probe-statistic-reader-no-bind': substitute(statistic, [bindElement, ''], [petrovAuth, readerAuth]),
    'probe-statistic-wrong-password': substitute(statistic, [bindElement, ''], [petrovAuth, wrongAuth]),
    'probe-history-no-bind': substitute(report, [bindElement, '']),
    'probe-history-random-bind': substitute(report, [bindId, RANDOM_BIND_ID]),
    'probe-history-reader-no-bind': substitute(report, [bindElement, ''], [petrovAuth, readerAuth]),
    'probe-history-wrong-password': substitute(report, [bindElement, ''], [petrovAuth, wrongAuth]),
    'probe-depot-users-no-bind': substitute(users, [bindElement, '']),
    'probe-depot-users-reader-no-bind': substitute(users, [bindElement, ''], [petrovAuth, readerAuth]),
    'probe-bind-unknown-existing': substitute(bindBody, [bindId, RANDOM_BIND_ID]),
    'probe-bind-new': substitute(bindBody, [bindId, NEW_BIND_ID], [bindString, `<crs:bindString value="${PROBE_BIND_STRING}"/>`],
      ['<crs:existing value="true"/>', '<crs:existing value="false"/>']),
    'probe-statistic-after-bind-new': substitute(statistic, [bindElement, '']),
  };
  const results = {};
  for (const [name, body] of Object.entries(probes)) {
    results[name] = await stand.tcpBodyProbe(path.join(outRoot, name), { hello, head, body });
    stand.log(`${name}: ${results[name].response}`);
  }
  writeFileSync(path.join(outRoot, 'read-probes-summary.json'), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  await stand.stop();
}
process.exit(0);
