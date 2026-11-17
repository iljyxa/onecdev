import * as assert from 'assert';
import {
  applyMainBindingToAutumn,
  applyMainBindingToEnvDefaults,
  removeMainBindingFromAutumn,
  removeMainBindingFromEnvDefaults,
  selectMainStorageBinding,
  type MainStorageBindingRead,
} from '../../infra/repository/VrunnerStorageKeys';

/**
 * Issue #120: привязка основной конфигурации к хранилищу читается из стандартных
 * ключей vanessa-runner (env.json 2.x `--storage-*`, autumn-properties.json 3.x
 * `vrunner.storage-*`) и из ключей прежних версий расширения (`--repo-*`).
 */
suite('VrunnerStorageKeys — selectMainStorageBinding (issue #120)', () => {
  type Row = [
    title: string,
    env: Record<string, unknown>,
    autumn: Record<string, unknown> | undefined,
    expected: MainStorageBindingRead | null,
  ];
  const rows: Row[] = [
    [
      'только --storage-*',
      { '--ibconnection': '/F./build/ib', '--storage-name': 'tcp://srv/main', '--storage-user': 'alice' },
      undefined,
      { source: 'env-storage', repoPath: 'tcp://srv/main', repoUser: 'alice', filePassword: '' },
    ],
    [
      'только legacy --repo-*',
      { '--repo-path': '\\\\srv\\repo', '--repo-user': 'bob' },
      undefined,
      { source: 'env-legacy', repoPath: '\\\\srv\\repo', repoUser: 'bob', filePassword: '' },
    ],
    [
      'стандарт и legacy одинаковые → env-storage',
      { '--storage-name': 'tcp://srv/a', '--storage-user': 'u', '--repo-path': 'tcp://srv/a', '--repo-user': 'u' },
      undefined,
      { source: 'env-storage', repoPath: 'tcp://srv/a', repoUser: 'u', filePassword: '' },
    ],
    [
      'стандарт и legacy разные → env-storage',
      { '--repo-path': 'tcp://old', '--repo-user': 'old', '--storage-name': 'tcp://new', '--storage-user': 'new' },
      undefined,
      { source: 'env-storage', repoPath: 'tcp://new', repoUser: 'new', filePassword: '' },
    ],
    [
      '--storage-name без --storage-user, но с --repo-user → пользователь не смешивается',
      { '--storage-name': 'tcp://new', '--repo-path': 'tcp://old', '--repo-user': 'old' },
      undefined,
      { source: 'env-storage', repoPath: 'tcp://new', repoUser: '', filePassword: '' },
    ],
    [
      'пустой --storage-name с legacy → env-legacy',
      { '--storage-name': '', '--storage-user': 'x', '--repo-path': 'tcp://old', '--repo-user': 'old' },
      undefined,
      { source: 'env-legacy', repoPath: 'tcp://old', repoUser: 'old', filePassword: '' },
    ],
    [
      'пробельный --storage-name и autumn → autumn',
      { '--storage-name': '   ' },
      { vrunner: { 'storage-name': 'http://srv/repo', 'storage-user': 'carol' } },
      { source: 'autumn', repoPath: 'http://srv/repo', repoUser: 'carol', filePassword: '' },
    ],
    [
      'только autumn',
      {},
      { vrunner: { 'storage-name': '/var/repo', 'storage-user': 'dan', cf: { compile: {} } } },
      { source: 'autumn', repoPath: '/var/repo', repoUser: 'dan', filePassword: '' },
    ],
    [
      'autumn + legacy → env-legacy',
      { '--repo-path': 'tcp://old' },
      { vrunner: { 'storage-name': 'tcp://autumn' } },
      { source: 'env-legacy', repoPath: 'tcp://old', repoUser: '', filePassword: '' },
    ],
    [
      'autumn + --storage-* → env-storage',
      { '--storage-name': 'tcp://env', '--storage-user': 'e' },
      { vrunner: { 'storage-name': 'tcp://autumn', 'storage-user': 'a' } },
      { source: 'env-storage', repoPath: 'tcp://env', repoUser: 'e', filePassword: '' },
    ],
    ['autumn: vrunner не объект', {}, { vrunner: 'строка' }, null],
    ['autumn: vrunner массив', {}, { vrunner: ['tcp://x'] }, null],
    ['autumn: storage-name не строка', {}, { vrunner: { 'storage-name': 42 } }, null],
    ['autumn: storage-name пустой', {}, { vrunner: { 'storage-name': ' ' } }, null],
    ['autumn: секции vrunner нет', {}, { other: {} }, null],
    ['ничего нет (autumn-файла нет)', { '--ibconnection': '/F./ib' }, undefined, null],
    [
      'значения обрезаются',
      { '--storage-name': '  tcp://srv/main \t', '--storage-user': ' alice ' },
      undefined,
      { source: 'env-storage', repoPath: 'tcp://srv/main', repoUser: 'alice', filePassword: '' },
    ],
    [
      'legacy: обрезка и пользователь не строка → ""',
      { '--repo-path': ' tcp://old ', '--repo-user': 42 },
      undefined,
      { source: 'env-legacy', repoPath: 'tcp://old', repoUser: '', filePassword: '' },
    ],
    [
      'autumn: обрезка, пользователь не строка → ""',
      {},
      { vrunner: { 'storage-name': ' tcp://a ', 'storage-user': null } },
      { source: 'autumn', repoPath: 'tcp://a', repoUser: '', filePassword: '' },
    ],
    [
      'filePassword env-storage — --storage-pwd',
      { '--storage-name': 'tcp://a', '--storage-pwd': 's3cret', '--repo-pwd': 'legacy' },
      undefined,
      { source: 'env-storage', repoPath: 'tcp://a', repoUser: '', filePassword: 's3cret' },
    ],
    [
      'filePassword env-legacy — --repo-pwd',
      { '--repo-path': 'tcp://a', '--repo-pwd': 'legacy', '--storage-pwd': 'std' },
      undefined,
      { source: 'env-legacy', repoPath: 'tcp://a', repoUser: '', filePassword: 'legacy' },
    ],
    [
      'filePassword autumn — vrunner.storage-pwd',
      {},
      { vrunner: { 'storage-name': 'tcp://a', 'storage-pwd': 'autumn-pwd' } },
      { source: 'autumn', repoPath: 'tcp://a', repoUser: '', filePassword: 'autumn-pwd' },
    ],
  ];

  for (const [title, env, autumn, expected] of rows) {
    test(title, () => {
      assert.deepStrictEqual(selectMainStorageBinding(env, () => autumn), expected);
    });
  }

  test('autumn-properties.json не читается, если привязку дал env.json (горячий путь hasBinding)', () => {
    let calls = 0;
    const readAutumn = (): Record<string, unknown> => {
      calls += 1;
      return { vrunner: { 'storage-name': 'tcp://autumn' } };
    };
    selectMainStorageBinding({ '--storage-name': 'tcp://env' }, readAutumn);
    selectMainStorageBinding({ '--repo-path': 'tcp://old' }, readAutumn);
    assert.strictEqual(calls, 0);
    selectMainStorageBinding({}, readAutumn);
    assert.strictEqual(calls, 1);
  });
});

