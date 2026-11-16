// Сырые http-потоки публикации .1ccr для транспорта http (issue #15).
// Зачем: example/crs/<версия>/http/ хранит заголовки и уже раскодированные тела (границы chunk потеряны),
// а транспорту http нужны ответы apache/wsap24 побайтно, как на проводе. Кроме того, между клиентом и
// crserver стоит wsap24 со своей версией: как он пропускает рукопожатие (версия 0.0.0.0) — снимается,
// а не переносится с tcp.
// Конвейер: хранилище из example/crs/config и пользователь Petrov (подготовка по tcp, трафик не сохраняется) →
// свой apache с wsap24.so и публикацией repo.1ccr → пробы: запрос собирает стенд — заголовки как у
// http/probe-valid (порт Host — текущего apache), тело — openDevDepot Конфигуратора из
// tcp-raw/wrong-password/conn-01.c2s.bin (тела tcp и http совпадают, 07) с подстановками; ответ настоящий.
// Артефакты — example/crs/<версия платформы>/http-raw/<проба>/ и http-raw-summary.json.
//
//   node example/tools/crs/capture-http-raw.mjs [каталог рабочих файлов, по умолчанию /tmp/crs-stand/work]
/* global process, Buffer */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { CORPUS_CONFIG, corpusDir, createStand } from './stand.mjs';

const outRoot = corpusDir('http-raw');
const work = path.resolve(process.argv[2] ?? '/tmp/crs-stand/work');

const petrov = { name: 'Petrov', password: '123' };
const CLIENT_HELLO_LENGTH = 20;
const TERMINATOR = Buffer.from('6653b2a6', 'hex');

// Тело openDevDepot Конфигуратора: после приветствия клиента, между заголовками и терминатором.
const stream = readFileSync(path.join(corpusDir('tcp-raw'), 'wrong-password', 'conn-01.c2s.bin'));
const frame = stream.subarray(CLIENT_HELLO_LENGTH);
const frameHeadEnd = frame.indexOf('\r\n\r\n');
const frameLength = Number(/Content-Length: (\d+)/.exec(frame.subarray(0, frameHeadEnd).toString('latin1'))?.[1]);
const body = frame.subarray(frameHeadEnd + 4, frameHeadEnd + 4 + frameLength);
if (!frame.subarray(frameHeadEnd + 4 + frameLength).equals(TERMINATOR)) throw new Error('conn-01.c2s.bin: после тела ожидался терминатор');
// Заголовки запроса — как у снятой пробы http/probe-valid (Host, Content-Type, Accept, Content-Length, Connection).
const validHead = readFileSync(path.join(corpusDir('http'), 'probe-valid', 'request.headers.txt'), 'latin1');
if (!validHead.endsWith('\r\n')) throw new Error('probe-valid/request.headers.txt: заголовки должны кончаться CRLF');

const substitute = (source, ...pairs) => {
  let text = source.toString('utf-8');
  for (const [from, to] of pairs) {
    const count = text.split(from).length - 1;
    if (count !== 1) throw new Error(`тело openDevDepot: «${from}» встречается ${String(count)} раз, ожидался один`);
    text = text.replace(from, to);
  }
  return Buffer.from(text, 'utf-8');
};
const version = /version="(\d+\.\d+\.\d+\.\d+)"/.exec(body.toString('utf-8'))?.[0];
if (version === undefined) throw new Error('тело openDevDepot: нет атрибута version');
const wrongAlias = ['<crs:alias value="exp"/>', '<crs:alias value="nosuch"/>'];
const unknownMethod = ['name="DevDepotAdmin_openDevDepot"', 'name="DevDepot_noSuchMethod"'];

const stand = createStand(work);
try {
  await stand.prepareRepository(CORPUS_CONFIG, [{ user: petrov, rights: 'LockObjects' }]);
  await stand.startApache();
  const head = (requestPath = '/repo/repo.1ccr') => `${validHead
    .replace(/^POST \S+ HTTP\/1\.1\r\n/, `POST ${requestPath} HTTP/1.1\r\n`)
    .replace(/\r\nHost: [^\r]+\r\n/, `\r\nHost: 127.0.0.1:${String(stand.apache.port)}\r\n`)}\r\n`;
  const probes = {
    'probe-valid': { head: head(), body },
    // Ответ 404 публикации приходит chunked: ради границ chunk эта проба и снимается сырой.
    'probe-wrong-path': { head: head('/repo/missing.1ccr'), body },
    'probe-malformed-body': { head: head(), body: Buffer.from('не xml', 'utf-8') },
    'probe-unknown-method': { head: head(), body: substitute(body, unknownMethod) },
    'probe-wrong-alias': { head: head(), body: substitute(body, wrongAlias) },
    // Рукопожатие через wsap24: пропустит ли публикация чужую версию и с каким ответом.
    'probe-version-zero': { head: head(), body: substitute(body, [version, 'version="0.0.0.0"']) },
    'probe-version-zero-wrong-alias': { head: head(), body: substitute(body, [version, 'version="0.0.0.0"'], wrongAlias) },
    'probe-version-other': { head: head(), body: substitute(body, [version, 'version="8.3.27.2342"']) },
  };
  const results = {};
  for (const [name, probe] of Object.entries(probes)) {
    const summary = await stand.httpRawProbe(path.join(outRoot, name), probe);
    results[name] = summary;
    stand.log(`${name}: HTTP ${String(summary.status)}, запрос ${String(summary.requestBytes)} Б, ответ ${String(summary.responseBytes)} Б, chunked: ${String(summary.chunked)}`);
  }
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(path.join(outRoot, 'http-raw-summary.json'), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  await stand.stop();
}
process.exit(0);
