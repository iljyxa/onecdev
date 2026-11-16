// Пробы фильтров истории crserver (issue #39): то, что из командной строки Конфигуратора не задаётся, —
// история объектов (objRefs, recursive), авторы (userIDs), версия конфигурации (configVersion), смысл
// mask (битовая маска включённых фильтров, установлено пробами), границы дат и метод
// DevDepot_devDepotVersions из crs-api.
// Конвейер: хранилище с версиями 1–6 (history-repository.mjs, как у capture-history.mjs) и версия 7 от
// Admin, меняющая свойство «Версия» конфигурации на 1.0.0.2, — чтобы configVersion было что различать →
// отчёт Admin (подготовка, потоки остаются во work) → из потоков берутся приветствие клиента, заголовок
// кадра и тело devDepotReport → контрольная проба без ограничений, из её ответа — uuid авторов, объектов
// и дата версии 3 → пробы: подстановка в снятое тело, на свежем соединении без openDevDepot, authenticate
// и crs:bind (привязка истории не нужна, tcp/probe-history-no-bind), ответ настоящий.
// Артефакты — example/crs/<версия платформы>/tcp/probe-history-*/ (request.xml, response.xml, result.json)
// и tcp/history-probes-summary.json (номера версий и изменённые объекты каждого ответа).
// http (issue #89): те же тела уходят POST на публикацию .1ccr через собственный apache с wsap24.so
// (stand.httpProbe) — только пробы истории объекта и постраничной загрузки (HTTP_PROBES); артефакты — в http/probe-history-*/
// (request.{headers.txt,xml}, response.{headers.txt,xml}, result.json) и http/history-probes-summary.json.
//
//   node example/tools/crs/capture-history-probes.mjs [--transport=tcp|http] [каталог рабочих файлов, по умолчанию /tmp/crs-stand/work]
/* global process, Buffer */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { admin, buildHistoryRepository } from './history-repository.mjs';
import { corpusDir, createStand, frameOf, setupConnection, substitute } from './stand.mjs';

const args = process.argv.slice(2);
const transport = args.find((a) => a.startsWith('--transport='))?.slice('--transport='.length) ?? 'tcp';
if (transport !== 'tcp' && transport !== 'http') throw new Error(`неизвестный транспорт: ${transport}`);
const outRoot = corpusDir(transport);
const work = path.resolve(args.find((a) => !a.startsWith('--')) ?? '/tmp/crs-stand/work');

// По http — только то, на чём строится история объекта: вопрос в том, пропускает ли публикация фильтр
// objRefs, а не в семантике фильтров (она снята по tcp).
// Списки номеров (devDepotVersions) и страницы по диапазону (issue #83) — тоже: на них строится постраничная
// загрузка истории, и она должна работать по обоим транспортам.
const HTTP_PROBES = new Set(['probe-history-filter-none', 'probe-history-object-catalog', 'probe-history-object-catalog-recursive',
  'probe-history-object-two', 'probe-history-object-unknown', 'probe-history-devdepotversions', 'probe-history-devdepotversions-object-two',
  'probe-history-devdepotversions-object-catalog-recursive', 'probe-history-devdepotversions-object-unknown',
  'probe-history-devdepotversions-object-root-recursive', 'probe-history-page-1-7', 'probe-history-page-5-7', 'probe-history-page-2-4',
  'probe-history-page-1-1', 'probe-history-page-object-catalog-recursive-3-6', 'probe-history-page-object-catalog-recursive-1-2',
  'probe-history-page-object-catalog-recursive-1-6', 'probe-history-page-object-root-recursive-5-7',
  'probe-history-page-object-root-recursive-1-7']);
const XML_HEADERS = { 'Content-Type': 'application/xml', Accept: 'application/xml' };

// Несуществующие автор и объект — постоянный uuid, чтобы пересъёмка давала те же запросы.
const UNKNOWN_ID = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const CATALOG_CLASS_ID = 'cf4abea6-37b2-11d4-940f-008048da11f9';
const FORM_CLASS_ID = 'fdf816d2-1ead-11d5-b975-0050bae0a95d';
const COMMON_MODULE_CLASS_ID = '0fe48980-252d-11d6-a3c7-0050bae0a776';
const NO_PARENT = '00000000-0000-0000-0000-000000000000';

