/**
 * Панель «История хранилища» (#117): одна панель на окно, постоянный протокол состояния
 * (init в HTML, полное состояние по `ready` и при каждом изменении сервиса), команды тулбара
 * и закрытие панели. Сервис — настоящий `RepositoryHistoryService` на ответах crserver 8.5.1
 * (пробы стенда capture-history-probes); HTML собирает настоящий `WebviewHtmlFactory` по
 * `dist/ui/manifest.json`, подменена только сама панель — см. `fakeWebviewPanel`.
 */
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseCrsAddress } from '../../infra/repository/crs/CrsAddress';
import type { CrsTransportError } from '../../infra/repository/crs/CrsTransport';
import {
  RepositoryHistoryService,
  type RepositoryHistoryScope,
} from '../../infra/repository/history/RepositoryHistoryService';
import type { RepositoryHistorySessionResolution } from '../../infra/repository/history/RepositoryHistorySession';
import { buildRepositoryHistoryViewDto } from '../../infra/repository/history/RepositoryHistoryView';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import { RepositoryHistoryViewProvider } from '../../ui/views/repositoryHistory/RepositoryHistoryViewProvider';
import { tcpBodyProbe } from './support/crsFixtures';
import { assertNoHashes, recordedClient, STAND_VERSION } from './support/crsMethods';
import { type FakeWebviewPanel, type FakeWebviewPanelFactory, installFakeWebviewPanels, readInitialState } from './support/fakeWebviewPanel';

const EXTENSION_ROOT = path.resolve(__dirname, '../../../');

const LIST_ALL = tcpBodyProbe('probe-history-devdepotversions').response;
const PAGE_5_7 = tcpBodyProbe('probe-history-page-5-7').response;
const PAGE_2_4 = tcpBodyProbe('probe-history-page-2-4').response;
const USERS = tcpBodyProbe('probe-depot-users-no-bind').response;

const CF: RepositoryTarget = { configRoot: path.join(path.sep, 'проект', 'src', 'cf'), configKind: 'cf', displayName: 'Торговый учёт' };
const CFE: RepositoryTarget = {
  configRoot: path.join(path.sep, 'проект', 'src', 'cfe', 'EVOLC'),
  configKind: 'cfe',
  extensionName: 'EVOLC',
  displayName: 'EVOLC',
};
const ROOT_SCOPE: RepositoryHistoryScope = { target: CF };
const CATALOG_SCOPE: RepositoryHistoryScope = {
  target: CF,
  filter: { objectId: '3e33ad69-478f-4f02-bad5-751699f70814', title: 'Справочник.Контрагенты' },
};

const SESSION: RepositoryHistorySessionResolution = {
  kind: 'session',
  session: {
    key: `${CF.configRoot}|tcp://127.0.0.1:1542/exp|Admin`,
    target: CF,
    address: parseCrsAddress('tcp://127.0.0.1:1542/exp'),
    auth: { user: 'Admin', passwordHash: 'd41d8cd98f00b204e9800998ecf8427e' },
    versionHint: STAND_VERSION,
  },
};

/**
 * Сервис с ответами по прогонам: каждый прогон загрузки берёт свой набор тел из очереди
 * (сервис создаёт клиента на прогон). Сеть недоступна в тесте — транспорт записанный.
 */
class Harness {
  resolution: RepositoryHistorySessionResolution = { kind: 'disconnected' };
  readonly runs: (Buffer | CrsTransportError)[][] = [];
  readonly service = new RepositoryHistoryService({
    resolveSession: () => Promise.resolve(this.resolution),
    createClient: () => {
      const outcomes = this.runs.shift();
      assert.ok(outcomes, 'лишний прогон загрузки');
      return recordedClient(outcomes).client;
    },
    onError: (error) => assert.fail(String(error)),
    pageSize: 3,
  });
  readonly commands: unknown[][] = [];

