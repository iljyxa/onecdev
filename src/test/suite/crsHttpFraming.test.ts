import * as assert from 'assert';
import {
  CRS_HTTP_DEFAULT_MAX_HEADER_BYTES,
  type CrsHttpEndpoint,
  crsHttpHeaders,
  crsHttpRequestOptions,
  formatHttpEndpoint,
} from '../../infra/repository/crs/CrsHttpFraming';
import { readFixture } from './support/crsFixtures';

// Снятая проба стенда: публикация на 127.0.0.1:33899, путь /repo/repo.1ccr.
const PROBE_HEAD = readFixture('http', 'probe-valid', 'request.headers.txt').toString('latin1');
const PROBE_BODY = readFixture('http', 'probe-valid', 'request.xml');
const STAND: CrsHttpEndpoint = { scheme: 'http', host: '127.0.0.1', port: 33899, path: '/repo/repo.1ccr' };

function headerLines(headers: Record<string, string>): string[] {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
}

suite('crs httpFraming', () => {
  test('заголовки — ровно строки снятой пробы http/probe-valid: порядок, регистр, значения', () => {
    const [requestLine, ...lines] = PROBE_HEAD.split('\r\n').filter((line) => line !== '');
    assert.strictEqual(requestLine, 'POST /repo/repo.1ccr HTTP/1.1');
    assert.deepStrictEqual(headerLines(crsHttpHeaders(STAND, PROBE_BODY.length)), lines);
  });

  test('Host без порта для 80 (http) и 443 (https), с портом для прочих; IPv6 в скобках', () => {
    const host = (endpoint: CrsHttpEndpoint): string => crsHttpHeaders(endpoint, 0).Host;
    const base = { host: 'srv', path: '/repo.1ccr' };
    assert.strictEqual(host({ ...base, scheme: 'http', port: 80 }), 'srv');
    assert.strictEqual(host({ ...base, scheme: 'https', port: 443 }), 'srv');
    assert.strictEqual(host({ ...base, scheme: 'http', port: 443 }), 'srv:443');
    assert.strictEqual(host({ ...base, scheme: 'https', port: 80 }), 'srv:80');
    assert.strictEqual(host({ ...base, scheme: 'http', host: '::1', port: 8080 }), '[::1]:8080');
    assert.strictEqual(host({ ...base, scheme: 'https', host: '::1', port: 443 }), '[::1]');
  });

  test('formatHttpEndpoint: схема, хост, порт всегда, путь; IPv6 в скобках', () => {
    assert.strictEqual(formatHttpEndpoint(STAND), 'http://127.0.0.1:33899/repo/repo.1ccr');
    assert.strictEqual(formatHttpEndpoint({ scheme: 'https', host: '::1', port: 443, path: '/a.1ccr' }), 'https://[::1]:443/a.1ccr');
  });

  test('опции http: POST на путь и порт, agent: false, maxHeaderSize, без TLS-полей', () => {
    const options = crsHttpRequestOptions(STAND, PROBE_BODY.length, CRS_HTTP_DEFAULT_MAX_HEADER_BYTES);
    assert.deepStrictEqual(options, {
      host: '127.0.0.1',
      port: 33899,
      method: 'POST',
      path: '/repo/repo.1ccr',
      headers: crsHttpHeaders(STAND, PROBE_BODY.length),
      agent: false,
      maxHeaderSize: CRS_HTTP_DEFAULT_MAX_HEADER_BYTES,
    });
    assert.strictEqual(CRS_HTTP_DEFAULT_MAX_HEADER_BYTES, 16 * 1024);
  });

  test('опции http: TLS-настройки игнорируются', () => {
    const options = crsHttpRequestOptions(STAND, 1, 100, { ca: 'CA', rejectUnauthorized: false, servername: 'x' });
    for (const key of ['ca', 'rejectUnauthorized', 'servername']) {
      assert.ok(!(key in options), key);
    }
  });

  test('опции https по умолчанию: rejectUnauthorized true, servername — DNS-имя хоста, ca нет', () => {
    const endpoint: CrsHttpEndpoint = { scheme: 'https', host: 'crs.example.org', port: 443, path: '/repo.1ccr' };
    const options = crsHttpRequestOptions(endpoint, 5, 100);
    assert.strictEqual(options.rejectUnauthorized, true);
    assert.strictEqual(options.servername, 'crs.example.org');
    assert.ok(!('ca' in options));
    assert.strictEqual(options.agent, false);
    assert.strictEqual(options.maxHeaderSize, 100);
    assert.deepStrictEqual(options.headers, crsHttpHeaders(endpoint, 5));
  });

  for (const host of ['127.0.0.1', '::1']) {
    test(`опции https для IP ${host}: servername не задаётся, явный — задаётся`, () => {
      const endpoint: CrsHttpEndpoint = { scheme: 'https', host, port: 8443, path: '/repo.1ccr' };
      assert.ok(!('servername' in crsHttpRequestOptions(endpoint, 0, 100)));
      assert.ok(!('servername' in crsHttpRequestOptions(endpoint, 0, 100, {})));
      assert.strictEqual(crsHttpRequestOptions(endpoint, 0, 100, { servername: 'crs.example.org' }).servername, 'crs.example.org');
    });
  }

  test('опции https с явными ca и rejectUnauthorized: false; массив ca копируется', () => {
    const endpoint: CrsHttpEndpoint = { scheme: 'https', host: 'srv', port: 443, path: '/repo.1ccr' };
    const pem = Buffer.from('CA');
    const list = ['A', pem] as const;
    const options = crsHttpRequestOptions(endpoint, 0, 100, { ca: list, rejectUnauthorized: false, servername: 'other' });
    assert.deepStrictEqual(options.ca, ['A', pem]);
    assert.notStrictEqual(options.ca, list);
    assert.strictEqual(options.rejectUnauthorized, false);
    assert.strictEqual(options.servername, 'other');
    assert.strictEqual(crsHttpRequestOptions(endpoint, 0, 100, { ca: 'PEM' }).ca, 'PEM');
    assert.strictEqual(crsHttpRequestOptions(endpoint, 0, 100, { ca: pem }).ca, pem);
    assert.strictEqual(crsHttpRequestOptions(endpoint, 0, 100, { ca: pem }).rejectUnauthorized, true);
  });
});
