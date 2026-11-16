import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import {
  buildCallBody,
  CRS_NAMESPACE,
  type CrsCallSpec,
  type CrsElement,
  crsValue,
  parseCallResponse,
} from '../../infra/xml/crs/CrsEnvelope';
import { CrsFormatError } from '../../infra/repository/crs/CrsErrors';
import { CRS_CLSID_DEPOT } from '../../infra/repository/crs/CrsException';
import { attributeOf, childElement, parseCrsXml, type CrsXmlElement } from '../../infra/xml/crs/CrsXmlReader';
import {
  crsCorpus,
  rawConfiguratorConnections,
  readFixture,
  requestBodyOf,
  responseFrameOf,
  splitTcpFrame,
  TCP_BODY_PROBES,
  tcpBodyProbe,
  tcpRawProbeBodies,
} from './support/crsFixtures';
import {
  lockFixturePath,
  NETWORK_FIXTURE_VERSIONS,
  readHttpExchange,
  readRun,
  readTcpExchange,
  tcpRequestBody,
} from './support/repositoryLockFixtures';

const BOM = Buffer.from('efbbbf', 'hex');

/** Пробы tcp-raw с настоящим запросом-конвертом и итогом ответа. */
const TCP_RAW_PROBES: Record<string, 'return' | 'exception' | 'empty'> = {
  'probe-open': 'return',
  'probe-late-terminator': 'return',
  'probe-unknown-method': 'empty',
  'probe-version-zero': 'exception',
  'probe-version-zero-wrong-alias': 'exception',
  'probe-version-other': 'exception',
  'probe-wrong-alias': 'exception',
};

