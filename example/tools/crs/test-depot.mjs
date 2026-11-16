// Локальный crserver с настоящим хранилищем для интеграционных тестов протокола crs (issue #118).
// Собирает хранилище из выгрузки конфигурации тем же стендом, что и съёмка трафика (stand.mjs): база →
// хранилище (Admin без пароля) → пользователи Petrov (LockObjects, пароль 123) и Reader (ReadOnly,
// пароль 789) → привязанные базы. После сборки печатает в stdout одну строку JSON и держит crserver до
// SIGTERM, SIGINT или закрытия stdin; весь остальной вывод — в stderr. Публикацию по http тесты поднимают
// сами поверх порта (src/test/suite/support/crsApache.ts).
//
// Запускается тестами дочерним процессом через src/test/suite/support/crsTestDepot.ts; вручную:
//   node example/tools/crs/test-depot.mjs [--config <выгрузка>] <рабочий каталог>
// Выгрузка по умолчанию — example/2.21/src/cf (только чтение). Строка готовности:
// {"ready":true,"port":…,"alias":"exp"}. Рабочий каталог создаётся заново (стенд очищает его) и удаляется
// вызывающей стороной.
/* global process */
import * as path from 'node:path';
import { ALIAS, REPO_ROOT, createStand } from './stand.mjs';

const args = process.argv.slice(2);
let config = path.join(REPO_ROOT, 'example', '2.21', 'src', 'cf');
let workArg;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--config') {
    if (args[i + 1] === undefined) throw new Error('после --config не указан каталог выгрузки');
    config = path.resolve(args[i + 1]);
    i += 1;
  } else if (args[i].startsWith('--')) {
    throw new Error(`неизвестный ключ ${args[i]}`);
  } else {
    workArg = args[i];
  }
}
if (workArg === undefined) throw new Error('не указан рабочий каталог');
const work = path.resolve(workArg);

const petrov = { name: 'Petrov', password: '123' };
const reader = { name: 'Reader', password: '789' };

process.stderr.write(`crs-depot: сборка из ${config}\n`);
const stand = createStand(work);
// stdout занят строкой готовности.
stand.log = (text) => process.stderr.write(`${text}\n`);
let stopping = false;
const shutdown = async (code) => {
  if (stopping) return;
  stopping = true;
  await stand.stop();
  process.exit(code);
};
// SIGTERM и SIGINT перехватывает stand.mjs: process.exit, а crserver и группы ibcmd/1cv8 синхронно
// убивает его обработчик exit — свои обработчики сигналов здесь не сработали бы.
// Родитель закрыл канал (упал тест-раннер) — останавливаемся, чтобы не оставить crserver.
process.stdin.on('end', () => void shutdown(0));
process.stdin.resume();

try {
  await stand.prepareRepository(config, [
    { user: petrov, rights: 'LockObjects' },
    { user: reader, rights: 'ReadOnly' },
  ]);
  process.stdout.write(`${JSON.stringify({ ready: true, port: stand.crs.port, alias: ALIAS })}\n`);
} catch (error) {
  process.stderr.write(`Ошибка: ${error instanceof Error ? error.message : String(error)}\n`);
  await shutdown(1);
}
