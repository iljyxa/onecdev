// Снятие трафика захвата и отпуска, включая отказы (issue #9).
// Каждый сценарий — одна команда Конфигуратора через записывающий tcp-прокси; кадры кладутся в
// example/crs/<версия платформы>/tcp/<сценарий>/, статус и вывод платформы — в result.json.
//
//   node example/tools/crs/capture-locks.mjs [--transport=tcp|http] [каталог рабочих файлов, по умолчанию /tmp/crs-stand/work]
// http (issue #11): сценарии те же, но Конфигуратор ходит через прокси на собственный apache с wsap24.so и
// публикацией .1ccr; кадры — в example/crs/<версия>/http/. Подготовка хранилища идёт по tcp.
/* global process */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { CORPUS_CONFIG, corpusDir, createStand, platformFullVersion } from './stand.mjs';

const args = process.argv.slice(2);
const transport = args.find((a) => a.startsWith('--transport='))?.slice('--transport='.length) ?? 'tcp';
if (transport !== 'tcp' && transport !== 'http') throw new Error(`неизвестный транспорт: ${transport}`);
const outRoot = corpusDir(transport);
const work = path.resolve(args.find((a) => !a.startsWith('--')) ?? '/tmp/crs-stand/work');

const petrov = { name: 'Petrov', password: '123' };
const sidorov = { name: 'Sidorov', password: '456' };
const reader = { name: 'Reader', password: '789' };

const stand = createStand(work);
try {
  const { bases } = await stand.prepareRepository(CORPUS_CONFIG,
    [{ user: petrov, rights: 'LockObjects' }, { user: sidorov, rights: 'LockObjects' }, { user: reader, rights: 'ReadOnly' }]);
  if (transport === 'http') await stand.startApache();
  const one = stand.objectList('Справочник.Контрагенты');
  const two = stand.objectList('Справочник.Контрагенты', 'Справочник.Номенклатура');
  const lock = (objects) => ['/ConfigurationRepositoryLock', '-Objects', objects];
  const unlock = (objects) => ['/ConfigurationRepositoryUnlock', '-Objects', objects];
  const results = {};
  const scenario = (name, base, user, command) => stand.record(outRoot, results, name, base, user, command, transport);

  // Успешные: один объект и несколько, захват и отпуск.
  await scenario('lock-one', bases.Petrov, petrov, lock(one));
  await scenario('unlock-one', bases.Petrov, petrov, unlock(one));
  await scenario('lock-several', bases.Petrov, petrov, lock(two));
  await scenario('unlock-several', bases.Petrov, petrov, unlock(two));
  // Отказы.
  await stand.setup('petrov-holds-lock', bases.Petrov, petrov, lock(one));
  await scenario('lock-held-by-other', bases.Sidorov, sidorov, lock(one));
  await scenario('unlock-held-by-other', bases.Sidorov, sidorov, unlock(one));
  await stand.setup('petrov-releases-lock', bases.Petrov, petrov, unlock(one));
  await scenario('lock-no-right', bases.Reader, reader, lock(one));
  await scenario('lock-wrong-password', bases.Petrov, { ...petrov, password: 'wrong' }, lock(one));
  await scenario('lock-unknown-user', bases.Petrov, { name: 'Nobody', password: '000' }, lock(one));
  if (transport === 'http') {
    // Пробы публикации: как отвечает apache/wsap24 на запросы, которых Конфигуратор не шлёт.
    const xmlHeaders = { 'Content-Type': 'application/xml', Accept: 'application/xml' };
    // Основа проб — настоящий запрос openDevDepot Конфигуратора (полный, с params); меняется один элемент.
    const call = ({ name = 'DevDepotAdmin_openDevDepot', alias = 'exp', bom = true } = {}) => `${bom ? '\uFEFF' : ''}<?xml version="1.0" encoding="UTF-8"?><crs:call xmlns:crs="http://v8.1c.ru/8.2/crs" alias="exp" name="${name}" version="${platformFullVersion}"><crs:params><crs:alias value="${alias}"/><crs:convert value="false"/></crs:params></crs:call>`;
    const probes = {
      'probe-valid': { requestPath: '/repo/repo.1ccr', headers: xmlHeaders, body: call() },
      'probe-no-bom': { requestPath: '/repo/repo.1ccr', headers: xmlHeaders, body: call({ bom: false }) },
      'probe-wrong-path': { requestPath: '/repo/missing.1ccr', headers: xmlHeaders, body: call() },
      'probe-get': { method: 'GET', requestPath: '/repo/repo.1ccr', headers: { Accept: 'application/xml' } },
      'probe-malformed-body': { requestPath: '/repo/repo.1ccr', headers: xmlHeaders, body: 'не xml' },
      'probe-unknown-method': { requestPath: '/repo/repo.1ccr', headers: xmlHeaders, body: call({ name: 'DevDepot_noSuchMethod' }) },
      'probe-wrong-alias': { requestPath: '/repo/repo.1ccr', headers: xmlHeaders, body: call({ alias: 'nosuch' }) },
    };
    for (const [name, probe] of Object.entries(probes)) {
      const dir = path.join(outRoot, name);
      rmSync(dir, { recursive: true, force: true });
      const { status } = await stand.httpProbe(dir, probe);
      results[name] = { status };
      stand.log(`${name}: HTTP ${String(status)}`);
    }
  }
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(path.join(outRoot, 'locks-summary.json'), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  await stand.stop();
}
process.exit(0);