const ROOT_OBJECT = { name: 'Конфигурация.ТестовоеХранилище', files: ['Configuration.xml'] };

// Версии и изменённые объекты ответа истории — для сводки и выбора uuid. Номера версий — в порядке ответа,
// с повторами: при фильтре по нескольким объектам сервер повторяет версию у каждого объекта.
function parseHistory(text) {
  const section = (name) => new RegExp(`<crs:${name}>(.*?)</crs:${name}>`, 's').exec(text)?.[1] ?? '';
  // devDepotReport кладёт версии в objectVersions, devDepotVersions — в versions (пары first/second).
  const versions = [...(section('objectVersions') || section('versions')).matchAll(/<crs:info><crs:verNum value="(\d+)"\/><crs:userID value="([^"]+)"\/>(?:(?!<\/crs:info>).)*?<crs:date value="([^"]+)"\/>(?:(?!<\/crs:info>).)*?<crs:code value="([^"]*)"\/>/gs)]
    .map(([, verNum, userId, date, code]) => ({ verNum: Number(verNum), userId, date, code }));
  const changes = [...section('depotVersions').matchAll(/<crs:_super><crs:id value="([^"]+)"\/><crs:classID value="([^"]+)"\/><\/crs:_super><crs:name value="([^"]*)"\/><crs:pos value="\d+"\/><crs:verNum value="(\d+)"\/>(?:(?!<\/crs:info>).)*?<crs:parentID value="([^"]+)"\/>/gs)]
    .map(([, id, classId, name, verNum, parentId]) => ({ id, classId, name, verNum: Number(verNum), parentId }));
  return { versions, changes };
}

// Итог пробы для сводки: номера версий и «версия:имя» изменённых объектов, у отказа — текст исключения.
function summarize(result, outDir) {
  const text = readFileSync(path.join(outDir, 'response.xml'), 'utf-8');
  if (result.response === 'call_return') {
    const { versions, changes } = parseHistory(text);
    return { ...result, versions: versions.map((v) => v.verNum), changes: changes.map((c) => `${String(c.verNum)}:${c.name}`) };
  }
  if (result.response === 'call_exception') {
    const encoded = />([^<]+)<\/crs:call_exception>/.exec(text)?.[1] ?? '';
    const decoded = Buffer.from(encoded.replace(/\s/g, ''), 'base64').toString('utf-8');
    return { ...result, exception: /"([^"]*)"/.exec(decoded)?.[1] ?? decoded };
  }
  return result;
}

const shiftSeconds = (date, seconds) => new Date(Date.parse(`${date}Z`) + seconds * 1000).toISOString().slice(0, 19);
const refs = (name, ids) => [`<crs:${name}/>`, `<crs:${name}>${ids.map((id) => `<crs:value value="${id}"/>`).join('')}</crs:${name}>`];
const value = (name, from, to) => [`<crs:${name} value="${from}"/>`, `<crs:${name} value="${to}"/>`];