  provider(withExecute: boolean): RepositoryHistoryViewProvider {
    const uri = vscode.Uri.file(EXTENSION_ROOT);
    return withExecute
      ? new RepositoryHistoryViewProvider(uri, this.service, (...args) => {
        this.commands.push(args);
        return Promise.resolve(undefined);
      })
      : new RepositoryHistoryViewProvider(uri, this.service);
  }

  get dto(): unknown {
    return buildRepositoryHistoryViewDto(this.service.view);
  }
}

function lastPosted(panel: FakeWebviewPanel): unknown {
  return panel.posted[panel.posted.length - 1];
}

suite('RepositoryHistoryViewProvider — панель истории хранилища (#117)', () => {
  let panels: FakeWebviewPanelFactory;
  let h: Harness;
  let provider: RepositoryHistoryViewProvider;

  setup(() => {
    panels = installFakeWebviewPanels();
    h = new Harness();
    provider = h.provider(false);
  });

  teardown(() => {
    provider.dispose();
    h.service.dispose();
    panels.restore();
  });

  test('одна панель: начальное состояние в HTML, повторный show — reveal, новая область и заголовок', async () => {
    provider.show(ROOT_SCOPE);
    assert.strictEqual(panels.panels.length, 1);
    const [panel] = panels.panels;
    assert.strictEqual(panel.panel.title, 'История хранилища: Торговый учёт');
    assert.deepStrictEqual(readInitialState(panel.htmlHistory[0]), buildRepositoryHistoryViewDto({ state: { kind: 'idle' }, scope: ROOT_SCOPE }));
    await h.service.ensureLoaded();
    assert.strictEqual(h.service.view.state.kind, 'disconnected');

    provider.show(CATALOG_SCOPE);

    assert.strictEqual(panels.panels.length, 1);
    assert.strictEqual(panel.revealCount(), 1);
    assert.strictEqual(panel.panel.title, 'История хранилища: Торговый учёт — Справочник.Контрагенты');
    assert.deepStrictEqual(h.service.view.scope, CATALOG_SCOPE);
    await h.service.ensureLoaded();
    assert.deepStrictEqual(lastPosted(panel), { type: 'state', state: h.dto });
  });

  test('ready — полное текущее состояние; каждое изменение сервиса — сообщение state с DTO', async () => {
    h.resolution = SESSION;
    h.runs.push([LIST_ALL, PAGE_5_7, USERS]);
    provider.show(ROOT_SCOPE);
    const [panel] = panels.panels;
    await h.service.ensureLoaded();

    const kinds = panel.posted.map((m) => (m as { state: { status: string } }).state.status);
    assert.deepStrictEqual(kinds, ['loading', 'ready']);
    const ready = lastPosted(panel) as { type: string; state: { versions: unknown[] } };
    assert.deepStrictEqual(ready, { type: 'state', state: h.dto });
    assert.strictEqual(ready.state.versions.length, 3);
    // Ключи присланного состояния — ровно ключи DTO: ни versionId, ни хешей паролей webview не получает.
    assertNoHashes(JSON.stringify(panel.posted));
    assert.ok(!/[0-9a-f]{40}/.test(JSON.stringify(panel.posted)));

    const before = panel.posted.length;
    panel.receive({ type: 'ready' });
    assert.strictEqual(panel.posted.length, before + 1);
    assert.deepStrictEqual(lastPosted(panel), { type: 'state', state: h.dto });
  });

  test('loadMore догружает более ранние версии, refresh загружает первую страницу заново', async () => {
    h.resolution = SESSION;
    h.runs.push([LIST_ALL, PAGE_5_7, USERS], [PAGE_2_4, USERS], [LIST_ALL, PAGE_5_7, USERS]);
    provider.show(ROOT_SCOPE);
    const [panel] = panels.panels;
    await h.service.ensureLoaded();

    panel.receive({ type: 'command', command: 'loadMore' });
    await h.service.loadMore();
    assert.deepStrictEqual(h.service.view.visible?.versions.map((v) => v.verNum), [7, 6, 5, 4, 3, 2]);
    assert.deepStrictEqual(lastPosted(panel), { type: 'state', state: h.dto });

    panel.receive({ type: 'command', command: 'refresh' });
    assert.strictEqual(h.service.view.state.kind, 'loading');
    await h.service.refresh();
    const refreshed = h.service.view.visible;
    assert.ok(refreshed);
    assert.deepStrictEqual(refreshed.versions.map((v) => v.verNum), [7, 6, 5]);
    assert.deepStrictEqual(lastPosted(panel), { type: 'state', state: h.dto });
    assert.strictEqual(h.runs.length, 0);
  });

  test('clearFilter — вся история той же цели, заголовок без объекта; без фильтра — ничего', async () => {
    provider.show(CATALOG_SCOPE);
    const [panel] = panels.panels;
    await h.service.ensureLoaded();

    panel.receive({ type: 'command', command: 'clearFilter' });

    assert.deepStrictEqual(h.service.view.scope, ROOT_SCOPE);
    assert.strictEqual(panel.panel.title, 'История хранилища: Торговый учёт');
    await h.service.ensureLoaded();
    const posted = panel.posted.length;

    panel.receive({ type: 'command', command: 'clearFilter' });

    assert.deepStrictEqual(h.service.view.scope, ROOT_SCOPE);
    assert.strictEqual(panel.posted.length, posted);
  });

  const reports: readonly [RepositoryTarget, string][] = [[CF, 'configuration'], [CFE, 'extension']];
  for (const [target, nodeKind] of reports) {
    test(`exportReport — отчёт Конфигуратора по корню цели (${target.configKind})`, () => {
      provider = h.provider(true);
      provider.show({ target });
      panels.panels[0].receive({ type: 'command', command: 'exportReport' });
      assert.deepStrictEqual(h.commands, [[
        'onecdev.repository.report',
        { nodeKind, xmlPath: path.join(target.configRoot, 'Configuration.xml') },
      ]]);
    });
  }

  test('команды без области сервиса (область сброшена извне) ничего не делают', () => {
    provider = h.provider(true);
    provider.show(CATALOG_SCOPE);
    const [panel] = panels.panels;
    h.service.setScope(undefined);
    const posted = panel.posted.length;

    panel.receive({ type: 'command', command: 'clearFilter' });
    panel.receive({ type: 'command', command: 'exportReport' });

    assert.strictEqual(h.service.view.scope, undefined);
    assert.deepStrictEqual(h.commands, []);
    assert.strictEqual(panel.posted.length, posted);
  });

  test('мусорные сообщения игнорируются', () => {
    provider = h.provider(true);
    provider.show(ROOT_SCOPE);
    const [panel] = panels.panels;
    const posted = panel.posted.length;
    const state = h.service.view;

    for (const raw of [null, 'refresh', { type: 'command', command: 'submit' }, { type: 'refresh' }]) {
      panel.receive(raw);
    }

    assert.strictEqual(panel.posted.length, posted);
    assert.strictEqual(h.service.view, state);
    assert.deepStrictEqual(h.commands, []);
  });

  test('закрытие панели сбрасывает область и отписывает: больше ни одного сообщения; show — новая панель', async () => {
    provider.show(ROOT_SCOPE);
    const [panel] = panels.panels;
    await h.service.ensureLoaded();
    const posted = panel.posted.length;

    panel.panel.dispose();

    assert.strictEqual(h.service.view.state.kind, 'no-scope');
    h.service.setScope(CATALOG_SCOPE);
    assert.strictEqual(panel.posted.length, posted);
    provider.dispose();

    provider.show(ROOT_SCOPE);
    assert.strictEqual(panels.panels.length, 2);
    assert.strictEqual(panels.panels[1].revealCount(), 0);
  });

  test('dispose провайдера закрывает открытую панель', () => {
    provider.show(ROOT_SCOPE);
    provider.dispose();
    assert.strictEqual(panels.panels[0].isDisposed(), true);
    assert.strictEqual(h.service.view.state.kind, 'no-scope');
  });
});
