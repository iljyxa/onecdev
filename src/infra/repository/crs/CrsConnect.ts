// Подключение по адресу хранилища — единая точка: разбор адреса, выбор транспорта и клиент с alias из
// адреса. Потребители не собирают CrsTcpTransport/CrsHttpTransport сами.
import { type CrsAddress, parseCrsAddress } from './CrsAddress';
import { CrsClient } from './CrsClient';
import type { CrsTlsOptions } from './CrsHttpFraming';
import { CrsHttpTransport } from './CrsHttpTransport';
import { CrsTcpTransport } from './CrsTcpTransport';
import type { CrsTransport } from './CrsTransport';

export interface CrsTransportFactoryOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Применяется только к https: настройки общие для всех адресов, для tcp и http они не нужны. */
  readonly tls?: CrsTlsOptions;
}

export interface CrsConnectOptions extends CrsTransportFactoryOptions {
  /** Известная версия сервера: рукопожатие пропускается. */
  readonly version?: string;
}

export function createCrsTransport(address: CrsAddress, options: CrsTransportFactoryOptions = {}): CrsTransport {
  const common = { timeoutMs: options.timeoutMs, maxResponseBytes: options.maxResponseBytes };
  if (address.transport === 'tcp') {
    return new CrsTcpTransport(address.endpoint, common);
  }
  return new CrsHttpTransport(address.endpoint, address.endpoint.scheme === 'https' ? { ...common, tls: options.tls } : common);
}

export function createCrsClient(address: string | CrsAddress, options: CrsConnectOptions = {}): CrsClient {
  const parsed = typeof address === 'string' ? parseCrsAddress(address) : address;
  return new CrsClient(createCrsTransport(parsed, options), { alias: parsed.alias, version: options.version });
}
