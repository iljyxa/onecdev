// Сырые tcp-потоки Конфигуратора и пробы транспорта crserver (issue #46).
// Зачем: example/crs/<версия>/tcp/ хранит только тела XML, а транспорту tcp (приветствие, заголовки,
// терминатор, порядок обмена, UUID клиента) нужны побайтные артефакты.
// Конвейер: хранилище из example/crs/config и пользователь Petrov (подготовка по tcp, трафик не сохраняется) →
// сценарий Конфигуратора через записывающий прокси в сыром режиме (conn-NN.{c2s,s2c}.bin + order.json,
// байты не правятся, имя машины и путь рабочего каталога в потоках — отказ стенда) → пробы: запрос
// собирает стенд из снятых приветствия и кадра openDevDepot, ответ crserver настоящий.
// Пробы рукопожатия (issue #13): версия 0.0.0.0 (сообщает ли сервер свою), 0.0.0.0 с неверным alias
// (что проверяется раньше), версия 8.3.27.2342 (строгость совпадения) и неверный alias при верной версии.
// Артефакты — example/crs/<версия платформы>/tcp-raw/<сценарий>/ и tcp-raw-summary.json.
//
//   node example/tools/crs/capture-tcp-raw.mjs [каталог рабочих файлов, по умолчанию /tmp/crs-stand/work]
/* global process, Buffer */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { CORPUS_CONFIG, corpusDir, createStand } from './stand.mjs';

const outRoot = corpusDir('tcp-raw');
const work = path.resolve(process.argv[2] ?? '/tmp/crs-stand/work');

const petrov = { name: 'Petrov', password: '123' };
const CLIENT_HELLO = Buffer.from('224855b5', 'hex');
const TERMINATOR = Buffer.from('6653b2a6', 'hex');

const stand = createStand(work);
try {
  const { bases } = await stand.prepareRepository(CORPUS_CONFIG, [{ user: petrov, rights: 'LockObjects' }]);
  const results = {};
  // Неверный пароль: openDevDepot, authenticate и call_exception без bind — в потоках нет имени машины.
  const wrongPassword = (name) => stand.recordRaw(outRoot, results, name, bases.Petrov, { ...petrov, password: 'wrong' },
    ['/ConfigurationRepositoryLock', '-Objects', stand.objectList('Справочник.Контрагенты')]);
  await wrongPassword('wrong-password');
  // Тот же сценарий другим процессом Конфигуратора: сравнение 16 байт после 224855b5 между процессами.
  await wrongPassword('wrong-password-rerun');

  // Основа проб — первое соединение Конфигуратора: приветствие клиента и кадр openDevDepot.
  const stream = readFileSync(path.join(outRoot, 'wrong-password', 'conn-01.c2s.bin'));
  const hello = stream.subarray(0, CLIENT_HELLO.length + 16);
  if (!hello.subarray(0, CLIENT_HELLO.length).equals(CLIENT_HELLO)) throw new Error('conn-01.c2s.bin: поток не начинается с приветствия клиента');
  const frame = stream.subarray(hello.length);
  const headerEnd = frame.indexOf('\r\n\r\n');
  const head = frame.subarray(0, headerEnd + 4).toString('latin1');
  const length = Number(/Content-Length: (\d+)/.exec(head)?.[1]);
  const body = frame.subarray(headerEnd + 4, headerEnd + 4 + length);
  const tail = frame.subarray(headerEnd + 4 + length);
  if (!tail.equals(TERMINATOR)) throw new Error(`conn-01.c2s.bin: после тела ожидался терминатор, а не ${tail.toString('hex')}`);
  // Кадр с другим телом: заголовки те же, меняется только Content-Length.
  const build = (payload, terminator = true) => Buffer.concat([
    Buffer.from(head.replace(/Content-Length: \d+/, `Content-Length: ${String(payload.length)}`), 'latin1'),
    payload, ...(terminator ? [TERMINATOR] : [])]);
  const unknown = Buffer.from(body.toString('utf-8').replace('name="DevDepotAdmin_openDevDepot"', 'name="DevDepot_noSuchMethod"'), 'utf-8');
  // Подстановка в снятое тело openDevDepot: образец обязан встретиться ровно один раз, иначе проба
  // незаметно стала бы копией исходного запроса.
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
  const probes = {
    'probe-open': { hello, frames: [build(body)] },
    'probe-two-frames': { hello, frames: [build(body), build(body)] },
    // Без терминатора ждём дольше обычного: вывод «сервер не отвечает» не должен зависеть от паузы в 1 с.
    'probe-no-terminator': { hello, frames: [build(body, false)], closeAfterMs: 3000 },
    // Тот же кадр, терминатор — отдельной записью после паузы: ждёт ли сервер именно его.
    'probe-late-terminator': { hello, frames: [build(body, false), TERMINATOR], closeAfterMs: 3000 },
    'probe-malformed-body': { hello, frames: [build(Buffer.from('не xml', 'utf-8'))] },
    'probe-unknown-method': { hello, frames: [build(unknown)] },
    'probe-no-hello': { frames: [build(body)] },
    // Рукопожатие по версии: заведомо чужая версия 0.0.0.0 — сообщит ли сервер свою в исключении.
    'probe-version-zero': { hello, frames: [build(substitute(body, [version, 'version="0.0.0.0"']))] },
    // Что сервер проверяет раньше — версию или alias: от этого зависит рукопожатие на пустом crserver.
    'probe-version-zero-wrong-alias': { hello, frames: [build(substitute(body, [version, 'version="0.0.0.0"'], wrongAlias))] },
    // Другая существующая версия платформы: нужно ли точное совпадение или хватает совместимой.
    'probe-version-other': { hello, frames: [build(substitute(body, [version, 'version="8.3.27.2342"']))] },
    // Неверный alias при верной версии — пара к http/probe-wrong-alias.
    'probe-wrong-alias': { hello, frames: [build(substitute(body, wrongAlias))] },
  };
  for (const [name, probe] of Object.entries(probes)) {
    const summary = await stand.tcpProbe(path.join(outRoot, name), probe);
    results[name] = summary;
    stand.log(`${name}: запрос ${String(summary.requestBytes)} Б, ответ ${String(summary.responseBytes)} Б, сервер закрыл: ${String(summary.serverClosed)}`);
  }
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(path.join(outRoot, 'tcp-raw-summary.json'), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  await stand.stop();
}
process.exit(0);
