/**
 * Ключи привязки основной конфигурации к хранилищу в файлах настроек vanessa-runner
 * и чистые преобразования над разобранным JSON.
 *
 * Почему отдельный модуль: привязку должны понимать и vanessa-runner, и Platform Tools,
 * поэтому ключи — стандартные опции набора хранилища vanessa-runner (`storage-name`,
 * `storage-user`, `storage-pwd`), а не собственные. Ключи прежних версий расширения
 * (`--repo-*`) читаются для совместимости и при записи заменяются стандартными. Это
 * единственное место, где перечислены имена ключей; файловый ввод-вывод — у
 * `RepositoryBindingStore`, здесь только данные.
 *
 * Все функции не мутируют входы: разобранный JSON лежит в кэше читателя, и
 * изменение «на месте» при сбое записи оставило бы кэш расходящимся с файлом.
 */

export const ENV_STORAGE_NAME_KEY = '--storage-name';
export const ENV_STORAGE_USER_KEY = '--storage-user';
export const ENV_STORAGE_PWD_KEY = '--storage-pwd';
export const LEGACY_REPO_PATH_KEY = '--repo-path';
export const LEGACY_REPO_USER_KEY = '--repo-user';
export const LEGACY_REPO_PWD_KEY = '--repo-pwd';
export const AUTUMN_PROPERTIES_FILE = 'autumn-properties.json';
export const AUTUMN_VRUNNER_SECTION = 'vrunner';
export const AUTUMN_STORAGE_NAME_KEY = 'storage-name';
export const AUTUMN_STORAGE_USER_KEY = 'storage-user';
export const AUTUMN_STORAGE_PWD_KEY = 'storage-pwd';

/** `env-storage` — env.json 2.x, `env-legacy` — ключи прежних версий расширения, `autumn` — vanessa-runner 3.x. */
export type MainStorageBindingSource = 'env-storage' | 'env-legacy' | 'autumn';

export interface MainStorageBindingRead {
  readonly source: MainStorageBindingSource;
  readonly repoPath: string;
  readonly repoUser: string;
  /** env-legacy: `--repo-pwd` (мигрируется); иначе запасной `*-pwd`; '' если нет */
  readonly filePassword: string;
}

/** Ключи привязки основной конфигурации в `default` env.json — и стандартные, и прежние. */
const ENV_LEGACY_KEYS: readonly string[] = [LEGACY_REPO_PATH_KEY, LEGACY_REPO_USER_KEY, LEGACY_REPO_PWD_KEY];
const ENV_STANDARD_KEYS: readonly string[] = [ENV_STORAGE_NAME_KEY, ENV_STORAGE_USER_KEY];

/**
 * Привязка основной конфигурации: env.json `--storage-*` → env.json `--repo-*` →
 * autumn-properties.json `vrunner.storage-*`. Источник — первый с непустым адресом;
 * пользователь и пароль берутся из него же: смешивание источников дало бы пару
 * «адрес одного хранилища + пользователь другого».
 *
 * `readAutumnRoot` вызывается только когда env.json привязки не дал: `hasBinding`
 * стоит на горячем пути, а второй файл чаще всего отсутствует.
 */
export function selectMainStorageBinding(
  envDefaults: Readonly<Record<string, unknown>>,
  readAutumnRoot: () => Readonly<Record<string, unknown>> | undefined
): MainStorageBindingRead | null {
  const fromEnv =
    readPair(envDefaults, 'env-storage', ENV_STORAGE_NAME_KEY, ENV_STORAGE_USER_KEY, ENV_STORAGE_PWD_KEY) ??
    readPair(envDefaults, 'env-legacy', LEGACY_REPO_PATH_KEY, LEGACY_REPO_USER_KEY, LEGACY_REPO_PWD_KEY);
  if (fromEnv) {
    return fromEnv;
  }
  const vrunner = readVrunnerSection(readAutumnRoot());
  return vrunner
    ? readPair(vrunner, 'autumn', AUTUMN_STORAGE_NAME_KEY, AUTUMN_STORAGE_USER_KEY, AUTUMN_STORAGE_PWD_KEY)
    : null;
}

