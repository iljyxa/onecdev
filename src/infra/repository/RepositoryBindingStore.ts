import * as fs from 'fs';
import * as path from 'path';
import type { ProjectSecretStorage } from '../environment/ProjectSecretStorage';
import { buildRepositoryScopeKey } from './RepositoryLockState';
import type { RepositoryBinding, RepositoryTarget, StoredRepositoryBinding } from './RepositoryService';
import { parseJsonObjectText, writeJsonPreservingStyle } from '../fs/JsonTextFile';
import {
  AUTUMN_PROPERTIES_FILE,
  LEGACY_REPO_PWD_KEY,
  applyMainBindingToAutumn,
  applyMainBindingToEnvDefaults,
  removeMainBindingFromAutumn,
  removeMainBindingFromEnvDefaults,
  selectMainStorageBinding,
} from './VrunnerStorageKeys';

const PLATFORM_VERSION_RE = /\d+\.\d+\.\d+\.\d+/;
const ENV_JSON_FILE = 'env.json';
const CFE_REPO_PATH_KEY = 'repo-path';
const CFE_REPO_USER_KEY = 'repo-user';
const CFE_REPO_PWD_KEY = 'repo-pwd';

/** Разобранный JSON-файл; `text` — эталон формата для перезаписи (undefined — файла нет). */
interface JsonFileState {
  readonly text: string | undefined;
  readonly value: Readonly<Record<string, unknown>>;
}

interface CachedJsonFile extends JsonFileState {
  readonly mtimeMs: number;
}

interface BindingRaw {
  readonly repoPath: string;
  readonly repoUser: string;
  /** Пароль прежних версий в файле: переносится в SecretStorage и стирается. */
  readonly migratedPassword: string;
  /** Пароль, заведённый пользователем для vanessa-runner: только запасной для команды, файл не трогается. */
  readonly fallbackPassword: string;
}

/**
 * Привязка цели к хранилищу (путь и пользователь) и пароль в `ProjectSecretStorage`.
 *
 * Основная конфигурация хранится в стандартных опциях vanessa-runner — в `env.json`
 * (`--storage-name/--storage-user`) и, если уже заведено пользователем, в
 * `autumn-properties.json` (`vrunner.storage-*`); ключи — в `VrunnerStorageKeys`.
 * Расширения — в `default.extension[<имя>]` env.json (у vanessa-runner аналога нет).
 * Пароль в файлы не пишется; оставшийся от прежних версий `--repo-pwd` мигрирует в
 * SecretStorage при первом чтении.
 */
