// Стенд для снятия трафика: базы 1С, crserver, пользователи хранилища и записывающий tcp-прокси.
// Общий для скриптов example/tools/crs/capture-*.mjs и для хранилища интеграционных тестов
// (example/tools/crs/test-depot.mjs). Перенесён из проекта vscode-1c-repository-tools (issue #118).
/* global process, Buffer, setTimeout, clearTimeout */
// Сырой режим (issue #46): recordRaw и tcpProbe сохраняют потоки tcp побайтно, без нарезки на кадры.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crserverRangeArg, freePort, freeRangeStart } from '../crserverPorts.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// Исходная конфигурация корпуса example/crs: с неё сняты кадры, состав объектов определяет их uuid.
export const CORPUS_CONFIG = path.join(REPO_ROOT, 'example', 'crs', 'config');
export const platformDir = process.env.V8 ?? '/opt/1cv8/x86_64/8.5.1.1529';
export const platformFullVersion = path.basename(platformDir);
export const platformVersion = platformFullVersion.split('.').slice(0, 3).join('.');
export const ALIAS = 'exp';
const APACHE = '/usr/sbin/apache2';
const APACHE_MODULES = '/usr/lib/apache2/modules';
// Кадрирование tcp (docs/research/08-crs-tcp-framing.md): приветствие сервера и терминатор кадра.
const TCP_GREETING_LENGTH = 5;
// Приветствие клиента: 20 байт перед первым кадром соединения.
const TCP_HELLO_LENGTH = 20;
const TCP_TERMINATOR = Buffer.from('6653b2a6', 'hex');

// Каталог артефактов съёмки: example/crs/<версия платформы>/<subdir>. CRS_CORPUS_ROOT подменяет корень
// корпуса — так пересборку сверяют с закоммиченным корпусом, не трогая его.
export function corpusDir(subdir) {
  return path.join(process.env.CRS_CORPUS_ROOT ?? path.join(REPO_ROOT, 'example', 'crs'), platformVersion, subdir);
}

