// Локальный crserver для интеграционных тестов протокола crs: свободные порты, пустой каталог данных,
// гарантированная остановка (SIGTERM, затем SIGKILL по дедлайну) и удаление каталога.
import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { findClosedPort } from './repositoryLockFixtures';

const DEFAULT_CRSERVER = '/opt/1cv8/x86_64/8.5.1.1529/crserver';
const START_DEADLINE_MS = 10_000;
const STOP_DEADLINE_MS = 5_000;
const POLL_MS = 100;
const RANGE_SIZE = 10;
const RANGE_ATTEMPTS = 20;

export interface LocalCrserver {
  readonly port: number;
  stop(): Promise<void>;
}

/** Путь к crserver или undefined, если платформы на машине нет. */
export function crserverPath(): string | undefined {
  const file = process.env.CRS_TEST_CRSERVER ?? DEFAULT_CRSERVER;
  return fs.existsSync(file) ? file : undefined;
}

/** Слушает ли кто-нибудь порт на 127.0.0.1: готовность crserver и apache видна только так. */
export function loopbackPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Пауза опроса; таймер не переживает промис, поэтому снимать его нечего. */
export function pollDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

/** Завершился ли процесс за ms; таймер ожидания снимается при выходе процесса. */
export function processExited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Начальный порт свободного диапазона RANGE_SIZE портов (-range crserver), проверяется весь диапазон. */
async function freeRangeStart(): Promise<number> {
  for (let attempt = 0; attempt < RANGE_ATTEMPTS; attempt++) {
    const base = await findClosedPort();
    const checks = await Promise.all(Array.from({ length: RANGE_SIZE }, (_, i) => loopbackPortOpen(base + i)));
    if (checks.every((occupied) => !occupied)) {
      return base;
    }
  }
  throw new Error(`Не найден свободный диапазон из ${String(RANGE_SIZE)} портов за ${String(RANGE_ATTEMPTS)} попыток`);
}

export async function startCrserver(file: string): Promise<LocalCrserver> {
  const port = await findClosedPort();
  const range = await freeRangeStart();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-test-'));
  const child = spawn(file, ['-port', String(port), '-range', `${String(range)}:${String(range + RANGE_SIZE - 1)}`, '-d', dir], {
    stdio: 'ignore',
  });

  let spawnError: Error | undefined;
  child.once('error', (err) => {
    spawnError = err;
  });

  const stop = async (): Promise<void> => {
    child.kill('SIGTERM');
    if (!(await processExited(child, STOP_DEADLINE_MS))) {
      child.kill('SIGKILL');
      await processExited(child, STOP_DEADLINE_MS);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  // Готовность — по опросу порта: crserver не сообщает о ней иначе.
  const deadline = Date.now() + START_DEADLINE_MS;
  while (!(await loopbackPortOpen(port))) {
    if (spawnError !== undefined) {
      await stop();
      throw new Error(`crserver не удалось запустить: ${spawnError.message}`);
    }
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
      await stop();
      throw new Error(`crserver не начал слушать порт ${String(port)} за ${String(START_DEADLINE_MS)} мс`);
    }
    await pollDelay();
  }
  return { port, stop };
}
