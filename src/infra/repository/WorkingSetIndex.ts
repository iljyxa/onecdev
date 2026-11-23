import * as path from 'path';
import { pathKey } from '../fs/PathKey';
import {
  getRepositoryUnitAncestors,
  getRootLockName,
  isRepositorySubordinateTag,
  parseRepositoryUnit,
  subordinateUnitFullName,
} from './RepositoryObjectNames';
import { resolveLockUnitByRelativePath } from './RepositoryObjectScope';
import type { RepositoryTarget } from './RepositoryService';

/**
 * Источник «рабочего набора» одной конфигурации: файлы, не загруженные в базу, и
 * единицы, захваченные мной в хранилище.
 */
export interface WorkingSetSource {
  readonly target: RepositoryTarget;
  /** Пути относительно корня выгрузки (через `/`). */
  readonly changedRelativePaths: Iterable<string>;
  readonly ownLockedFullNames: Iterable<string>;
}

/** Поля узла дерева, по которым определяется его единица хранилища. */
export interface WorkingSetNodeRef {
  readonly nodeKind?: string;
  readonly label?: string;
  readonly xmlPath?: string;
  readonly metaContext?: { readonly ownerObjectXmlPath?: string };
}

/** Положение узла относительно рабочего набора. */
export interface WorkingSetNodeMatch {
  /** Единица узла сама изменена или захвачена. */
  readonly marked: boolean;
  /** Под узлом есть отмеченные единицы: ветку нужно раскрыть до них. */
  readonly hasMarkedDescendants: boolean;
}

interface WorkingSetScope {
  readonly target: RepositoryTarget;
  readonly units: ReadonlySet<string>;
  readonly ancestors: ReadonlySet<string>;
}

/**
 * Рабочий набор, сведённый к полным именам единиц хранилища (`Справочник.А`,
 * `Справочник.А.Форма.Ф`, сентинел корня): этим ключом одинаково выражаются и
 * изменённые файлы, и захваты, и узлы дерева. Без I/O — узлы сопоставляются
 * строковыми операциями, поэтому годится для обхода дерева целиком.
 */
export class WorkingSetIndex {
  private constructor(private readonly scopes: ReadonlyMap<string, WorkingSetScope>) {}

  static build(sources: readonly WorkingSetSource[]): WorkingSetIndex {
    const scopes = new Map<string, WorkingSetScope>();
    for (const source of sources) {
      const units = new Set<string>(source.ownLockedFullNames);
      for (const relativePath of source.changedRelativePaths) {
        const unit = resolveLockUnitByRelativePath(relativePath, source.target);
        if (unit) {
          units.add(unit);
        }
      }
      if (units.size === 0) {
        continue;
      }
      const ancestors = new Set<string>();
      for (const unit of units) {
        for (const ancestor of getRepositoryUnitAncestors(unit)) {
          ancestors.add(ancestor);
        }
      }
      scopes.set(pathKey(source.target.configRoot), { target: source.target, units, ancestors });
    }
    return new WorkingSetIndex(scopes);
  }

  /** Число отмеченных единиц во всех конфигурациях. */
  get unitCount(): number {
    let count = 0;
    for (const scope of this.scopes.values()) {
      count += scope.units.size;
    }
    return count;
  }

  /** Есть ли в конфигурации хоть одна отмеченная единица. */
  hasUnits(configRoot: string): boolean {
    return this.scopes.has(pathKey(configRoot));
  }

  /**
   * Положение узла конфигурации `configRoot`; `undefined` — у узла нет своей
   * единицы (группа, реквизит, модуль): решение о нём принимается по его детям.
   */
  matchNode(configRoot: string, node: WorkingSetNodeRef): WorkingSetNodeMatch | undefined {
    const scope = this.scopes.get(pathKey(configRoot));
    if (!scope) {
      return { marked: false, hasMarkedDescendants: false };
    }
    if (node.nodeKind === 'configuration' || node.nodeKind === 'extension') {
      const marked = scope.units.has(getRootLockName(scope.target));
      return { marked, hasMarkedDescendants: scope.units.size > (marked ? 1 : 0) };
    }
    const unit = resolveNodeUnitName(node, scope.target);
    if (!unit) {
      return undefined;
    }
    return { marked: scope.units.has(unit), hasMarkedDescendants: scope.ancestors.has(unit) };
  }
}

/**
 * Имя единицы узла: форма/макет/вложенная единица — имя владельца плюс сегмент
 * `Вид.Имя` (у таких узлов `xmlPath` указывает на XML владельца); объект — по пути
 * его XML; части владельца (реквизиты, модули, группы) своей единицы не имеют.
 */
function resolveNodeUnitName(node: WorkingSetNodeRef, target: RepositoryTarget): string | null {
  const ownerXmlPath = node.metaContext?.ownerObjectXmlPath;
  if (ownerXmlPath) {
    if (!node.nodeKind || !isRepositorySubordinateTag(node.nodeKind) || !node.label) {
      return null;
    }
    const owner = resolveUnitNameByXmlPath(ownerXmlPath, target);
    return owner && parseRepositoryUnit(owner) ? subordinateUnitFullName(owner, node.nodeKind, node.label) : null;
  }
  return node.xmlPath ? resolveUnitNameByXmlPath(node.xmlPath, target) : null;
}

function resolveUnitNameByXmlPath(xmlPath: string, target: RepositoryTarget): string | null {
  return resolveLockUnitByRelativePath(path.relative(target.configRoot, xmlPath), target);
}
