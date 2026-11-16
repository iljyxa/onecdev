import * as assert from 'assert';
import { parseRepositoryHistoryUiMessage } from '../../ui/views/repositoryHistory/repositoryHistoryMessages';

/**
 * Разбор входящих сообщений панели «История хранилища» (#117): webview — недоверенная сторона,
 * поэтому до провайдера доходит только закрытое множество команд.
 */
suite('parseRepositoryHistoryUiMessage (#117)', () => {
  test('ready', () => {
    assert.strictEqual(parseRepositoryHistoryUiMessage({ type: 'ready' }), 'ready');
  });

  for (const command of ['refresh', 'loadMore', 'clearFilter', 'exportReport'] as const) {
    test(`command ${command}`, () => {
      assert.strictEqual(parseRepositoryHistoryUiMessage({ type: 'command', command }), command);
    });
  }

  const garbage: readonly [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['строка', 'ready'],
    ['число', 42],
    ['неизвестный type', { type: 'refresh' }],
    ['command без команды', { type: 'command' }],
    ['неизвестная команда', { type: 'command', command: 'submit' }],
    ['команда не строкой', { type: 'command', command: ['refresh'] }],
    ['команда ready через command', { type: 'command', command: 'ready' }],
  ];
  for (const [name, raw] of garbage) {
    test(`мусор: ${name} → undefined`, () => {
      assert.strictEqual(parseRepositoryHistoryUiMessage(raw), undefined);
    });
  }
});