/**
 * Стандартные ключи вместо прежних. Позиция сохраняется — на месте прежних ключей,
 * иначе на месте стандартных: файл правит и пользователь, и лишняя перестановка
 * строк засоряет его diff. `--storage-pwd` не пишется никогда (пароль — в SecretStorage).
 */
export function applyMainBindingToEnvDefaults(
  defaults: Readonly<Record<string, unknown>>,
  binding: { readonly repoPath: string; readonly repoUser: string }
): Record<string, unknown> {
  const keys = Object.keys(defaults);
  const anchors = keys.some((key) => ENV_LEGACY_KEYS.includes(key)) ? ENV_LEGACY_KEYS : ENV_STANDARD_KEYS;
  const anchorIndex = keys.findIndex((key) => anchors.includes(key));
  const insertAt = anchorIndex < 0 ? keys.length : anchorIndex;
  const entries: [string, unknown][] = keys.map((key) => [key, defaults[key]]);
  entries.splice(insertAt, 0, [ENV_STORAGE_NAME_KEY, binding.repoPath], [ENV_STORAGE_USER_KEY, binding.repoUser]);
  // Вставленная пара стоит до своих прежних копий, поэтому фильтр по позиции снимает только их.
  return Object.fromEntries(
    entries.filter(([key], index) => (index >= insertAt && index < insertAt + 2) || !isEnvBindingKey(key))
  );
}

/** `--storage-pwd` остаётся: его завёл пользователь для vanessa-runner, не расширение. */
export function removeMainBindingFromEnvDefaults(defaults: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(defaults).filter(([key]) => !isEnvBindingKey(key)));
}

/**
 * autumn-properties.json обновляется, только если привязка там уже заведена: файл
 * vanessa-runner 3.x расширение не создаёт, основное место записи — env.json.
 * undefined — менять не нужно
 */
export function applyMainBindingToAutumn(
  root: Readonly<Record<string, unknown>>,
  binding: { readonly repoPath: string; readonly repoUser: string }
): Record<string, unknown> | undefined {
  const vrunner = readVrunnerSection(root);
  if (typeof vrunner?.[AUTUMN_STORAGE_NAME_KEY] !== 'string') {
    return undefined;
  }
  return {
    ...root,
    [AUTUMN_VRUNNER_SECTION]: {
      ...vrunner,
      [AUTUMN_STORAGE_NAME_KEY]: binding.repoPath,
      [AUTUMN_STORAGE_USER_KEY]: binding.repoUser,
    },
  };
}

/** undefined — нечего удалять */
export function removeMainBindingFromAutumn(root: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const vrunner = readVrunnerSection(root);
  if (!vrunner || !(AUTUMN_STORAGE_NAME_KEY in vrunner || AUTUMN_STORAGE_USER_KEY in vrunner)) {
    return undefined;
  }
  return {
    ...root,
    [AUTUMN_VRUNNER_SECTION]: Object.fromEntries(
      Object.entries(vrunner).filter(([key]) => key !== AUTUMN_STORAGE_NAME_KEY && key !== AUTUMN_STORAGE_USER_KEY)
    ),
  };
}

function isEnvBindingKey(key: string): boolean {
  return ENV_LEGACY_KEYS.includes(key) || ENV_STANDARD_KEYS.includes(key);
}

function readPair(
  section: Readonly<Record<string, unknown>>,
  source: MainStorageBindingSource,
  nameKey: string,
  userKey: string,
  pwdKey: string
): MainStorageBindingRead | null {
  const repoPath = readString(section[nameKey]).trim();
  if (!repoPath) {
    return null;
  }
  return {
    source,
    repoPath,
    repoUser: readString(section[userKey]).trim(),
    // Пароль не обрезается: пробелы по краям могут быть его частью.
    filePassword: readString(section[pwdKey]),
  };
}

function readVrunnerSection(root: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | undefined {
  const section = root?.[AUTUMN_VRUNNER_SECTION];
  return section && typeof section === 'object' && !Array.isArray(section)
    ? (section as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