suite('VrunnerStorageKeys — запись и удаление в env.json default (issue #120)', () => {
  const binding = { repoPath: 'tcp://srv/new', repoUser: 'new' };

  test('legacy в середине → стандартные ключи на его позиции, legacy и --repo-pwd удалены', () => {
    const input = {
      '--ibconnection': '/F./ib',
      '--repo-path': 'tcp://old',
      '--repo-user': 'old',
      '--repo-pwd': 'pwd',
      '--v8version': '8.3.27',
      extension: { Ext: { 'repo-path': 'x', 'repo-user': 'y' } },
    };
    const snapshot = JSON.stringify(input);

    const result = applyMainBindingToEnvDefaults(input, binding);

    assert.deepStrictEqual(Object.keys(result), ['--ibconnection', '--storage-name', '--storage-user', '--v8version', 'extension']);
    assert.strictEqual(result['--storage-name'], 'tcp://srv/new');
    assert.strictEqual(result['--storage-user'], 'new');
    assert.deepStrictEqual(result.extension, { Ext: { 'repo-path': 'x', 'repo-user': 'y' } });
    assert.strictEqual(JSON.stringify(input), snapshot, 'вход не мутирован');
  });

  test('legacy и --storage-* вместе → позиция legacy в приоритете', () => {
    const result = applyMainBindingToEnvDefaults(
      { '--storage-name': 'tcp://std', a: 1, '--repo-user': 'old', b: 2, '--storage-user': 'std' },
      binding
    );
    assert.deepStrictEqual(Object.keys(result), ['a', '--storage-name', '--storage-user', 'b']);
    assert.strictEqual(result['--storage-name'], 'tcp://srv/new');
  });

  test('существующие --storage-* обновляются на месте, --storage-pwd и посторонние сохранены', () => {
    const input = { a: 1, '--storage-name': 'tcp://old', '--storage-user': 'old', '--storage-pwd': 'p', b: 2 };
    const snapshot = JSON.stringify(input);

    const result = applyMainBindingToEnvDefaults(input, binding);

    assert.deepStrictEqual(result, { a: 1, '--storage-name': 'tcp://srv/new', '--storage-user': 'new', '--storage-pwd': 'p', b: 2 });
    assert.deepStrictEqual(Object.keys(result), ['a', '--storage-name', '--storage-user', '--storage-pwd', 'b']);
    assert.strictEqual(JSON.stringify(input), snapshot, 'вход не мутирован');
  });

  test('ни legacy, ни стандартных ключей → в конец default', () => {
    const result = applyMainBindingToEnvDefaults({ '--ibconnection': '/F./ib', '--storage-pwd': 'p' }, binding);
    assert.deepStrictEqual(Object.keys(result), ['--ibconnection', '--storage-pwd', '--storage-name', '--storage-user']);
  });

  test('removeMainBindingFromEnvDefaults удаляет пять ключей, --storage-pwd и посторонние сохраняет', () => {
    const input = {
      '--ibconnection': '/F./ib',
      '--storage-name': 'a',
      '--storage-user': 'b',
      '--storage-pwd': 'p',
      '--repo-path': 'c',
      '--repo-user': 'd',
      '--repo-pwd': 'e',
      extension: {},
    };
    const snapshot = JSON.stringify(input);

    const result = removeMainBindingFromEnvDefaults(input);

    assert.deepStrictEqual(result, { '--ibconnection': '/F./ib', '--storage-pwd': 'p', extension: {} });
    assert.strictEqual(JSON.stringify(input), snapshot, 'вход не мутирован');
  });
});