export function createStand(work) {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const stand = { work, crs: null, log: (text) => process.stdout.write(`${text}\n`) };

  stand.createBase = async (name) => {
    const base = { db: path.join(work, `ib${name}`), data: path.join(work, `data${name}`) };
    mkdirSync(base.data, { recursive: true });
    await ibcmd(work, base, 'infobase', 'create', '--create-database');
    return base;
  };
  stand.importConfig = async (base, source) => {
    await ibcmd(work, base, 'infobase', 'config', 'import', source);
    await ibcmd(work, base, 'infobase', 'config', 'apply', '--force');
  };
  stand.startCrserver = async () => {
    mkdirSync(path.join(work, 'crsdata'), { recursive: true });
    const port = await freePort();
    const range = await freeRangeStart(port);
    const child = spawn(path.join(platformDir, 'crserver'),
      ['-port', String(port), '-range', crserverRangeArg(range), '-d', 'crsdata'], { stdio: 'ignore', cwd: work });
    // crserver живёт дольше run() и не входит в activeGroups: без этого по SIGTERM стенда (process.exit
    // из обработчика сигнала ниже) он остался бы сиротой.
    if (child.pid !== undefined) liveChildren.add(child);
    child.once('exit', () => liveChildren.delete(child));
    let up = false;
    for (let i = 0; i < 100 && !up; i += 1) {
      up = await canConnect(port);
      if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    if (!up) {
      child.kill('SIGTERM');
      throw new Error('crserver не начал слушать порт за 10 секунд');
    }
    stand.crs = { child, port };
  };
  // Публикация хранилища для http: свой apache на 127.0.0.1 с wsap24.so, .1ccr указывает на crserver.
  stand.startApache = async () => {
    const root = path.join(work, 'apache');
    const www = path.join(root, 'www');
    mkdirSync(path.join(root, 'logs'), { recursive: true });
    mkdirSync(www, { recursive: true });
    writeFileSync(path.join(www, 'repo.1ccr'), '<?xml version="1.0" encoding="UTF-8"?>\n'
      + `<repository connectString="tcp://127.0.0.1:${String(stand.crs.port)}/${ALIAS}"/>\n`);
    const port = await freePort();
    const conf = path.join(root, 'httpd.conf');
    // mime_module и log_config_module не загружаются: первому нужен mime.types, второй встроен.
    writeFileSync(conf, [
      `ServerRoot "${root}"`,
      `PidFile "${path.join(root, 'httpd.pid')}"`,
      `Listen 127.0.0.1:${String(port)}`,
      'ServerName localhost',
      `LoadModule mpm_prefork_module ${APACHE_MODULES}/mod_mpm_prefork.so`,
      `LoadModule authz_core_module ${APACHE_MODULES}/mod_authz_core.so`,
      `LoadModule alias_module ${APACHE_MODULES}/mod_alias.so`,
      `LoadModule _1cws_module "${path.join(platformDir, 'wsap24.so')}"`,
      `ErrorLog "${path.join(root, 'logs', 'error.log')}"`,
      'LogLevel warn',
      `Alias "/repo" "${www}"`,
      `<Directory "${www}">`,
      '    AllowOverride None',
      '    Options None',
      '    Require all granted',
      '    SetHandler 1c-application',
      '</Directory>',
      '',
    ].join('\n'));
    await run(work, APACHE, ['-f', conf, '-k', 'start']);
    // Присваивается до ожидания порта: при сбое запуска stop() всё равно остановит apache.
    stand.apache = { conf, port, pidFile: path.join(root, 'httpd.pid') };
    let up = false;
    for (let i = 0; i < 100 && !up; i += 1) {
      up = await canConnect(port);
      if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    if (!up) throw new Error('apache не начал слушать порт за 10 секунд');
  };
  // Проба публикации: запрос собран стендом (не Конфигуратором), ответ — настоящий ответ apache/wsap24.
  // Заголовки заданы явно и записываются как есть (Host, Content-Length, Connection: close), агент Node
  // ничего не добавляет. Кадры: request.{headers.txt,xml} и response.{headers.txt,xml} в outDir.
  stand.httpProbe = (outDir, { method = 'POST', requestPath, headers = {}, body = '' }) => new Promise((resolve, reject) => {
    mkdirSync(outDir, { recursive: true });
    const payload = Buffer.from(body, 'utf-8');
    const sent = { Host: `127.0.0.1:${String(stand.apache.port)}`, ...headers, ...(payload.length ? { 'Content-Length': String(payload.length) } : {}), Connection: 'close' };
    const request = http.request({ host: '127.0.0.1', port: stand.apache.port, method, path: requestPath, headers: sent, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => {
        const head = [`HTTP/${response.httpVersion} ${String(response.statusCode)} ${response.statusMessage ?? ''}`,
          ...response.rawHeaders.reduce((acc, v, i) => (i % 2 ? acc : [...acc, `${v}: ${response.rawHeaders[i + 1]}`]), [])].join('\r\n');
        writeFileSync(path.join(outDir, 'request.headers.txt'), scrub(`${method} ${requestPath} HTTP/1.1\r\n${Object.entries(sent).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n`, work));
        writeFileSync(path.join(outDir, 'request.xml'), scrub(body, work));
        writeFileSync(path.join(outDir, 'response.headers.txt'), scrub(`${head}\r\n`, work));
        writeFileSync(path.join(outDir, 'response.xml'), scrub(Buffer.concat(chunks).toString('utf-8'), work));
        resolve({ status: response.statusCode });
      });
    });
    request.setTimeout(30_000, () => request.destroy(new Error('проба не получила ответ за 30 секунд')));
    request.on('error', reject);
    request.end(payload);
  });
  // Сырая проба публикации (issue #15): заголовки head и тело body уходят одной записью через net, ответ
  // apache/wsap24 читается побайтно до закрытия сервером (head несёт Connection: close). В отличие от
  // httpProbe сохраняются границы chunk и заголовки как на проводе. Итог: request.bin, response.bin и
  // result.json; имя машины или путь work в потоках — отказ, как у recordRaw.
  stand.httpRawProbe = (outDir, { head, body, deadlineMs = 30_000 }) => new Promise((resolve, reject) => {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const request = Buffer.concat([Buffer.from(head.replace(/Content-Length: \d+/, `Content-Length: ${String(body.length)}`), 'latin1'), body]);
    const received = [];
    let settled = false;
    const socket = net.connect(stand.apache.port, '127.0.0.1');
    const deadline = setTimeout(() => finish(new Error(`проба ${path.basename(outDir)} не завершилась за ${String(deadlineMs)} мс`)), deadlineMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      const response = Buffer.concat(received);
      writeFileSync(path.join(outDir, 'request.bin'), request);
      writeFileSync(path.join(outDir, 'response.bin'), response);
      const statusLine = response.subarray(0, Math.max(0, response.indexOf('\r\n'))).toString('latin1');
      const headEnd = response.indexOf('\r\n\r\n');
      const responseHead = headEnd < 0 ? '' : response.subarray(0, headEnd).toString('latin1');
      const summary = {
        requestBytes: request.length,
        responseBytes: response.length,
        status: Number(/^HTTP\/1\.\d (\d{3})/.exec(statusLine)?.[1] ?? NaN),
        chunked: /\r\nTransfer-Encoding: chunked/i.test(responseHead),
      };
      writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
      try {
        if (error) throw error;
        assertRawClean(outDir, work);
        resolve(summary);
      } catch (failure) {
        reject(failure);
      }
    };
    socket.on('connect', () => socket.write(request));
    socket.on('data', (b) => received.push(b));
    socket.on('end', () => finish());
    socket.on('error', (error) => finish(error));
  });
  stand.stop = async () => {
    // crserver на SIGTERM может не завершиться до process.exit стенда и остаться фоновым процессом:
    // ждём выхода и добиваем SIGKILL.
    const child = stand.crs?.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
    if (stand.apache) {
      await run(work, APACHE, ['-f', stand.apache.conf, '-k', 'stop'], true);
    }
  };

  // Конфигуратор с параметрами хранилища; при `capture` весь его трафик пишется в capture.dir.
  // Возвращает { status, output }: отказ платформы — это тоже материал сценария, а не ошибка стенда.
  stand.designer = async (base, user, command, capture) => {
    const log = path.join(work, 'designer.log');
    rmSync(log, { force: true });
    const run1 = async (repoAddress) => {
      const argv = ['DESIGNER', '/F', base.db, '/DisableStartupDialogs', '/DisableStartupMessages', '/Out', log];
      if (repoAddress) {
        argv.push('/ConfigurationRepositoryF', repoAddress, '/ConfigurationRepositoryN', user.name);
        if (user.password) argv.push('/ConfigurationRepositoryP', user.password);
      }
      argv.push(...command);
      const result = await run(work, 'xvfb-run', ['-a', path.join(platformDir, '1cv8'), ...argv], true);
      const text = existsSync(log) ? readFileSync(log).toString('utf-8').replace(/^\uFEFF/, '').trim() : '';
      return { status: result.status, output: text || result.output };
    };
    if (!capture) return run1(null);
    return viaProxy(stand, capture, run1);
  };

  // Подготовительный шаг: трафик не сохраняется (каталог во work), отказ платформы — ошибка стенда.
  stand.setup = async (name, base, user, command) => {
    const result = await stand.designer(base, user, command, { dir: path.join(work, 'setup', name) });
    stand.log(`  ${name}: код ${String(result.status)}`);
    if (result.status !== 0) throw new Error(`${name}: ${result.output}`);
    return result;
  };
  // Сценарий: трафик команды → кадры в outRoot/<name>/, итог — result.json и запись в results.
  stand.record = async (outRoot, results, name, base, user, command, transport = 'tcp') => {
    const dir = path.join(outRoot, name);
    rmSync(dir, { recursive: true, force: true });
    const result = await stand.designer(base, user, command, { dir, transport });
    const frames = extractFrames(dir, work, transport);
    const output = scrub(result.output, work);
    results[name] = { status: result.status, output: output.split('\n').slice(-3).map((l) => l.trim()).join(' | '), frames };
    writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify({ command: command[0], user: user.name, status: result.status, output }, null, 2)}\n`);
    stand.log(`${name}: код ${String(result.status)}, кадров ${String(frames)}; ${results[name].output}`);
    return result;
  };
  // Сырой сценарий: потоки conn-NN.{c2s,s2c}.bin остаются как есть (без нарезки и правок байт),
  // рядом conn-NN.order.json; итог — result.json и запись в results.
  stand.recordRaw = async (outRoot, results, name, base, user, command) => {
    const dir = path.join(outRoot, name);
    rmSync(dir, { recursive: true, force: true });
    const result = await stand.designer(base, user, command, { dir, transport: 'tcp', raw: true });
    assertRawClean(dir, work);
    const connections = readdirSync(dir).filter((f) => f.endsWith('.c2s.bin')).length;
    const output = scrub(result.output, work);
    results[name] = { status: result.status, output: output.split('\n').slice(-3).map((l) => l.trim()).join(' | '), connections };
    writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify({ command: command[0], user: user.name, status: result.status, output }, null, 2)}\n`);
    stand.log(`${name}: код ${String(result.status)}, соединений ${String(connections)}; ${results[name].output}`);
    return result;
  };
  // Проба crserver по tcp: запрос собран стендом, ответ — настоящий. Стенд ждёт приветствие сервера
  // и шлёт hello (если задано) вместе с первым кадром, как Конфигуратор; остальные кадры — по одному:
  // следующий уходит, когда сервер замолчал на closeAfterMs. После последнего кадра стенд ждёт столько же
  // и закрывает сокет сам, если сервер не закрыл раньше. Итог: request.bin, response.bin, order.json
  // (с событиями end) и result.json; имя машины или путь work в потоках — отказ, как у recordRaw.
  stand.tcpProbe = (outDir, { hello = null, frames = [], closeAfterMs = 1000, deadlineMs = 30_000 }) => new Promise((resolve, reject) => {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const sent = [];
    const received = [];
    const events = [];
    let serverEnded = false;
    let quietTimer = null;
    let greeted = false;
    const pending = [...(hello ? [hello] : []), ...frames];
    let settled = false;
    const socket = net.connect(stand.crs.port, '127.0.0.1');
    const deadline = setTimeout(() => finish(new Error(`проба ${path.basename(outDir)} не завершилась за ${String(deadlineMs)} мс`)), deadlineMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(quietTimer);
      socket.destroy();
      writeFileSync(path.join(outDir, 'request.bin'), Buffer.concat(sent));
      writeFileSync(path.join(outDir, 'response.bin'), Buffer.concat(received));
      writeFileSync(path.join(outDir, 'order.json'), orderJson(events));
      const summary = { requestBytes: Buffer.concat(sent).length, responseBytes: Buffer.concat(received).length, serverClosed: serverEnded };
      writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
      try {
        if (error) throw error;
        assertRawClean(outDir, work);
        resolve(summary);
      } catch (failure) {
        reject(failure);
      }
    };
    // Пауза сервера — сигнал слать следующую часть; по концу очереди стенд закрывает сокет сам.
    const armQuiet = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => sendNext(), closeAfterMs);
    };
    const sendNext = () => {
      if (serverEnded || pending.length === 0) { finish(); return; }
      // Приветствие и первый кадр — двумя записями подряд, без ожидания ответа на приветствие: так делает
      // Конфигуратор (conn-NN.order.json сценария wrong-password).
      for (const chunk of hello && sent.length === 0 ? pending.splice(0, 2) : pending.splice(0, 1)) {
        sent.push(chunk);
        // Свои записи стенд не сливает: они детерминированы, а пауза между ними — суть пробы.
        events.push({ dir: 'c2s', bytes: chunk.length });
        socket.write(chunk);
      }
      armQuiet();
    };
    socket.on('data', (b) => {
      received.push(b);
      pushEvent(events, { dir: 's2c', bytes: b.length });
      if (!greeted) { greeted = true; sendNext(); return; }
      armQuiet();
    });
    socket.on('end', () => { serverEnded = true; events.push({ dir: 's2c', end: true }); finish(); });
    socket.on('error', (error) => finish(error));
  });
  // Проба crserver на уровне тел (issue #14): свежее соединение, приветствие клиента и один кадр с телом
  // body, ответ читается по Content-Length. Сырые байты не сохраняются: в ответах devObjectsStatistic и
  // bind есть имя машины (bindString), а в теле его можно заменить без потери смысла (scrub), в потоке —
  // нет (сломался бы Content-Length). Итог: request.xml, response.xml и result.json в outDir.
  stand.tcpBodyProbe = (outDir, { hello, head, body, deadlineMs = 30_000 }) => new Promise((resolve, reject) => {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const frame = Buffer.concat([Buffer.from(head.replace(/Content-Length: \d+/, `Content-Length: ${String(body.length)}`), 'latin1'), body, TCP_TERMINATOR]);
    const received = [];
    let greeted = false;
    let settled = false;
    const socket = net.connect(stand.crs.port, '127.0.0.1');
    const deadline = setTimeout(() => finish(new Error(`проба ${path.basename(outDir)} не получила ответ за ${String(deadlineMs)} мс`)), deadlineMs);
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) { reject(error); return; }
      const text = response.toString('utf-8');
      const method = /<crs:call [^>]*name="([^"]+)"/.exec(body.toString('utf-8'))?.[1];
      const kind = /<crs:(call_return|call_exception)/.exec(text)?.[1] ?? (text.replace(/^\uFEFF/, '') === '' ? 'empty' : 'other');
      writeFileSync(path.join(outDir, 'request.xml'), scrub(body.toString('utf-8'), work));
      writeFileSync(path.join(outDir, 'response.xml'), scrub(text, work));
      const summary = { method, response: kind };
      writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
      resolve(summary);
    };
    socket.on('data', (b) => {
      received.push(b);
      const data = Buffer.concat(received);
      if (!greeted) {
        if (data.length < TCP_GREETING_LENGTH) return;
        greeted = true;
        received.splice(0, received.length, data.subarray(TCP_GREETING_LENGTH));
        // Приветствие и кадр — одной записью подряд, как у Конфигуратора (tcp-raw/wrong-password).
        socket.write(Buffer.concat([hello, frame]));
        return;
      }
      const headerEnd = data.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(data.subarray(0, headerEnd).toString('latin1'))?.[1] ?? NaN);
      if (Number.isNaN(length)) { finish(new Error(`${path.basename(outDir)}: в ответе нет Content-Length`)); return; }
      if (data.length >= headerEnd + 4 + length) finish(null, data.subarray(headerEnd + 4, headerEnd + 4 + length));
    });
    socket.on('end', () => finish(new Error(`${path.basename(outDir)}: сервер закрыл соединение до конца ответа`)));
    socket.on('error', (error) => finish(error));
  });
  // Хранилище из тестовой конфигурации, пользователи с правами и привязанная база на каждого.
  stand.prepareRepository = async (source, users) => {
    const admin = { name: 'Admin', password: '' };
    const baseA = await stand.createBase('A');
    await stand.importConfig(baseA, source);
    await stand.startCrserver();
    await stand.setup('create', baseA, admin, ['/ConfigurationRepositoryCreate', '-AllowConfigurationChanges',
      '-ChangesAllowedRule', 'ObjectIsEditableSupportEnabled', '-ChangesNotRecommendedRule', 'ObjectIsEditableSupportEnabled']);
    for (const { user, rights } of users) {
      await stand.setup(`adduser-${user.name}`, baseA, admin, ['/ConfigurationRepositoryAddUser', '-User', user.name, '-Pwd', user.password, '-Rights', rights]);
    }
    const bases = {};
    for (const { user } of users) {
      bases[user.name] = await stand.createBase(user.name);
      await stand.setup(`bind-${user.name}`, bases[user.name], user, ['/ConfigurationRepositoryBindCfg', '-forceBindAlreadyBindedUser', '-forceReplaceCfg']);
    }
    return { baseA, bases };
  };
  // Файл списка объектов для /ConfigurationRepositoryLock|Unlock|Commit -Objects.
  stand.objectList = (...names) => {
    const file = path.join(work, `objects-${names.join('-')}.xml`);
    writeFileSync(file, '<?xml version="1.0" encoding="UTF-8"?>\n<Objects xmlns="http://v8.1c.ru/8.3/config/objects" version="1.0">\n'
      + names.map((n) => `  <Object fullName="${n}" includeChildObjects="false"/>\n`).join('') + '</Objects>\n');
    return file;
  };
  return stand;
}

