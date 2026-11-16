import * as assert from 'assert';
import type { CrsCallErrorKind } from '../../infra/repository/crs/CrsErrors';
import { CrsFormatError } from '../../infra/repository/crs/CrsErrors';
import {
  classifyServerException,
  classifyVrsException,
  CRS_CLSID_DEPOT,
  decodeCallException,
  extractServerVersion,
  findStructuredVersion,
  VRS_CLSID_XML_PARSE,
} from '../../infra/repository/crs/CrsException';
import {
  callExceptionBodies,
  exceptionPayload,
  httpRawProbeBodies,
  readFixture,
  tcpRawProbeBodies,
  xmlParseExceptionBodies,
} from './support/crsFixtures';
import { parseVrsException } from '../../infra/xml/crs/CrsEnvelope';

const SERVER_VERSION = '8.5.1.1529';
const HTTP_CLSID = '580392e6-ba49-4280-ac67-fcd6f2180121';

interface Expected {
  kind: CrsCallErrorKind;
  code: number;
  first: string;
  count: number;
}

// Ожидания критерия 4 по имени артефакта: вид, код, начало первого сообщения и длина цепочки.
function expectedFor(name: string): Expected {
  // Отказы привязки (capture-read-probes.mjs): отличать их потребителю не нужно — остаются server.
  if (name === 'tcp/probe-bind-unknown-existing') {
    return { kind: 'server', code: 11, first: 'Информационная база не связана с хранилищем конфигурации.', count: 1 };
  }
  if (name === 'tcp/probe-bind-new') {
    return { kind: 'server', code: 10, first: 'Попытка связывания информационной базы пользователем,\r\n', count: 1 };
  }
  if (/lock-(wrong-password|unknown-user)|tcp-raw\/wrong-password|probe-(statistic|history)-wrong-password/.test(name)) {
    return { kind: 'auth-failed', code: 4, first: 'Ошибка аутентификации в хранилище конфигурации!\r\n', count: 1 };
  }
  if (name.endsWith('/probe-wrong-alias')) {
    return { kind: 'depot-not-found', code: 1, first: 'Хранилище конфигурации по адресу:\r\ncrsdata/nosuch', count: 2 };
  }
  assert.match(name, /probe-version-/);
  return { kind: 'version-mismatch', code: 17, first: 'Несоответствие версий клиентского приложения и сервера хранилища', count: 1 };
}

function decode(body: Buffer): ReturnType<typeof decodeCallException> {
  const { clsid, base64 } = exceptionPayload(body);
  return decodeCallException(clsid, base64);
}

