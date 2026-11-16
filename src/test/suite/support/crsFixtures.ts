// Доступ тестов к снятому трафику crserver в example/crs (корпус перенесён без изменений байтов). Разбор
// здесь — собственный, независимый от production-кода: он служит оракулом для тестов кадрирования.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Из out/test/suite/support к корню репозитория.
export const ROOT = path.resolve(__dirname, '../../../../');
export const CRS_851 = path.join(ROOT, 'example', 'crs', '8.5.1');

export function readFixture(...parts: string[]): Buffer {
  return fs.readFileSync(path.join(CRS_851, ...parts));
}

const CRLFCRLF = Buffer.from('\r\n\r\n', 'latin1');
const TERMINATOR = Buffer.from('6653b2a6', 'hex');
const HELLO_LENGTH = 20;
const GREETING_LENGTH = 5;

/** Соединение Конфигуратора из tcp-raw: что клиент отправил и что получил, побайтно. */
export interface RawConnection {
  name: string;
  c2s: Buffer;
  s2c: Buffer;
}

/** Все соединения сценариев Конфигуратора tcp-raw (wrong-password и wrong-password-rerun). */
export function rawConfiguratorConnections(): RawConnection[] {
  const result: RawConnection[] = [];
  for (const scenario of ['wrong-password', 'wrong-password-rerun']) {
    const dir = path.join(CRS_851, 'tcp-raw', scenario);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.c2s.bin')).sort()) {
      const conn = file.slice(0, -'.c2s.bin'.length);
      result.push({
        name: `${scenario}/${conn}`,
        c2s: fs.readFileSync(path.join(dir, file)),
        s2c: fs.readFileSync(path.join(dir, `${conn}.s2c.bin`)),
      });
    }
  }
  assert.strictEqual(result.length, 8, 'в tcp-raw ожидается восемь соединений Конфигуратора');
  return result;
}

/** UUID клиента из снятого приветствия: GUID Microsoft, первые три поля little-endian. */
export function clientIdFromHello(stream: Buffer): string {
  assert.deepStrictEqual(stream.subarray(0, 4), Buffer.from('224855b5', 'hex'), 'нет сигнатуры приветствия клиента');
  const g = stream.subarray(4, HELLO_LENGTH);
  const hex = (b: Buffer): string => b.toString('hex');
  const le = (b: Buffer): string => hex(Buffer.from(b).reverse());
  return [le(g.subarray(0, 4)), le(g.subarray(4, 6)), le(g.subarray(6, 8)), hex(g.subarray(8, 10)), hex(g.subarray(10, 16))].join('-');
}

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Разобранное HTTP-подобное сообщение: заголовки, тело по Content-Length и то, что после него. */
export interface SplitMessage {
  head: string;
  headLength: number;
  contentLength: number;
  body: Buffer;
  rest: Buffer;
}

/** Делит сообщение (кадр запроса или ответа без приветствий) по Content-Length. */
export function splitMessage(message: Buffer): SplitMessage {
  const end = message.indexOf(CRLFCRLF);
  assert.ok(end > 0, 'нет конца заголовков');
  const headLength = end + CRLFCRLF.length;
  const head = message.subarray(0, headLength).toString('latin1');
  const match = /\r\nContent-Length: (\d+)\r\n/.exec(head);
  assert.ok(match, 'нет Content-Length');
  const contentLength = Number(match[1]);
  const body = message.subarray(headLength, headLength + contentLength);
  assert.strictEqual(body.length, contentLength, 'тело короче Content-Length');
  return { head, headLength, contentLength, body, rest: message.subarray(headLength + contentLength) };
}

/** Кадр tcp (запрос после приветствия клиента или ответ после приветствия сервера) с проверкой терминатора. */
export function splitTcpFrame(frame: Buffer): SplitMessage {
  const split = splitMessage(frame);
  assert.deepStrictEqual(split.rest, TERMINATOR, 'после тела ожидается ровно терминатор');
  return split;
}

/** Тело запроса Конфигуратора из снятого c2s (после приветствия клиента). */
export function requestBodyOf(c2s: Buffer): Buffer {
  return splitTcpFrame(c2s.subarray(HELLO_LENGTH)).body;
}

/** Кадр ответа из снятого s2c (после приветствия сервера). */
export function responseFrameOf(s2c: Buffer): Buffer {
  assert.deepStrictEqual(s2c.subarray(0, GREETING_LENGTH), Buffer.from('53f5c61a7b', 'hex'), 'нет приветствия сервера');
  return s2c.subarray(GREETING_LENGTH);
}