suite('VrunnerStorageKeys — autumn-properties.json (issue #120)', () => {
  const binding = { repoPath: 'tcp://srv/new', repoUser: 'new' };

  test('есть storage-name → оба ключа обновлены, остальное сохранено', () => {
    const input = {
      $schema: 'x',
      vrunner: { ibconnection: '/F./ib', 'storage-name': 'tcp://old', 'storage-user': 'old', 'storage-pwd': 'p', cf: { compile: {} } },
      other: 1,
    };
    const snapshot = JSON.stringify(input);

    const result = applyMainBindingToAutumn(input, binding);

    assert.deepStrictEqual(result, {
      $schema: 'x',
      vrunner: { ibconnection: '/F./ib', 'storage-name': 'tcp://srv/new', 'storage-user': 'new', 'storage-pwd': 'p', cf: { compile: {} } },
      other: 1,
    });
    assert.deepStrictEqual(Object.keys(result), ['$schema', 'vrunner', 'other']);
    assert.strictEqual(JSON.stringify(input), snapshot, 'вход не мутирован');
  });

  test('нет storage-user → добавлен', () => {
    const result = applyMainBindingToAutumn({ vrunner: { 'storage-name': 'tcp://old' } }, binding);
    assert.deepStrictEqual(result, { vrunner: { 'storage-name': 'tcp://srv/new', 'storage-user': 'new' } });
  });

  const untouched: [string, Record<string, unknown>][] = [
    ['нет storage-name', { vrunner: { 'storage-user': 'u' } }],
    ['storage-name не строка', { vrunner: { 'storage-name': 1 } }],
    ['нет vrunner', { other: {} }],
    ['vrunner — массив', { vrunner: [] }],
    ['vrunner — null', { vrunner: null }],
  ];
  for (const [title, root] of untouched) {
    test(`applyMainBindingToAutumn: ${title} → undefined`, () => {
      assert.strictEqual(applyMainBindingToAutumn(root, binding), undefined);
    });
  }

  test('removeMainBindingFromAutumn: storage-name/user удалены, storage-pwd сохранён, вход не мутирован', () => {
    const input = { vrunner: { 'storage-name': 'a', 'storage-user': 'b', 'storage-pwd': 'p', x: 1 }, y: 2 };
    const snapshot = JSON.stringify(input);

    assert.deepStrictEqual(removeMainBindingFromAutumn(input), { vrunner: { 'storage-pwd': 'p', x: 1 }, y: 2 });
    assert.strictEqual(JSON.stringify(input), snapshot, 'вход не мутирован');
  });

  test('removeMainBindingFromAutumn: только storage-user → удалён', () => {
    assert.deepStrictEqual(removeMainBindingFromAutumn({ vrunner: { 'storage-user': 'b' } }), { vrunner: {} });
  });

  const nothing: [string, Record<string, unknown>][] = [
    ['нет ключей хранилища', { vrunner: { 'storage-pwd': 'p' } }],
    ['нет vrunner', {}],
    ['vrunner не объект', { vrunner: 'x' }],
  ];
  for (const [title, root] of nothing) {
    test(`removeMainBindingFromAutumn: ${title} → undefined`, () => {
      assert.strictEqual(removeMainBindingFromAutumn(root), undefined);
    });
  }
});
