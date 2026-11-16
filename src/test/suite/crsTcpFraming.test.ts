import * as assert from 'assert';
import {
  buildTcpRequestFrame,
  CRS_TCP_DEFAULT_MAX_HEADER_BYTES,
  encodeClientHello,
  TcpFrameReader,
  type TcpFrameLimits,
  type TcpReadResult,
} from '../../infra/repository/crs/CrsTcpFraming';
import {
  clientIdFromHello,
  httpProbeResponse,
  rawConfiguratorConnections,
  responseFrameOf,
  splitMessage,
  splitTcpFrame,
  tcpProbe,
  UUID_V4,
} from './support/crsFixtures';

const DEFAULT_LIMITS: TcpFrameLimits = { maxHeaderBytes: CRS_TCP_DEFAULT_MAX_HEADER_BYTES, maxResponseBytes: 128 * 1024 * 1024 };

function readAll(chunks: Buffer[], limits: TcpFrameLimits = DEFAULT_LIMITS): TcpReadResult {
  const reader = new TcpFrameReader(limits);
  let result: TcpReadResult = { state: 'more' };
  for (const chunk of chunks) {
    result = reader.push(chunk);
    if (result.state !== 'more') {
      break;
    }
  }
  return result;
}

function bytewise(data: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < data.length; i += 1) {
    chunks.push(data.subarray(i, i + 1));
  }
  return chunks;
}

function assertDone(result: TcpReadResult, body: Buffer): void {
  assert.ok(result.state === 'done', result.state === 'failed' ? result.detail : result.state);
  assert.deepStrictEqual(result.body, body);
}

function assertFailed(result: TcpReadResult, kind: 'protocol' | 'too-large' | 'status'): Extract<TcpReadResult, { state: 'failed' }> {
  assert.ok(result.state === 'failed', result.state);
  assert.strictEqual(result.kind, kind, result.detail);
  assert.ok(result.detail.length > 0);
  return result;
}

const BOM = Buffer.from('efbbbf', 'hex');

suite('crs tcpFraming: приветствие и кадр запроса', () => {
  for (const conn of rawConfiguratorConnections()) {
    test(`encodeClientHello воспроизводит приветствие Конфигуратора (${conn.name})`, () => {
      const id = clientIdFromHello(conn.c2s);
      assert.match(id, UUID_V4, 'в раскладке GUID LE идентификатор — UUID v4');
      assert.deepStrictEqual(encodeClientHello(id), conn.c2s.subarray(0, 20));
      assert.deepStrictEqual(encodeClientHello(id.toUpperCase()), conn.c2s.subarray(0, 20));
    });

    test(`buildTcpRequestFrame воспроизводит кадр Конфигуратора (${conn.name})`, () => {
      const frame = conn.c2s.subarray(20);
      const { body } = splitTcpFrame(frame);
      assert.deepStrictEqual(buildTcpRequestFrame(body), frame);
    });
  }

  for (const bad of ['not-a-uuid', '', '78d3c98a5aeb4632866d1a50e885b42a', '{78d3c98a-5aeb-4632-866d-1a50e885b42a}', '78d3c98a-5aeb-4632-866d-1a50e885b42g']) {
    test(`encodeClientHello отвергает «${bad}»`, () => {
      assert.throws(() => encodeClientHello(bad), RangeError);
    });
  }
});

