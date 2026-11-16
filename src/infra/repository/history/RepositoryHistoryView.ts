// Представление истории хранилища для webview без vscode: подписи, сообщения состояний и строка догрузки
// решаются здесь, где они тестируются без Extension Host; панель только рисует готовый DTO. В DTO нет
// хешей версий (versionId) и учётных данных — только то, что видит пользователь.
import type { HistoryChange, HistoryChangeKind, HistoryVersion, RepositoryHistory } from './RepositoryHistoryModel';
import type { HistoryMoreState, RepositoryHistoryState, RepositoryHistoryViewModel } from './RepositoryHistoryService';
import type { RepositoryHistoryFailure } from './RepositoryHistorySession';

/** Предел изменений версии в панели: первая версия несёт всю конфигурацию. */
export const DEFAULT_MAX_CHANGES_SHOWN = 500;

export interface RepositoryHistoryChangeDto {
  readonly objectId: string;
  readonly title: string;
  readonly kind: HistoryChangeKind;
  readonly kindText: string;
}

export interface RepositoryHistoryVersionDto {
  readonly verNum: number;
  readonly title: string;
  readonly author: string;
  readonly date: string;
  readonly comment: string;
  readonly summary?: string;
  readonly label?: { readonly name: string; readonly comment: string; readonly author: string; readonly date: string };
  readonly tooltip: string;
  readonly configVersion: string;
  readonly platformVersion: string;
  readonly changes: readonly RepositoryHistoryChangeDto[];
  readonly hiddenChanges: number;
}

export interface RepositoryHistoryOlderDto {
  readonly state: 'available' | 'loading' | 'failed';
  readonly label: string;
  readonly description?: string;
  readonly tooltip: string;
  readonly remaining: number;
}

export interface RepositoryHistoryViewDto {
  readonly title: string;
  readonly filterTitle?: string;
  readonly status: RepositoryHistoryState['kind'];
  readonly message?: string;
  readonly description?: string;
  readonly versions: readonly RepositoryHistoryVersionDto[];
  readonly older?: RepositoryHistoryOlderDto;
  readonly canClearFilter: boolean;
  readonly canExportReport: boolean;
}

const KIND_TEXT: Readonly<Record<HistoryChangeKind, string>> = { added: 'добавлен', modified: 'изменён', removed: 'удалён' };
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/** '2026-09-29T17:12:44' → '29.09.2026 17:12:44'. Пояс сервер не сообщает, поэтому только перестановка. */
export function formatHistoryDate(iso: string): string {
  const m = ISO_DATE.exec(iso);
  return m === null ? iso : `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}:${m[6]}`;
}

/** Простой текст без markdown: комментарий пишет пользователь. */
export function describeVersionTooltip(version: HistoryVersion): string {
  const lines = [`Версия ${String(version.verNum)} · ${version.author} · ${formatHistoryDate(version.date)}`, `Версия конфигурации: ${version.configVersion}`];
  const label = version.label;
  if (label !== undefined) {
    // Пустой комментарий метки строки не занимает.
    lines.push(`Метка: ${label.name} (${label.author}, ${formatHistoryDate(label.date)})`, ...[label.comment].filter((c) => c !== ''));
  }
  lines.push('', version.comment === '' ? 'Без комментария' : version.comment);
  return lines.join('\n');
}

/** Текст отказа уже собран без секретов (toRepositoryHistoryFailure), в том числе для too-large. */
export function describeHistoryFailure(failure: RepositoryHistoryFailure): string {
  return failure.message;
}

function changeDto(change: HistoryChange): RepositoryHistoryChangeDto {
  return { objectId: change.objectId, title: change.title, kind: change.kind, kindText: KIND_TEXT[change.kind] };
}

function versionDto(version: HistoryVersion, maxChangesShown: number): RepositoryHistoryVersionDto {
  const summary = [version.comment.split('\n')[0], version.label === undefined ? '' : `[${version.label.name}]`].filter((p) => p !== '').join(' ');
  const shown = version.changes.slice(0, maxChangesShown).map(changeDto);
  const label = version.label;
  return {
    verNum: version.verNum,
    title: `№ ${String(version.verNum)} · ${version.author} · ${formatHistoryDate(version.date)}`,
    author: version.author,
    date: formatHistoryDate(version.date),
    comment: version.comment,
    ...(summary === '' ? {} : { summary }),
    ...(label === undefined ? {} : { label: { name: label.name, comment: label.comment, author: label.author, date: formatHistoryDate(label.date) } }),
    tooltip: describeVersionTooltip(version),
    configVersion: version.configVersion,
    platformVersion: version.platformVersion,
    changes: shown,
    hiddenChanges: version.changes.length - shown.length,
  };
}

