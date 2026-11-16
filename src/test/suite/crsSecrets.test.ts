import * as assert from 'assert';
import { crsPasswordHash } from '../../infra/repository/crs/CrsSecrets';
import { CRS_SECRET_MASK, maskCrsSecrets } from '../../infra/xml/crs/CrsEnvelope';
import { OneCdFile } from '../../infra/repository/onecd/OneCdFile';
import { readOneCdTable } from '../../infra/repository/onecd/OneCdTable';
import { crsCorpus, rawConfiguratorConnections, requestBodyOf, responseFrameOf, splitTcpFrame } from './support/crsFixtures';
import { lockFixturePath, must, readHttpExchange, requestPasswordHash } from './support/repositoryLockFixtures';

// Пользователи и пароли из скриптов стенда, с которого снят корпус example/crs (см. example/crs/README.md).
const PAIRS: [string, string][] = [
  ['Admin', ''],
  ['Petrov', '123'],
  ['Sidorov', '456'],
  ['Reader', '789'],
  ['Petrov', 'wrong'],
  ['Nobody', '000'],
];

/** Пары «пользователь:хеш» из запроса: crs:auth и параметры DevDepot_authenticate. */
function credentialsOf(text: string): string[] {
  const result: string[] = [];
  for (const m of text.matchAll(/<crs:auth user="(\w+)" password="([0-9a-f]{32})"\/>/g)) {
    result.push(`${m[1]}:${m[2]}`);
  }
  for (const m of text.matchAll(/<crs:user value="(\w+)"\/><crs:password value="([0-9a-f]{32})"\/>/g)) {
    result.push(`${m[1]}:${m[2]}`);
  }
  return result;
}

function allBodies(): { name: string; direction: 'c2s' | 's2c'; text: string }[] {
  const result = crsCorpus().map((f) => ({
    name: `${f.transport}/${f.scenario}/${f.file}`,
    direction: f.direction,
    text: f.body.toString('utf-8'),
  }));
  for (const conn of rawConfiguratorConnections()) {
    result.push({ name: `tcp-raw/${conn.name}/c2s`, direction: 'c2s', text: requestBodyOf(conn.c2s).toString('utf-8') });
    result.push({ name: `tcp-raw/${conn.name}/s2c`, direction: 's2c', text: splitTcpFrame(responseFrameOf(conn.s2c)).body.toString('utf-8') });
  }
  return result;
}

suite('crs secrets: хеш пароля и маскировка', () => {
  const bodies = allBodies();
  const hashes = (): string[] => PAIRS.map(([, password]) => crsPasswordHash(password));

  test('хеш каждой пары стенда совпадает со снятыми запросами tcp и http', () => {
    const expected = new Set(PAIRS.map(([user, password]) => `${user}:${crsPasswordHash(password)}`));
    for (const transport of ['tcp/', 'http/', 'tcp-raw/']) {
      const seen = new Set(bodies.filter((b) => b.name.startsWith(transport) && b.direction === 'c2s').flatMap((b) => credentialsOf(b.text)));
      assert.ok(seen.size > 0, transport);
      // Любая снятая пара — из стенда; по tcp сняты все шесть (Admin по http не ходил: истории там нет).
      for (const pair of seen) {
        assert.ok(expected.has(pair), `${transport}: ${pair}`);
      }
      if (transport === 'tcp/') {
        assert.deepStrictEqual([...seen].sort(), [...expected].sort(), transport);
      }
    }
    assert.ok(hashes().every((h) => /^[0-9a-f]{32}$/.test(h)));
    assert.strictEqual(new Set(hashes()).size, PAIRS.length);
  });

  test('после маскировки в запросах и ответах не остаётся хешей, остальной текст не меняется', () => {
    let masked = 0;
    const known = hashes();
    for (const { name, text } of bodies) {
      const result = maskCrsSecrets(text);
      for (const hash of known) {
        assert.ok(!result.includes(hash), `${name}: ${hash}`);
      }
      // Хеши встречаются только в значениях паролей — замена каждого на маску даёт тот же текст.
      assert.strictEqual(result, known.reduce((t, h) => t.split(h).join(CRS_SECRET_MASK), text), name);
      assert.strictEqual(maskCrsSecrets(result), result, `${name}: маскировка идемпотентна`);
      masked += Number(result !== text);
    }
    // Маскируются и запросы (crs:auth, authenticate), и ответы (devObjectsStatistic, depotUsers).
    assert.ok(bodies.some((b) => b.direction === 's2c' && maskCrsSecrets(b.text) !== b.text));
    assert.ok(masked > 100, String(masked));
  });
});

// Независимый оракул хеша — файл хранилища (example/repository/2.21-locks): пароль хранится там тем же
// хешем, что сервер сверяет в crs:auth, и этот хеш сервер принял в снятом запросе статистики.
suite('crs secrets: хеш пароля против 1CD хранилища и принятого сервером запроса', () => {
  test('«» — хеш Admin, «123» — хеш Petrov в USERS.PASSWORD и в принятом запросе', async () => {
    const file = await OneCdFile.open(lockFixturePath('8.5.1', '1cv8ddb.1CD'));
    try {
      const users = await readOneCdTable(file, 'USERS');
      const hashOf = (name: string): unknown => must(users.find((row) => row.NAME === name), name).PASSWORD;
      assert.strictEqual(crsPasswordHash(''), hashOf('Admin'));
      assert.strictEqual(crsPasswordHash('123'), hashOf('Petrov'));
    } finally {
      await file.close();
    }
    assert.strictEqual(crsPasswordHash(''), requestPasswordHash(readHttpExchange('8.5.1', 'statistic-admin').request));
    assert.strictEqual(crsPasswordHash('123'), requestPasswordHash(readHttpExchange('8.5.1', 'statistic-petrov').request));
  });
});
