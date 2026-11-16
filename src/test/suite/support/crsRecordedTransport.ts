// Транспорт с заранее заданными исходами: настоящие тела ответов crserver или ошибки транспорта.
// Нужен тестам конверта, где сеть не проверяется, а важны запросы клиента и разбор ответов.
import * as assert from 'assert';
import type { CrsCallOptions, CrsTransport, CrsTransportError } from '../../../infra/repository/crs/CrsTransport';

export class RecordedTransport implements CrsTransport {
  readonly requests: { body: Buffer; options: CrsCallOptions | undefined }[] = [];
  private readonly queue: (Buffer | CrsTransportError)[];

  constructor(outcomes: readonly (Buffer | CrsTransportError)[]) {
    this.queue = [...outcomes];
  }

  call(body: Buffer, options?: CrsCallOptions): Promise<Buffer> {
    this.requests.push({ body, options });
    const outcome = this.queue.shift();
    if (outcome === undefined) {
      assert.fail(`лишний вызов транспорта №${String(this.requests.length)}`);
    }
    return Buffer.isBuffer(outcome) ? Promise.resolve(outcome) : Promise.reject(outcome);
  }

  /** Все ли заданные исходы израсходованы. */
  get exhausted(): boolean {
    return this.queue.length === 0;
  }
}
