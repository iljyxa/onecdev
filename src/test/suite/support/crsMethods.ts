// Общее для тестов методов crs (depot, statistic): клиент над снятыми ответами и разбор снятого
// запроса в входные данные метода. Разбор запроса — регулярными выражениями, независимо от конверта.
import * as assert from 'assert';
import { CrsClient } from '../../../infra/repository/crs/CrsClient';
import type { CrsAuth } from '../../../infra/xml/crs/CrsEnvelope';
import { CrsCallError } from '../../../infra/repository/crs/CrsErrors';
import type { CrsTransportError } from '../../../infra/repository/crs/CrsTransport';
import { RecordedTransport } from './crsRecordedTransport';

/** Версия стенда: клиент не делает рукопожатия, первый запрос транспорта — сам метод. */
export const STAND_VERSION = '8.5.1.1529';

export function recordedClient(outcomes: readonly (Buffer | CrsTransportError)[]): { client: CrsClient; transport: RecordedTransport } {
  const transport = new RecordedTransport(outcomes);
  return { client: new CrsClient(transport, { alias: 'exp', version: STAND_VERSION }), transport };
}

/** Отказ промиса; успех — провал теста. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => assert.fail('ожидался отказ'),
    (e: unknown) => e,
  );
}

export async function callRejection(promise: Promise<unknown>): Promise<CrsCallError> {
  const error = await rejection(promise);
  assert.ok(error instanceof CrsCallError, String(error));
  return error;
}

function unescape(value: string): string {
  return value.replace(/&quot;/g, '"');
}

/** Входные данные снятого запроса: учётные данные конверта, привязка и скалярные параметры. */
export interface RequestInputs {
  auth?: CrsAuth;
  bindId?: string;
  /** `<crs:name value="…"/>` внутри crs:params, первое вхождение имени. */
  params: Map<string, string>;
  /** Значения `<crs:value value="…"/>` внутри crs:objRefs. */
  objRefs: string[];
}

export function inputsOf(request: Buffer): RequestInputs {
  const text = request.toString('utf-8');
  const auth = /<crs:auth user="([^"]*)" password="([^"]*)"\/>/.exec(text);
  const bind = /<crs:bind bindID="([^"]*)"\/>/.exec(text);
  const params = /<crs:params>(.*)<\/crs:params>/.exec(text)?.[1] ?? '';
  const result: RequestInputs = { params: new Map(), objRefs: [] };
  if (auth) {
    result.auth = { user: auth[1], passwordHash: auth[2] };
  }
  if (bind) {
    result.bindId = bind[1];
  }
  for (const m of params.matchAll(/<crs:(\w+) value="([^"]*)"\/>/g)) {
    if (m[1] !== 'value' && !result.params.has(m[1])) {
      result.params.set(m[1], unescape(m[2]));
    }
  }
  const refs = /<crs:objRefs>(.*)<\/crs:objRefs>/.exec(params)?.[1] ?? '';
  result.objRefs = [...refs.matchAll(/<crs:value value="([^"]*)"\/>/g)].map((m) => m[1]);
  return result;
}

/** Обязательный параметр снятого запроса. */
export function param(params: ReadonlyMap<string, string>, name: string): string {
  const value = params.get(name);
  assert.ok(value !== undefined, `в запросе нет crs:${name}`);
  return value;
}

/** Хеши паролей в теле: `<crs:password value="…"/>` ответов и authenticate, `password="…"` конверта. */
export function passwordHashesIn(body: Buffer): string[] {
  const text = body.toString('utf-8');
  return [...text.matchAll(/(?:<crs:password value="|<crs:auth user="[^"]*" password=")([0-9a-f]{32})"/g)].map((m) => m[1]);
}

/** Ни одного хеша из тел в сериализованном результате или ошибке. */
export function assertNoHashes(value: unknown, ...bodies: Buffer[]): void {
  const hashes = bodies.flatMap(passwordHashesIn);
  const text = value instanceof Error ? `${value.message} ${JSON.stringify(value)}` : JSON.stringify(value);
  for (const hash of hashes) {
    assert.ok(!text.includes(hash), `в результате хеш ${hash}`);
  }
}

export function attr(text: string, pattern: RegExp): string {
  const m = pattern.exec(text);
  assert.ok(m, String(pattern));
  return unescape(m[1]);
}
