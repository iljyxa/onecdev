import * as assert from 'assert';
import { CRS_DEFAULT_ALIAS, CRS_TCP_DEFAULT_PORT, type CrsAddress, CrsAddressError, type CrsAddressErrorReason, parseCrsAddress } from '../../infra/repository/crs/CrsAddress';

// Основа — адреса стенда, с которого снят корпус example/crs: crserver по tcp и публикация /repo/repo.1ccr, alias exp.
const accepted: [string, CrsAddress][] = [
  ['tcp://127.0.0.1:33899/exp', { transport: 'tcp', endpoint: { host: '127.0.0.1', port: 33899 }, alias: 'exp' }],
  [
    'http://127.0.0.1:33899/repo/repo.1ccr/exp',
    { transport: 'http', endpoint: { scheme: 'http', host: '127.0.0.1', port: 33899, path: '/repo/repo.1ccr' }, alias: 'exp' },
  ],
  [
    'https://crs.example.org:8443/repo/repo.1ccr/exp',
    { transport: 'http', endpoint: { scheme: 'https', host: 'crs.example.org', port: 8443, path: '/repo/repo.1ccr' }, alias: 'exp' },
  ],
  ['tcp://srv/exp', { transport: 'tcp', endpoint: { host: 'srv', port: CRS_TCP_DEFAULT_PORT }, alias: 'exp' }],
  ['http://srv/repo.1ccr/exp', { transport: 'http', endpoint: { scheme: 'http', host: 'srv', port: 80, path: '/repo.1ccr' }, alias: 'exp' }],
  ['https://srv/repo.1ccr/exp', { transport: 'http', endpoint: { scheme: 'https', host: 'srv', port: 443, path: '/repo.1ccr' }, alias: 'exp' }],
  ['http://srv:80/repo.1ccr/exp', { transport: 'http', endpoint: { scheme: 'http', host: 'srv', port: 80, path: '/repo.1ccr' }, alias: 'exp' }],
  ['tcp://[::1]:1600/exp', { transport: 'tcp', endpoint: { host: '::1', port: 1600 }, alias: 'exp' }],
  [
    'http://[::1]:8080/repo/repo.1ccr/exp',
    { transport: 'http', endpoint: { scheme: 'http', host: '::1', port: 8080, path: '/repo/repo.1ccr' }, alias: 'exp' },
  ],
  ['TCP://srv:1542/exp', { transport: 'tcp', endpoint: { host: 'srv', port: 1542 }, alias: 'exp' }],
  [
    'HTTPS://srv/repo/repo.1ccr/exp',
    { transport: 'http', endpoint: { scheme: 'https', host: 'srv', port: 443, path: '/repo/repo.1ccr' }, alias: 'exp' },
  ],
  ['  tcp://srv/exp \t\n', { transport: 'tcp', endpoint: { host: 'srv', port: 1542 }, alias: 'exp' }],
  ['tcp://srv/exp/', { transport: 'tcp', endpoint: { host: 'srv', port: 1542 }, alias: 'exp' }],
  ['http://srv/repo.1ccr/exp/', { transport: 'http', endpoint: { scheme: 'http', host: 'srv', port: 80, path: '/repo.1ccr' }, alias: 'exp' }],
  // Кириллица: alias для конверта раскодирован, путь для запроса остаётся закодированным.
  ['tcp://srv/Хранилище', { transport: 'tcp', endpoint: { host: 'srv', port: 1542 }, alias: 'Хранилище' }],
  ['tcp://srv/%D0%A5%D1%80', { transport: 'tcp', endpoint: { host: 'srv', port: 1542 }, alias: 'Хр' }],
  [
    'http://srv/публикация/хранилище.1ccr/Основное',
    {
      transport: 'http',
      endpoint: {
        scheme: 'http',
        host: 'srv',
        port: 80,
        path: `/${encodeURIComponent('публикация')}/${encodeURIComponent('хранилище')}.1ccr`,
      },
      alias: 'Основное',
    },
  ],
  // http без хвоста после .1ccr — хранилище публикации по умолчанию (адреса привязок onecdev до переноса клиента).
  ['http://srv/repo.1ccr', { transport: 'http', endpoint: { scheme: 'http', host: 'srv', port: 80, path: '/repo.1ccr' }, alias: CRS_DEFAULT_ALIAS }],
  ['HTTP://srv/repo/REPO.1CCR/', { transport: 'http', endpoint: { scheme: 'http', host: 'srv', port: 80, path: '/repo/REPO.1CCR' }, alias: 'maincr' }],
  ['https://srv:8443/r.1ccr', { transport: 'http', endpoint: { scheme: 'https', host: 'srv', port: 8443, path: '/r.1ccr' }, alias: 'maincr' }],
  ['tcp://[::1]:17542/Хранилище/', { transport: 'tcp', endpoint: { host: '::1', port: 17542 }, alias: 'Хранилище' }],
  // Вложенный alias принимается как есть: проб на него нет.
  ['tcp://srv/a/b', { transport: 'tcp', endpoint: { host: 'srv', port: 1542 }, alias: 'a/b' }],
];

