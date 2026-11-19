import * as assert from 'assert';
import * as fs from 'fs';
import { CrsClient } from '../../infra/repository/crs/CrsClient';
import { devDepotVersions } from '../../infra/repository/crs/CrsHistory';
import { crsPasswordHash } from '../../infra/repository/crs/CrsSecrets';
import { CrsTransportError } from '../../infra/repository/crs/CrsTransport';
import {
  repositoryHistorySessionDepsFrom,
  resolveRepositoryHistorySession,
  toRepositoryHistoryFailure,
  type RepositoryHistorySession,
} from '../../infra/repository/history/RepositoryHistorySession';
import { DEFAULT_CRS_VERSION_HINT } from '../../infra/repository/RepositoryLockStatusService';
import type { RepositoryBinding } from '../../infra/repository/RepositoryService';
import { escapeRegExp } from './support/configDumpInfoFixture';
import { tcpRawProbeBodies } from './support/crsFixtures';
import { callRejection, STAND_VERSION } from './support/crsMethods';
import { RecordedTransport } from './support/crsRecordedTransport';
import { createLockWorkspace, type LockWorkspace } from './support/repositoryLockFixtures';

/**
 * Сессия истории хранилища (#117): привязка цели → адрес сервера, учётные данные (хеш пароля только
 * в памяти) и подсказка версии. Рабочая область — копия example/2.21/src/cf с настоящей привязкой
 * через SecretStorage, как после команды «Подключить к хранилищу».
 */

const PASSWORD = 'секрет-123';

async function resolveWith(binding: RepositoryBinding | undefined, prepare?: (ws: LockWorkspace) => void): Promise<{ ws: LockWorkspace; result: Awaited<ReturnType<typeof resolveRepositoryHistorySession>> }> {
  const ws = await createLockWorkspace(binding);
  prepare?.(ws);
  const result = await resolveRepositoryHistorySession(ws.target, repositoryHistorySessionDepsFrom(ws.service, ws.workspaceRoot));
  return { ws, result };
}

function sessionOf(result: Awaited<ReturnType<typeof resolveRepositoryHistorySession>>): RepositoryHistorySession {
  assert.strictEqual(result.kind, 'session', JSON.stringify(result));
  return result.session;
}

function writeEnvDefaults(ws: LockWorkspace, defaults: Record<string, string>): void {
  const file = ws.service.getEnvJsonPath();
  const env = JSON.parse(fs.readFileSync(file, 'utf-8')) as { default?: Record<string, unknown> };
  fs.writeFileSync(file, JSON.stringify({ ...env, default: { ...env.default, ...defaults } }));
}