async function viaProxy(stand, capture, action) {
  mkdirSync(capture.dir, { recursive: true });
  let n = 0;
  const proxy = net.createServer((client) => {
    const id = String(++n).padStart(2, '0');
    const c2s = path.join(capture.dir, `conn-${id}.c2s.bin`);
    const s2c = path.join(capture.dir, `conn-${id}.s2c.bin`);
    writeFileSync(c2s, Buffer.alloc(0));
    writeFileSync(s2c, Buffer.alloc(0));
    // Порядок событий нужен только сырому режиму: по нему видно, кто говорит первым и кто закрывает.
    const order = capture.raw ? path.join(capture.dir, `conn-${id}.order.json`) : null;
    const events = [];
    const note = (event) => { if (order) { pushEvent(events, event); writeFileSync(order, orderJson(events)); } };
    const server = net.connect(capture.transport === 'http' ? stand.apache.port : stand.crs.port, '127.0.0.1');
    client.on('data', (b) => { appendFileSync(c2s, b); note({ dir: 'c2s', bytes: b.length }); server.write(b); });
    server.on('data', (b) => { appendFileSync(s2c, b); note({ dir: 's2c', bytes: b.length }); client.write(b); });
    // end — полузакрытие (FIN) стороной; для сырого режима это факт протокола, а не шум.
    client.on('end', () => note({ dir: 'c2s', end: true }));
    server.on('end', () => note({ dir: 's2c', end: true }));
    client.on('close', () => server.destroy());
    server.on('close', () => client.destroy());
    client.on('error', () => server.destroy());
    server.on('error', () => client.destroy());
  });
  const port = await new Promise((r) => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
  try {
    // Для http Конфигуратор ходит на прокси, тот — на apache; путь до .1ccr — как в настройках публикации.
    const address = capture.transport === 'http' ? `http://127.0.0.1:${String(port)}/repo/repo.1ccr/${ALIAS}` : `tcp://127.0.0.1:${String(port)}/${ALIAS}`;
    return await action(address);
  } finally {
    proxy.close();
  }
}

// Потоки conn-NN.{c2s,s2c}.bin → кадры (тела XML) NN-conn-NN-<c2s|s2c>-<метод>.xml.
// Имя машины и рабочий каталог стенда заменяются: в снятых кадрах их быть не должно.
export function extractFrames(dir, work, transport = 'tcp') {
  if (transport === 'http') return extractHttpFrames(dir, work);
  let index = 0;
  const files = readdirSync(dir).filter((f) => f.endsWith('.bin')).sort();
  for (const file of files) {
    const direction = file.includes('c2s') ? 'c2s' : 's2c';
    const conn = file.split('.')[0];
    const data = readFileSync(path.join(dir, file));
    let pos = 0;
    for (;;) {
      const start = data.indexOf(direction === 'c2s' ? 'POST  HTTP/1.1' : 'HTTP/1.1 ', pos);
      if (start < 0) break;
      const headerEnd = data.indexOf('\r\n\r\n', start);
      if (headerEnd < 0) break;
      const header = data.subarray(start, headerEnd).toString('latin1');
      const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1] ?? 0);
      // Обрыв потока посреди тела: усечённый кадр выглядел бы настоящим, поэтому стенд падает.
      if (headerEnd + 4 + length > data.length) {
        throw new Error(`${file}: тело кадра короче Content-Length (${String(length)}), поток оборван`);
      }
      const body = data.subarray(headerEnd + 4, headerEnd + 4 + length);
      pos = headerEnd + 4 + length;
      const text = body.toString('utf-8');
      const method = /<crs:call [^>]*name="([^"]+)"/.exec(text)?.[1] ?? /<crs:(call_return|call_exception)/.exec(text)?.[1] ?? 'binary';
      index += 1;
      const clean = scrub(text, work);
      writeFileSync(path.join(dir, `${String(index).padStart(2, '0')}-${conn}-${direction}-${method}.xml`), clean);
    }
    rmSync(path.join(dir, file));
  }
  return index;
}