suite('crs exception: разбор и классификация снятых исключений', () => {
  const bodies = callExceptionBodies();

  test('decodeCallException: clsid, код и цепочка сообщений каждого снятого исключения', () => {
    for (const { name, body } of bodies) {
      const expected = expectedFor(name);
      const exception = decode(body);
      assert.strictEqual(exception.clsid, CRS_CLSID_DEPOT, name);
      assert.strictEqual(exception.code, expected.code, name);
      assert.strictEqual(exception.messages.length, expected.count, `${name}: ${exception.messages.join(' | ')}`);
      assert.ok(exception.messages[0].startsWith(expected.first), `${name}: ${exception.messages[0]}`);
    }
  });

  test('неверный alias: второе сообщение — об отсутствующем файле базы (tcp и http)', () => {
    for (const name of ['http/probe-wrong-alias', 'tcp-raw/probe-wrong-alias']) {
      const exception = decode((bodies.find((b) => b.name === name) as { body: Buffer }).body);
      assert.ok(exception.messages[1].startsWith("Отсутствует файл базы данных 'crsdata/nosuch//1cv8ddb.1CD'"), exception.messages[1]);
    }
  });

  test('пробы версии: версия клиента и сервера — в тексте первого сообщения', () => {
    for (const [probe, client] of [
      ['probe-version-zero', '0.0.0.0'],
      ['probe-version-zero-wrong-alias', '0.0.0.0'],
      ['probe-version-other', '8.3.27.2342'],
    ]) {
      const [message] = decode(tcpRawProbeBodies(probe).response.body).messages;
      assert.ok(message.includes(`Версия клиентского приложения:  ${client}`), message);
      assert.ok(message.includes(`Версия сервера хранилища конфигурации: ${SERVER_VERSION}`), message);
    }
  });

  test('любой обрезанный префикс base64 — CrsFormatError', () => {
    const { clsid, base64 } = exceptionPayload(readFixture('tcp', 'lock-wrong-password', '04-conn-02-s2c-call_exception.xml'));
    const full = Buffer.from(base64, 'base64');
    for (let length = 0; length < base64.length; length += 1) {
      // Без хвостового «=» base64 раскодируется целиком — это уже не обрезанный текст.
      if (Buffer.from(base64.slice(0, length), 'base64').equals(full)) {
        continue;
      }
      assert.throws(() => decodeCallException(clsid, base64.slice(0, length)), CrsFormatError, String(length));
    }
  });

  test('ошибка скобочного разбора → CrsFormatError со смещением, без содержимого нагрузки', () => {
    const error = (() => {
      try {
        decodeCallException('x', Buffer.from('{"секрет').toString('base64'));
      } catch (e) {
        return e;
      }
      return assert.fail('ожидался отказ');
    })();
    assert.ok(error instanceof CrsFormatError, String(error));
    assert.strictEqual(error.offset, 1);
    assert.ok(!error.message.includes('секрет'), error.message);
  });

  test('extractServerVersion: версия сервера из проб версии, а не версия клиента; в прочих — нет', () => {
    for (const { name, body } of bodies) {
      const expected = expectedFor(name).kind === 'version-mismatch' ? SERVER_VERSION : undefined;
      assert.strictEqual(extractServerVersion(decode(body).messages), expected, name);
    }
  });

  test('classifyServerException: полная таблица снятых исключений, версия — только у несовпадения версий', () => {
    for (const { name, body } of bodies) {
      const expected = expectedFor(name);
      const serverVersion = expected.kind === 'version-mismatch' ? { serverVersion: SERVER_VERSION } : {};
      assert.deepStrictEqual(classifyServerException(decode(body)), { kind: expected.kind, ...serverVersion }, name);
    }
  });

  test('classifyServerException: неизвестная пара clsid и код — server (данные исключения разбора XML)', () => {
    for (const { name, body } of xmlParseExceptionBodies()) {
      const exception = decode(body);
      assert.strictEqual(exception.clsid, VRS_CLSID_XML_PARSE, name);
      assert.strictEqual(exception.code, -6, name);
      assert.ok(exception.messages[0].startsWith('Ошибка разбора XML:'), name);
      assert.deepStrictEqual(classifyServerException(exception), { kind: 'server' }, name);
    }
  });

  test('parseVrsException: отказы публикации 404 и 406, разбор XML по tcp и http', () => {
    const cases: [Buffer, string, number | undefined, string][] = [
      [readFixture('http', 'probe-wrong-path', 'response.xml'), HTTP_CLSID, 404, 'HTTP: Not found\nОшибка при работе с ресурсом /repo/missing.1ccr'],
      [readFixture('http', 'probe-get', 'response.xml'), HTTP_CLSID, 406, 'HTTP: Not acceptable\n'],
      ...xmlParseExceptionBodies().map(({ body }): [Buffer, string, number | undefined, string] => [
        body,
        VRS_CLSID_XML_PARSE,
        undefined,
        'Ошибка разбора XML:  - [1,1]\nФатальная ошибка: \nDocument is empty\n',
      ]),
    ];
    for (const [body, clsid, reason, description] of cases) {
      const exception = parseVrsException(body);
      assert.ok(exception);
      assert.strictEqual(exception.clsid, clsid);
      assert.strictEqual(exception.reason, reason);
      assert.ok(exception.description.startsWith(description), exception.description);
    }
  });

  test('parseVrsException: тело crs и не XML — undefined', () => {
    assert.strictEqual(parseVrsException(bodies[0].body), undefined);
    assert.strictEqual(parseVrsException(tcpRawProbeBodies('probe-open').response.body), undefined);
    assert.strictEqual(parseVrsException(tcpRawProbeBodies('probe-malformed-body').request), undefined);
    assert.strictEqual(parseVrsException(tcpRawProbeBodies('probe-unknown-method').response.body), undefined);
  });

  test('classifyVrsException: разбор XML — bad-request, отказ публикации — rejected', () => {
    for (const { body } of xmlParseExceptionBodies()) {
      const exception = parseVrsException(body);
      assert.ok(exception);
      assert.strictEqual(classifyVrsException(exception), 'bad-request');
    }
    for (const probe of ['probe-wrong-path', 'probe-get']) {
      const exception = parseVrsException(readFixture('http', probe, 'response.xml'));
      assert.ok(exception);
      assert.strictEqual(classifyVrsException(exception), 'rejected');
    }
  });
});