suite('crs tcpFraming: чтение ответа', () => {
  for (const conn of rawConfiguratorConnections()) {
    const frame = responseFrameOf(conn.s2c);
    const expected = splitTcpFrame(frame);

    test(`ответ целиком, по байту и с разрезом в каждой позиции (${conn.name})`, () => {
      assert.ok(expected.body.subarray(0, 3).equals(BOM));
      assert.match(expected.body.toString('utf-8'), /<crs:call_(return|exception)[ >]/);
      assertDone(readAll([frame]), expected.body);
      assertDone(readAll(bytewise(frame)), expected.body);
      for (let cut = 1; cut < frame.length; cut += 1) {
        assertDone(readAll([frame.subarray(0, cut), frame.subarray(cut)]), expected.body);
      }
    });

    test(`лимит тела: Content-Length впритык проходит, на байт меньше — too-large до чтения тела (${conn.name})`, () => {
      const limit = expected.contentLength;
      assertDone(readAll([frame], { ...DEFAULT_LIMITS, maxResponseBytes: limit }), expected.body);
      const headOnly = frame.subarray(0, expected.headLength);
      assertFailed(readAll([headOnly], { ...DEFAULT_LIMITS, maxResponseBytes: limit - 1 }), 'too-large');
    });

    test(`лимит заголовков: блок впритык проходит, на байт меньше — protocol (${conn.name})`, () => {
      const limit = expected.headLength;
      assertDone(readAll([frame], { ...DEFAULT_LIMITS, maxHeaderBytes: limit }), expected.body);
      assertFailed(readAll([frame], { ...DEFAULT_LIMITS, maxHeaderBytes: limit - 1 }), 'protocol');
      assertFailed(readAll(bytewise(frame), { ...DEFAULT_LIMITS, maxHeaderBytes: limit - 1 }), 'protocol');
    });

    test(`поток с приветствием сервера и поток клиента — не ответ (${conn.name})`, () => {
      assertFailed(readAll([conn.s2c]), 'protocol');
      assertFailed(readAll([conn.c2s]), 'protocol');
      assertFailed(readAll([conn.c2s.subarray(20)]), 'protocol');
    });
  }

  test('неизвестный метод: 200 и тело из одного BOM', () => {
    const frame = responseFrameOf(tcpProbe('probe-unknown-method').response);
    assert.strictEqual(splitTcpFrame(frame).contentLength, 3);
    assertDone(readAll([frame]), BOM);
    assertDone(readAll(bytewise(frame)), BOM);
  });

  test('ответ на второй кадр соединения читается так же, лишние байты после тела игнорируются', () => {
    const stream = responseFrameOf(tcpProbe('probe-two-frames').response);
    const first = splitMessage(stream);
    assertDone(readAll([stream]), first.body);
    const second = splitTcpFrame(first.rest.subarray(4));
    assertDone(readAll([first.rest.subarray(4)]), second.body);
  });

  test('400 по tcp: тело exception дочитывается и возвращается со статусом', () => {
    const frame = responseFrameOf(tcpProbe('probe-malformed-body').response);
    const expected = splitTcpFrame(frame);
    for (const chunks of [[frame], bytewise(frame)]) {
      const failed = assertFailed(readAll(chunks), 'status');
      assert.strictEqual(failed.status, 400);
      assert.deepStrictEqual(failed.body, expected.body);
      assert.match(expected.body.toString('utf-8'), /Exception/);
    }
    // Лимит проверяется раньше статуса: большое тело ошибки тоже не читается.
    assertFailed(readAll([frame], { ...DEFAULT_LIMITS, maxResponseBytes: expected.contentLength - 1 }), 'too-large');
    // Пока тело не пришло, итога нет.
    assert.deepStrictEqual(readAll([frame.subarray(0, expected.headLength + 1)]), { state: 'more' });
  });

  for (const [probe, status] of [['probe-malformed-body', 400], ['probe-get', 406]] as const) {
    test(`настоящий http-ответ ${String(status)} (${probe}) — status с телом`, () => {
      const message = httpProbeResponse(probe);
      const failed = assertFailed(readAll([message]), 'status');
      assert.strictEqual(failed.status, status);
      assert.deepStrictEqual(failed.body, splitMessage(message).body);
    });
  }

  test('настоящий http-ответ 200 без терминатора — done', () => {
    const message = httpProbeResponse('probe-valid');
    assertDone(readAll([message]), splitMessage(message).body);
  });

  test('404 chunked без Content-Length — protocol', () => {
    assertFailed(readAll([httpProbeResponse('probe-wrong-path')]), 'protocol');
  });

  test('после итога push возвращает тот же итог', () => {
    const conn = rawConfiguratorConnections()[0];
    const frame = responseFrameOf(conn.s2c);
    const reader = new TcpFrameReader(DEFAULT_LIMITS);
    const done = reader.push(frame);
    assert.strictEqual(done.state, 'done');
    assert.strictEqual(reader.push(frame), done);
    assert.strictEqual(reader.push(conn.c2s), done);

    const failing = new TcpFrameReader(DEFAULT_LIMITS);
    const failed = failing.push(conn.c2s);
    assert.strictEqual(failed.state, 'failed');
    assert.strictEqual(failing.push(frame), failed);
  });
});