// http: потоки — сырой HTTP/1.1 (keep-alive, возможен chunked). Тело кадра — XML; заголовки
// сообщения (без тела) сохраняются рядом: NN-conn-NN-<c2s|s2c>-<метод>.headers.txt.
function extractHttpFrames(dir, work) {
  let index = 0;
  const files = readdirSync(dir).filter((f) => f.endsWith('.bin')).sort();
  for (const file of files) {
    const direction = file.includes('c2s') ? 'c2s' : 's2c';
    const conn = file.split('.')[0];
    const data = readFileSync(path.join(dir, file));
    let pos = 0;
    while (pos < data.length) {
      const headerEnd = data.indexOf('\r\n\r\n', pos);
      if (headerEnd < 0) throw new Error(`${file}: заголовок HTTP не завершён, поток оборван`);
      const head = data.subarray(pos, headerEnd).toString('latin1');
      let cursor = headerEnd + 4;
      let body;
      const length = /^Content-Length:\s*(\d+)/im.exec(head)?.[1];
      if (/^Transfer-Encoding:\s*chunked/im.test(head)) {
        const parts = [];
        for (;;) {
          const lineEnd = data.indexOf('\r\n', cursor);
          if (lineEnd < 0) throw new Error(`${file}: chunked-поток оборван`);
          const size = Number.parseInt(data.subarray(cursor, lineEnd).toString('latin1'), 16);
          if (Number.isNaN(size)) throw new Error(`${file}: некорректный размер chunk`);
          cursor = lineEnd + 2;
          if (size === 0) {
            // Трейлеров стенд не ждёт: после последнего chunk обязан идти пустой CRLF.
            if (data.subarray(cursor, cursor + 2).toString('latin1') !== '\r\n') throw new Error(`${file}: chunked-поток завершён неверно`);
            cursor += 2;
            break;
          }
          if (cursor + size > data.length) throw new Error(`${file}: chunked-поток оборван`);
          parts.push(data.subarray(cursor, cursor + size));
          cursor += size + 2;
        }
        body = Buffer.concat(parts);
      } else {
        const n = Number(length ?? 0);
        if (cursor + n > data.length) throw new Error(`${file}: тело короче Content-Length (${String(n)}), поток оборван`);
        body = data.subarray(cursor, cursor + n);
        cursor += n;
      }
      pos = cursor;
      const text = body.toString('utf-8');
      const method = /<crs:call [^>]*name="([^"]+)"/.exec(text)?.[1] ?? /<crs:(call_return|call_exception)/.exec(text)?.[1] ?? 'empty';
      index += 1;
      const base = `${String(index).padStart(2, '0')}-${conn}-${direction}-${method}`;
      writeFileSync(path.join(dir, `${base}.xml`), scrub(text, work));
      writeFileSync(path.join(dir, `${base}.headers.txt`), scrub(`${head}\r\n`, work));
    }
    rmSync(path.join(dir, file));
  }
  return index;
}

