import * as assert from 'assert';
import { devDepotReport } from '../../infra/repository/crs/CrsHistory';
import { depotUsers } from '../../infra/repository/crs/CrsUsers';
import { buildHistory, type HistoryVersion, type RepositoryHistory } from '../../infra/repository/history/RepositoryHistoryModel';
import type { RepositoryHistoryScope, RepositoryHistoryState, RepositoryHistoryViewModel } from '../../infra/repository/history/RepositoryHistoryService';
import type { RepositoryHistoryFailure } from '../../infra/repository/history/RepositoryHistorySession';
import {
  buildRepositoryHistoryViewDto,
  DEFAULT_MAX_CHANGES_SHOWN,
  describeHistoryFailure,
  describeVersionTooltip,
  formatHistoryDate,
  type RepositoryHistoryViewDto,
} from '../../infra/repository/history/RepositoryHistoryView';
import { corpusExchanges } from './support/crsFixtures';
import { assertNoHashes } from './support/crsMethods';
import { recordedClient } from './support/crsMethods';

/**
 * Представление истории для webview (#117): DTO без vscode — подписи, сообщения состояний, строка
 * догрузки, предел изменений. История — настоящий ответ tcp/history-all со всеми версиями.
 */

const AUTH = { user: 'Admin', passwordHash: 'd41d8cd98f00b204e9800998ecf8427e' };
const TARGET = { configRoot: '/проект/src/cf', configKind: 'cf' as const, displayName: 'Торговый учёт' };
const ROOT: RepositoryHistoryScope = { target: TARGET };
const FILTER = { objectId: '3e33ad69-478f-4f02-bad5-751699f70814', title: 'Справочник.Контрагенты' };
const OBJECT: RepositoryHistoryScope = { target: TARGET, filter: FILTER };
const FAILURE: RepositoryHistoryFailure = { code: 'unavailable', message: 'Сервер хранилища недоступен.' };
const TOO_LARGE: RepositoryHistoryFailure = { code: 'too-large', message: 'История слишком велика. Полная история доступна в отчёте Конфигуратора.' };

let full: RepositoryHistory;
let rawBodies: Buffer[];

async function historyAll(): Promise<RepositoryHistory> {
  const response = (method: string): Buffer => {
    const found = corpusExchanges().find((e) => e.transport === 'tcp' && e.scenario === 'history-all' && e.method === method);
    assert.ok(found, method);
    return found.response;
  };
  rawBodies = [response('DevDepot_devDepotReport'), response('UserManager_depotUsers')];
  const { client } = recordedClient(rawBodies);
  return buildHistory(await devDepotReport(client, AUTH), await depotUsers(client, AUTH, { removed: true }));
}

/** scope=null — без области (undefined подставил бы область по умолчанию). */
function view(state: RepositoryHistoryState, scope: RepositoryHistoryScope | null = ROOT, visible?: RepositoryHistory): RepositoryHistoryViewModel {
  return {
    state,
    ...(scope ? { scope } : {}),
    ...(scope?.filter ? { filter: scope.filter } : {}),
    ...(visible ? { visible } : {}),
  };
}

const ready = (history: RepositoryHistory, scope: RepositoryHistoryScope = ROOT, more?: { kind: 'loading' } | { kind: 'failed'; failure: RepositoryHistoryFailure }): RepositoryHistoryViewModel =>
  view(more ? { kind: 'ready', history, more } : { kind: 'ready', history }, scope, history);

const paged = (): RepositoryHistory => ({ versions: full.versions.slice(0, 2), pending: [4, 3, 2, 1] });

function assertNoSecrets(dto: RepositoryHistoryViewDto): void {
  const text = JSON.stringify(dto);
  assertNoHashes(dto, ...rawBodies);
  assert.ok(!/[0-9a-f]{40}/.test(text), 'в DTO хеш версии');
}

