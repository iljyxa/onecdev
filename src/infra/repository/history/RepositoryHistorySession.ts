// Сессия истории хранилища: привязка цели → адрес сервера, учётные данные и подсказка версии.
// Пароль приходит из SecretStorage и живёт только в памяти — в сессии лишь его хеш, а ключ сессии
// (по нему сервис узнаёт смену хранилища или пользователя) хеша не содержит.
import { parseCrsAddress, type CrsAddress } from '../crs/CrsAddress';
import { crsPasswordHash } from '../crs/CrsSecrets';
import { normalizeCrsVersionHint } from '../crs/CrsVersionRetry';
import type { CrsAuth } from '../../xml/crs/CrsEnvelope';
import { toRepositoryLockStatusError } from '../NetworkRepositoryLockStatusSource';
import { DEFAULT_CRS_VERSION_HINT } from '../RepositoryLockStatusService';
import { classifyRepositoryLocation, type RepositoryLockStatusErrorCode } from '../RepositoryLockStatusSource';
import type { RepositoryBinding, RepositoryService, RepositoryTarget } from '../RepositoryService';
import { HISTORY_MAX_RESPONSE_BYTES } from './RepositoryHistoryLoader';

export interface RepositoryHistorySession {
  readonly key: string;
  readonly target: RepositoryTarget;
  readonly address: CrsAddress;
  readonly auth: CrsAuth;
  /** Версия для конверта первого вызова (N.N.N.N); нет — версию сообщит рукопожатие. */
  readonly versionHint?: string;
}

export interface RepositoryHistoryFailure {
  readonly code: RepositoryLockStatusErrorCode;
  readonly message: string;
}

export type RepositoryHistorySessionResolution =
  | { readonly kind: 'session'; readonly session: RepositoryHistorySession }
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'file-repository' }
  | { readonly kind: 'failed'; readonly failure: RepositoryHistoryFailure };

export interface RepositoryHistorySessionDeps {
  readonly workspaceRoot: string;
  isConnected(target: RepositoryTarget): boolean;
  resolveBinding(target: RepositoryTarget): Promise<RepositoryBinding | null>;
  serverVersionHint(target: RepositoryTarget): string | undefined;
}

/**
 * Сессия цели или причина, по которой истории по протоколу сервера нет: цель не подключена,
 * хранилище файловое (.1CD — только отчёт Конфигуратора), адрес не разбирается. Сеть не трогается.
 */
export async function resolveRepositoryHistorySession(
  target: RepositoryTarget,
  deps: RepositoryHistorySessionDeps,
): Promise<RepositoryHistorySessionResolution> {
  const binding = deps.isConnected(target) ? await deps.resolveBinding(target) : null;
  if (!binding) {
    return { kind: 'disconnected' };
  }
  const location = classifyRepositoryLocation(binding.repoPath, deps.workspaceRoot);
  if (location.kind === 'file') {
    return { kind: 'file-repository' };
  }
  let address: CrsAddress;
  try {
    address = parseCrsAddress(location.repoPath);
  } catch (error) {
    return { kind: 'failed', failure: toRepositoryHistoryFailure(error) };
  }
  const user = binding.repoUser;
  const versionHint = normalizeCrsVersionHint(deps.serverVersionHint(target));
  const session: RepositoryHistorySession = {
    key: `${target.configRoot}|${location.repoPath}|${user}`,
    target,
    address,
    auth: { user, passwordHash: crsPasswordHash(binding.repoPassword) },
    ...(versionHint === undefined ? {} : { versionHint }),
  };
  return { kind: 'session', session };
}

/**
 * Зависимости по фасаду хранилища. Подсказка версии — та же цепочка, что у опроса статусов захвата:
 * версия последнего опроса сервера, затем env.json, затем версия по умолчанию.
 */
export function repositoryHistorySessionDepsFrom(repositoryService: RepositoryService, workspaceRoot: string): RepositoryHistorySessionDeps {
  return {
    workspaceRoot,
    isConnected: (target) => repositoryService.isConnected(target),
    resolveBinding: (target) => repositoryService.resolveBindingForCommand(target),
    serverVersionHint: (target) => repositoryService.lockState.getServerVersion(target)
      ?? repositoryService.readPlatformVersionHint()
      ?? DEFAULT_CRS_VERSION_HINT,
  };
}

/**
 * Отказ → код и текст для панели и MCP тем же переводом, что у статусов захвата (без тела запроса и хеша
 * пароля). Слишком большой ответ истории отсылает к отчёту Конфигуратора: он строится без лимита ответа.
 */
export function toRepositoryHistoryFailure(error: unknown, retriedWithVersion?: string): RepositoryHistoryFailure {
  const { code, message } = toRepositoryLockStatusError(error, retriedWithVersion);
  if (code === 'too-large') {
    const limit = String(HISTORY_MAX_RESPONSE_BYTES / (1024 * 1024));
    return { code, message: `История слишком велика: ответ сервера больше ${limit} МиБ. Полная история доступна в отчёте Конфигуратора.` };
  }
  return { code, message };
}