// Версия сервера берётся структурно — из записи {9f06d311-…,"",{…},"N.N.N.N"}, а не из локализованного текста.
suite('crs exception: структурная версия сервера', () => {
  const VERSION_PROBES = ['probe-version-zero', 'probe-version-zero-wrong-alias', 'probe-version-other'];
  const versionBodies = VERSION_PROBES.flatMap((probe) => [
    { name: `tcp-raw/${probe}`, body: tcpRawProbeBodies(probe).response.body },
    { name: `http-raw/${probe}`, body: httpRawProbeBodies(probe).response.body },
  ]);

  /** Настоящая нагрузка пробы, преобразованная в памяти: скобочный текст → правка → base64. */
  function rewritten(probe: string, edit: (text: string) => string): ReturnType<typeof decodeCallException> {
    const { clsid, base64 } = exceptionPayload(tcpRawProbeBodies(probe).response.body);
    const text = Buffer.from(base64, 'base64').toString('utf-8');
    const edited = edit(text);
    assert.notStrictEqual(edited, text);
    return decodeCallException(clsid, Buffer.from(edited, 'utf-8').toString('base64'));
  }

  test('все пробы probe-version-* (tcp-raw и http-raw): версия сервера из записи версии', () => {
    for (const { name, body } of versionBodies) {
      const exception = decode(body);
      assert.strictEqual(exception.serverVersion, SERVER_VERSION, name);
      const { base64 } = exceptionPayload(body);
      // Оракул структуры — тот же общий разборщик скобочного текста.
      assert.ok(Buffer.from(base64, 'base64').toString('utf-8').includes('{9f06d311-1431-4a54-bd6f-fa93c4d4c471,'), name);
      assert.strictEqual(classifyServerException(exception).serverVersion, SERVER_VERSION, name);
    }
  });

  test('у прочих снятых исключений записи версии нет — поля serverVersion нет', () => {
    for (const { name, body } of callExceptionBodies()) {
      if (expectedFor(name).kind !== 'version-mismatch') {
        assert.ok(!('serverVersion' in decode(body)), name);
      }
    }
  });

  test('сообщения без слов «версия»/«version» — версия всё равно находится по записи', () => {
    // Все непустые строки в кавычках, кроме самой версии N.N.N.N, заменены нейтральным текстом; запись
    // 9f06d311 сохранена.
    const exception = rewritten('probe-version-other', (text) =>
      text.replace(/"(?:[^"]|"")*"/g, (quoted) => (quoted === '""' || /^"\d+\.\d+\.\d+\.\d+"$/.test(quoted) ? quoted : '"Отказ сервера"')));
    assert.ok(exception.messages.length > 0);
    assert.ok(exception.messages.every((message) => !/верси|version/i.test(message)), exception.messages.join(' | '));
    assert.strictEqual(extractServerVersion(exception.messages), undefined);
    assert.deepStrictEqual(classifyServerException(exception), { kind: 'version-mismatch', serverVersion: SERVER_VERSION });
  });

  test('записи версии нет — запасной путь: версия из текста сообщения', () => {
    // clsid записи версии заменён во всех вхождениях: структурно версия не находится, текст сообщений прежний.
    const exception = rewritten('probe-version-other', (text) =>
      text.split('9f06d311-1431-4a54-bd6f-fa93c4d4c471').join('00000000-0000-0000-0000-000000000000'));
    assert.strictEqual(exception.serverVersion, undefined);
    assert.deepStrictEqual(classifyServerException(exception), { kind: 'version-mismatch', serverVersion: SERVER_VERSION });
  });

  test('findStructuredVersion: последний элемент записи не вида N.N.N.N или не скаляр — нет версии', () => {
    const id = '9f06d311-1431-4a54-bd6f-fa93c4d4c471';
    assert.strictEqual(findStructuredVersion([[id, { quoted: '' }, { quoted: '8.5.1' }]]), undefined);
    assert.strictEqual(findStructuredVersion([[id, { quoted: '' }, ['8.5.1.1529']]]), undefined);
    assert.strictEqual(findStructuredVersion(['x', [id, { quoted: '8.5.1.1529' }]]), '8.5.1.1529');
  });
});