suite('RepositoryHistoryView (#117)', () => {
  suiteSetup(async () => {
    full = await historyAll();
  });

  test('formatHistoryDate: ISO → ДД.ММ.ГГГГ чч:мм:сс; иное — как есть', () => {
    assert.strictEqual(formatHistoryDate('2026-09-29T17:12:44'), '29.09.2026 17:12:44');
    assert.strictEqual(formatHistoryDate('2026-09-29'), '2026-09-29');
    assert.strictEqual(formatHistoryDate(''), '');
  });

  test('подсказка версии: с меткой, без метки, пустой комментарий метки, без комментария', () => {
    const labeled = full.versions.find((v) => v.label !== undefined && v.label.comment !== '');
    assert.ok(labeled?.label);
    const tip = describeVersionTooltip(labeled);
    assert.strictEqual(tip.split('\n')[0], `Версия ${String(labeled.verNum)} · ${labeled.author} · ${formatHistoryDate(labeled.date)}`);
    assert.ok(tip.includes(`Метка: ${labeled.label.name} (${labeled.label.author}, ${formatHistoryDate(labeled.label.date)})\n${labeled.label.comment}`));
    assert.ok(tip.endsWith(`\n\n${labeled.comment}`));
    const emptyLabelComment: HistoryVersion = { ...labeled, label: { ...labeled.label, comment: '' } };
    assert.ok(describeVersionTooltip(emptyLabelComment).includes(`(${labeled.label.author}, ${formatHistoryDate(labeled.label.date)})\n\n`));
    const plain = full.versions.find((v) => v.label === undefined && v.comment === '');
    assert.ok(plain, 'в history-all нет версии без комментария');
    const plainTip = describeVersionTooltip(plain);
    assert.ok(!plainTip.includes('Метка:'));
    assert.ok(plainTip.endsWith('\n\nБез комментария'));
    assert.ok(plainTip.includes(`Версия конфигурации: ${plain.configVersion}`));
  });

  test('describeHistoryFailure — текст отказа', () => {
    assert.strictEqual(describeHistoryFailure(FAILURE), FAILURE.message);
  });

  test('готовая история: версии, изменения, сводка, метка', () => {
    const dto = buildRepositoryHistoryViewDto(ready(full));
    assert.strictEqual(dto.title, 'История хранилища: Торговый учёт');
    assert.strictEqual(dto.filterTitle, undefined);
    assert.strictEqual(dto.status, 'ready');
    assert.strictEqual(dto.message, undefined);
    assert.strictEqual(dto.description, undefined);
    assert.strictEqual(dto.older, undefined);
    assert.strictEqual(dto.canClearFilter, false);
    assert.strictEqual(dto.canExportReport, false);
    assert.deepStrictEqual(dto.versions.map((v) => v.verNum), full.versions.map((v) => v.verNum));
    for (const [i, version] of full.versions.entries()) {
      const item = dto.versions[i];
      assert.strictEqual(item.title, `№ ${String(version.verNum)} · ${version.author} · ${formatHistoryDate(version.date)}`);
      assert.strictEqual(item.date, formatHistoryDate(version.date));
      assert.strictEqual(item.tooltip, describeVersionTooltip(version));
      assert.strictEqual(item.hiddenChanges, 0);
      assert.deepStrictEqual(item.changes.map((c) => c.objectId), version.changes.map((c) => c.objectId));
      assert.strictEqual(item.configVersion, version.configVersion);
      assert.strictEqual(item.platformVersion, version.platformVersion);
      const parts = [version.comment.split('\n')[0], version.label ? `[${version.label.name}]` : ''].filter((p) => p !== '');
      assert.strictEqual(item.summary, parts.length === 0 ? undefined : parts.join(' '));
      if (version.label) {
        assert.deepStrictEqual(item.label, { ...version.label, date: formatHistoryDate(version.label.date) });
      } else {
        assert.strictEqual(item.label, undefined);
      }
    }
    const kinds = new Set(dto.versions.flatMap((v) => v.changes.map((c) => `${c.kind}:${c.kindText}`)));
    assert.deepStrictEqual([...kinds].sort(), ['added:добавлен', 'modified:изменён']);
    assertNoSecrets(dto);
  });

  test('удалённый объект — «удалён»', () => {
    const [first] = full.versions;
    const removed: RepositoryHistory = { versions: [{ ...first, changes: [{ ...first.changes[0], kind: 'removed' }] }], pending: [] };
    assert.strictEqual(buildRepositoryHistoryViewDto(ready(removed)).versions[0].changes[0].kindText, 'удалён');
  });

  test('предел изменений версии: maxChangesShown=2 и hiddenChanges; по умолчанию 500', () => {
    const first = full.versions[full.versions.length - 1];
    assert.ok(first.changes.length > 2);
    const dto = buildRepositoryHistoryViewDto(ready(full), { maxChangesShown: 2 });
    const item = dto.versions[dto.versions.length - 1];
    assert.strictEqual(item.changes.length, 2);
    assert.strictEqual(item.hiddenChanges, first.changes.length - 2);
    assert.strictEqual(DEFAULT_MAX_CHANGES_SHOWN, 500);
  });

  test('строка догрузки: доступна, загрузка, ошибка; «показано N из M»', () => {
    const history = paged();
    const available = buildRepositoryHistoryViewDto(ready(history));
    assert.deepStrictEqual(available.older, {
      state: 'available',
      label: 'Загрузить более ранние версии…',
      description: 'ещё 4',
      tooltip: 'Показано версий: 2 из 6. Нажмите, чтобы загрузить более ранние.',
      remaining: 4,
    });
    assert.strictEqual(available.description, 'показано 2 из 6 версий');
    const loading = buildRepositoryHistoryViewDto(ready(history, ROOT, { kind: 'loading' }));
    assert.deepStrictEqual(loading.older, { state: 'loading', label: 'Загрузка более ранних версий…', tooltip: 'Показано версий: 2 из 6.', remaining: 4 });
    const failed = buildRepositoryHistoryViewDto(ready(history, ROOT, { kind: 'failed', failure: FAILURE }));
    assert.deepStrictEqual(failed.older, {
      state: 'failed',
      label: 'Повторить загрузку более ранних версий…',
      description: 'ошибка',
      tooltip: `${FAILURE.message}\nПоказано версий: 2 из 6.`,
      remaining: 4,
    });
    assert.strictEqual(failed.message, `${FAILURE.message} Загруженные версии сохранены.`);
    const withFilter = buildRepositoryHistoryViewDto(ready(history, OBJECT));
    assert.strictEqual(withFilter.description, `${FILTER.title} · показано 2 из 6 версий`);
  });

  test('без строки догрузки при обновлении и после отказа поверх неполной истории', () => {
    const history = paged();
    const refreshing = buildRepositoryHistoryViewDto(view({ kind: 'loading', stale: history }, ROOT, history));
    assert.strictEqual(refreshing.older, undefined);
    assert.strictEqual(refreshing.message, 'Обновление истории…');
    assert.strictEqual(refreshing.versions.length, 2);
    const failed = buildRepositoryHistoryViewDto(view({ kind: 'failed', failure: FAILURE, stale: history }, ROOT, history));
    assert.strictEqual(failed.older, undefined);
    assert.strictEqual(failed.message, `${FAILURE.message} Показаны данные прошлой загрузки.`);
  });

  const messages: readonly [string, RepositoryHistoryViewModel, string][] = [
    ['no-scope', view({ kind: 'no-scope' }, null), 'Выберите конфигурацию, расширение или объект, чтобы посмотреть историю хранилища.'],
    ['disconnected', view({ kind: 'disconnected' }), 'Хранилище не подключено. Выполните «Подключить к хранилищу».'],
    ['file-repository', view({ kind: 'file-repository' }), 'История файлового хранилища по протоколу сервера недоступна. Постройте отчёт через Конфигуратор.'],
    ['idle', view({ kind: 'idle' }), 'История не загружена.'],
    ['loading', view({ kind: 'loading' }), 'Загрузка истории…'],
    ['failed', view({ kind: 'failed', failure: FAILURE }), FAILURE.message],
  ];
  for (const [name, model, message] of messages) {
    test(`сообщение состояния ${name}`, () => {
      const dto = buildRepositoryHistoryViewDto(model);
      assert.strictEqual(dto.status, model.state.kind);
      assert.strictEqual(dto.message, message);
      assert.deepStrictEqual(dto.versions, []);
    });
  }

  test('пустая история — без фильтра и с фильтром', () => {
    const empty: RepositoryHistory = { versions: [], pending: [] };
    assert.strictEqual(buildRepositoryHistoryViewDto(ready(empty)).message, 'В хранилище нет версий.');
    const filtered = buildRepositoryHistoryViewDto(ready(empty, OBJECT));
    assert.strictEqual(filtered.message, `Нет версий, в которых изменён объект ${FILTER.title}.`);
    assert.strictEqual(filtered.filterTitle, FILTER.title);
    assert.strictEqual(filtered.description, FILTER.title);
    assert.strictEqual(filtered.canClearFilter, true);
    assert.strictEqual(filtered.title, 'История хранилища: Торговый учёт');
  });

  test('заголовок без области', () => {
    assert.strictEqual(buildRepositoryHistoryViewDto(view({ kind: 'no-scope' }, null)).title, 'История хранилища');
  });

  test('canExportReport: файловое хранилище и отказ too-large (загрузки и догрузки)', () => {
    assert.strictEqual(buildRepositoryHistoryViewDto(view({ kind: 'file-repository' })).canExportReport, true);
    assert.strictEqual(buildRepositoryHistoryViewDto(view({ kind: 'failed', failure: TOO_LARGE })).canExportReport, true);
    assert.strictEqual(buildRepositoryHistoryViewDto(view({ kind: 'failed', failure: FAILURE })).canExportReport, false);
    assert.strictEqual(buildRepositoryHistoryViewDto(ready(paged(), ROOT, { kind: 'failed', failure: TOO_LARGE })).canExportReport, true);
    assert.strictEqual(buildRepositoryHistoryViewDto(ready(paged(), ROOT, { kind: 'loading' })).canExportReport, false);
  });
});
