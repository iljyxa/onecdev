import { CrsAddressError, parseCrsAddress, type CrsAddress } from './crs/CrsAddress';
import type { CrsClient } from './crs/CrsClient';
import { createCrsClient, type CrsTransportFactoryOptions } from './crs/CrsConnect';
import { CrsCallError, type CrsCallErrorKind } from './crs/CrsErrors';
import { crsPasswordHash } from './crs/CrsSecrets';
import { devObjectsStatistic, type CrsDevObjectsStatistic } from './crs/CrsStatistic';
import { CrsTransportError, type CrsTransportErrorKind } from './crs/CrsTransport';
import { normalizeCrsVersionHint, runWithServerVersionRetry } from './crs/CrsVersionRetry';
import {
  RepositoryLockStatusError,
  type RepositoryLocation,
  type RepositoryLockReadContext,
  type RepositoryLockReadResult,
  type RepositoryLockStatusErrorCode,
  type RepositoryLockStatusSource,
  type RepositoryServerLockRecord,
} from './RepositoryLockStatusSource';

/**
 * Сервер хранилища (tcp/http/https): один вызов `DevDepot_devObjectsStatistic` — статистика
 * всех объектов с признаком захвата, держателем и временем захвата. Только чтение: база и
 * Конфигуратор не нужны, привязка (`crs:bind`) не передаётся. Протокол — клиент `crs/*`;
 * здесь только выбор версии, сведение ответа в записи и перевод отказов в коды источника.
 */

/** Общий дедлайн вызова: полная статистика большого хранилища идёт десятки секунд. */
export const NETWORK_LOCK_STATUS_TIMEOUT_MS = 60_000;
export const NETWORK_LOCK_STATUS_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;

const AUTH_HINT = 'Проверьте пользователя и пароль хранилища в «Подключить к хранилищу».';

// Коды ошибок проверки сертификата Node: сертификат не принят — это не «сервер недоступен».
const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const TLS_ERROR_PREFIX = /^ERR_(SSL|TLS)_/;

const TRANSPORT_CODES: Readonly<Record<CrsTransportErrorKind, RepositoryLockStatusErrorCode>> = {
  unavailable: 'unavailable',
  timeout: 'timeout',
  aborted: 'unavailable',
  closed: 'protocol',
  'too-large': 'too-large',
  protocol: 'protocol',
  status: 'server-error',
};

const CALL_CODES: Readonly<Record<CrsCallErrorKind, RepositoryLockStatusErrorCode>> = {
  'version-mismatch': 'version-mismatch',
  'auth-failed': 'auth-failed',
  'depot-not-found': 'server-error',
  'unknown-method': 'protocol',
  'bad-request': 'protocol',
  rejected: 'server-error',
  server: 'server-error',
  'malformed-response': 'protocol',
};

export class NetworkRepositoryLockStatusSource implements RepositoryLockStatusSource {
  private readonly options: CrsTransportFactoryOptions;

  constructor(options: CrsTransportFactoryOptions = {}) {
    this.options = { timeoutMs: NETWORK_LOCK_STATUS_TIMEOUT_MS, maxResponseBytes: NETWORK_LOCK_STATUS_MAX_RESPONSE_BYTES, ...options };
  }

  supports(location: RepositoryLocation): boolean {
    return location.kind === 'server';
  }

  async readLocks(location: RepositoryLocation, context: RepositoryLockReadContext): Promise<RepositoryLockReadResult> {
    if (location.kind !== 'server') {
      throw new RepositoryLockStatusError('invalid-address', `Адрес ${location.repoPath} не является адресом сервера хранилища.`);
    }
    let retriedWithVersion: string | undefined;
    try {
      const address = parseCrsAddress(location.repoPath);
      const auth = { user: context.user, passwordHash: crsPasswordHash(context.password) };
      const read = async (version: string | undefined): Promise<RepositoryLockReadResult> => {
        const client = this.client(address, version);
        // removed=false — те же байты запроса, что принимал сервер до переноса клиента (2.21-locks).
        const statistic = await devObjectsStatistic(client, auth, { removed: false });
        return { records: statisticToLockRecords(statistic), serverVersion: await client.serverVersion() };
      };
      return await runWithServerVersionRetry(normalizeCrsVersionHint(context.platformVersionHint), read, (serverVersion) => {
        retriedWithVersion = serverVersion;
      });
    } catch (error) {
      throw toRepositoryLockStatusError(error, retriedWithVersion);
    }
  }

  private client(address: CrsAddress, version: string | undefined): CrsClient {
    return createCrsClient(address, version === undefined ? this.options : { ...this.options, version });
  }
}

/** Захваты по статистике: держатель — по списку пользователей ответа; захват неизвестного пользователя не выводится. */
export function statisticToLockRecords(statistic: CrsDevObjectsStatistic): RepositoryServerLockRecord[] {
  const users = new Map(statistic.users.map((user) => [user.id, user.name]));
  const records: RepositoryServerLockRecord[] = [];
  for (const object of statistic.objects) {
    const user = object.lock === undefined ? undefined : users.get(object.lock.userId);
    if (object.lock !== undefined && user !== undefined) {
      records.push({ objectId: object.objectId, user, lockedAt: object.lock.date });
    }
  }
  return records;
}

/**
 * Отказ клиента crs → код источника статусов. Причина сохраняется в cause; в тексте — только сообщения
 * сервера или транспорта (без тела запроса, хеша пароля и исходной строки адреса).
 */
export function toRepositoryLockStatusError(error: unknown, retriedWithVersion?: string): RepositoryLockStatusError {
  if (error instanceof RepositoryLockStatusError) {
    return error;
  }
  if (error instanceof CrsTransportError) {
    const code = TRANSPORT_CODES[error.kind];
    const tls = code === 'unavailable' && isTlsFailure(error.details.cause);
    return new RepositoryLockStatusError(tls ? 'tls' : code, error.message, { cause: error });
  }
  if (error instanceof CrsCallError) {
    const code = CALL_CODES[error.kind];
    const messages = error.details.messages ?? [];
    const text = messages.length > 0 ? messages.join(' ') : error.message;
    const suffix = code === 'auth-failed'
      ? ` ${AUTH_HINT}`
      : code === 'version-mismatch' && retriedWithVersion !== undefined
        ? ` (повтор с версией сервера ${retriedWithVersion} не помог)`
        : '';
    return new RepositoryLockStatusError(code, `${text}${suffix}`, { cause: error });
  }
  if (error instanceof CrsAddressError) {
    // Сообщение разбора адреса уже называет адрес хранилища — без повторного префикса.
    const text = `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.`;
    return new RepositoryLockStatusError('invalid-address', text, { cause: error });
  }
  if (error instanceof RangeError) {
    return new RepositoryLockStatusError('invalid-address', `Неверный адрес хранилища: ${error.message}.`, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new RepositoryLockStatusError('protocol', `Сбой обмена с сервером хранилища: ${message}`, { cause: error });
}

function isTlsFailure(cause: NodeJS.ErrnoException | undefined): boolean {
  const code = String(cause?.code);
  return TLS_ERROR_CODES.has(code) || TLS_ERROR_PREFIX.test(code);
}