// Подряд идущие data одного направления сливаются: дробление потока на куски — случайность tcp
// (одна и та же пара «приветствие + кадр» приходит то двумя кусками, то одним), а order.json должен
// пересобираться одинаково.
function pushEvent(events, event) {
  const last = events.at(-1);
  if (event.bytes !== undefined && last?.dir === event.dir && last.bytes !== undefined) last.bytes += event.bytes;
  else events.push(event);
}

// Одно событие на строку: диффы order.json между пересборками читаются построчно.
function orderJson(events) {
  return `[\n${events.map((e) => `  ${JSON.stringify(e)}`).join(',\n')}\n]\n`;
}

// Сырые потоки не правятся: замена имени машины или пути сломала бы Content-Length кадра,
// поэтому их появление — отказ стенда, а не повод для scrub.
export function assertRawClean(dir, work) {
  const secrets = [os.hostname(), work].map((s) => Buffer.from(s, 'utf-8'));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.bin'))) {
    const data = readFileSync(path.join(dir, file));
    for (const secret of secrets) {
      if (data.includes(secret)) throw new Error(`${file}: в сыром потоке есть «${secret.toString('utf-8')}» — такой сценарий в сырые фикстуры не годится`);
    }
  }
}

export function scrub(text, work) {
  return text.split(os.hostname()).join('crs-stand').split(work).join('/tmp/crs-stand/work');
}

