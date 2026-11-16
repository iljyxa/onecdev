// Модель истории хранилища для панели и MCP: версии с авторами по имени и изменённые объекты с
// заголовками, как в отчёте Конфигуратора («Справочник.Контрагенты.Форма.ФормаЭлемента»).
import { getMetaKindByRepositoryClassId, META_TYPES } from '../../../domain/MetaTypes';
import type { CrsChangedObject, CrsDepotHistory } from '../crs/CrsHistory';
import type { CrsDepotUser } from '../crs/CrsStatistic';
import { isRepositorySubordinateTag, ONE_C_TYPE_NAMES, REPOSITORY_SUBORDINATE_LAYOUT } from '../RepositoryObjectNames';

export type HistoryChangeKind = 'added' | 'modified' | 'removed';

export interface HistoryLabel {
  readonly name: string;
  readonly comment: string;
  readonly author: string;
  readonly date: string;
}

export interface HistoryChange {
  readonly objectId: string;
  readonly title: string;
  readonly kind: HistoryChangeKind;
}

export interface HistoryVersion {
  readonly verNum: number;
  readonly versionId: string;
  readonly authorId: string;
  readonly author: string;
  readonly date: string;
  readonly configVersion: string;
  readonly platformVersion: string;
  readonly comment: string;
  readonly label?: HistoryLabel;
  readonly changes: readonly HistoryChange[];
}

/** Версии по убыванию номера. */
export interface RepositoryHistory {
  readonly versions: readonly HistoryVersion[];
  /** Номера версий по тому же фильтру, ещё не загруженные (более ранние), по убыванию; пусто — история полная. */
  readonly pending: readonly number[];
}

export interface RepositoryHistoryObjectFilter {
  readonly objectId: string;
  readonly title: string;
}

/**
 * Вид изменения по действию сервера. На 8.5.1 сняты только 0 (добавлен) и 5 (изменён); прочие значения
 * трактуются как изменение, а пометка удаления важнее действия.
 */
export function describeChangeKind(action: number, removed: boolean): HistoryChangeKind {
  if (removed) {
    return 'removed';
  }
  return action === 0 ? 'added' : 'modified';
}

const CLASS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Русское имя вида по classID: техническое имя хранилища (ONE_C_TYPE_NAMES), для форм и макетов —
 * имя подчинённой единицы, для корня — «Конфигурация». Класс вне META_TYPES показывается началом uuid.
 */
function classTitle(classId: string): string {
  const kind = getMetaKindByRepositoryClassId(classId);
  const title = kind === undefined
    ? undefined
    : ONE_C_TYPE_NAMES[kind] ?? (isRepositorySubordinateTag(kind) ? REPOSITORY_SUBORDINATE_LAYOUT[kind].oneCName : META_TYPES[kind].label);
  return title ?? `Объект (${classId.toLowerCase().slice(0, 8)})`;
}

/**
 * Сервер называет объект парами `<classID>.<имя>` от корня → «Справочник.Контрагенты.Форма.ФормаЭлемента».
 * Корень (пустой fullName) — имя объекта; нераспознанный формат — как есть.
 */
export function objectTitle(change: Pick<CrsChangedObject, 'fullName' | 'name'>): string {
  if (change.fullName === '') {
    return change.name;
  }
  // Имена объектов 1С — идентификаторы без точек, поэтому точка однозначно разделяет пары.
  const segments = change.fullName.split('.');
  const pairs = segments.length % 2 === 0 && segments.every((s, i) => (i % 2 === 0 ? CLASS_ID.test(s) : s !== ''));
  if (!pairs) {
    return change.fullName;
  }
  return segments.map((s, i) => (i % 2 === 0 ? classTitle(s) : s)).join('.');
}

// Без locale: порядок одинаков на любой машине.
const byCode = (a: string, b: string): number => Number(a > b) - Number(a < b);

export function buildHistory(raw: CrsDepotHistory, users: readonly Pick<CrsDepotUser, 'id' | 'name'>[]): RepositoryHistory {
  const names = new Map(users.map((u) => [u.id, u.name]));
  // Автор мог быть удалён из списка пользователей — показываем начало его uuid, а не пустоту.
  const author = (id: string): string => names.get(id) ?? `Пользователь ${id.slice(0, 8)}`;
  const lists = new Map<number, HistoryChange[]>();
  const versions = [...raw.versions]
    .sort((a, b) => b.verNum - a.verNum)
    .map((v): HistoryVersion => {
      const changes: HistoryChange[] = [];
      lists.set(v.verNum, changes);
      const version: HistoryVersion = {
        verNum: v.verNum,
        versionId: v.versionId,
        authorId: v.userId,
        author: author(v.userId),
        date: v.date,
        configVersion: v.configVersion,
        platformVersion: v.platformVersion,
        comment: v.comment,
        changes,
      };
      const label = v.label;
      return label === undefined ? version : { ...version, label: { name: label.name, comment: label.comment, author: author(label.userId), date: label.date } };
    });
  // Изменение версии, которой нет в выборке, показать негде — оно пропускается.
  for (const change of raw.changes) {
    lists.get(change.verNum)?.push({ objectId: change.objectId, title: objectTitle(change), kind: describeChangeKind(change.action, change.removed) });
  }
  for (const changes of lists.values()) {
    changes.sort((a, b) => byCode(a.title, b.title));
  }
  return { versions, pending: [] };
}
