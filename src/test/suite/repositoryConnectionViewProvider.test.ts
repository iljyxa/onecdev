/**
 * Issue #184: форма подключения к хранилищу закрывалась сразу по «Подключиться», и ошибка
 * Конфигуратора приходила уведомлением после того, как введённые данные пропали. Теперь
 * провайдер отдаёт данные в `onSubmit` и закрывает форму только при успехе.
 *
 * HTML собирает настоящий `WebviewHtmlFactory` по реальному `dist/ui/manifest.json`; подменены
 * панель (`fakeWebviewPanel`) и `showErrorMessage`.
 */
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  type RepositoryConnectionFormData,
  type RepositoryConnectionSubmitOutcome,
  RepositoryConnectionViewProvider,
} from '../../ui/views/RepositoryConnectionViewProvider';
import { type FakeWebviewPanelFactory, installFakeWebviewPanels, readInitialState } from './support/fakeWebviewPanel';

const EXTENSION_ROOT = path.resolve(__dirname, '../../../');

const FORM_DATA: RepositoryConnectionFormData = {
  repoPath: 'tcp://server/repo',
  repoUser: 'Petrov',
  repoPassword: '123',
  forceBindAlreadyBindedUser: true,
  forceReplaceCfg: false,
};

type Outcome<T> = { settled: false } | { settled: true; value: T | undefined };

/** Следит за промисом, не дожидаясь его: незавершённость — тоже проверяемый результат. */
function track<T>(promise: Promise<T | undefined>): () => Promise<Outcome<T>> {
  let outcome: Outcome<T> = { settled: false };
  void promise.then((value) => { outcome = { settled: true, value }; });
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return outcome;
  };
}

/** `onSubmit`, исход которого тест задаёт сам: так видно состояние формы во время операции. */
function controllableSubmit(): {
  handler: (data: RepositoryConnectionFormData) => Promise<RepositoryConnectionSubmitOutcome<string>>;
  calls: RepositoryConnectionFormData[];
  finish: (outcome: RepositoryConnectionSubmitOutcome<string>) => void;
  fail: (error: Error) => void;
} {
  const calls: RepositoryConnectionFormData[] = [];
  let finish: (outcome: RepositoryConnectionSubmitOutcome<string>) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  return {
    calls,
    handler: (data) => {
      calls.push(data);
      return new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
    },
    finish: (outcome) => finish(outcome),
    fail: (error) => fail(error),
  };
}

const submitMessage = { type: 'command', command: 'submit', payload: FORM_DATA };

