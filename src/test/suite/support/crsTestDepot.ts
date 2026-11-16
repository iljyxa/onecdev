// crserver с настоящим хранилищем для интеграционных тестов методов чтения crs. Хранилище собирает
// платформа (ibcmd, 1cv8 под xvfb-run) скриптом example/tools/crs/test-depot.mjs — тем же стендом, что
// снимает корпус example/crs; здесь только запуск дочернего процесса, ожидание готовности и остановка.
//
// Скрипт запускается только отдельным процессом: стенд при импорте вешает на SIGINT/SIGTERM/SIGHUP
// process.exit, а в extension host это уронило бы весь прогон тестов.
//
// Пользователи хранилища: Admin (пароль пустой), Petrov (LockObjects, 123), Reader (ReadOnly, 789).
// Без crserver, ibcmd, 1cv8 рядом с ним или xvfb-run `startTestDepot` возвращает undefined — suite в pending.
import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ROOT } from './crsFixtures';
import { crserverPath, processExited } from './crsLocalServer';
import { EXAMPLE_CF_221 } from './repositoryLockFixtures';

/** Выгрузка, из которой по умолчанию собирается хранилище (только чтение). */
export const TEST_DEPOT_CONFIG = EXAMPLE_CF_221;

// Замер на машине разработки (платформа 8.5.1.1529, example/2.21/src/cf): сборка — около 17 с. Дедлайн —
// max(240 с, 3 × замер) с запасом на медленную машину CI.
export const BUILD_DEADLINE_MS = 240_000;
const STOP_DEADLINE_MS = 15_000;
// Лимит накопленного вывода скрипта: для диагностики сбоя нужен только хвост stderr.
const MAX_LOG_CHARS = 64 * 1024;
const STDERR_TAIL_LINES = 15;

export const TEST_DEPOT_USERS = {
  admin: { user: 'Admin', password: '' },
  petrov: { user: 'Petrov', password: '123' },
  reader: { user: 'Reader', password: '789' },
} as const;

export interface TestDepot {
  /** tcp-порт crserver на 127.0.0.1. */
  readonly port: number;
  /** Алиас хранилища в адресе: `tcp://127.0.0.1:<port>/<alias>`. */
  readonly alias: string;
  /** Остановка crserver и удаление рабочего каталога. */
  stop(): Promise<void>;
}

/** Есть ли на машине всё для сборки хранилища: crserver, ibcmd, 1cv8 рядом с ним и xvfb-run в PATH. */
export function testDepotAvailable(): boolean {
  const crserver = crserverPath();
  if (!crserver) {
    return false;
  }
  const dir = path.dirname(crserver);
  const tools = [path.join(dir, 'ibcmd'), path.join(dir, '1cv8')];
  const onPath = (process.env.PATH ?? '').split(path.delimiter).some((entry) => entry !== '' && fs.existsSync(path.join(entry, 'xvfb-run')));
  return tools.every((file) => fs.existsSync(file)) && onPath;
}

async function stopScript(child: ChildProcess, work: string): Promise<void> {
  // Закрытие stdin — штатный сигнал остановки скрипта; SIGTERM/SIGKILL — на случай, если он завис.
  child.stdin?.end();
  if (!(await processExited(child, STOP_DEADLINE_MS))) {
    child.kill('SIGTERM');
    if (!(await processExited(child, STOP_DEADLINE_MS))) {
      child.kill('SIGKILL');
      await processExited(child, STOP_DEADLINE_MS);
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
}

interface ReadyLine {
  readonly ready: boolean;
  readonly port: number;
  readonly alias: string;
}

/**
 * Хранилище из выгрузки config; undefined — на машине нет платформы. Сбой или таймаут сборки — отказ с
 * хвостом stderr скрипта: при наличии платформы это дефект, а не повод для pending.
 */
export function startTestDepot(config: string = TEST_DEPOT_CONFIG): Promise<TestDepot | undefined> {
  const crserver = crserverPath();
  if (!crserver || !testDepotAvailable()) {
    return Promise.resolve(undefined);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-depot-'));
  const script = path.join(ROOT, 'example', 'tools', 'crs', 'test-depot.mjs');
  // Extension host — это Electron: без ELECTRON_RUN_AS_NODE он запустил бы своё окно вместо скрипта.
  const child = spawn(process.execPath, [script, '--config', config, work], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', V8: path.dirname(crserver) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf-8')).slice(-MAX_LOG_CHARS);
  });
  const stop = (): Promise<void> => stopScript(child, work);
  return new Promise<TestDepot>((resolve, reject) => {
    let settled = false;
    const fail = (reason: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void stop().finally(() => {
        reject(new Error(`${reason}\n${stderr.split('\n').slice(-STDERR_TAIL_LINES).join('\n')}`));
      });
    };
    const timer = setTimeout(() => {
      fail(`хранилище не собралось за ${String(BUILD_DEADLINE_MS)} мс`);
    }, BUILD_DEADLINE_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      // После готовности stdout скрипта не читается: копить нечего.
      if (settled) {
        return;
      }
      stdout = (stdout + chunk.toString('utf-8')).slice(-MAX_LOG_CHARS);
      // Только законченные строки: чанк может оборваться посреди JSON.
      const line = stdout.split('\n').slice(0, -1).find((l) => l.startsWith('{'));
      if (line === undefined) {
        return;
      }
      let ready: ReadyLine;
      try {
        ready = JSON.parse(line) as ReadyLine;
      } catch {
        fail(`скрипт хранилища выдал не JSON: ${line}`);
        return;
      }
      if (!ready.ready) {
        fail('скрипт хранилища сообщил о неготовности');
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ port: ready.port, alias: ready.alias, stop });
    });
    child.once('error', (error) => {
      fail(`скрипт хранилища не запустился: ${error.message}`);
    });
    child.once('exit', (code) => {
      fail(`скрипт хранилища завершился с кодом ${String(code)} до готовности`);
    });
  });
}

/** uuid корня конфигурации — `<Configuration uuid="…">` в Configuration.xml выгрузки. */
export function configRootId(configRoot: string): string {
  const text = fs.readFileSync(path.join(configRoot, 'Configuration.xml'), 'utf-8');
  const id = /<Configuration uuid="([0-9a-f-]{36})"/.exec(text)?.[1];
  if (id === undefined) {
    throw new Error(`${configRoot}: в Configuration.xml нет <Configuration uuid="…">`);
  }
  return id;
}

/**
 * uuid единиц хранилища: записи ConfigDumpInfo.xml с собственной версией (`configVersion`) и uuid без точки —
 * объекты, их формы и макеты; порождённые типы (`<uuid>.0`) и дочерние элементы без версии в хранилище
 * отдельными объектами не живут. Сверено с example/repository/2.21-locks (statistic-admin): 107 единиц.
 */
export function depotUnitIds(configRoot: string): ReadonlySet<string> {
  const text = fs.readFileSync(path.join(configRoot, 'ConfigDumpInfo.xml'), 'utf-8');
  return new Set(Array.from(text.matchAll(/ id="([^".]{36})" configVersion=/g), (m) => m[1]));
}
