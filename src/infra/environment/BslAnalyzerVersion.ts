import { spawn } from 'child_process';

/**
 * Первая версия bsl-analyzer, принимающая `[source].exclude`. Разбор конфига у сервера строгий
 * (`deny_unknown_fields`), поэтому более старая версия с этим ключом проект не загрузит вовсе.
 */
export const BSL_ANALYZER_SOURCE_EXCLUDE_MIN_VERSION = '0.2.85';

export interface BslAnalyzerVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * `unknown` — версию определить не удалось: файл конфига тогда не трогаем ни в какую сторону,
 * потому что ошибка в любую сторону ломает либо анализ (лишний каталог), либо загрузку проекта.
 */
export type SourceExcludeSupport = 'supported' | 'unsupported' | 'unknown';

/** Тот же порог, что в строковой константе, — числами, чтобы не разбирать её при каждом сравнении. */
const SOURCE_EXCLUDE_MIN: BslAnalyzerVersion = { major: 0, minor: 2, patch: 85 };

const DEFAULT_PROBE_TIMEOUT_MS = 5000;
/** Выводу `--version` хватает сотни байт; предел защищает от бинарника, льющего бесконечный stdout. */
const MAX_PROBE_OUTPUT = 64 * 1024;

/**
 * Первый токен вида `v?X.Y.Z` в тексте. Пред-релизный суффикс (`-rc1`) игнорируется: для порога
 * поддержки ключа значим только номер. Подходит и для тега `version.txt` (`v0.4.6`), и для вывода
 * `--version` загрузчика (`bsl-analyzer 0.4.6\nbsl-analyzer-launcher 0.4.6`).
 */
export function parseBslAnalyzerVersion(text: string | undefined): BslAnalyzerVersion | undefined {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  if (!match) {
    return undefined;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareBslAnalyzerVersions(a: BslAnalyzerVersion, b: BslAnalyzerVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function resolveSourceExcludeSupport(versionText: string | undefined): SourceExcludeSupport {
  const version = parseBslAnalyzerVersion(versionText);
  if (!version) {
    return 'unknown';
  }
  return compareBslAnalyzerVersions(version, SOURCE_EXCLUDE_MIN) >= 0 ? 'supported' : 'unsupported';
}

/**
 * Запускает `<execPath> --version` и возвращает stdout при коде 0, иначе `undefined`; не бросает.
 *
 * Ассет bsl-analyzer — загрузчик: при первом запуске (любой командой, включая `--version`) он сам
 * скачивает основной бинарь (~76 МБ) и только потом печатает версию. Такая проба может упереться
 * в таймаут — результат `unknown`, что безопасно: конфиг тогда не меняется.
 *
 * Таймаут отрабатывается собственным таймером, а не опцией `execFile`: убитый по таймауту
 * shell-обёрткой процесс может оставить потомка, держащего stdout открытым, и колбэк `execFile`
 * ждал бы его завершения. stdin закрыт сразу (`ignore`), stderr (прогресс загрузчика) не читается.
 */
export function probeBslAnalyzerVersion(
  execPath: string,
  options: { timeoutMs?: number } = {}
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    const finish = (value: string | undefined): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const child = spawn(execPath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(0, MAX_PROBE_OUTPUT);
    });
    child.on('error', () => finish(undefined));
    child.on('close', (code) => finish(code === 0 ? stdout : undefined));
  });
}
