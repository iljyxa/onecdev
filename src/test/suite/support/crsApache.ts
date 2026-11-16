// Свой apache на 127.0.0.1 с модулем wsap24.so для интеграционных тестов транспорта http: публикация
// repo.1ccr указывает на локальный crserver. Конфигурация — как у стенда (example/tools/crs/stand.mjs,
// startApache); запуск и остановка — с дедлайном, каталог удаляется и при сбое запуска.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { crserverPath, loopbackPortOpen, pollDelay } from './crsLocalServer';
import { findClosedPort } from './repositoryLockFixtures';

const DEFAULT_APACHE = '/usr/sbin/apache2';
const DEFAULT_MODULES = '/usr/lib/apache2/modules';
const COMMAND_DEADLINE_MS = 10_000;
const START_DEADLINE_MS = 10_000;
const STOP_DEADLINE_MS = 5_000;

export interface LocalApache {
  readonly port: number;
  /** Путь публикации до .1ccr включительно. */
  readonly path: string;
  stop(): Promise<void>;
}

export interface ApachePaths {
  readonly apache: string;
  readonly modules: string;
  readonly wsap: string;
}

/** Пути apache, его модулей и wsap24.so (рядом с crserver) или undefined, если чего-то нет. */
export function apachePaths(): ApachePaths | undefined {
  const crserver = crserverPath();
  if (!crserver) {
    return undefined;
  }
  const paths = {
    apache: process.env.CRS_TEST_APACHE ?? DEFAULT_APACHE,
    modules: process.env.CRS_TEST_APACHE_MODULES ?? DEFAULT_MODULES,
    wsap: path.join(path.dirname(crserver), 'wsap24.so'),
  };
  const required = [paths.apache, path.join(paths.modules, 'mod_mpm_prefork.so'), paths.wsap];
  return required.every((file) => fs.existsSync(file)) ? paths : undefined;
}

function command(apache: string, conf: string, action: 'start' | 'stop'): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(apache, ['-f', conf, '-k', action], { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, COMMAND_DEADLINE_MS);
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (status === 0) {
        resolve();
      } else {
        reject(new Error(`apache -k ${action}: код ${String(status)}\n${Buffer.concat(stderr).toString('utf-8')}`));
      }
    });
  });
}

function processAlive(pidFile: string): boolean {
  if (!fs.existsSync(pidFile)) {
    return false;
  }
  try {
    process.kill(Number(fs.readFileSync(pidFile, 'utf-8').trim()), 0);
    return true;
  } catch {
    return false;
  }
}

export async function startApache(crserverPort: number, alias: string): Promise<LocalApache> {
  const paths = apachePaths();
  if (!paths) {
    throw new Error('apache или wsap24.so не найдены');
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-apache-'));
  const www = path.join(root, 'www');
  fs.mkdirSync(path.join(root, 'logs'));
  fs.mkdirSync(www);
  fs.writeFileSync(
    path.join(www, 'repo.1ccr'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<repository connectString="tcp://127.0.0.1:${String(crserverPort)}/${alias}"/>\n`,
  );
  const port = await findClosedPort();
  const conf = path.join(root, 'httpd.conf');
  const pidFile = path.join(root, 'httpd.pid');
  // mime_module и log_config_module не загружаются: первому нужен mime.types, второй встроен.
  fs.writeFileSync(
    conf,
    [
      `ServerRoot "${root}"`,
      `PidFile "${pidFile}"`,
      `Listen 127.0.0.1:${String(port)}`,
      'ServerName localhost',
      `LoadModule mpm_prefork_module ${paths.modules}/mod_mpm_prefork.so`,
      `LoadModule authz_core_module ${paths.modules}/mod_authz_core.so`,
      `LoadModule alias_module ${paths.modules}/mod_alias.so`,
      `LoadModule _1cws_module "${paths.wsap}"`,
      `ErrorLog "${path.join(root, 'logs', 'error.log')}"`,
      'LogLevel warn',
      `Alias "/repo" "${www}"`,
      `<Directory "${www}">`,
      '    AllowOverride None',
      '    Options None',
      '    Require all granted',
      '    SetHandler 1c-application',
      '</Directory>',
      '',
    ].join('\n'),
  );
  const stop = async (): Promise<void> => {
    await command(paths.apache, conf, 'stop').catch(() => undefined);
    // -k stop только посылает сигнал: ждём, пока процесс уйдёт, иначе каталог удалится из-под него.
    const deadline = Date.now() + STOP_DEADLINE_MS;
    while (processAlive(pidFile) && Date.now() < deadline) {
      await pollDelay();
    }
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    await command(paths.apache, conf, 'start');
    const deadline = Date.now() + START_DEADLINE_MS;
    while (!(await loopbackPortOpen(port))) {
      if (Date.now() > deadline) {
        throw new Error(`apache не начал слушать порт ${String(port)} за ${String(START_DEADLINE_MS)} мс`);
      }
      await pollDelay();
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { port, path: '/repo/repo.1ccr', stop };
}
