/**
 * Выбор целей пакетного импорта/обновления конфигураций без участия человека.
 *
 * MCP-агент не может ответить на QuickPick: раньше при нескольких
 * конфигурациях вызов `onecdev_execute_command` висел на модальном выборе.
 * Теперь вызывающий передаёт команде запрос выбора (`auto`/`all`/`names`), а
 * решение — выбранные цели или явный исход `invalid-selection` — принимает
 * этот модуль. Без `vscode`/`fs`/`path`: правила выбора проверяются на чистых
 * входах, а UI-путь передаёт свой picker параметром.
 */
import type { ConfigurationCommandOutcome } from './configurationCommandOutcome';

export interface ConfigurationTarget {
  readonly kind: 'cf' | 'cfe';
  readonly name: string;
  readonly rootPath: string;
}

export type ConfigurationTargetRequest =
  | { readonly mode: 'auto' }
  | { readonly mode: 'all' }
  | { readonly mode: 'names'; readonly names: readonly string[] };

export type ConfigurationSelectionScope = 'import' | 'update';

export interface ConfigurationSelectionArgs {
  readonly configurations?: readonly string[];
  readonly all?: boolean;
}

export type ConfigurationSelectionArgsResult =
  | { readonly ok: true; readonly request: ConfigurationTargetRequest }
  | { readonly ok: false; readonly error: string };

type InvalidSelectionOutcome = Extract<ConfigurationCommandOutcome, { status: 'invalid-selection' }>;

export type ConfigurationTargetSelection<T extends ConfigurationTarget> =
  | { readonly kind: 'selected'; readonly targets: T[] }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'invalid'; readonly outcome: InvalidSelectionOutcome };

/**
 * Сужает аргумент команды до запроса выбора. UI вызывает команды без
 * аргумента или с узлом дерева (`NodeArg`) — такие значения не запрос, и
 * команда идёт интерактивным путём.
 */
export function isConfigurationTargetRequest(value: unknown): value is ConfigurationTargetRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { mode, names } = value as { mode?: unknown; names?: unknown };
  if (mode === 'auto' || mode === 'all') {
    return true;
  }
  return mode === 'names'
    && Array.isArray(names)
    && names.length > 0
    && names.every((name) => typeof name === 'string');
}

/**
 * Проверяет форму аргументов MCP. Ошибки здесь — ошибки вызова (агент
 * передал противоречивые или пустые аргументы), а не данных, поэтому они
 * отбиваются до запуска команды; неизвестные имена проверяет уже команда —
 * только она знает кандидатов.
 */
export function parseConfigurationSelectionArgs(args: ConfigurationSelectionArgs): ConfigurationSelectionArgsResult {
  const { configurations, all } = args;
  if (configurations === undefined) {
    return { ok: true, request: { mode: all === true ? 'all' : 'auto' } };
  }
  if (all === true) {
    return { ok: false, error: 'Аргументы configurations и all взаимоисключающие: укажите что-то одно.' };
  }
  if (configurations.length === 0) {
    return { ok: false, error: 'Список configurations пуст: укажите имена конфигураций или all: true.' };
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of configurations) {
    const name = raw.trim();
    if (name.length === 0) {
      return { ok: false, error: 'Список configurations содержит пустое имя конфигурации.' };
    }
    const key = normalizeName(name);
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return { ok: true, request: { mode: 'names', names } };
}

export function resolveConfigurationTargets<T extends ConfigurationTarget>(
  candidates: readonly T[],
  request: ConfigurationTargetRequest,
  scope: ConfigurationSelectionScope
): ConfigurationTargetSelection<T> {
  const available = candidates.map((candidate) => candidate.name);
  if (request.mode === 'all' || (request.mode === 'auto' && candidates.length <= 1)) {
    return { kind: 'selected', targets: [...candidates] };
  }
  if (request.mode === 'auto') {
    return invalidSelection({
      reason: 'selection-required',
      message: SELECTION_REQUIRED_MESSAGES[scope](available),
      available,
    });
  }
  const candidateKeys = new Set(available.map(normalizeName));
  const unknown = request.names.filter((name) => !candidateKeys.has(normalizeName(name)));
  if (unknown.length > 0) {
    // Без частичного выполнения: агент, ошибившийся в одном имени, иначе
    // получил бы молча урезанный импорт/обновление.
    return invalidSelection({
      reason: 'unknown-names',
      message: UNKNOWN_NAMES_MESSAGES[scope](unknown, available),
      available,
      unknown,
    });
  }
  const requestedKeys = new Set(request.names.map(normalizeName));
  return { kind: 'selected', targets: candidates.filter((candidate) => requestedKeys.has(normalizeName(candidate.name))) };
}

/** Без запроса — интерактивный выбор UI, с запросом — решение без человека. */
export async function selectConfigurationTargets<T extends ConfigurationTarget>(
  candidates: T[],
  request: ConfigurationTargetRequest | undefined,
  scope: ConfigurationSelectionScope,
  pickInteractively: (candidates: T[]) => Promise<T[] | undefined>
): Promise<ConfigurationTargetSelection<T>> {
  if (request !== undefined) {
    return resolveConfigurationTargets(candidates, request, scope);
  }
  const picked = await pickInteractively(candidates);
  if (!picked || picked.length === 0) {
    return { kind: 'cancelled' };
  }
  return { kind: 'selected', targets: picked };
}

/** Основная конфигурация раньше расширений: расширения применяются поверх неё. */
export function orderConfigurationTargets<T extends ConfigurationTarget>(targets: readonly T[]): T[] {
  return [...targets].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'cf' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

/** Регистр не важен, «ё» и «е» различаются — как в именах объектов 1С. */
function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase('ru-RU');
}

function invalidSelection<T extends ConfigurationTarget>(
  details: Omit<InvalidSelectionOutcome, 'status'>
): ConfigurationTargetSelection<T> {
  return { kind: 'invalid', outcome: { status: 'invalid-selection', ...details } };
}

const SELECTION_REQUIRED_MESSAGES: Record<ConfigurationSelectionScope, (available: readonly string[]) => string> = {
  import: (available) => `Для импорта доступно несколько конфигураций: ${available.join(', ')}. `
    + 'Укажите configurations (имена из available) или all: true, чтобы импортировать все.',
  update: (available) => `Изменено несколько конфигураций: ${available.join(', ')}. `
    + 'Укажите configurations (имена из available) или all: true, чтобы обновить все изменённые.',
};

const UNKNOWN_NAMES_MESSAGES: Record<
  ConfigurationSelectionScope,
  (unknown: readonly string[], available: readonly string[]) => string
> = {
  import: (unknown, available) => `Нет конфигураций для импорта с именами: ${unknown.join(', ')}. `
    + `Доступны: ${available.join(', ')}.`,
  update: (unknown, available) => `Среди изменённых конфигураций нет: ${unknown.join(', ')}. `
    + `Изменены: ${available.join(', ')}.`,
};