/** «Показано версий: N из M.» — N загружено, M — всего по фильтру. */
function shownText(history: RepositoryHistory): string {
  return `Показано версий: ${String(history.versions.length)} из ${String(history.versions.length + history.pending.length)}.`;
}

function olderDto(history: RepositoryHistory, more: HistoryMoreState | undefined): RepositoryHistoryOlderDto {
  const remaining = history.pending.length;
  if (more?.kind === 'loading') {
    return { state: 'loading', label: 'Загрузка более ранних версий…', tooltip: shownText(history), remaining };
  }
  if (more?.kind === 'failed') {
    return {
      state: 'failed',
      label: 'Повторить загрузку более ранних версий…',
      description: 'ошибка',
      tooltip: `${describeHistoryFailure(more.failure)}\n${shownText(history)}`,
      remaining,
    };
  }
  return {
    state: 'available',
    label: 'Загрузить более ранние версии…',
    description: `ещё ${String(remaining)}`,
    tooltip: `${shownText(history)} Нажмите, чтобы загрузить более ранние.`,
    remaining,
  };
}

function message(view: RepositoryHistoryViewModel): string | undefined {
  const state = view.state;
  switch (state.kind) {
    case 'no-scope':
      return 'Выберите конфигурацию, расширение или объект, чтобы посмотреть историю хранилища.';
    case 'disconnected':
      return 'Хранилище не подключено. Выполните «Подключить к хранилищу».';
    case 'file-repository':
      return 'История файлового хранилища по протоколу сервера недоступна. Постройте отчёт через Конфигуратор.';
    case 'idle':
      return 'История не загружена.';
    case 'loading':
      return state.stale === undefined ? 'Загрузка истории…' : 'Обновление истории…';
    case 'failed':
      return state.stale === undefined ? describeHistoryFailure(state.failure) : `${describeHistoryFailure(state.failure)} Показаны данные прошлой загрузки.`;
    case 'ready':
      if (state.more?.kind === 'failed') {
        return `${describeHistoryFailure(state.more.failure)} Загруженные версии сохранены.`;
      }
      if (state.history.versions.length > 0) {
        return undefined;
      }
      return view.filter === undefined ? 'В хранилище нет версий.' : `Нет версий, в которых изменён объект ${view.filter.title}.`;
  }
}

function description(view: RepositoryHistoryViewModel): string | undefined {
  const visible = view.visible;
  const title = view.filter?.title;
  if (visible === undefined || visible.pending.length === 0) {
    return title;
  }
  const shown = `показано ${String(visible.versions.length)} из ${String(visible.versions.length + visible.pending.length)} версий`;
  return title === undefined ? shown : `${title} · ${shown}`;
}

/** Отчёт Конфигуратора — выход, когда протокол сервера историю не отдаёт: файловое хранилище или слишком большой ответ. */
function canExportReport(state: RepositoryHistoryState): boolean {
  const failure = state.kind === 'failed' ? state.failure : state.kind === 'ready' && state.more?.kind === 'failed' ? state.more.failure : undefined;
  return state.kind === 'file-repository' || failure?.code === 'too-large';
}

export function buildRepositoryHistoryViewDto(view: RepositoryHistoryViewModel, options: { readonly maxChangesShown?: number } = {}): RepositoryHistoryViewDto {
  const max = options.maxChangesShown ?? DEFAULT_MAX_CHANGES_SHOWN;
  const visible = view.visible;
  const state = view.state;
  // Догружать можно только готовую историю: во время обновления и после отказа строка увела бы к прежней.
  const older = state.kind === 'ready' && state.history.pending.length > 0 ? olderDto(state.history, state.more) : undefined;
  const text = message(view);
  const desc = description(view);
  return {
    title: view.scope === undefined ? 'История хранилища' : `История хранилища: ${view.scope.target.displayName}`,
    ...(view.filter === undefined ? {} : { filterTitle: view.filter.title }),
    status: state.kind,
    ...(text === undefined ? {} : { message: text }),
    ...(desc === undefined ? {} : { description: desc }),
    versions: (visible?.versions ?? []).map((v) => versionDto(v, max)),
    ...(older === undefined ? {} : { older }),
    canClearFilter: view.filter !== undefined,
    canExportReport: canExportReport(state),
  };
}