function toCrsElement(element: CrsXmlElement): CrsElement {
  const attributes = Object.fromEntries(element.attributes);
  const children = element.children.map(toCrsElement);
  return {
    name: element.local,
    ...(element.attributes.size > 0 ? { attributes } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

/** Тестовый обратный разбор снятого запроса в модель конверта. */
function specOf(body: Buffer): CrsCallSpec {
  const root = parseCrsXml(body.toString('utf-8'));
  const auth = childElement(root, CRS_NAMESPACE, 'auth');
  const bind = childElement(root, CRS_NAMESPACE, 'bind');
  const params = childElement(root, CRS_NAMESPACE, 'params');
  assert.ok(params, 'в каждом снятом запросе есть crs:params');
  assert.strictEqual(root.children.length, 1 + Number(auth !== undefined) + Number(bind !== undefined));
  return {
    alias: attributeOf(root, 'alias'),
    method: attributeOf(root, 'name'),
    version: attributeOf(root, 'version'),
    ...(auth ? { auth: { user: attributeOf(auth, 'user'), passwordHash: attributeOf(auth, 'password') } } : {}),
    ...(bind ? { bindId: attributeOf(bind, 'bindID') } : {}),
    params: params.children.map(toCrsElement),
  };
}

/** Все снятые запросы: корпус tcp и http, соединения Конфигуратора tcp-raw, пробы tcp-raw с конвертом и пробы тел tcp. */
function requests(): { name: string; body: Buffer }[] {
  const result = crsCorpus()
    .filter((f) => f.direction === 'c2s')
    .map((f) => ({ name: `${f.transport}/${f.scenario}/${f.file}`, body: f.body }));
  for (const conn of rawConfiguratorConnections()) {
    result.push({ name: `tcp-raw/${conn.name}`, body: requestBodyOf(conn.c2s) });
  }
  for (const probe of Object.keys(TCP_RAW_PROBES)) {
    result.push({ name: `tcp-raw/${probe}`, body: tcpRawProbeBodies(probe).request });
  }
  for (const probe of Object.keys(TCP_BODY_PROBES)) {
    result.push({ name: `tcp/${probe}`, body: tcpBodyProbe(probe).request });
  }
  return result;
}

function responses(): { name: string; body: Buffer; kind: string }[] {
  const result = crsCorpus()
    .filter((f) => f.direction === 's2c')
    .map((f) => ({
      name: `${f.transport}/${f.scenario}/${f.file}`,
      body: f.body,
      kind: f.file.endsWith('call_return.xml') ? 'return' : 'exception',
    }));
  for (const conn of rawConfiguratorConnections()) {
    const body = splitTcpFrame(responseFrameOf(conn.s2c)).body;
    result.push({ name: `tcp-raw/${conn.name}`, body, kind: body.includes('call_exception') ? 'exception' : 'return' });
  }
  for (const [probe, kind] of Object.entries(TCP_RAW_PROBES)) {
    result.push({ name: `tcp-raw/${probe}`, body: tcpRawProbeBodies(probe).response.body, kind });
  }
  for (const [probe, kind] of Object.entries(TCP_BODY_PROBES)) {
    result.push({ name: `tcp/${probe}`, body: tcpBodyProbe(probe).response, kind });
  }
  result.push({ name: 'http/probe-unknown-method', body: readFixture('http', 'probe-unknown-method', 'response.xml'), kind: 'empty' });
  result.push({ name: 'http/probe-wrong-alias', body: readFixture('http', 'probe-wrong-alias', 'response.xml'), kind: 'exception' });
  return result;
}

suite('CrsEnvelope — конверт crs:call на снятых телах (example/crs)', () => {
  test('buildCallBody побайтно воспроизводит каждое снятое тело запроса', () => {
    const all = requests();
    assert.strictEqual(all.length, 283 + 8 + Object.keys(TCP_RAW_PROBES).length + Object.keys(TCP_BODY_PROBES).length);
    for (const { name, body } of all) {
      const built = buildCallBody(specOf(body));
      assert.deepStrictEqual(built.subarray(0, 3), BOM, name);
      assert.ok(built.includes(`xmlns:crs="${CRS_NAMESPACE}"`), name);
      assert.strictEqual(built.toString('utf-8'), body.toString('utf-8'), name);
      assert.deepStrictEqual(built, body, name);
    }
  });

  test('crsValue: строка, число и логическое значение — атрибут value', () => {
    assert.deepStrictEqual(crsValue('alias', 'exp'), { name: 'alias', attributes: { value: 'exp' } });
    assert.deepStrictEqual(crsValue('convert', false), { name: 'convert', attributes: { value: 'false' } });
    assert.deepStrictEqual(crsValue('beginVerNum', 2), { name: 'beginVerNum', attributes: { value: '2' } });
    // Параметры openDevDepot, собранные через crsValue, дают тело пробы probe-open.
    const { request } = tcpRawProbeBodies('probe-open');
    const body = buildCallBody({
      alias: 'exp',
      method: 'DevDepotAdmin_openDevDepot',
      version: '8.5.1.1529',
      params: [crsValue('alias', 'exp'), crsValue('convert', false)],
    });
    assert.deepStrictEqual(body, request);
  });

  test('parseCallResponse: каждое снятое тело ответа — return, exception или empty', () => {
    for (const { name, body, kind } of responses()) {
      const response = parseCallResponse(body);
      assert.strictEqual(response.kind, kind, name);
      if (response.kind === 'return') {
        assert.strictEqual(response.element.name, 'crs:call_return', name);
        assert.strictEqual(response.element.namespace, CRS_NAMESPACE, name);
      } else if (response.kind === 'exception') {
        assert.strictEqual(response.exception.clsid, CRS_CLSID_DEPOT, name);
        assert.ok(response.exception.messages.length > 0, name);
      }
    }
  });

  test('parseCallResponse: тело запроса, исключение VRS и не XML — CrsFormatError', () => {
    for (const body of [
      tcpRawProbeBodies('probe-open').request,
      tcpRawProbeBodies('probe-malformed-body').response.body,
      readFixture('http', 'probe-wrong-path', 'response.xml'),
      tcpRawProbeBodies('probe-malformed-body').request,
      tcpRawProbeBodies('probe-open').response.body.subarray(0, 100),
    ]) {
      assert.throws(() => parseCallResponse(body), CrsFormatError);
    }
  });
});

/** md5 от UTF-16LE — независимое от продукта вычисление хеша для сверки конверта. */
function md5Utf16(password: string): string {
  return crypto.createHash('md5').update(Buffer.from(password, 'utf16le')).digest('hex');
}

/**
 * Обмены фикстуры захватов (example/repository/2.21-locks): тело статистики, которое шлёт источник
 * статусов, совпадает с принятым сервером, а после удаления crs:bind и removed=false — с запросом
 * самого Конфигуратора.
 */
for (const version of NETWORK_FIXTURE_VERSIONS) {
  suite(`CrsEnvelope — обмены статистики с crserver ${version}`, () => {
    const run = readRun(version);
    const statisticBody = (user: string, password: string): Buffer => buildCallBody({
      alias: run.alias,
      method: 'DevDepot_devObjectsStatistic',
      version: run.platform,
      auth: { user, passwordHash: md5Utf16(password) },
      params: [{ name: 'objRefs' }, crsValue('removed', false)],
    });

    for (const [exchange, user, password] of [['statistic-admin', 'Admin', ''], ['statistic-petrov', 'Petrov', '123']] as const) {
      test(`${exchange}: тело совпадает байт-в-байт с принятым сервером (tcp и http)`, () => {
        const body = statisticBody(user, password);
        assert.deepStrictEqual(body, tcpRequestBody(readTcpExchange(version, exchange).client));
        assert.deepStrictEqual(body, readHttpExchange(version, exchange).request);
      });
    }

    test('конверт совпадает с запросом Конфигуратора после удаления crs:bind и removed=false', () => {
      const designer = fs.readFileSync(lockFixturePath(version, 'designer-devObjectsStatistic.request.bin'), 'utf-8')
        .replace(/<crs:bind [^>]*\/>/, '')
        .replace('<crs:removed value="true"/>', '<crs:removed value="false"/>');
      assert.strictEqual(statisticBody('Admin', '').toString('utf-8'), designer);
    });

    test('ответы: статистика — call_return, отказы — call_exception хранилища с сообщением', () => {
      assert.strictEqual(parseCallResponse(readHttpExchange(version, 'statistic-admin').response).kind, 'return');
      for (const exchange of ['version-mismatch', 'auth-failed', 'alias-not-found'] as const) {
        const response = parseCallResponse(readHttpExchange(version, exchange).response);
        assert.ok(response.kind === 'exception', exchange);
        assert.strictEqual(response.exception.clsid, CRS_CLSID_DEPOT, exchange);
        assert.ok(response.exception.messages.length > 0, exchange);
      }
    });
  });
}

suite('CrsEnvelope — экранирование и искажённые ответы', () => {
  test('атрибуты конверта экранируются', () => {
    const body = buildCallBody({
      alias: 'a<b', method: 'M', version: '8.5.1.1529', auth: { user: 'Иван "Бух" & Ко', passwordHash: 'h' },
    }).toString('utf-8');
    assert.ok(body.includes('alias="a&lt;b"'));
    assert.ok(body.includes('user="Иван &quot;Бух&quot; &amp; Ко"'));
    assert.ok(body.endsWith('<crs:params/></crs:call>'));
  });

  // Не данные платформы, а искажённые ответы (веб-сервер вместо публикации, обрыв ответа).
  test('HTML-страница вместо crs и оборванный ответ → CrsFormatError', () => {
    assert.throws(() => parseCallResponse(Buffer.from('<html><body><h1>502 Bad Gateway</h1></body></html>')), CrsFormatError);
    assert.throws(() => parseCallResponse(readHttpExchange('8.5.1', 'statistic-admin').response.subarray(0, 4)), CrsFormatError);
  });
});