// Кадры c2s снятого соединения: заголовок и тело по Content-Length, после тела — терминатор.
function requestFrames(stream) {
  const frames = [];
  let pos = TCP_HELLO_LENGTH;
  while (pos < stream.length) {
    const headerEnd = stream.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) throw new Error('поток c2s: заголовок кадра не завершён');
    const head = stream.subarray(pos, headerEnd + 4).toString('latin1');
    const length = Number(/Content-Length: (\d+)/.exec(head)?.[1]);
    const body = stream.subarray(headerEnd + 4, headerEnd + 4 + length);
    if (body.length !== length) throw new Error('поток c2s: тело короче Content-Length');
    if (!stream.subarray(headerEnd + 4 + length, headerEnd + 8 + length).equals(TCP_TERMINATOR)) throw new Error('поток c2s: нет терминатора');
    frames.push({ head, body: body.toString('utf-8') });
    pos = headerEnd + 8 + length;
  }
  return frames;
}

// Кадры соединения подготовительного шага stand.setup, где встретился метод, и приветствие клиента в нём —
// основа проб stand.tcpBodyProbe (issue #14).
export function setupConnection(work, step, method) {
  const setupDir = path.join(work, 'setup', step);
  const connection = readdirSync(setupDir).filter((f) => f.endsWith('.c2s.bin')).sort()
    .map((f) => readFileSync(path.join(setupDir, f)))
    .find((s) => s.includes(`name="${method}"`));
  if (connection === undefined) throw new Error(`в потоках ${step} нет соединения с ${method}`);
  return { hello: connection.subarray(0, TCP_HELLO_LENGTH), frames: requestFrames(connection) };
}

