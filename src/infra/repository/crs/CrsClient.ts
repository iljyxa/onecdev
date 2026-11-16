// Клиент протокола crs поверх любого транспорта: рукопожатие по версии, сборка конверта и перевод
// ответов и отказов в CrsCallError. crserver принимает только конверт с точной версией своей
// платформы (8.3.27.2342 против 8.5.1.1529 — отказ), а версию сообщает в исключении на чужую.
import {
  buildCallBody,
  type CrsAuth,
  type CrsCallSpec,
  type CrsElement,
  type CrsResponse,
  crsValue,
  parseCallResponse,
  parseVrsException,
} from '../../xml/crs/CrsEnvelope';
import { CrsCallError, type CrsCallErrorDetails, type CrsCallErrorKind, type CrsFormatError } from './CrsErrors';
import { classifyServerException, classifyVrsException } from './CrsException';
import { type CrsCallOptions, type CrsTransport, CrsTransportError } from './CrsTransport';
import type { CrsXmlElement } from '../../xml/crs/CrsXmlReader';

/** Заведомо чужая версия: сервер отвечает исключением со своей версией в тексте. */
export const CRS_VERSION_PROBE = '0.0.0.0';

const VERSION_FORMAT = /^\d+\.\d+\.\d+\.\d+$/;

/** Версия сервера хранилища вида N.N.N.N (`8.5.1.1529`); подсказка иной формы рукопожатие не пропускает. */
export function isCrsServerVersion(value: string): boolean {
  return VERSION_FORMAT.test(value);
}

const OPEN_DEV_DEPOT = 'DevDepotAdmin_openDevDepot';

export interface CrsClientOptions {
  readonly alias: string;
  /** Известная версия сервера: рукопожатие пропускается. Не вида N.N.N.N — RangeError. */
  readonly version?: string;
}

export interface CrsInvocation {
  readonly method: string;
  readonly auth?: CrsAuth;
  readonly bindId?: string;
  readonly params?: readonly CrsElement[];
}

export class CrsClient {
  // Кэшируется только успех: после отказа следующий вызов снова пробует рукопожатие.
  private version: string | undefined;

  constructor(
    private readonly transport: CrsTransport,
    private readonly options: CrsClientOptions,
  ) {
    if (options.version !== undefined && !isCrsServerVersion(options.version)) {
      throw new RangeError(`версия сервера хранилища должна быть вида N.N.N.N, получено «${options.version}»`);
    }
    this.version = options.version;
  }

  /** Alias хранилища из адреса: его же openDevDepot передаёт параметром crs:alias (tcp/lock-one/01). */
  get alias(): string {
    return this.options.alias;
  }

  /**
   * openDevDepot с версией 0.0.0.0 → версия из version-mismatch. call_return → CrsCallError('version-mismatch')
   * без serverVersion; прочие отказы пробрасываются.
   */
  async serverVersion(options?: CrsCallOptions): Promise<string> {
    this.version ??= await this.handshake(options);
    return this.version;
  }

  /**
   * Корень crs:call_return. exception → классифицированная CrsCallError; пустое тело → 'unknown-method';
   * тело не crs → 'malformed-response'; статус с телом VRS → 'bad-request' | 'rejected'; прочие
   * CrsTransportError — как есть. version-mismatch сбрасывает кэш версии, автоповтора нет.
   */
  async call(invocation: CrsInvocation, options?: CrsCallOptions): Promise<CrsXmlElement> {
    const version = await this.serverVersion(options);
    return this.invoke({ ...invocation, alias: this.options.alias, version }, options);
  }

  private async handshake(options: CrsCallOptions | undefined): Promise<string> {
    // openDevDepot — частный вызов рукопожатия; публичный метод открытия хранилища живёт выше.
    const params = [crsValue('alias', this.options.alias), crsValue('convert', false)];
    try {
      await this.invoke({ alias: this.options.alias, method: OPEN_DEV_DEPOT, version: CRS_VERSION_PROBE, params }, options);
    } catch (e) {
      if (e instanceof CrsCallError && e.details.serverVersion !== undefined) {
        return e.details.serverVersion;
      }
      throw e;
    }
    throw new CrsCallError('version-mismatch', `${OPEN_DEV_DEPOT}: сервер принял версию ${CRS_VERSION_PROBE} и не сообщил свою`, {
      method: OPEN_DEV_DEPOT,
    });
  }

  private async invoke(spec: CrsCallSpec, options: CrsCallOptions | undefined): Promise<CrsXmlElement> {
    const method = spec.method;
    let body: Buffer;
    try {
      body = await this.transport.call(buildCallBody(spec), options);
    } catch (e) {
      throw fromTransport(e, method);
    }
    let response: CrsResponse;
    try {
      response = parseCallResponse(body);
    } catch (e) {
      // parseCallResponse отказывает только CrsFormatError.
      throw new CrsCallError('malformed-response', `${method}: ответ сервера не похож на ответ crserver`, {
        method,
        cause: e as CrsFormatError,
      });
    }
    if (response.kind === 'return') {
      return response.element;
    }
    if (response.kind === 'empty') {
      throw new CrsCallError('unknown-method', `${method}: пустой ответ — сервер не знает такого метода`, { method });
    }
    const { clsid, code, messages } = response.exception;
    const { kind, serverVersion } = classifyServerException(response.exception);
    if (kind === 'version-mismatch') {
      this.version = undefined;
    }
    throw callError(kind, method, messages, { clsid, code, serverVersion });
  }
}

function callError(
  kind: CrsCallErrorKind,
  method: string,
  messages: readonly string[],
  details: Omit<CrsCallErrorDetails, 'method' | 'messages'>,
): CrsCallError {
  // В сообщении — только метод и тексты сервера: тело запроса несёт хеш пароля.
  return new CrsCallError(kind, `${method}: ${messages.join(' ')}`, { method, messages, ...details });
}

/** Статус с телом исключения VRS — отказ сервера, а не транспорта; остальное пробрасывается как есть. */
function fromTransport(e: unknown, method: string): unknown {
  const body = e instanceof CrsTransportError && e.kind === 'status' ? e.details.body : undefined;
  const vrs = body === undefined ? undefined : parseVrsException(body);
  if (vrs === undefined) {
    return e;
  }
  const error = e as CrsTransportError;
  return callError(classifyVrsException(vrs), method, [vrs.description], {
    clsid: vrs.clsid,
    status: error.details.status,
    cause: error,
  });
}
