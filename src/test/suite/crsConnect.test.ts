import * as assert from 'assert';
import { CrsAddressError, parseCrsAddress } from '../../infra/repository/crs/CrsAddress';
import { CrsClient } from '../../infra/repository/crs/CrsClient';
import { crsValue } from '../../infra/xml/crs/CrsEnvelope';
import { createCrsClient, createCrsTransport } from '../../infra/repository/crs/CrsConnect';
import { CrsHttpTransport } from '../../infra/repository/crs/CrsHttpTransport';
import { CrsTcpTransport } from '../../infra/repository/crs/CrsTcpTransport';
import { CrsTransportError } from '../../infra/repository/crs/CrsTransport';
import { ReplayServer } from './support/crsReplayServer';
import { TRANSPORT_CASES } from './support/crsTransportCases';

const SERVER_VERSION = '8.5.1.1529';
const OPEN = { method: 'DevDepotAdmin_openDevDepot', params: [crsValue('alias', 'exp'), crsValue('convert', false)] };
const TLS = { rejectUnauthorized: false };

suite('crs createCrsTransport и createCrsClient', () => {
  test('транспорт по виду адреса: tcp, http, https; tls для tcp и http игнорируется', () => {
    assert.ok(createCrsTransport(parseCrsAddress('tcp://srv/exp')) instanceof CrsTcpTransport);
    assert.ok(createCrsTransport(parseCrsAddress('tcp://srv/exp'), { tls: TLS }) instanceof CrsTcpTransport);
    assert.ok(createCrsTransport(parseCrsAddress('http://srv/repo.1ccr/exp'), { tls: TLS }) instanceof CrsHttpTransport);
    assert.ok(createCrsTransport(parseCrsAddress('https://srv/repo.1ccr/exp'), { tls: TLS }) instanceof CrsHttpTransport);
    assert.ok(createCrsTransport(parseCrsAddress('https://srv/repo.1ccr/exp')) instanceof CrsHttpTransport);
  });

  test('опции дедлайна и лимита доходят до транспорта: неверные — RangeError', () => {
    for (const address of ['tcp://srv/exp', 'http://srv/repo.1ccr/exp', 'https://srv/repo.1ccr/exp']) {
      assert.throws(() => createCrsTransport(parseCrsAddress(address), { timeoutMs: 0 }), RangeError, address);
      assert.throws(() => createCrsTransport(parseCrsAddress(address), { maxResponseBytes: 0 }), RangeError, address);
      assert.throws(() => createCrsClient(address, { timeoutMs: 0 }), RangeError, address);
    }
  });

  test('клиент: alias из адреса (строка и разобранный), версия не N.N.N.N — RangeError', () => {
    assert.ok(createCrsClient('tcp://srv/Хранилище') instanceof CrsClient);
    assert.strictEqual(createCrsClient('tcp://srv/Хранилище').alias, 'Хранилище');
    assert.strictEqual(createCrsClient('http://srv/repo.1ccr/exp').alias, 'exp');
    assert.strictEqual(createCrsClient(parseCrsAddress('https://srv/repo.1ccr/main')).alias, 'main');
    assert.throws(() => createCrsClient('tcp://srv/exp', { version: '8.5' }), RangeError);
  });

  test('неверный адрес — CrsAddressError пробрасывается', () => {
    assert.throws(() => createCrsClient('ftp://srv/exp'), (e: unknown) => e instanceof CrsAddressError && e.reason === 'scheme');
    assert.throws(() => createCrsClient('tcp://user:pwd@srv/exp'), (e: unknown) => e instanceof CrsAddressError && e.reason === 'credentials');
  });

  for (const c of TRANSPORT_CASES) {
    const probe = c.name === 'tcp' ? 'probe-open' : 'probe-valid';
    test(`${c.name}: сквозной вызов по адресу с известной версией — без рукопожатия (${probe})`, async () => {
      const exchange = c.probe(probe);
      const server = await ReplayServer.start(exchange.steps);
      try {
        const client = createCrsClient(`${c.endpoint(server.port)}/exp`, { version: SERVER_VERSION });
        const element = await client.call(OPEN);
        assert.strictEqual(element.name, 'crs:call_return');
        assert.strictEqual(server.connections.length, 1);
        const wire = await server.connection(0);
        await wire.closed;
        // tcp: UUID клиента случайный — сверяется всё после приветствия клиента.
        const skip = c.name === 'tcp' ? 20 : 0;
        assert.deepStrictEqual(wire.received().subarray(skip), exchange.wire(server.port).subarray(skip));
      } finally {
        await server.close();
      }
    });

    test(`${c.name}: лимит тела из опций доходит до вызова`, async () => {
      const exchange = c.probe(probe);
      const server = await ReplayServer.start(exchange.steps);
      try {
        const transport = createCrsTransport(parseCrsAddress(`${c.endpoint(server.port)}/exp`), { maxResponseBytes: exchange.responseBody.length - 1 });
        const error = await transport.call(exchange.body).then(
          () => assert.fail('ожидался отказ'),
          (e: unknown) => e,
        );
        assert.ok(error instanceof CrsTransportError && error.kind === 'too-large', String(error));
      } finally {
        await server.close();
      }
    });
  }
});