/** Проба tcp-raw: запрос стенда и настоящий ответ crserver. */
export function tcpProbe(name: string): { request: Buffer; response: Buffer } {
  return { request: readFixture('tcp-raw', name, 'request.bin'), response: readFixture('tcp-raw', name, 'response.bin') };
}

/**
 * Настоящий http-ответ публикации: заголовки как снял стенд + пустая строка + тело.
 * Content-Length (если есть) сверяется с длиной тела — иначе сборка исказила бы сообщение.
 */
export function httpProbeResponse(name: string): Buffer {
  const headers = readFixture('http', name, 'response.headers.txt');
  const body = readFixture('http', name, 'response.xml');
  assert.ok(headers.toString('latin1').endsWith('\r\n'), 'заголовки должны кончаться CRLF');
  const length = /\r\nContent-Length: (\d+)\r\n/.exec(headers.toString('latin1'));
  if (length) {
    assert.strictEqual(Number(length[1]), body.length, 'Content-Length не совпадает с телом');
  }
  return Buffer.concat([headers, Buffer.from('\r\n', 'latin1'), body]);
}

/** Тело crs из снятого трафика tcp/ или http/: запрос Конфигуратора или ответ crserver. */
export interface CorpusFrame {
  transport: 'tcp' | 'http';
  scenario: string;
  file: string;
  direction: 'c2s' | 's2c';
  body: Buffer;
}

const CORPUS_FILE = /^\d+-conn-\d+-(c2s|s2c)-[A-Za-z_]+\.xml$/;
// Сверка с числом снятых файлов: пересъёмка, потерявшая сценарий, не должна молча сузить корпус.
const CORPUS_SIZE = { tcp: 290, http: 276 } as const;

/** Все тела сценариев tcp/ и http/ (без проб — у них другая раскладка файлов). */
export function crsCorpus(): CorpusFrame[] {
  const result: CorpusFrame[] = [];
  for (const transport of ['tcp', 'http'] as const) {
    const dir = path.join(CRS_851, transport);
    let count = 0;
    for (const scenario of fs.readdirSync(dir).sort()) {
      if (!fs.statSync(path.join(dir, scenario)).isDirectory()) {
        continue;
      }
      for (const file of fs.readdirSync(path.join(dir, scenario)).sort()) {
        const match = CORPUS_FILE.exec(file);
        if (match) {
          count += 1;
          result.push({
            transport,
            scenario,
            file,
            direction: match[1] as 'c2s' | 's2c',
            body: fs.readFileSync(path.join(dir, scenario, file)),
          });
        }
      }
    }
    assert.strictEqual(count, CORPUS_SIZE[transport], `число тел в example/crs/8.5.1/${transport}`);
  }
  return result;
}

/** Пара запрос↔ответ одного вызова из корпуса tcp/ или http/. */
export interface CorpusExchange {
  transport: 'tcp' | 'http';
  scenario: string;
  conn: string;
  method: string;
  request: Buffer;
  response: Buffer;
}

const CORPUS_NAME = /^\d+-(conn-\d+)-(c2s|s2c)-([A-Za-z_]+)\.xml$/;

function corpusName(file: string): RegExpExecArray {
  const match = CORPUS_NAME.exec(file);
  assert.ok(match, file);
  return match;
}

/**
 * Пары по соединению: стенд нумерует кадры соединения подряд — сначала все запросы, затем все ответы,
 * а crserver отвечает по порядку, поэтому i-й ответ соединения — на i-й запрос.
 */
export function corpusExchanges(): CorpusExchange[] {
  const result: CorpusExchange[] = [];
  const connections = new Map<string, { frames: CorpusFrame[]; conn: string }>();
  for (const frame of crsCorpus()) {
    const conn = corpusName(frame.file)[1];
    const key = `${frame.transport}/${frame.scenario}/${conn}`;
    const entry = connections.get(key) ?? { frames: [], conn };
    entry.frames.push(frame);
    connections.set(key, entry);
  }
  for (const [key, { frames, conn }] of connections) {
    const requests = frames.filter((f) => f.direction === 'c2s');
    const responses = frames.filter((f) => f.direction === 's2c');
    assert.strictEqual(requests.length, responses.length, `${key}: число запросов и ответов`);
    requests.forEach((request, i) => {
      result.push({
        transport: request.transport,
        scenario: request.scenario,
        conn,
        method: corpusName(request.file)[3],
        request: request.body,
        response: responses[i].body,
      });
    });
  }
  // Половина корпуса: 290 тел tcp и 276 тел http.
  assert.strictEqual(result.length, 283);
  return result;
}

/**
 * Проба уровня тел в tcp/ или http/ (capture-read-probes.mjs): тело запроса стенда и настоящий ответ
 * crserver. Для http — тела без заголовков публикации.
 */