export class RepositoryBindingStore {
  private readonly fileCache = new Map<string, CachedJsonFile>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly secrets: ProjectSecretStorage
  ) {}

  getEnvJsonPath(): string {
    return path.join(this.workspaceRoot, ENV_JSON_FILE);
  }

  getAutumnPropertiesPath(): string {
    return path.join(this.workspaceRoot, AUTUMN_PROPERTIES_FILE);
  }

  async loadBinding(target: RepositoryTarget): Promise<StoredRepositoryBinding | null> {
    const raw = await this.loadBindingRaw(target);
    return raw ? { repoPath: raw.repoPath, repoUser: raw.repoUser } : null;
  }

  async saveBinding(target: RepositoryTarget, binding: RepositoryBinding): Promise<void> {
    const env = this.readEnvFile();
    const defaults = getDefaultSection(env.value);
    if (target.configKind === 'cfe') {
      const extensionSection = getExtensionSection(defaults);
      extensionSection[target.extensionName ?? ''] = {
        [CFE_REPO_PATH_KEY]: binding.repoPath,
        [CFE_REPO_USER_KEY]: binding.repoUser,
      };
      this.writeEnvFile(env, { ...defaults, extension: extensionSection });
    } else {
      // Оба результата вычисляются до первой записи: повреждённый autumn-properties.json
      // должен отбить операцию, пока env.json ещё не тронут.
      const autumn = this.readAutumnFile();
      const nextAutumn = autumn.text === undefined ? undefined : applyMainBindingToAutumn(autumn.value, binding);
      this.writeEnvFile(env, applyMainBindingToEnvDefaults(defaults, binding));
      this.writeAutumnFile(autumn, nextAutumn);
    }
    // Непустой ввод обновляет секрет; пустой пароль означает «оставить сохранённый».
    if (binding.repoPassword.trim()) {
      await this.secrets.setRepoPassword(buildRepositoryScopeKey(target), binding.repoPassword);
    }
  }

  async clearBinding(target: RepositoryTarget): Promise<void> {
    const env = this.readEnvFile();
    const defaults = getDefaultSection(env.value);
    if (target.configKind === 'cfe') {
      const extensionName = target.extensionName ?? '';
      this.writeEnvFile(env, {
        ...defaults,
        extension: Object.fromEntries(
          Object.entries(getExtensionSection(defaults)).filter(([name]) => name !== extensionName)
        ),
      });
    } else {
      const autumn = this.readAutumnFile();
      const nextAutumn = removeMainBindingFromAutumn(autumn.value);
      this.writeEnvFile(env, removeMainBindingFromEnvDefaults(defaults));
      this.writeAutumnFile(autumn, nextAutumn);
    }
    await this.secrets.setRepoPassword(buildRepositoryScopeKey(target), '');
  }

  async hasStoredRepoPassword(target: RepositoryTarget): Promise<boolean> {
    return this.secrets.hasRepoPassword(buildRepositoryScopeKey(target));
  }

  /**
   * Полная привязка с паролем — только в памяти для запуска команды 1С. Пароль из
   * SecretStorage; если его нет — `*-pwd`, заведённый пользователем для vanessa-runner
   * (как `--db-pwd` у `DbPasswordResolver`).
   */
  async resolveBindingForCommand(target: RepositoryTarget): Promise<RepositoryBinding | null> {
    const raw = await this.loadBindingRaw(target);
    if (!raw) {
      return null;
    }
    // Пустая строка в SecretStorage — тоже «пароля нет».
    const stored = (await this.secrets.getRepoPassword(buildRepositoryScopeKey(target))) ?? '';
    return { repoPath: raw.repoPath, repoUser: raw.repoUser, repoPassword: stored.length > 0 ? stored : raw.fallbackPassword };
  }

  /**
   * Версия платформы проекта для первого вызова сервера хранилища: `--v8version`, иначе
   * версия-подстрока пути `--path`. Читает уже кэшируемый env.json.
   */
  readPlatformVersionHint(): string | undefined {
    const defaults = getDefaultSection(this.readEnvFile().value);
    const explicit = readString(defaults['--v8version'])?.trim();
    if (explicit) {
      return explicit;
    }
    return PLATFORM_VERSION_RE.exec(readString(defaults['--path']) ?? '')?.[0];
  }

  /**
   * Вызывается на каждый узел дерева (декорация хранилища), поэтому не бросает из-за
   * чужого `autumn-properties.json`: файл vanessa-runner бывает временно невалиден, пока
   * его правят, и это не должно ломать отрисовку навигатора. Повреждённый файл здесь —
   * «привязки нет»; операции с привязкой (load/resolve/save/clear) по-прежнему отбиваются
   * понятной ошибкой. Повреждённый `env.json` бросает, как и до #120 — это файл расширения.
   */
  hasBinding(target: RepositoryTarget): boolean {
    return this.readBindingRaw(target, { tolerateBrokenAutumn: true }) !== null;
  }

  private async loadBindingRaw(target: RepositoryTarget): Promise<BindingRaw | null> {
    const raw = this.readBindingRaw(target);
    if (raw?.migratedPassword.trim()) {
      await this.secrets.setRepoPassword(buildRepositoryScopeKey(target), raw.migratedPassword);
      this.eraseLegacyRepoPassword(target);
    }
    return raw;
  }

  /**
   * Синхронное чтение привязки без SecretStorage — для проверок на hot path и
   * последующей асинхронной миграции legacy-пароля.
   */
  private readBindingRaw(target: RepositoryTarget, options: { tolerateBrokenAutumn?: boolean } = {}): BindingRaw | null {
    const defaults = getDefaultSection(this.readEnvFile().value);
    if (target.configKind === 'cfe') {
      const item = getRawExtensionSection(defaults)[target.extensionName ?? ''] as Record<string, unknown> | undefined;
      const repoPath = readString(item?.[CFE_REPO_PATH_KEY]);
      if (!repoPath) {
        return null;
      }
      return {
        repoPath,
        repoUser: readString(item?.[CFE_REPO_USER_KEY]) ?? '',
        migratedPassword: readString(item?.[CFE_REPO_PWD_KEY]) ?? '',
        fallbackPassword: '',
      };
    }
    const main = selectMainStorageBinding(defaults, () => this.readAutumnRootForBinding(options.tolerateBrokenAutumn === true));
    if (!main) {
      return null;
    }
    const legacy = main.source === 'env-legacy';
    return {
      repoPath: main.repoPath,
      repoUser: main.repoUser,
      migratedPassword: legacy ? main.filePassword : '',
      fallbackPassword: legacy ? '' : main.filePassword,
    };
  }

  private readAutumnRootForBinding(tolerateBroken: boolean): Readonly<Record<string, unknown>> | undefined {
    if (!tolerateBroken) {
      return this.readAutumnFile().value;
    }
    try {
      return this.readAutumnFile().value;
    } catch {
      return undefined;
    }
  }

  private eraseLegacyRepoPassword(target: RepositoryTarget): void {
    const env = this.readEnvFile();
    const defaults = getDefaultSection(env.value);
    if (target.configKind === 'cfe') {
      const extensionName = target.extensionName ?? '';
      // Копия, а не delete на месте: объект лежит в кэше, и при сбое записи кэш
      // разошёлся бы с файлом — повторное чтение уже не нашло бы пароль для стирания.
      // Секция и запись существуют: стирание вызывается только после их чтения.
      const extension = defaults.extension as Record<string, unknown>;
      const item = extension[extensionName] as Record<string, unknown>;
      this.writeEnvFile(env, {
        ...defaults,
        extension: { ...extension, [extensionName]: omitKey(item, CFE_REPO_PWD_KEY) },
      });
    } else {
      this.writeEnvFile(env, omitKey(defaults, LEGACY_REPO_PWD_KEY));
    }
  }

  private readEnvFile(): JsonFileState {
    return this.readJsonFile(this.getEnvJsonPath(), ENV_JSON_FILE);
  }

  private readAutumnFile(): JsonFileState {
    return this.readJsonFile(this.getAutumnPropertiesPath(), AUTUMN_PROPERTIES_FILE);
  }

  private readJsonFile(filePath: string, fileLabel: string): JsonFileState {
    const mtimeMs = getFileMtimeMs(filePath) ?? -1;
    const cached = this.fileCache.get(filePath);
    if (cached?.mtimeMs === mtimeMs) {
      return cached;
    }
    const text = mtimeMs < 0 ? undefined : fs.readFileSync(filePath, 'utf-8');
    const value = parseJsonObjectText(text ?? '', fileLabel, filePath);
    this.fileCache.set(filePath, { mtimeMs, text, value });
    return { text, value };
  }

  private writeEnvFile(env: JsonFileState, defaults: Record<string, unknown>): void {
    this.writeJsonFile(this.getEnvJsonPath(), env.text, { ...env.value, default: defaults });
  }

  private writeAutumnFile(autumn: JsonFileState, next: Record<string, unknown> | undefined): void {
    if (next) {
      this.writeJsonFile(this.getAutumnPropertiesPath(), autumn.text, next);
    }
  }

  private writeJsonFile(filePath: string, original: string | undefined, value: Record<string, unknown>): void {
    const text = writeJsonPreservingStyle(filePath, original, value);
    // Файл только что записан; mtime отсутствует лишь при гонке с внешним удалением.
    /* c8 ignore next */
    this.fileCache.set(filePath, { mtimeMs: getFileMtimeMs(filePath) ?? Date.now(), text, value });
  }
}

function getDefaultSection(env: Record<string, unknown>): Record<string, unknown> {
  const defaults = env.default;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    return {};
  }
  return { ...(defaults as Record<string, unknown>) };
}

function getExtensionSection(defaults: Record<string, unknown>): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const [key, item] of Object.entries(getRawExtensionSection(defaults))) {
    result[key] = {
      [CFE_REPO_PATH_KEY]: readString(item[CFE_REPO_PATH_KEY]) ?? '',
      [CFE_REPO_USER_KEY]: readString(item[CFE_REPO_USER_KEY]) ?? '',
    };
  }
  return result;
}

/** Секция расширений с сохранением `repo-pwd` — нужна для миграции legacy-пароля. */
function getRawExtensionSection(defaults: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const raw = defaults.extension;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = value as Record<string, unknown>;
    }
  }
  return result;
}

function omitKey(source: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([name]) => name !== key));
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getFileMtimeMs(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}