suite('crs parseCrsAddress: допустимые адреса', () => {
  for (const [address, expected] of accepted) {
    test(`«${address}»`, () => {
      assert.deepStrictEqual(parseCrsAddress(address), expected);
    });
  }
});

// secret в каждом адресе: исходная строка не должна попасть ни в message, ни в сериализацию ошибки.
const rejected: [string, CrsAddressErrorReason][] = [
  ['', 'syntax'],
  ['   ', 'syntax'],
  ['secret', 'syntax'],
  ['tcp:secret', 'syntax'],
  ['http://secret host/repo.1ccr/exp', 'syntax'],
  ['tcp://srv:99999/secret', 'syntax'],
  ['http://srv:99999/repo.1ccr/secret', 'syntax'],
  ['tcp://srv/secret?q=1', 'syntax'],
  ['tcp://srv/secret#f', 'syntax'],
  ['http://srv/repo.1ccr/exp?token=secret', 'syntax'],
  ['http://srv/repo.1ccr/exp#secret', 'syntax'],
  ['ftp://srv/secret', 'scheme'],
  ['secret://srv/exp', 'scheme'],
  ['user:secret@srv/exp', 'scheme'],
  ['tcp://user:secret@srv/exp', 'credentials'],
  ['tcp://secret@srv/exp', 'credentials'],
  ['http://user:secret@srv/repo.1ccr/exp', 'credentials'],
  ['https://:secret@srv/repo.1ccr/exp', 'credentials'],
  ['tcp:///secret', 'host'],
  ['tcp://srv:0/secret', 'port'],
  ['http://srv:0/repo.1ccr/secret', 'port'],
  ['http://srv/repo/secret', 'path'],
  ['http://srv/secret', 'path'],
  ['http://srv/', 'path'],
  ['http://srv/a//repo.1ccr/secret', 'path'],
  ['http://srv/repo%zz.1ccr/secret', 'path'],
  ['tcp://srv/a//secret', 'path'],
  ['tcp://srv/%zzsecret', 'path'],
  ['http://srv/repo.1ccr/secret%zz', 'path'],
  ['tcp://srv', 'alias'],
  ['tcp://srv/', 'alias'],
  ['tcp://srv/secret//', 'path'],
  ['http://[secret', 'syntax'],
];

suite('crs parseCrsAddress: отказы', () => {
  for (const [address, reason] of rejected) {
    test(`«${address}» — ${reason}, исходная строка не в сообщении`, () => {
      const error = (() => {
        try {
          parseCrsAddress(address);
        } catch (e) {
          return e;
        }
        return assert.fail('ожидался отказ');
      })();
      assert.ok(error instanceof CrsAddressError, String(error));
      assert.strictEqual(error.reason, reason, error.message);
      assert.strictEqual(error.name, 'CrsAddressError');
      assert.ok(error.message.length > 0);
      for (const text of [error.message, JSON.stringify(error), String(error.stack)]) {
        assert.ok(!text.includes('secret'), text);
        if (address.trim() !== '') {
          assert.ok(!text.includes(address.trim()), text);
        }
      }
    });
  }
});