// Первый кадр метода среди кадров соединения.
export function frameOf(frames, method) {
  const frame = frames.find((f) => f.body.includes(`name="${method}"`));
  if (frame === undefined) throw new Error(`в соединении нет ${method}`);
  return frame;
}

// Подстановка в снятое тело: образец обязан встретиться ровно один раз, иначе проба незаметно стала бы
// копией исходного запроса.
export function substitute(source, ...pairs) {
  let text = source;
  for (const [from, to] of pairs) {
    const count = text.split(from).length - 1;
    if (count !== 1) throw new Error(`«${from}» встречается ${String(count)} раз, ожидался один`);
    text = text.replace(from, to);
  }
  return Buffer.from(text, 'utf-8');
}

async function ibcmd(work, base, ...command) {
  const modeLength = command[1] === 'config' ? 3 : 2;
  await run(work, path.join(platformDir, 'ibcmd'),
    [...command.slice(0, modeLength), `--data=${base.data}`, `--db-path=${base.db}`, ...command.slice(modeLength)]);
}

function canConnect(port) {
  return new Promise((r) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
}

const PROCESS_DEADLINE_MS = 10 * 60 * 1000;

// Группы запущенных run(): detached отрывает их от терминала, поэтому Ctrl+C и падение стенда
// до них не доходят — убиваем сами.
const activeGroups = new Set();

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error; // группа уже завершилась
  }
}