export function bodyProbe(transport: 'tcp' | 'http', name: string): { request: Buffer; response: Buffer } {
  return { request: readFixture(transport, name, 'request.xml'), response: readFixture(transport, name, 'response.xml') };
}

/** Проба уровня тел в tcp/. */
export function tcpBodyProbe(name: string): { request: Buffer; response: Buffer } {
  return bodyProbe('tcp', name);
}

/** Пробы уровня тел в tcp/ и итог ответа. */
export const TCP_BODY_PROBES: Readonly<Record<string, 'return' | 'exception'>> = {
  'probe-statistic-own-bind': 'return',
  'probe-statistic-no-bind': 'return',
  'probe-statistic-random-bind': 'return',
  'probe-statistic-reader-no-bind': 'return',
  'probe-statistic-wrong-password': 'exception',
  'probe-history-no-bind': 'return',
  'probe-history-random-bind': 'return',
  'probe-history-reader-no-bind': 'return',
  'probe-history-wrong-password': 'exception',
  'probe-depot-users-no-bind': 'return',
  'probe-depot-users-reader-no-bind': 'return',
  'probe-bind-unknown-existing': 'exception',
  'probe-bind-new': 'exception',
  'probe-statistic-after-bind-new': 'return',
};

/** Проба tcp-raw: тело запроса стенда и разобранный кадр настоящего ответа crserver. */
export function tcpRawProbeBodies(name: string): { request: Buffer; response: SplitMessage } {
  const { request, response } = tcpProbe(name);
  return { request: requestBodyOf(request), response: splitTcpFrame(responseFrameOf(response)) };
}

/** Снятый ответ crserver, в котором лежит исключение: тело целиком. */
export interface ExceptionBody {
  name: string;
  body: Buffer;
}

/** Все снятые тела call_exception: корпус tcp/http, пробы http и tcp-raw, сценарии Конфигуратора tcp-raw. */
export function callExceptionBodies(): ExceptionBody[] {
  const result: ExceptionBody[] = crsCorpus()
    .filter((f) => f.file.endsWith('-s2c-call_exception.xml'))
    .map((f) => ({ name: `${f.transport}/${f.scenario}/${f.file}`, body: f.body }));
  result.push({ name: 'http/probe-wrong-alias', body: readFixture('http', 'probe-wrong-alias', 'response.xml') });
  for (const probe of ['probe-version-zero', 'probe-version-zero-wrong-alias', 'probe-version-other', 'probe-wrong-alias']) {
    result.push({ name: `tcp-raw/${probe}`, body: tcpRawProbeBodies(probe).response.body });
  }
  for (const conn of rawConfiguratorConnections()) {
    const body = splitTcpFrame(responseFrameOf(conn.s2c)).body;
    if (body.includes('call_exception')) {
      result.push({ name: `tcp-raw/${conn.name}`, body });
    }
  }
  for (const [probe, kind] of Object.entries(TCP_BODY_PROBES)) {
    if (kind === 'exception') {
      result.push({ name: `tcp/${probe}`, body: tcpBodyProbe(probe).response });
    }
  }
  // 8 в корпусе, 1 проба http, 4 пробы tcp-raw, 4 соединения Конфигуратора tcp-raw, 4 пробы тел tcp.
  assert.strictEqual(result.length, 21, result.map((r) => r.name).join(', '));
  return result;
}

/** Тела исключений VRS разбора XML (статус 400) по tcp и по http. */
export function xmlParseExceptionBodies(): ExceptionBody[] {
  return [
    { name: 'http/probe-malformed-body', body: readFixture('http', 'probe-malformed-body', 'response.xml') },
    { name: 'tcp-raw/probe-malformed-body', body: tcpRawProbeBodies('probe-malformed-body').response.body },
  ];
}

/** clsid и base64 из тела call_exception или d1p1:data исключения VRS — собственным разбором, как оракул. */
export function exceptionPayload(body: Buffer): { clsid: string; base64: string } {
  const text = body.toString('utf-8');
  const call = /<crs:call_exception [^>]*clsid="([^"]+)">([^<]*)</.exec(text);
  if (call) {
    return { clsid: call[1], base64: call[2] };
  }
  const clsid = / clsid="([^"]+)"/.exec(text);
  const data = /<d1p1:data>([^<]*)</.exec(text);
  assert.ok(clsid && data, 'в теле нет ни call_exception, ни d1p1:data');
  return { clsid: clsid[1], base64: data[1] };
}

/** Раскодированный скобочный текст исключения из файла фикстур. */
export function decodedBracketText(...parts: string[]): string {
  return Buffer.from(exceptionPayload(readFixture(...parts)).base64, 'base64').toString('utf-8');
}

