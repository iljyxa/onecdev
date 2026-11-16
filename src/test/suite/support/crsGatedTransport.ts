// Транспорт, у которого каждый вызов висит, пока тест не решит его судьбу: release(i, тело) или
// fail(i, ошибка). Нужен, чтобы проверять запросы «в полёте» (дедупликация, отмена) без таймингов.
// Тела ответов — настоящие, снятые с crserver; транспорт лишь задерживает их выдачу.
import * as assert from 'assert';
import { type CrsCallOptions, type CrsTransport, CrsTransportError } from '../../../infra/repository/crs/CrsTransport';

interface Call {
  readonly resolve: (body: Buffer) => void;
  readonly reject: (error: Error) => void;
}

const ENDPOINT = 'tcp://127.0.0.1:1542';

export class GatedTransport implements CrsTransport {
  readonly requests: Buffer[] = [];
  readonly options: (CrsCallOptions | undefined)[] = [];
  private readonly calls: Call[] = [];
  private readonly waiters: { count: number; resolve: () => void }[] = [];

  /** honorAbort=false — транспорт игнорирует сигнал: так проверяется запоздалый ответ отменённой загрузки. */
  constructor(private readonly honorAbort = true) {}

  call(body: Buffer, options?: CrsCallOptions): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this.requests.push(body);
      this.options.push(options);
      this.calls.push({ resolve, reject });
      const signal = options?.signal;
      if (this.honorAbort && signal !== undefined) {
        const abort = (): void => {
          reject(new CrsTransportError('aborted', 'вызов отменён', { endpoint: ENDPOINT }));
        };
        if (signal.aborted) {
          abort();
        } else {
          signal.addEventListener('abort', abort, { once: true });
        }
      }
      for (const waiter of this.waiters.filter((w) => w.count <= this.requests.length)) {
        waiter.resolve();
      }
    });
  }

  /** Резолвится, когда транспорт получил не меньше count запросов. */
  whenRequests(count: number): Promise<void> {
    if (this.requests.length >= count) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  release(index: number, body: Buffer): void {
    this.callAt(index).resolve(body);
  }

  fail(index: number, error: Error): void {
    this.callAt(index).reject(error);
  }

  private callAt(index: number): Call {
    const call = this.calls[index];
    assert.ok(call, `запроса №${String(index)} не было`);
    return call;
  }
}
