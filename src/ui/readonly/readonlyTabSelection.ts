import * as path from 'path';

/**
 * Роль вкладки относительно файла: обычный редактор, правая (изменяемая) или левая
 * сторона сравнения. Readonly-команды VS Code действуют только на основную сторону
 * активного редактора — у сравнения это правая, поэтому левую сторону нельзя
 * переключить активацией самого сравнения.
 */
export type ReadonlyTabRole = 'text' | 'diff-modified' | 'diff-original';

export interface ReadonlyTabCandidate {
  path: string;
  role: ReadonlyTabRole;
  visible: boolean;
  viewColumn: number;
}

/**
 * `activate` — активировать саму вкладку; `temporary` — файл открыт только левой
 * стороной сравнения, нужна временная обычная вкладка; `defer` — применить при
 * следующей активации скрытой вкладки.
 */
export type ReadonlyApplyRoute<T extends ReadonlyTabCandidate> =
  | { kind: 'activate'; tab: T }
  | { kind: 'temporary'; tab: T }
  | { kind: 'defer'; tab: T };

/**
 * Левая сторона сравнения применяется сразу даже в скрытом сравнении: событие
 * активации для сравнения приходит по правой стороне, отложенный переход левой
 * не сработал бы никогда.
 */
export function isImmediatelyApplicable(tab: Pick<ReadonlyTabCandidate, 'role' | 'visible'>): boolean {
  return tab.role === 'diff-original' || tab.visible;
}

/**
 * ФС по умолчанию регистронезависимы только на Windows (NTFS) и macOS (APFS/HFS+). На Linux
 * `ObjectModule.bsl` и `objectmodule.bsl` — разные файлы, и вкладку одного нельзя
 * активировать вместо другого.
 */
const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>(['win32', 'darwin']);

function normalizeKey(filePath: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(filePath);
  return CASE_INSENSITIVE_PLATFORMS.has(platform) ? resolved.toLowerCase() : resolved;
}

/**
 * Видимая основная вкладка активируется без побочных эффектов, поэтому она важнее
 * временной вкладки для левой стороны сравнения; скрытая основная без левой
 * стороны ждёт собственной активации. `platform` задаёт регистрочувствительность
 * сравнения путей; параметр нужен, чтобы проверить поведение всех платформ на одной.
 */
export function selectReadonlyApplyRoute<T extends ReadonlyTabCandidate>(
  tabs: readonly T[],
  filePath: string,
  platform: NodeJS.Platform = process.platform
): ReadonlyApplyRoute<T> | undefined {
  const key = normalizeKey(filePath, platform);
  const matches = tabs.filter((tab) => normalizeKey(tab.path, platform) === key);
  const primary = matches.filter((tab) => tab.role !== 'diff-original');
  const visiblePrimary = primary.find((tab) => tab.visible);
  if (visiblePrimary) {
    return { kind: 'activate', tab: visiblePrimary };
  }
  const originals = matches.filter((tab) => tab.role === 'diff-original');
  const original = originals.find((tab) => tab.visible) ?? originals.find((tab) => !tab.visible);
  if (original) {
    return { kind: 'temporary', tab: original };
  }
  return primary.length > 0 ? { kind: 'defer', tab: primary[0] } : undefined;
}