/** Скобочные тексты всех снятых исключений (call_exception и данные исключения разбора XML). */
export function callExceptionTexts(): { name: string; text: string }[] {
  return [...callExceptionBodies(), ...xmlParseExceptionBodies()].map(({ name, body }) => ({
    name,
    text: Buffer.from(exceptionPayload(body).base64, 'base64').toString('utf-8'),
  }));
}

/** Сырая проба http-raw: запрос стенда и ответ apache/wsap24 побайтно, как на проводе. */
export function httpRawProbe(name: string): { request: Buffer; response: Buffer } {
  return { request: readFixture('http-raw', name, 'request.bin'), response: readFixture('http-raw', name, 'response.bin') };
}

/** Проба http-raw: тело запроса стенда и разобранный по Content-Length ответ (не chunked). */
export function httpRawProbeBodies(name: string): { request: Buffer; response: SplitMessage } {
  const { request, response } = httpRawProbe(name);
  const split = splitMessage(request);
  assert.strictEqual(split.rest.length, 0, 'после тела запроса ничего нет');
  const answer = splitMessage(response);
  assert.strictEqual(answer.rest.length, 0, 'после тела ответа ничего нет');
  return { request: split.body, response: answer };
}

/**
 * Ожидаемые байты запроса транспорта http: заголовки снятой пробы http/probe-valid (порядок, регистр),
 * в которых заменены путь, порт в Host и Content-Length, затем пустая строка и тело.
 */
export function expectedHttpRequest(port: number, body: Buffer, requestPath = '/repo/repo.1ccr'): Buffer {
  const head = readFixture('http', 'probe-valid', 'request.headers.txt').toString('latin1');
  assert.match(head, /^POST \/repo\/repo\.1ccr HTTP\/1\.1\r\nHost: 127\.0\.0\.1:\d+\r\n[^]*\r\nContent-Length: \d+\r\n[^]*\r\n$/);
  const replaced = head
    .replace(/^POST \S+ /, `POST ${requestPath} `)
    .replace(/\r\nHost: 127\.0\.0\.1:\d+\r\n/, `\r\nHost: 127.0.0.1:${String(port)}\r\n`)
    .replace(/\r\nContent-Length: \d+\r\n/, `\r\nContent-Length: ${String(body.length)}\r\n`);
  return Buffer.concat([Buffer.from(`${replaced}\r\n`, 'latin1'), body]);
}

// Обмены http/, в которых Content-Length ответа совпал с телом: в остальных scrub заменил имя машины
// в теле, и собранное сообщение было бы искажено.
const HTTP_CORPUS_MESSAGES = 98;

/** Снятые обмены Конфигуратора по http: запрос и ответ — заголовки.txt + пустая строка + тело .xml. */
export function httpCorpusMessages(): { name: string; request: Buffer; response: Buffer }[] {
  const dir = path.join(CRS_851, 'http');
  const message = (scenario: string, file: string): Buffer | undefined => {
    const headers = fs.readFileSync(path.join(dir, scenario, file.replace(/\.xml$/, '.headers.txt')));
    const body = fs.readFileSync(path.join(dir, scenario, file));
    const length = /\r\nContent-Length: (\d+)\r\n/.exec(headers.toString('latin1'));
    assert.ok(length, `${scenario}/${file}: нет Content-Length`);
    return Number(length[1]) === body.length ? Buffer.concat([headers, Buffer.from('\r\n', 'latin1'), body]) : undefined;
  };
  const result: { name: string; request: Buffer; response: Buffer }[] = [];
  for (const scenario of fs.readdirSync(dir).sort()) {
    if (!fs.statSync(path.join(dir, scenario)).isDirectory() || scenario.startsWith('probe-')) {
      continue;
    }
    const byConn = new Map<string, { c2s: string[]; s2c: string[] }>();
    for (const file of fs.readdirSync(path.join(dir, scenario)).sort()) {
      const match = CORPUS_NAME.exec(file);
      if (match) {
        const entry = byConn.get(match[1]) ?? { c2s: [], s2c: [] };
        entry[match[2] as 'c2s' | 's2c'].push(file);
        byConn.set(match[1], entry);
      }
    }
    for (const [conn, { c2s, s2c }] of byConn) {
      c2s.forEach((file, i) => {
        const request = message(scenario, file);
        const response = message(scenario, s2c[i]);
        if (request && response) {
          result.push({ name: `${scenario}/${conn}/${file}`, request, response });
        }
      });
    }
  }
  assert.strictEqual(result.length, HTTP_CORPUS_MESSAGES, 'число обменов http/ с верным Content-Length');
  return result;
}