suite('RepositoryHistorySession (#117)', () => {
  const workspaces: LockWorkspace[] = [];
  teardown(() => {
    workspaces.splice(0).forEach((ws) => ws.dispose());
  });
  const track = <T extends { ws: LockWorkspace }>(value: T): T => {
    workspaces.push(value.ws);
    return value;
  };

  const servers: readonly { readonly name: string; readonly repoPath: string; readonly transport: 'tcp' | 'http'; readonly alias: string }[] = [
    { name: 'tcp', repoPath: 'tcp://127.0.0.1:1/x', transport: 'tcp', alias: 'x' },
    { name: 'http', repoPath: 'http://127.0.0.1:1/repo/repo.1ccr/x', transport: 'http', alias: 'x' },
  ];
  for (const server of servers) {
    test(`${server.name}: сессия с адресом, хешем пароля и ключом без хеша`, async () => {
      const { ws, result } = track(await resolveWith({ repoPath: server.repoPath, repoUser: 'Admin', repoPassword: PASSWORD }));
      const session = sessionOf(result);
      assert.strictEqual(session.target.configRoot, ws.target.configRoot);
      assert.strictEqual(session.address.transport, server.transport);
      assert.strictEqual(session.address.alias, server.alias);
      assert.deepStrictEqual(session.auth, { user: 'Admin', passwordHash: crsPasswordHash(PASSWORD) });
      assert.strictEqual(session.key, `${ws.target.configRoot}|${server.repoPath}|Admin`);
      assert.ok(!session.key.includes(session.auth.passwordHash));
      assert.ok(!JSON.stringify(session.address).includes(PASSWORD));
    });
  }

  test('файловое хранилище — file-repository', async () => {
    const { result } = track(await resolveWith({ repoPath: 'repo', repoUser: 'Admin', repoPassword: '' }));
    assert.deepStrictEqual(result, { kind: 'file-repository' });
  });

  test('адрес с учётными данными — failed invalid-address без исходной строки', async () => {
    const { result } = track(await resolveWith({ repoPath: 'tcp://user@host/x', repoUser: 'Admin', repoPassword: '' }));
    assert.strictEqual(result.kind, 'failed');
    assert.strictEqual(result.failure.code, 'invalid-address');
    assert.ok(!result.failure.message.includes('user@host'), result.failure.message);
  });

  test('без привязки — disconnected', async () => {
    const { result } = track(await resolveWith(undefined));
    assert.deepStrictEqual(result, { kind: 'disconnected' });
  });

  test('привязка есть, но цель отключена — disconnected', async () => {
    const { result } = track(await resolveWith({ repoPath: 'tcp://127.0.0.1:1/x', repoUser: 'Admin', repoPassword: '' }, (ws) => {
      ws.service.setConnected(ws.target, false);
    }));
    assert.deepStrictEqual(result, { kind: 'disconnected' });
  });

  test('привязка исчезла между проверкой подключения и чтением — disconnected', async () => {
    const ws = await createLockWorkspace({ repoPath: 'tcp://127.0.0.1:1/x', repoUser: 'Admin', repoPassword: '' });
    workspaces.push(ws);
    const deps = { ...repositoryHistorySessionDepsFrom(ws.service, ws.workspaceRoot), resolveBinding: () => Promise.resolve(null) };
    assert.deepStrictEqual(await resolveRepositoryHistorySession(ws.target, deps), { kind: 'disconnected' });
  });

  const binding = { repoPath: 'tcp://127.0.0.1:1/x', repoUser: 'Admin', repoPassword: '' };
  const hints: readonly { readonly name: string; readonly prepare: (ws: LockWorkspace) => void; readonly expected: string | undefined }[] = [
    { name: 'ничего не известно — версия по умолчанию', prepare: () => undefined, expected: DEFAULT_CRS_VERSION_HINT },
    { name: 'версия из env.json', prepare: (ws) => writeEnvDefaults(ws, { '--v8version': '8.5.1.1600' }), expected: '8.5.1.1600' },
    { name: 'подсказка env.json не вида N.N.N.N — без подсказки (рукопожатие)', prepare: (ws) => writeEnvDefaults(ws, { '--v8version': '8.3.27' }), expected: undefined },
    {
      name: 'версия последнего опроса сервера важнее env.json',
      prepare: (ws) => {
        writeEnvDefaults(ws, { '--v8version': '8.5.1.1600' });
        const lockState = ws.service.lockState;
        const applied = lockState.applyServerLocks(ws.target, {
          user: 'Admin', syncedAt: '2026-10-01T00:00:00', serverVersion: STAND_VERSION, basedOnRevision: lockState.getRevision(), foreign: {}, own: {},
        });
        assert.ok(applied);
      },
      expected: STAND_VERSION,
    },
  ];
  for (const hint of hints) {
    test(`подсказка версии: ${hint.name}`, async () => {
      const { result } = track(await resolveWith(binding, hint.prepare));
      assert.strictEqual(sessionOf(result).versionHint, hint.expected);
    });
  }

  test('too-large — текст об отчёте Конфигуратора', () => {
    const failure = toRepositoryHistoryFailure(new CrsTransportError('too-large', 'ответ больше лимита', { endpoint: 'tcp://127.0.0.1:1542' }));
    assert.strictEqual(failure.code, 'too-large');
    assert.match(failure.message, /128 МиБ/);
    assert.match(failure.message, /отчёт[а-я]* Конфигуратора/);
  });

  test('прочие отказы — код и текст источника статусов; повтор по версии упомянут', async () => {
    const transport = new RecordedTransport([tcpRawProbeBodies('probe-version-other').response.body]);
    const error = await callRejection(devDepotVersions(new CrsClient(transport, { alias: 'exp', version: '8.3.0.0' }), { user: 'Admin', passwordHash: '' }));
    const failure = toRepositoryHistoryFailure(error, STAND_VERSION);
    assert.strictEqual(failure.code, 'version-mismatch');
    assert.match(failure.message, new RegExp(`повтор с версией сервера ${escapeRegExp(STAND_VERSION)} не помог`));
    assert.deepStrictEqual(Object.keys(failure).sort(), ['code', 'message']);
    const unavailable = toRepositoryHistoryFailure(new CrsTransportError('unavailable', 'tcp://127.0.0.1:1: соединение отклонено', { endpoint: 'tcp://127.0.0.1:1' }));
    assert.strictEqual(unavailable.code, 'unavailable');
  });
});
