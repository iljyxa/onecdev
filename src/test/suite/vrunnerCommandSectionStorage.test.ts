import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { RepositoryBindingStore } from '../../infra/repository/RepositoryBindingStore';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import {
  type CommandSectionStorage,
  describeCommandSectionStorages,
  findCommandSectionStorages,
} from '../../infra/repository/VrunnerStorageKeys';
import { resolveConnectionInitialBinding } from '../../ui/commands/repository/RepositoryBindFlow';

/**
 * Issue #136. Поведение vanessa-runner снято на 2.6.1 и 3.0.2 (комментарий в issue):
 * адрес из секции команды действует только для неё, поэтому привязкой не считается,
 * а форма подключения подсказывает перенести его в общие опции.
 */
suite('Адрес хранилища только в секции команды vanessa-runner (#136)', () => {
  suite('findCommandSectionStorages', () => {
    test('env.json 2.x: секции команд, кроме default; пустой адрес и не-объекты пропускаются', () => {
      const env = {
        $schema: 'https://example/schema.json',
        default: { '--storage-name': 'tcp://общий/repo', '--storage-user': 'Общий' },
        loadrepo: { '--storage-name': ' tcp://srv/repo ', '--storage-user': 'Иванов' },
        lockrepo: { '--storage-name': '   ' },
        unbindrepo: ['--storage-name'],
        xunit: { '--testsPath': 'tests' },
      };
      assert.deepStrictEqual(findCommandSectionStorages(env, undefined), [
        { file: 'env.json', section: 'loadrepo', repoPath: 'tcp://srv/repo', repoUser: 'Иванов' },
      ]);
    });

    test('autumn-properties.json 3.x: вложенные секции под vrunner, общий vrunner.storage-name не секция', () => {
      const autumn = {
        vrunner: {
          'storage-name': 'tcp://общий/repo',
          repo: {
            load: { 'storage-name': 'tcp://srv/repo', 'storage-user': 'Петров' },
            lock: { 'storage-user': 'без адреса' },
          },
          cf: { compile: { out: 'build/1cv8.cf' } },
          list: ['storage-name'],
        },
        other: { 'storage-name': 'не vrunner' },
      };
      assert.deepStrictEqual(findCommandSectionStorages({}, autumn), [
        { file: 'autumn-properties.json', section: 'vrunner.repo.load', repoPath: 'tcp://srv/repo', repoUser: 'Петров' },
      ]);
    });

    test('без секций и без vrunner — пусто', () => {
      assert.deepStrictEqual(findCommandSectionStorages({ default: {} }, { other: {} }), []);
      assert.deepStrictEqual(findCommandSectionStorages({}, { vrunner: 'строка' }), []);
    });
  });

  suite('describeCommandSectionStorages', () => {
    const load: CommandSectionStorage = { file: 'env.json', section: 'loadrepo', repoPath: 'tcp://srv/repo', repoUser: 'Иванов' };

    test('нет секций — подсказки нет', () => {
      assert.strictEqual(describeCommandSectionStorages([]), undefined);
    });

    test('один адрес — подсказка с местами и подстановка адреса и пользователя', () => {
      const autumn: CommandSectionStorage = { ...load, file: 'autumn-properties.json', section: 'vrunner.repo.load' };
      const described = describeCommandSectionStorages([load, autumn]);
      assert.ok(described);
      assert.deepStrictEqual(described.prefill, { repoPath: 'tcp://srv/repo', repoUser: 'Иванов' });
      assert.match(described.hint, /только в секции команды vanessa-runner \(env\.json: loadrepo; autumn-properties\.json: vrunner\.repo\.load\)/);
      assert.match(described.hint, /default\.--storage-name/);
    });

    test('один адрес, разные пользователи — пользователь не подставляется', () => {
      const described = describeCommandSectionStorages([load, { ...load, section: 'lockrepo', repoUser: 'Петров' }]);
      assert.deepStrictEqual(described?.prefill, { repoPath: 'tcp://srv/repo', repoUser: '' });
    });

    test('разные адреса — без подстановки, с просьбой указать вручную', () => {
      const described = describeCommandSectionStorages([load, { ...load, section: 'lockrepo', repoPath: 'tcp://other/repo' }]);
      assert.strictEqual(described?.prefill, undefined);
      assert.match(described?.hint ?? '', /Адреса в секциях различаются/);
    });
  });

  suite('хранилище привязок и форма подключения на реальных файлах', () => {
    let workspaceRoot: string;
    let store: RepositoryBindingStore;
    let cfTarget: RepositoryTarget;
    let warnings: string[];

    setup(() => {
      workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-section-storage-'));
      const map = new Map<string, string>();
      const secrets: SecretStore = {
        get: (key) => Promise.resolve(map.get(key)),
        store: (key, value) => { map.set(key, value); return Promise.resolve(); },
        delete: (key) => { map.delete(key); return Promise.resolve(); },
      };
      store = new RepositoryBindingStore(workspaceRoot, new ProjectSecretStorage(secrets, workspaceRoot));
      cfTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Конфигурация' };
      warnings = [];
    });

    teardown(() => {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    const writeJson = (file: string, value: unknown): void => {
      fs.writeFileSync(path.join(workspaceRoot, file), JSON.stringify(value, null, 2), 'utf-8');
    };
    const resolve = (target: RepositoryTarget = cfTarget): ReturnType<typeof resolveConnectionInitialBinding> =>
      resolveConnectionInitialBinding(target, {
        loadBinding: (t) => store.loadBinding(t),
        hasStoredRepoPassword: (t) => store.hasStoredRepoPassword(t),
        findCommandSectionStorages: (t) => store.findCommandSectionStorages(t),
      }, (message) => { warnings.push(message); });

    test('адрес только в секции loadrepo: проект не привязан, форма получает адрес и подсказку', async () => {
      writeJson('env.json', { default: {}, loadrepo: { '--storage-name': 'tcp://srv/repo', '--storage-user': 'Иванов' } });
      assert.strictEqual(store.hasBinding(cfTarget), false);
      assert.deepStrictEqual(await resolve(), { repoPath: 'tcp://srv/repo', repoUser: 'Иванов', repoPasswordSet: false });
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0], /env\.json: loadrepo/);
    });

    test('autumn-properties.json с секцией и повреждённым env отсутствующим — секция найдена', () => {
      writeJson('autumn-properties.json', { vrunner: { repo: { load: { 'storage-name': 'tcp://srv/repo' } } } });
      assert.deepStrictEqual(store.findCommandSectionStorages(cfTarget), [
        { file: 'autumn-properties.json', section: 'vrunner.repo.load', repoPath: 'tcp://srv/repo', repoUser: '' },
      ]);
    });

    test('повреждённый autumn-properties.json не ломает поиск: секции env.json находятся', () => {
      writeJson('env.json', { loadrepo: { '--storage-name': 'tcp://srv/repo' } });
      fs.writeFileSync(path.join(workspaceRoot, 'autumn-properties.json'), '{ не json', 'utf-8');
      assert.strictEqual(store.findCommandSectionStorages(cfTarget).length, 1);
    });

    test('общая привязка есть — секции не подсказываются, форма получает привязку', async () => {
      writeJson('env.json', {
        default: { '--storage-name': 'tcp://общий/repo', '--storage-user': 'Общий' },
        loadrepo: { '--storage-name': 'tcp://srv/repo' },
      });
      assert.deepStrictEqual(store.findCommandSectionStorages(cfTarget), []);
      assert.deepStrictEqual(await resolve(), { repoPath: 'tcp://общий/repo', repoUser: 'Общий', repoPasswordSet: false });
      assert.deepStrictEqual(warnings, []);
    });

    test('расширение: секции основной конфигурации к нему не относятся', () => {
      writeJson('env.json', { loadrepo: { '--storage-name': 'tcp://srv/repo' } });
      const cfe: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cfe', 'EVOLC'), configKind: 'cfe', extensionName: 'EVOLC', displayName: 'EVOLC' };
      assert.deepStrictEqual(store.findCommandSectionStorages(cfe), []);
    });

    test('нет ни привязки, ни секций — форма пустая, без подсказки', async () => {
      assert.strictEqual(await resolve(), undefined);
      assert.deepStrictEqual(warnings, []);
    });

    test('разные адреса в секциях — подсказка без подстановки', async () => {
      writeJson('env.json', { loadrepo: { '--storage-name': 'tcp://a/repo' }, lockrepo: { '--storage-name': 'tcp://b/repo' } });
      assert.strictEqual(await resolve(), undefined);
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0], /различаются/);
    });
  });
});