suite('RepositoryConnectionViewProvider — форма не закрывается до успеха (issue #184)', () => {
  const windowRef = vscode.window as Pick<typeof vscode.window, 'showErrorMessage'>;
  let originalShowError: typeof vscode.window.showErrorMessage;
  let notifications: string[];
  let panels: FakeWebviewPanelFactory;
  let provider: RepositoryConnectionViewProvider;

  setup(() => {
    notifications = [];
    originalShowError = vscode.window.showErrorMessage;
    windowRef.showErrorMessage = (message: string) => {
      notifications.push(message);
      return Promise.resolve(undefined);
    };
    panels = installFakeWebviewPanels();
    provider = new RepositoryConnectionViewProvider(vscode.Uri.file(EXTENSION_ROOT));
  });

  teardown(() => {
    provider.dispose();
    panels.restore();
    windowRef.showErrorMessage = originalShowError;
  });

  test('initialState несёт описание опций режима: в connect флаги принудительности включены', () => {
    void provider.show('connect', 'ТорговыйУчет', { repoPath: 'tcp://s/r', repoUser: 'Petrov', repoPasswordSet: true },
      () => Promise.resolve({ ok: true, value: '' }));
    const state = readInitialState(panels.panels[0].htmlHistory[0]) as {
      mode: string; target: string; initialBinding: unknown; form: { options: { id: string; defaultValue: unknown }[] };
    };
    assert.strictEqual(state.mode, 'connect');
    assert.strictEqual(state.target, 'ТорговыйУчет');
    assert.deepStrictEqual(state.initialBinding, { repoPath: 'tcp://s/r', repoUser: 'Petrov', repoPasswordSet: true });
    assert.deepStrictEqual(state.form.options.map((option) => [option.id, option.defaultValue]),
      [['forceBindAlreadyBindedUser', true], ['forceReplaceCfg', true]]);
  });

  test('ошибка onSubmit не закрывает форму и уходит в webview; повтор с успехом закрывает форму', async () => {
    const submit = controllableSubmit();
    const outcome = track(provider.show('connect', 'ТорговыйУчет', undefined, submit.handler));
    const [panel] = panels.panels;

    panel.receive(submitMessage);
    // Второй submit во время операции не запускает её повторно.
    panel.receive(submitMessage);
    submit.finish({ ok: false, error: 'Неверный пароль' });

    assert.deepStrictEqual(await outcome(), { settled: false });
    assert.strictEqual(panel.isDisposed(), false);
    assert.deepStrictEqual(panel.posted, [{ type: 'error', message: 'Неверный пароль' }]);
    assert.deepStrictEqual(submit.calls, [FORM_DATA]);
    assert.deepStrictEqual(notifications, []);

    panel.receive(submitMessage);
    submit.finish({ ok: true, value: 'привязано' });

    assert.deepStrictEqual(await outcome(), { settled: true, value: 'привязано' });
    assert.strictEqual(panel.isDisposed(), true);
    assert.strictEqual(submit.calls.length, 2);
  });

  test('исключение onSubmit показывается в форме как ошибка', async () => {
    const submit = controllableSubmit();
    const outcome = track(provider.show('create', 'ТорговыйУчет', undefined, submit.handler));
    const [panel] = panels.panels;

    panel.receive(submitMessage);
    submit.fail(new Error('сбой'));

    assert.deepStrictEqual(await outcome(), { settled: false });
    assert.deepStrictEqual(panel.posted, [{ type: 'error', message: 'сбой' }]);
  });

  test('отмена без операции возвращает undefined и закрывает форму', async () => {
    const submit = controllableSubmit();
    const outcome = track(provider.show('connect', 'ТорговыйУчет', undefined, submit.handler));

    panels.panels[0].receive({ type: 'command', command: 'cancel' });

    assert.deepStrictEqual(await outcome(), { settled: true, value: undefined });
    assert.strictEqual(panels.panels[0].isDisposed(), true);
    assert.deepStrictEqual(submit.calls, []);
  });

  test('отмена во время операции игнорируется: исход операции решает', async () => {
    const submit = controllableSubmit();
    const outcome = track(provider.show('connect', 'ТорговыйУчет', undefined, submit.handler));
    const [panel] = panels.panels;

    panel.receive(submitMessage);
    panel.receive({ type: 'command', command: 'cancel' });

    assert.deepStrictEqual(await outcome(), { settled: false });
    assert.strictEqual(panel.isDisposed(), false);
    submit.finish({ ok: true, value: 'готово' });
    assert.deepStrictEqual(await outcome(), { settled: true, value: 'готово' });
  });

  test('закрытие вкладки без операции возвращает undefined', async () => {
    const outcome = track(provider.show('connect', 'ТорговыйУчет', undefined, controllableSubmit().handler));

    panels.panels[0].panel.dispose();

    assert.deepStrictEqual(await outcome(), { settled: true, value: undefined });
  });

  test('закрытие вкладки во время операции: успех операции разрешает show()', async () => {
    const submit = controllableSubmit();
    const outcome = track(provider.show('connect', 'ТорговыйУчет', undefined, submit.handler));
    const [panel] = panels.panels;

    panel.receive(submitMessage);
    panel.panel.dispose();

    assert.deepStrictEqual(await outcome(), { settled: false });
    submit.finish({ ok: true, value: 'готово' });
    assert.deepStrictEqual(await outcome(), { settled: true, value: 'готово' });
    assert.deepStrictEqual(notifications, []);
  });

  test('закрытие вкладки во время операции: ошибка уходит уведомлением, show() → undefined', async () => {
    const submit = controllableSubmit();
    const outcome = track(provider.show('connect', 'ТорговыйУчет', undefined, submit.handler));
    const [panel] = panels.panels;

    panel.receive(submitMessage);
    panel.panel.dispose();
    submit.finish({ ok: false, error: 'Неверный пароль' });

    assert.deepStrictEqual(await outcome(), { settled: true, value: undefined });
    assert.deepStrictEqual(notifications, ['Неверный пароль']);
    assert.deepStrictEqual(panel.posted, []);
  });

  test('повторный show при открытой форме: прежний вызов получает undefined, форма перерисована под новый режим', async () => {
    const first = track(provider.show('connect', 'ТорговыйУчет', undefined, controllableSubmit().handler));
    const submit = controllableSubmit();
    const second = track(provider.show('create', 'Расширение', undefined, submit.handler));

    assert.strictEqual(panels.panels.length, 1);
    const [panel] = panels.panels;
    assert.strictEqual(panel.revealCount(), 1);
    assert.strictEqual(panel.panel.title, 'Создание хранилища');
    assert.deepStrictEqual(await first(), { settled: true, value: undefined });
    assert.strictEqual((readInitialState(panel.htmlHistory[1]) as { mode: string }).mode, 'create');

    panel.receive(submitMessage);
    submit.finish({ ok: true, value: 'создано' });
    assert.deepStrictEqual(await second(), { settled: true, value: 'создано' });
  });

  test('show во время операции только раскрывает форму и сразу возвращает undefined', async () => {
    const submit = controllableSubmit();
    const first = track(provider.show('connect', 'ТорговыйУчет', undefined, submit.handler));
    const [panel] = panels.panels;
    panel.receive(submitMessage);

    const second = track(provider.show('create', 'ТорговыйУчет', undefined, controllableSubmit().handler));

    assert.deepStrictEqual(await second(), { settled: true, value: undefined });
    assert.strictEqual(panel.revealCount(), 1);
    assert.strictEqual(panel.htmlHistory.length, 1);
    submit.finish({ ok: true, value: 'готово' });
    assert.deepStrictEqual(await first(), { settled: true, value: 'готово' });
  });

  test('show после закрытия вкладки во время операции не открывает новую форму', async () => {
    const submit = controllableSubmit();
    const first = track(provider.show('connect', 'ТорговыйУчет', undefined, submit.handler));
    panels.panels[0].receive(submitMessage);
    panels.panels[0].panel.dispose();

    const second = track(provider.show('connect', 'ТорговыйУчет', undefined, controllableSubmit().handler));

    assert.deepStrictEqual(await second(), { settled: true, value: undefined });
    assert.strictEqual(panels.panels.length, 1);
    submit.finish({ ok: true, value: 'готово' });
    assert.deepStrictEqual(await first(), { settled: true, value: 'готово' });
  });

  test('сообщения вне протокола игнорируются, форма остаётся открытой', async () => {
    const outcome = track(provider.show('connect', 'ТорговыйУчет', undefined, controllableSubmit().handler));
    const [panel] = panels.panels;

    panel.receive({ type: 'ready' });
    panel.receive({ type: 'command', command: 'refresh' });

    assert.deepStrictEqual(await outcome(), { settled: false });
    assert.strictEqual(panel.isDisposed(), false);
  });

  test('выбор папки хранилища: ответ с путём уходит в форму; отказ от выбора — без ответа', async () => {
    const windowOpen = vscode.window as Pick<typeof vscode.window, 'showOpenDialog'>;
    const originalOpen = vscode.window.showOpenDialog;
    const answers = [[vscode.Uri.file('/srv/repo')], undefined];
    windowOpen.showOpenDialog = () => Promise.resolve(answers.shift());
    try {
      void provider.show('connect', 'ТорговыйУчет', undefined, controllableSubmit().handler);
      const [panel] = panels.panels;
      const request = { type: 'request', requestId: 'browse', name: 'browseRepoPath' };

      panel.receive(request);
      panel.receive(request);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.deepStrictEqual(panel.posted, [{ type: 'reply', requestId: 'browse', payload: { repoPath: vscode.Uri.file('/srv/repo').fsPath } }]);
    } finally {
      windowOpen.showOpenDialog = originalOpen;
    }
  });
});