// Долгоживущие дочерние процессы стенда (crserver), которые не идут через run().
const liveChildren = new Set();

process.on('exit', () => {
  for (const pid of activeGroups) killGroup(pid);
  // В обработчике exit доступны только синхронные вызовы: SIGKILL без ожидания.
  for (const child of liveChildren) child.kill('SIGKILL');
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  // 128 + номер сигнала — соглашение оболочек: вызывающий отличает прерывание (130, 143, 129) от сбоя.
  process.once(signal, () => process.exit(128 + os.constants.signals[signal]));
}

export function run(cwd, exe, argv, allowFailure = false) {
  return new Promise((resolve, reject) => {
    // detached — своя группа процессов: под xvfb-run убить надо всё дерево, а не только обёртку.
    const child = spawn(exe, argv, { stdio: ['ignore', 'pipe', 'pipe'], cwd, detached: true });
    // Модальный диалог под xvfb-run иначе завесил бы стенд навсегда.
    if (child.pid !== undefined) activeGroups.add(child.pid);
    const timer = setTimeout(() => killGroup(child.pid), PROCESS_DEADLINE_MS);
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => {
      clearTimeout(timer);
      activeGroups.delete(child.pid);
      const output = Buffer.concat(chunks).toString('utf-8').trim();
      if (!allowFailure && status !== 0) { reject(new Error(`${exe} ${argv.join(' ')}\n${output}`)); return; }
      resolve({ status, output });
    });
  });
}