const stand = createStand(work);
try {
  const { baseA, commit } = await buildHistoryRepository(stand, work);
  await commit(baseA, admin, [ROOT_OBJECT], 'Версия конфигурации 1.0.0.2', (dump) => {
    const file = path.join(dump, 'Configuration.xml');
    writeFileSync(file, substitute(readFileSync(file, 'utf-8'), ['<Version>1.0.0.1</Version>', '<Version>1.0.0.2</Version>']));
  });
  if (transport === 'http') await stand.startApache();
  await stand.setup('admin-report', baseA, admin, ['/ConfigurationRepositoryReport', path.join(work, 'admin-report.txt'), '-ReportFormat', 'txt']);

  const { hello, frames } = setupConnection(work, 'admin-report', 'DevDepot_devDepotReport');
  const { head, body: captured } = frameOf(frames, 'DevDepot_devDepotReport');
  const bindElement = /<crs:bind bindID="[^"]+"\/>/.exec(captured)?.[0];
  if (bindElement === undefined) throw new Error('в теле devDepotReport нет crs:bind');
  const report = substitute(captured, [bindElement, '']).toString('utf-8');

  const results = {};
  // По http тело то же, что по tcp: кадрирование tcp к нему не относится (07-crs-http.md).
  const httpBodyProbe = async (outDir, body) => {
    rmSync(outDir, { recursive: true, force: true });
    const text = body.toString('utf-8');
    const { status } = await stand.httpProbe(outDir, { requestPath: '/repo/repo.1ccr', headers: XML_HEADERS, body: text });
    const response = readFileSync(path.join(outDir, 'response.xml'), 'utf-8');
    const method = /<crs:call [^>]*name="([^"]+)"/.exec(text)?.[1];
    const kind = /<crs:(call_return|call_exception)/.exec(response)?.[1] ?? (response.replace(/^\uFEFF/, '') === '' ? 'empty' : 'other');
    const summary = { method, status, response: kind };
    writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  };
  const probe = async (name, body) => {
    if (transport === 'http' && !HTTP_PROBES.has(name)) return;
    const outDir = path.join(outRoot, name);
    const result = transport === 'http' ? await httpBodyProbe(outDir, body) : await stand.tcpBodyProbe(outDir, { hello, head, body });
    results[name] = summarize(result, outDir);
    stand.log(`${name}: ${JSON.stringify(results[name])}`);
  };

  await probe('probe-history-filter-none', substitute(report));
  const base = parseHistory(readFileSync(path.join(outRoot, 'probe-history-filter-none', 'response.xml'), 'utf-8'));
  const version = (verNum) => base.versions.find((v) => v.verNum === verNum) ?? (() => { throw new Error(`в истории нет версии ${String(verNum)}`); })();
  const object = (predicate, what) => base.changes.find(predicate)?.id ?? (() => { throw new Error(`в истории нет объекта: ${what}`); })();
  const adminId = version(1).userId;
  const petrovId = version(2).userId;
  const date3 = version(3).date;
  const rootId = object((c) => c.parentId === NO_PARENT, 'корень конфигурации');
  const catalogId = object((c) => c.classId === CATALOG_CLASS_ID && c.name === 'Контрагенты', 'Справочник.Контрагенты');
  const formId = object((c) => c.classId === FORM_CLASS_ID && c.parentId === catalogId, 'форма Справочник.Контрагенты');
  const moduleId = object((c) => c.classId === COMMON_MODULE_CLASS_ID, 'ОбщийМодуль.ОбщегоНазначения');

  // mask — битовая маска включённых фильтров: 1 — диапазон (номера и даты), 2 — авторы (userIDs),
  // 4 — объекты (objRefs); Конфигуратор всегда шлёт 1. Пробы с «чужой» маской показывают, что фильтр без
  // своего бита не действует.
  const mask = (bits) => value('mask', '1', String(bits));
  const users = (...ids) => refs('userIDs', ids);
  const objects = (...ids) => refs('objRefs', ids);
  const recursive = value('recursive', 'false', 'true');
  const noDate = '0001-01-01T00:00:00';
  const versionsMethod = ['name="DevDepot_devDepotReport"', 'name="DevDepot_devDepotVersions"'];
  // Диапазон номеров страницы: бит 1 Конфигуратор ставит и так, у страниц объекта маска 5 задаётся явно.
  const range = (begin, end) => [value('beginVerNum', '-1', String(begin)), value('endVerNum', '-1', String(end))];
  const probes = {
    // Авторы: Petrov поместил версии 2 и 3.
    'probe-history-user-petrov': [mask(2), users(petrovId)],
    'probe-history-user-both': [mask(2), users(adminId, petrovId)],
    'probe-history-user-unknown': [mask(2), users(UNKNOWN_ID)],
    'probe-history-user-petrov-mask-1': [users(petrovId)],
    // Объекты: справочник изменён в 1, 2, 3, 6; его форма и макет — только в 1; корень — в 1 и 7.
    'probe-history-object-catalog': [mask(4), objects(catalogId)],
    'probe-history-object-catalog-recursive': [mask(4), objects(catalogId), recursive],
    'probe-history-object-form': [mask(4), objects(formId)],
    'probe-history-object-root': [mask(4), objects(rootId)],
    'probe-history-object-root-recursive': [mask(4), objects(rootId), recursive],
    'probe-history-object-two': [mask(4), objects(catalogId, moduleId)],
    'probe-history-object-unknown': [mask(4), objects(UNKNOWN_ID)],
    'probe-history-object-catalog-mask-1': [objects(catalogId)],
    'probe-history-object-catalog-user-petrov': [mask(6), objects(catalogId), users(petrovId)],
    'probe-history-object-catalog-range': [mask(5), objects(catalogId), value('beginVerNum', '-1', '2')],
    'probe-history-object-catalog-only-labels': [mask(4), objects(catalogId), value('onlyLabels', 'false', 'true')],
    // Маска без фильтров и неизвестный бит.
    'probe-history-mask-0': [mask(0)],
    'probe-history-mask-0-range': [mask(0), value('beginVerNum', '-1', '2'), value('endVerNum', '-1', '3')],
    'probe-history-mask-2-no-users': [mask(2)],
    'probe-history-mask-4-no-objects': [mask(4)],
    'probe-history-mask-8': [mask(8)],
    // Версия конфигурации: у версий 1–6 — 1.0.0.1, у 7 — 1.0.0.2; от маски не зависит.
    'probe-history-config-version-1': [value('configVersion', '', '1.0.0.1')],
    'probe-history-config-version-2': [value('configVersion', '', '1.0.0.2')],
    'probe-history-config-version-2-mask-0': [mask(0), value('configVersion', '', '1.0.0.2')],
    'probe-history-config-version-unknown': [value('configVersion', '', '9.9.9.9')],
    // Границы дат по дате версии 3 (с точностью до секунды); без бита 1 даты не действуют.
    'probe-history-date-exact': [value('beginDate', noDate, date3), value('endDate', noDate, date3)],
    'probe-history-date-begin-after': [value('beginDate', noDate, shiftSeconds(date3, 1))],
    'probe-history-date-end-at': [value('endDate', noDate, date3)],
    'probe-history-date-end-before': [value('endDate', noDate, shiftSeconds(date3, -1))],
    'probe-history-date-future-mask-0': [mask(0), value('beginDate', noDate, '2100-01-01T00:00:00')],
    // Метод crs-api: тот же фильтр, что у Конфигуратора, фильтры объектов и автора, фильтр в записи crs-api
    // (mask 0, 0xFFFFFFFF текстом).
    'probe-history-devdepotversions': [versionsMethod],
    'probe-history-devdepotversions-object-two': [versionsMethod, mask(4), objects(catalogId, moduleId)],
    'probe-history-devdepotversions-user-petrov': [versionsMethod, mask(2), users(petrovId)],
    'probe-history-devdepotversions-crs-api': [versionsMethod, mask(0),
      ['<crs:beginVerNum value="-1"/>', '<crs:beginVerNum>4294967295</crs:beginVerNum>'], ['<crs:endVerNum value="-1"/>', '<crs:endVerNum>4294967295</crs:endVerNum>']],
    // Постраничная история (issue #83): список номеров версий объекта с подчинёнными (справочник — 1, 2, 3, 6;
    // корень — все) и неизвестного объекта, затем страницы devDepotReport по диапазону номеров из списка.
    'probe-history-devdepotversions-object-catalog-recursive': [versionsMethod, mask(4), objects(catalogId), recursive],
    'probe-history-devdepotversions-object-unknown': [versionsMethod, mask(4), objects(UNKNOWN_ID), recursive],
    'probe-history-devdepotversions-object-root-recursive': [versionsMethod, mask(4), objects(rootId), recursive],
    'probe-history-page-1-7': range(1, 7),
    'probe-history-page-5-7': range(5, 7),
    'probe-history-page-2-4': range(2, 4),
    'probe-history-page-1-1': range(1, 1),
    'probe-history-page-object-catalog-recursive-3-6': [mask(5), objects(catalogId), recursive, ...range(3, 6)],
    'probe-history-page-object-catalog-recursive-1-2': [mask(5), objects(catalogId), recursive, ...range(1, 2)],
    'probe-history-page-object-catalog-recursive-1-6': [mask(5), objects(catalogId), recursive, ...range(1, 6)],
    'probe-history-page-object-root-recursive-5-7': [mask(5), objects(rootId), recursive, ...range(5, 7)],
    'probe-history-page-object-root-recursive-1-7': [mask(5), objects(rootId), recursive, ...range(1, 7)],
  };
  for (const [name, pairs] of Object.entries(probes)) {
    await probe(name, substitute(report, ...pairs));
  }
  writeFileSync(path.join(outRoot, 'history-probes-summary.json'), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  await stand.stop();
}
process.exit(0);
