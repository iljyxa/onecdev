// Версия в конверте crs: crserver принимает только точную версию своей платформы, а о чужой сообщает
// исключением со своей версией. Общий помощник для всех вызовов сервера (статусы захвата, история).
import { isCrsServerVersion } from './CrsClient';
import { CrsCallError } from './CrsErrors';

/** Подсказка версии сервера вида N.N.N.N; иная форма (пусто, «8.3.27») — `undefined`: версию сообщит рукопожатие. */
export function normalizeCrsVersionHint(hint: string | undefined): string | undefined {
  return hint !== undefined && isCrsServerVersion(hint) ? hint : undefined;
}

/**
 * Вызов с подсказкой версии; если подсказка устарела (платформу сервера обновили) — ровно один повтор с
 * версией из исключения сервера. Без подсказки повтора нет: клиент делал рукопожатие сам, и отказ по
 * версии повтором не лечится. `onRetry` сообщает версию повтора — она нужна тексту отказа и следующим вызовам.
 */
export async function runWithServerVersionRetry<T>(
  hint: string | undefined,
  run: (version: string | undefined) => Promise<T>,
  onRetry?: (serverVersion: string) => void,
): Promise<T> {
  try {
    return await run(hint);
  } catch (error) {
    const serverVersion = hint !== undefined && error instanceof CrsCallError && error.kind === 'version-mismatch'
      ? error.details.serverVersion
      : undefined;
    if (serverVersion === undefined) {
      throw error;
    }
    onRetry?.(serverVersion);
    return await run(serverVersion);
  }
}
