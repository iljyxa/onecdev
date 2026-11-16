// Tcp-сервер, воспроизводящий снятый поток crserver по сценарию. Порядок шагов задаётся
// событиями (сколько байт принято), а не таймерами — тесты детерминированы.
import * as net from 'net';

export type ReplayStep =
  /** Отправить байты клиенту. */
  | { send: Buffer }
  /** Дождаться, пока от клиента придёт всего не меньше стольких байт. */
  | { expect: number }
  /** Закрыть свою сторону (FIN). */
  | { end: true };
// После последнего шага сервер держит соединение открытым: так делает crserver (08, A3).

export class ReplayConnection {
  private readonly chunks: Buffer[] = [];
  private total = 0;
  private isClosed = false;
  private readonly waiters: (() => void)[] = [];
  /** Разрешается, когда сокет закрыт (клиентом или сервером). */
  readonly closed: Promise<void>;

  constructor(readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.total += chunk.length;
      this.wake();
    });
    // Сброс соединения клиентом (destroy) — ожидаемый исход, а не ошибка теста.
    socket.on('error', () => undefined);
    this.closed = new Promise((resolve) => {
      socket.on('close', () => {
        this.isClosed = true;
        this.wake();
        resolve();
      });
    });
  }

  received(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** true — байт набралось; false — соединение закрылось раньше. */
  async receivedAtLeast(bytes: number): Promise<boolean> {
    while (this.total < bytes && !this.isClosed) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.total >= bytes;
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter();
    }
  }
}

export class ReplayServer {
  readonly connections: ReplayConnection[] = [];
  private readonly connectionWaiters: (() => void)[] = [];

  private constructor(
    private readonly server: net.Server,
    readonly port: number,
  ) {}

  /** steps-функция получает порт сервера: запрос http несёт его в Host, от этого зависит длина. */
  static async start(steps: ReplayStep[] | ((port: number) => ReplayStep[])): Promise<ReplayServer> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as net.AddressInfo;
    const replay = new ReplayServer(server, address.port);
    const script = typeof steps === 'function' ? steps(address.port) : steps;
    server.on('connection', (socket) => {
      const connection = new ReplayConnection(socket);
      replay.connections.push(connection);
      for (const waiter of replay.connectionWaiters.splice(0)) {
        waiter();
      }
      void play(connection, script);
    });
    return replay;
  }

  /** Ждёт index-е (с нуля) принятое соединение. */
  async connection(index: number): Promise<ReplayConnection> {
    while (this.connections.length <= index) {
      await new Promise<void>((resolve) => this.connectionWaiters.push(resolve));
    }
    return this.connections[index];
  }

  async close(): Promise<void> {
    for (const connection of this.connections) {
      connection.socket.destroy();
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}

async function play(connection: ReplayConnection, steps: ReplayStep[]): Promise<void> {
  for (const step of steps) {
    if ('send' in step) {
      connection.socket.write(step.send);
    } else if ('expect' in step) {
      if (!(await connection.receivedAtLeast(step.expect))) {
        return;
      }
    } else {
      connection.socket.end();
    }
  }
}

/** Сценарий по снятому соединению: приветствие, ожидание всего запроса клиента, остаток ответа. */
export function replayOf(c2s: Buffer, s2c: Buffer, greetingLength = 5): ReplayStep[] {
  return [{ send: s2c.subarray(0, greetingLength) }, { expect: c2s.length }, { send: s2c.subarray(greetingLength) }];
}

/** Сценарий http: приветствия нет — дождаться запроса целиком и отдать снятый ответ. */
export function httpReplayOf(requestLength: number, response: Buffer): ReplayStep[] {
  return [{ expect: requestLength }, { send: response }];
}
