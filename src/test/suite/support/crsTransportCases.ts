// Параметризация тестов по транспорту {tcp, http}: для каждого — адрес, фабрика и снятые обмены.
// Общее поведение (дедлайн, отмена, лимиты, закрытие) проверяется одним набором тестов на обоих.
import { CrsHttpTransport } from '../../../infra/repository/crs/CrsHttpTransport';
import { CrsTcpTransport } from '../../../infra/repository/crs/CrsTcpTransport';
import type { CrsTransport } from '../../../infra/repository/crs/CrsTransport';
import {
  clientIdFromHello,
  expectedHttpRequest,
  httpRawProbe,
  httpRawProbeBodies,
  type RawConnection,
  rawConfiguratorConnections,
  readFixture,
  requestBodyOf,
  responseFrameOf,
  splitMessage,
  splitTcpFrame,
  tcpProbe,
} from './crsFixtures';
import { httpReplayOf, replayOf, type ReplayStep } from './crsReplayServer';

export const HTTP_PATH = '/repo/repo.1ccr';

export interface TransportCreateOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxHeaderBytes?: number;
}

/**
 * Снятый обмен: тело запроса, ожидаемые байты на проводе, шаги сервера, байты ответа после preamble
 * (приветствия сервера tcp) и тело ответа.
 */
export interface RecordedExchange {
  readonly body: Buffer;
  readonly wire: (port: number) => Buffer;
  readonly steps: (port: number) => ReplayStep[];
  readonly response: Buffer;
  readonly responseBody: Buffer;
}

export interface TransportCase {
  readonly name: 'tcp' | 'http';
  readonly endpoint: (port: number) => string;
  readonly create: (port: number, options?: TransportCreateOptions) => CrsTransport;
  /** Проба стенда tcp-raw/<name> или http-raw/<name>: запрос стенда и настоящий ответ. */
  readonly probe: (name: string) => RecordedExchange;
  /** Что сервер шлёт до запроса: приветствие crserver по tcp, по http — ничего. */
  readonly preamble: ReplayStep[];
  /** Успешный обмен (openDevDepot Конфигуратора) и длины заголовков и тела его ответа. */
  readonly ok: RecordedExchange & { headLength: number; contentLength: number };
  /** Неверный пароль: DevDepot_authenticate Конфигуратора и ответ call_exception. */
  readonly authFailed: RecordedExchange;
  /** Тело «не xml»: сервер отвечает 400 с исключением разбора XML. */
  readonly malformed: RecordedExchange & { status: 400 };
  /** Настоящие байты чужого протокола вместо ответа. */
  readonly foreign: ReplayStep[];
}

const first = rawConfiguratorConnections()[0];
// Пробы tcp-raw сняты с приветствием первого соединения Конфигуратора, поэтому UUID клиента общий.
const TCP_CLIENT_ID = clientIdFromHello(first.c2s);
const TCP_GREETING = first.s2c.subarray(0, 5);

function tcpProbeExchange(name: string): RecordedExchange {
  const { request, response } = tcpProbe(name);
  return {
    body: requestBodyOf(request),
    wire: () => request,
    steps: () => replayOf(request, response),
    response: responseFrameOf(response),
    responseBody: splitTcpFrame(responseFrameOf(response)).body,
  };
}

function httpProbeExchange(name: string): RecordedExchange {
  const { request, response } = httpRawProbeBodies(name);
  const raw = httpRawProbe(name).response;
  return {
    body: request,
    wire: (port) => expectedHttpRequest(port, request),
    steps: (port) => httpReplayOf(expectedHttpRequest(port, request).length, raw),
    response: raw,
    responseBody: response.body,
  };
}

const firstResponse = splitTcpFrame(responseFrameOf(first.s2c));

function tcpConnectionExchange(conn: RawConnection): RecordedExchange {
  return {
    body: requestBodyOf(conn.c2s),
    wire: () => conn.c2s,
    steps: () => replayOf(conn.c2s, conn.s2c),
    response: responseFrameOf(conn.s2c),
    responseBody: splitTcpFrame(responseFrameOf(conn.s2c)).body,
  };
}

/** Обмен Конфигуратора из корпуса http/: тело запроса и ответ — заголовки + пустая строка + тело. */
function httpCorpusExchange(scenario: string, request: string, response: string): RecordedExchange {
  const body = readFixture('http', scenario, `${request}.xml`);
  const raw = Buffer.concat([readFixture('http', scenario, `${response}.headers.txt`), Buffer.from('\r\n', 'latin1'), readFixture('http', scenario, `${response}.xml`)]);
  return {
    body,
    wire: (port) => expectedHttpRequest(port, body),
    steps: (port) => httpReplayOf(expectedHttpRequest(port, body).length, raw),
    response: raw,
    responseBody: splitMessage(raw).body,
  };
}

const tcp: TransportCase = {
  name: 'tcp',
  endpoint: (port) => `tcp://127.0.0.1:${String(port)}`,
  create: (port, options = {}) => new CrsTcpTransport({ host: '127.0.0.1', port }, { clientId: TCP_CLIENT_ID, ...options }),
  probe: tcpProbeExchange,
  preamble: [{ send: TCP_GREETING }],
  ok: { ...tcpConnectionExchange(first), headLength: firstResponse.headLength, contentLength: firstResponse.contentLength },
  authFailed: tcpConnectionExchange(rawConfiguratorConnections()[1]),
  malformed: { ...tcpProbeExchange('probe-malformed-body'), status: 400 },
  // Ответ публикации http вместо приветствия crserver.
  foreign: [{ send: httpRawProbe('probe-valid').response }],
};

const valid = httpRawProbe('probe-valid');
const validResponse = splitMessage(valid.response);

const http: TransportCase = {
  name: 'http',
  endpoint: (port) => `http://127.0.0.1:${String(port)}${HTTP_PATH}`,
  create: (port, options = {}) => new CrsHttpTransport({ scheme: 'http', host: '127.0.0.1', port, path: HTTP_PATH }, options),
  probe: httpProbeExchange,
  preamble: [],
  ok: { ...httpProbeExchange('probe-valid'), headLength: validResponse.headLength, contentLength: validResponse.contentLength },
  authFailed: httpCorpusExchange('lock-wrong-password', '03-conn-02-c2s-DevDepot_authenticate', '04-conn-02-s2c-call_exception'),
  malformed: { ...httpProbeExchange('probe-malformed-body'), status: 400 },
  // Приветствие и кадр ответа crserver по tcp вместо ответа http.
  foreign: [{ send: readFixture('tcp-raw', 'wrong-password', 'conn-01.s2c.bin') }],
};

export const TRANSPORT_CASES: readonly TransportCase[] = [tcp, http];
