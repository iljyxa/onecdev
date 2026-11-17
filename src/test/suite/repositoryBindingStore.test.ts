import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryBindingStore } from '../../infra/repository/RepositoryBindingStore';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { buildRepositoryScopeKey } from '../../infra/repository/RepositoryLockState';

/**
 * `RepositoryBindingStore` уже покрыт КОСВЕННО через `RepositoryService`
 * (`repositoryService.test.ts`/`repositoryServiceSecrets.test.ts`), но эти
 * наборы используют `configKind:'cfe'` только с ЯВНО заданным `extensionName` —
 * ветки `target.extensionName ?? ''` (cfe-цель без имени расширения) и форма
 * `env.default`, отличная от «обычного объекта» (`getDefaultSection`), там не
 * возникают. Прямой тест класса — контроль над этими граничными формами данных.
 */
function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

suite('RepositoryBindingStore — граничные ветки (issue #1)', () => {
  let workspaceRoot: string;
  let store: RepositoryBindingStore;
  let cfeTargetNoName: RepositoryTarget;

  setup(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-binding-store-'));
    store = new RepositoryBindingStore(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
    cfeTargetNoName = { configRoot: path.join(workspaceRoot, 'src', 'cfe', 'Ext'), configKind: 'cfe', displayName: 'Расширение' };
  });

  teardown(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function writeEnvJson(content: Record<string, unknown>): void {
    fs.writeFileSync(store.getEnvJsonPath(), JSON.stringify(content, null, 2), 'utf-8');
  }

  function readEnvJson(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(store.getEnvJsonPath(), 'utf-8')) as Record<string, unknown>;
  }

  test('cfe-цель БЕЗ extensionName: saveBinding пишет секцию под ключом "" (fallback ??)', async () => {
    await store.saveBinding(cfeTargetNoName, { repoPath: '\\\\repo\\ext', repoUser: 'bob', repoPassword: 'x' });
    const env = readEnvJson();
    const defaults = env.default as Record<string, unknown>;
    const extension = defaults.extension as Record<string, unknown>;
    assert.deepStrictEqual(extension[''], { 'repo-path': '\\\\repo\\ext', 'repo-user': 'bob' });
  });

  test('cfe-цель БЕЗ extensionName: loadBinding читает ту же секцию "" и мигрирует legacy-пароль', async () => {
    writeEnvJson({ default: { extension: { '': { 'repo-path': '\\\\repo\\ext', 'repo-user': 'bob', 'repo-pwd': 'legacy' } } } });

    const loaded = await store.loadBinding(cfeTargetNoName);

    assert.deepStrictEqual(loaded, { repoPath: '\\\\repo\\ext', repoUser: 'bob' });
    assert.strictEqual(await store.hasStoredRepoPassword(cfeTargetNoName), true, 'legacy-пароль должен быть перенесён в SecretStorage.');
    const envAfter = readEnvJson();
    const item = ((envAfter.default as Record<string, unknown>).extension as Record<string, Record<string, unknown>>)[''];
    assert.strictEqual(item['repo-pwd'], undefined, 'legacy repo-pwd должен быть стёрт из env.json.');
  });

  test('cfe-цель БЕЗ extensionName: clearBinding удаляет секцию "" (fallback ??)', async () => {
    writeEnvJson({ default: { extension: { '': { 'repo-path': '\\\\repo\\ext', 'repo-user': 'bob' } } } });

    await store.clearBinding(cfeTargetNoName);

    assert.strictEqual(store.hasBinding(cfeTargetNoName), false);
  });

  test('repoUser отсутствует в env.json (не строка) → loadBinding отдаёт repoUser="" (readString ?? "")', async () => {
    const cfTarget: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
    writeEnvJson({ default: { '--repo-path': '\\\\repo\\main', '--repo-user': 42 } });

    const loaded = await store.loadBinding(cfTarget);

    assert.deepStrictEqual(loaded, { repoPath: '\\\\repo\\main', repoUser: '' });
  });

  test('repoUser cfe-секции отсутствует (не строка) → loadBinding отдаёт repoUser="" (readString ?? "")', async () => {
    writeEnvJson({ default: { extension: { '': { 'repo-path': '\\\\repo\\ext', 'repo-user': null } } } });

    const loaded = await store.loadBinding(cfeTargetNoName);

    assert.deepStrictEqual(loaded, { repoPath: '\\\\repo\\ext', repoUser: '' });
  });

  test('env.default отсутствует (env.json = {}) → getDefaultSection отдаёт {} без ошибки, hasBinding=false', () => {
    writeEnvJson({});
    const cfTarget: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
    assert.strictEqual(store.hasBinding(cfTarget), false);
  });

  test('env.default — массив (некорректная форма) → getDefaultSection отдаёт {} без ошибки', () => {
    writeEnvJson({ default: ['неожиданный массив'] });
    const cfTarget: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
    assert.strictEqual(store.hasBinding(cfTarget), false);
  });

  test('saveBinding для одного расширения санирует ЧУЖИЕ записи секции extension без repo-path/repo-user (readString ?? "")', async () => {
    writeEnvJson({
      default: {
        extension: {
          'БезПользователя': { 'repo-path': '\\\\repo\\a' },
          'БезПути': { 'repo-user': 'carol' },
        },
      },
    });
    const targetB: RepositoryTarget = { configRoot: cfeTargetNoName.configRoot, configKind: 'cfe', extensionName: 'Б', displayName: 'Б' };

    await store.saveBinding(targetB, { repoPath: '\\\\repo\\b', repoUser: 'bob', repoPassword: 'x' });

    const extension = ((readEnvJson().default as Record<string, unknown>).extension) as Record<string, Record<string, unknown>>;
    assert.deepStrictEqual(extension['БезПользователя'], { 'repo-path': '\\\\repo\\a', 'repo-user': '' });
    assert.deepStrictEqual(extension['БезПути'], { 'repo-path': '', 'repo-user': 'carol' });
  });

  test('env.default — строка (некорректная форма) → getDefaultSection отдаёт {} без ошибки', () => {
    writeEnvJson({ default: 'неожиданная строка' });
    const cfTarget: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
    assert.strictEqual(store.hasBinding(cfTarget), false);
  });
});

/**
 * Issue #6: подсказка версии платформы для рукопожатия с сервером хранилища —
 * `--v8version`, иначе версия-подстрока пути `--path` к платформе.
 */
suite('RepositoryBindingStore — readPlatformVersionHint (issue #6)', () => {
  let workspaceRoot: string;
  let store: RepositoryBindingStore;

  setup(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-binding-hint-'));
    store = new RepositoryBindingStore(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  });

  teardown(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const cases: [string, string | undefined, string | undefined][] = [
    ['--v8version задан', JSON.stringify({ default: { '--v8version': ' 8.3.27.2342 ', '--path': '/opt/1cv8/x86_64/8.5.1.1529/1cv8' } }), '8.3.27.2342'],
    ['--v8version пуст — версия из --path', JSON.stringify({ default: { '--v8version': '', '--path': '/opt/1cv8/x86_64/8.5.1.1529/1cv8' } }), '8.5.1.1529'],
    ['ни версии, ни версии в пути', JSON.stringify({ default: { '--path': '/usr/bin/1cv8' } }), undefined],
    ['пустой env.json', '', undefined],
    ['env.json нет', undefined, undefined],
  ];
  for (const [title, content, expected] of cases) {
    test(title, () => {
      if (content !== undefined) {
        fs.writeFileSync(store.getEnvJsonPath(), content, 'utf-8');
      }
      assert.strictEqual(store.readPlatformVersionHint(), expected);
    });
  }
});

/**
 * Issue #120: привязка основной конфигурации хранится в стандартных ключах
 * vanessa-runner — `--storage-name/--storage-user` в env.json (2.x) и
 * `vrunner.storage-*` в autumn-properties.json (3.x); ключи прежних версий
 * (`--repo-*`) читаются и при записи заменяются. Файлы пишутся с сохранением
 * отступа, BOM и переводов строк.
 */
suite('RepositoryBindingStore — стандартные ключи vanessa-runner (issue #120)', () => {
  const BOM = '﻿';
  let workspaceRoot: string;
  let secrets: ProjectSecretStorage;
  let store: RepositoryBindingStore;
  let cfTarget: RepositoryTarget;
  let cfeTarget: RepositoryTarget;

  setup(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-binding-vrunner-'));
    secrets = new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot);
    store = new RepositoryBindingStore(workspaceRoot, secrets);
    cfTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Конфигурация' };
    cfeTarget = {
      configRoot: path.join(workspaceRoot, 'src', 'cfe', 'EVOLC'),
      configKind: 'cfe',
      extensionName: 'EVOLC',
      displayName: 'EVOLC',
    };
  });

  teardown(() => {
    fs.chmodSync(workspaceRoot, 0o700);
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  /** Профиль vanessa-runner: `$schema`, общие опции и секции команд, которые хранилище не трогает. */
  function vrunnerEnv(defaults: Record<string, unknown>): Record<string, unknown> {
    return {
      $schema: 'https://raw.githubusercontent.com/vanessa-opensource/vanessa-runner/develop/vanessa-runner-schema.json',
      default: { '--ibconnection': '/F./build/ib', '--db-user': 'Админ', ...defaults, '--v8version': '8.3.27.2342' },
      xunit: { '--xddConfig': 'tools/xUnitParams.json' },
      loadrepo: { '--storage-name': 'чужое', '--storage-user': 'чужой' },
    };
  }

  /** Профиль, в конец `default` которого дописаны ключи — так ложатся ключи, которых в файле не было. */
  function vrunnerEnvAppended(defaults: Record<string, unknown>, appended: Record<string, unknown>): Record<string, unknown> {
    const env = vrunnerEnv(defaults);
    return { ...env, default: { ...(env.default as Record<string, unknown>), ...appended } };
  }

  /** Стиль Platform Tools: табуляция; `crlf` — как сохраняет Windows-редактор. */
  function tabText(value: unknown, crlf = false): string {
    const text = `${JSON.stringify(value, null, '\t')}\n`;
    return crlf ? text.replace(/\n/g, '\r\n') : text;
  }

  function writeEnv(text: string): void {
    fs.writeFileSync(store.getEnvJsonPath(), text, 'utf-8');
  }

  function readEnv(): string {
    return fs.readFileSync(store.getEnvJsonPath(), 'utf-8');
  }

  function writeAutumn(text: string): void {
    fs.writeFileSync(store.getAutumnPropertiesPath(), text, 'utf-8');
  }

  function readAutumn(): string {
    return fs.readFileSync(store.getAutumnPropertiesPath(), 'utf-8');
  }

  test('getAutumnPropertiesPath — autumn-properties.json рядом с env.json', () => {
    assert.strictEqual(store.getAutumnPropertiesPath(), path.join(workspaceRoot, 'autumn-properties.json'));
    assert.strictEqual(path.dirname(store.getAutumnPropertiesPath()), path.dirname(store.getEnvJsonPath()));
  });

  suite('чтение', () => {
    type ReadCase = [title: string, env: string | undefined, autumn: string | undefined, expected: { repoPath: string; repoUser: string } | null];
    const cases: ReadCase[] = [
      [
        '2.x: --storage-name/--storage-user',
        tabText(vrunnerEnv({ '--storage-name': 'tcp://srv/main', '--storage-user': 'alice' })),
        undefined,
        { repoPath: 'tcp://srv/main', repoUser: 'alice' },
      ],
      [
        'legacy --repo-*',
        tabText(vrunnerEnv({ '--repo-path': '\\\\srv\\repo', '--repo-user': 'bob' })),
        undefined,
        { repoPath: '\\\\srv\\repo', repoUser: 'bob' },
      ],
      [
        'стандарт и legacy с разными значениями → стандарт',
        tabText(vrunnerEnv({ '--repo-path': 'tcp://old', '--repo-user': 'old', '--storage-name': 'tcp://new', '--storage-user': 'new' })),
        undefined,
        { repoPath: 'tcp://new', repoUser: 'new' },
      ],
      [
        '3.x: только autumn-properties.json',
        tabText(vrunnerEnv({})),
        JSON.stringify({ vrunner: { 'storage-name': 'http://srv/repo', 'storage-user': 'carol' } }, null, 4),
        { repoPath: 'http://srv/repo', repoUser: 'carol' },
      ],
      [
        '2.x и 3.x → env.json',
        tabText(vrunnerEnv({ '--storage-name': 'tcp://env', '--storage-user': 'e' })),
        JSON.stringify({ vrunner: { 'storage-name': 'tcp://autumn', 'storage-user': 'a' } }),
        { repoPath: 'tcp://env', repoUser: 'e' },
      ],
      [
        'legacy и 3.x → legacy',
        tabText(vrunnerEnv({ '--repo-path': 'tcp://old', '--repo-user': 'old' })),
        JSON.stringify({ vrunner: { 'storage-name': 'tcp://autumn' } }),
        { repoPath: 'tcp://old', repoUser: 'old' },
      ],
      [
        'пустой --storage-name и legacy → legacy',
        tabText(vrunnerEnv({ '--storage-name': '', '--repo-path': 'tcp://old', '--repo-user': 'old' })),
        undefined,
        { repoPath: 'tcp://old', repoUser: 'old' },
      ],
      [
        'env.json нет, autumn есть',
        undefined,
        JSON.stringify({ vrunner: { 'storage-name': '/var/repo' } }),
        { repoPath: '/var/repo', repoUser: '' },
      ],
      ['ни env.json, ни autumn', undefined, undefined, null],
    ];
    for (const [title, env, autumn, expected] of cases) {
      test(title, async () => {
        if (env !== undefined) {
          writeEnv(env);
        }
        if (autumn !== undefined) {
          writeAutumn(autumn);
        }

        assert.deepStrictEqual(await store.loadBinding(cfTarget), expected);
        assert.strictEqual(store.hasBinding(cfTarget), expected !== null);
        if (env !== undefined) {
          assert.strictEqual(readEnv(), env, 'чтение без пароля в файле не меняет env.json');
        } else {
          assert.strictEqual(fs.existsSync(store.getEnvJsonPath()), false, 'чтение не создаёт env.json');
        }
        if (autumn !== undefined) {
          assert.strictEqual(readAutumn(), autumn);
        }
      });
    }

    test('env.json с BOM читается', async () => {
      writeEnv(`${BOM}${tabText(vrunnerEnv({ '--storage-name': 'tcp://bom' }), true)}`);
      assert.deepStrictEqual(await store.loadBinding(cfTarget), { repoPath: 'tcp://bom', repoUser: '' });
    });
  });

  suite('пароль из файла', () => {
    test('legacy-источник: --repo-pwd переносится в SecretStorage и стирается, табуляция и CRLF сохранены', async () => {
      writeEnv(tabText(vrunnerEnv({ '--repo-path': 'tcp://old', '--repo-user': 'old', '--repo-pwd': 'legacy-pwd' }), true));

      assert.deepStrictEqual(await store.loadBinding(cfTarget), { repoPath: 'tcp://old', repoUser: 'old' });

      assert.strictEqual(await secrets.getRepoPassword(buildRepositoryScopeKey(cfTarget)), 'legacy-pwd');
      assert.strictEqual(readEnv(), tabText(vrunnerEnv({ '--repo-path': 'tcp://old', '--repo-user': 'old' }), true));
    });

    test('источник --storage-*: оставшийся --repo-pwd не переносится и файл не меняется', async () => {
      const text = tabText(vrunnerEnv({ '--storage-name': 'tcp://new', '--repo-path': 'tcp://old', '--repo-pwd': 'legacy-pwd' }));
      writeEnv(text);

      await store.loadBinding(cfTarget);

      assert.strictEqual(await store.hasStoredRepoPassword(cfTarget), false);
      assert.strictEqual(readEnv(), text);
    });

    test('--storage-pwd — запасной пароль команды при пустом SecretStorage; не отдаётся и не стирается', async () => {
      const text = tabText(vrunnerEnv({ '--storage-name': 'tcp://new', '--storage-user': 'u', '--storage-pwd': 'file-pwd' }));
      writeEnv(text);

      assert.deepStrictEqual(await store.loadBinding(cfTarget), { repoPath: 'tcp://new', repoUser: 'u' });
      assert.strictEqual(await store.hasStoredRepoPassword(cfTarget), false);
      assert.deepStrictEqual(await store.resolveBindingForCommand(cfTarget), { repoPath: 'tcp://new', repoUser: 'u', repoPassword: 'file-pwd' });
      assert.strictEqual(readEnv(), text, '--storage-pwd остаётся в файле');
    });

    test('сохранённый секрет важнее --storage-pwd', async () => {
      writeEnv(tabText(vrunnerEnv({ '--storage-name': 'tcp://new', '--storage-pwd': 'file-pwd' })));
      await secrets.setRepoPassword(buildRepositoryScopeKey(cfTarget), 'secret-pwd');

      const resolved = await store.resolveBindingForCommand(cfTarget);

      assert.strictEqual(resolved?.repoPassword, 'secret-pwd');
    });

    test('vrunner.storage-pwd — запасной пароль для привязки из autumn-properties.json', async () => {
      const autumn = JSON.stringify({ vrunner: { 'storage-name': 'tcp://a', 'storage-pwd': 'autumn-pwd' } }, null, 2);
      writeAutumn(autumn);

      assert.deepStrictEqual(await store.resolveBindingForCommand(cfTarget), { repoPath: 'tcp://a', repoUser: '', repoPassword: 'autumn-pwd' });
      assert.strictEqual(await store.hasStoredRepoPassword(cfTarget), false);
      assert.strictEqual(readAutumn(), autumn);
    });

    test('ни секрета, ни пароля в файле → пустой пароль', async () => {
      writeEnv(tabText(vrunnerEnv({ '--storage-name': 'tcp://new' })));
      assert.strictEqual((await store.resolveBindingForCommand(cfTarget))?.repoPassword, '');
    });

    test('привязки нет → resolveBindingForCommand null', async () => {
      assert.strictEqual(await store.resolveBindingForCommand(cfTarget), null);
    });
  });

  suite('повреждённый autumn-properties.json', () => {
    const broken = '{ "vrunner": { "storage-name": ';

    test('нужен для чтения (в env.json привязки нет) → понятная ошибка', async () => {
      writeEnv('');
      writeAutumn(broken);
      await assert.rejects(store.loadBinding(cfTarget), /autumn-properties\.json повреждён \(/);
    });

    test('не нужен (привязка в env.json) → hasBinding без исключения', () => {
      writeEnv(tabText(vrunnerEnv({ '--storage-name': 'tcp://new' })));
      writeAutumn(broken);
      assert.strictEqual(store.hasBinding(cfTarget), true);
    });

    test('saveBinding (cf) отклоняется до записи env.json', async () => {
      const text = tabText(vrunnerEnv({ '--repo-path': 'tcp://old' }));
      writeEnv(text);
      writeAutumn(broken);

      await assert.rejects(store.saveBinding(cfTarget, { repoPath: 'tcp://new', repoUser: 'u', repoPassword: 'p' }), /autumn-properties\.json повреждён/);

      assert.strictEqual(readEnv(), text);
      assert.strictEqual(await store.hasStoredRepoPassword(cfTarget), false);
    });

    test('clearBinding (cf) отклоняется до записи env.json', async () => {
      const text = tabText(vrunnerEnv({ '--storage-name': 'tcp://new' }));
      writeEnv(text);
      writeAutumn(broken);

      await assert.rejects(store.clearBinding(cfTarget), /autumn-properties\.json повреждён/);

      assert.strictEqual(readEnv(), text);
    });
  });

  suite('saveBinding (cf)', () => {
    const binding = { repoPath: 'tcp://srv/new', repoUser: 'new', repoPassword: 'pwd' };

    test('legacy + табуляция + CRLF + $schema + секции команд + extension → стандартные ключи на месте legacy', async () => {
      const extension = { EVOLC: { 'repo-path': 'tcp://ext', 'repo-user': 'ext' } };
      writeEnv(tabText(vrunnerEnv({ '--repo-path': 'tcp://old', '--repo-user': 'old', '--repo-pwd': 'x', extension }), true));

      await store.saveBinding(cfTarget, binding);

      assert.strictEqual(
        readEnv(),
        tabText(vrunnerEnv({ '--storage-name': 'tcp://srv/new', '--storage-user': 'new', extension }), true)
      );
      assert.strictEqual(await secrets.getRepoPassword(buildRepositoryScopeKey(cfTarget)), 'pwd');
      assert.ok(!readEnv().includes('--storage-pwd'), 'пароль в файл не пишется');
    });

    test('env.json с BOM → BOM сохранён', async () => {
      writeEnv(`${BOM}${tabText(vrunnerEnv({}))}`);

      await store.saveBinding(cfTarget, binding);

      assert.strictEqual(
        readEnv(),
        `${BOM}${tabText(vrunnerEnvAppended({}, { '--storage-name': 'tcp://srv/new', '--storage-user': 'new' }))}`
      );
    });

    test('autumn со storage-name → обновлён с сохранением формата', async () => {
      writeEnv(tabText(vrunnerEnv({})));
      const autumn = (vrunner: Record<string, unknown>): string =>
        `${JSON.stringify({ $schema: 's', vrunner }, null, 4).replace(/\n/g, '\r\n')}\r\n`;
      writeAutumn(autumn({ 'storage-name': 'tcp://old', 'storage-pwd': 'p', cf: { compile: {} } }));

      await store.saveBinding(cfTarget, binding);

      assert.strictEqual(readAutumn(), autumn({ 'storage-name': 'tcp://srv/new', 'storage-pwd': 'p', cf: { compile: {} }, 'storage-user': 'new' }));
    });

    test('autumn без storage-name → байты не изменились', async () => {
      const autumn = JSON.stringify({ vrunner: { ibconnection: '/F./ib' } }, null, '\t');
      writeAutumn(autumn);

      await store.saveBinding(cfTarget, binding);

      assert.strictEqual(readAutumn(), autumn);
    });

    test('autumn нет → не создаётся', async () => {
      await store.saveBinding(cfTarget, binding);
      assert.strictEqual(fs.existsSync(store.getAutumnPropertiesPath()), false);
    });

    test('env.json нет → создаётся с 2 пробелами и \\n, только default с двумя ключами', async () => {
      await store.saveBinding(cfTarget, { repoPath: 'tcp://srv/new', repoUser: 'new', repoPassword: '' });

      assert.strictEqual(
        readEnv(),
        '{\n  "default": {\n    "--storage-name": "tcp://srv/new",\n    "--storage-user": "new"\n  }\n}\n'
      );
      assert.strictEqual(await store.hasStoredRepoPassword(cfTarget), false, 'пустой пароль не записывается');
    });
  });

  test('clearBinding (cf): обе формы и autumn удалены, --storage-pwd и посторонние сохранены, секрет стёрт', async () => {
    writeEnv(tabText(vrunnerEnv({
      '--storage-name': 'tcp://new',
      '--storage-user': 'new',
      '--storage-pwd': 'p',
      '--repo-path': 'tcp://old',
      '--repo-user': 'old',
      '--repo-pwd': 'x',
    })));
    const autumn = (vrunner: Record<string, unknown>): string => `${JSON.stringify({ vrunner }, null, 2)}\n`;
    writeAutumn(autumn({ 'storage-name': 'tcp://a', 'storage-user': 'a', 'storage-pwd': 'ap', ibconnection: '/F./ib' }));
    await secrets.setRepoPassword(buildRepositoryScopeKey(cfTarget), 'secret');

    await store.clearBinding(cfTarget);

    assert.strictEqual(readEnv(), tabText(vrunnerEnv({ '--storage-pwd': 'p' })));
    assert.strictEqual(readAutumn(), autumn({ 'storage-pwd': 'ap', ibconnection: '/F./ib' }));
    assert.strictEqual(store.hasBinding(cfTarget), false);
    assert.strictEqual(await store.hasStoredRepoPassword(cfTarget), false);
  });

  suite('cfe не трогает ключи основной конфигурации и autumn', () => {
    const cfKeys = { '--storage-name': 'tcp://main', '--storage-user': 'm', '--repo-path': 'tcp://old', '--repo-user': 'old' };
    const autumnText = `${JSON.stringify({ vrunner: { 'storage-name': 'tcp://a', 'storage-user': 'a' } }, null, '\t')}\n`;

    test('saveBinding (cfe)', async () => {
      writeEnv(tabText(vrunnerEnv(cfKeys)));
      writeAutumn(autumnText);

      await store.saveBinding(cfeTarget, { repoPath: 'tcp://ext', repoUser: 'e', repoPassword: '' });

      assert.strictEqual(
        readEnv(),
        tabText(vrunnerEnvAppended(cfKeys, { extension: { EVOLC: { 'repo-path': 'tcp://ext', 'repo-user': 'e' } } }))
      );
      assert.strictEqual(readAutumn(), autumnText);
    });

    test('clearBinding (cfe)', async () => {
      writeEnv(tabText(vrunnerEnv({ ...cfKeys, extension: { EVOLC: { 'repo-path': 'tcp://ext', 'repo-user': 'e' } } })));
      writeAutumn(autumnText);

      await store.clearBinding(cfeTarget);

      assert.strictEqual(readEnv(), tabText(vrunnerEnv({ ...cfKeys, extension: {} })));
      assert.strictEqual(readAutumn(), autumnText);
      assert.strictEqual(store.hasBinding(cfeTarget), false);
      assert.strictEqual(store.hasBinding(cfTarget), true);
    });
  });

  suite('кэш', () => {
    /** mtime сдвигается явно: перезапись в тот же миллисекундный тик не должна делать тест гонкой. */
    function touchLater(filePath: string, seconds: number): void {
      const when = new Date(Date.now() + seconds * 1000);
      fs.utimesSync(filePath, when, when);
    }

    test('внешняя перезапись env.json перечитывается по mtime', async () => {
      writeEnv(tabText(vrunnerEnv({ '--storage-name': 'tcp://one' })));
      assert.strictEqual((await store.loadBinding(cfTarget))?.repoPath, 'tcp://one');

      writeEnv(tabText(vrunnerEnv({ '--storage-name': 'tcp://two' })));
      touchLater(store.getEnvJsonPath(), 10);

      assert.strictEqual((await store.loadBinding(cfTarget))?.repoPath, 'tcp://two');
    });

    test('внешняя перезапись autumn-properties.json перечитывается по mtime', async () => {
      writeAutumn(JSON.stringify({ vrunner: { 'storage-name': 'tcp://one' } }));
      assert.strictEqual((await store.loadBinding(cfTarget))?.repoPath, 'tcp://one');

      writeAutumn(JSON.stringify({ vrunner: { 'storage-name': 'tcp://two' } }));
      touchLater(store.getAutumnPropertiesPath(), 10);

      assert.strictEqual((await store.loadBinding(cfTarget))?.repoPath, 'tcp://two');
    });

    /**
     * Сбой записи моделируется настоящим отказом ФС: каталог рабочей области только
     * на чтение, атомарная запись не может создать временный файл рядом с env.json.
     * Под root права не ограничивают запись — там сценарий невоспроизводим.
     */
    function skipIfWritableAnyway(context: Mocha.Context): void {
      if (process.platform === 'win32' || process.getuid?.() === 0) {
        context.skip();
      }
    }

    test('сбой стирания --repo-pwd (cfe) не портит кэш: повторное чтение снова стирает пароль', async function () {
      skipIfWritableAnyway(this);
      writeEnv(tabText({ default: { extension: { EVOLC: { 'repo-path': 'tcp://ext', 'repo-user': 'e', 'repo-pwd': 'legacy' } } } }));
      fs.chmodSync(workspaceRoot, 0o500);

      await assert.rejects(store.loadBinding(cfeTarget));

      fs.chmodSync(workspaceRoot, 0o700);
      assert.deepStrictEqual(await store.loadBinding(cfeTarget), { repoPath: 'tcp://ext', repoUser: 'e' });
      assert.strictEqual(readEnv(), tabText({ default: { extension: { EVOLC: { 'repo-path': 'tcp://ext', 'repo-user': 'e' } } } }));
    });

    test('сбой записи saveBinding (cf) не портит кэш: читается прежняя привязка', async function () {
      skipIfWritableAnyway(this);
      const text = tabText(vrunnerEnv({ '--repo-path': 'tcp://old', '--repo-user': 'old' }));
      writeEnv(text);
      assert.strictEqual(store.hasBinding(cfTarget), true);
      fs.chmodSync(workspaceRoot, 0o500);

      await assert.rejects(store.saveBinding(cfTarget, { repoPath: 'tcp://new', repoUser: 'new', repoPassword: '' }));

      fs.chmodSync(workspaceRoot, 0o700);
      assert.deepStrictEqual(await store.loadBinding(cfTarget), { repoPath: 'tcp://old', repoUser: 'old' });
      assert.strictEqual(readEnv(), text);
    });
  });
});
