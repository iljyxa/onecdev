// Хранилище с историей версий для снятия трафика истории: общее для capture-history.mjs (отчёты
// Конфигуратора, issue #10) и capture-history-probes.mjs (пробы фильтров, issue #39), чтобы пробы шли
// по тем же версиям, что и снятые отчёты. Трафик подготовки не сохраняется.
import { appendFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { CORPUS_CONFIG } from './stand.mjs';

export const admin = { name: 'Admin', password: '' };
export const petrov = { name: 'Petrov', password: '123' };

export const CATALOG = { name: 'Справочник.Контрагенты', files: ['Catalogs/Контрагенты.xml', 'Catalogs/Контрагенты/Ext/ObjectModule.bsl'] };
export const COMMON_MODULE = { name: 'ОбщийМодуль.ОбщегоНазначения', files: ['CommonModules/ОбщегоНазначения.xml', 'CommonModules/ОбщегоНазначения/Ext/Module.bsl'] };

// Версии 1–6 из source (по умолчанию example/crs/config): 1 — создание (Admin), 2 и 3 — Petrov (в 3 — два
// объекта), 4 — Admin с комментарием из двух строк, метки на 2 и 4, 5 — Admin без комментария, 6 — Admin
// со спецсимволами XML. Возвращает базы и commit — помещение следующей версии, если сценарию нужны ещё версии.
export async function buildHistoryRepository(stand, work, source = CORPUS_CONFIG) {
  const { baseA, bases } = await stand.prepareRepository(source, [{ user: petrov, rights: 'LockObjects' }]);
  const baseB = bases.Petrov;
  let counter = 0;

  // Версия хранилища: захват → правка в выгрузке → частичная загрузка → помещение. По умолчанию правка —
  // строка в конце модулей объектов; edit(dump) заменяет её своей.
  const commit = async (base, user, objects, comment, edit) => {
    counter += 1;
    const tag = `commit-${String(counter)}`;
    const list = stand.objectList(...objects.map((o) => o.name));
    await stand.setup(`${tag}-lock`, base, user, ['/ConfigurationRepositoryLock', '-Objects', list]);
    const dump = path.join(work, `dump-${tag}`);
    await stand.designer(base, user, ['/DumpConfigToFiles', dump]);
    const files = objects.flatMap((o) => o.files).map((f) => path.join(dump, f));
    if (edit === undefined) {
      for (const file of files.filter((f) => f.endsWith('.bsl'))) {
        appendFileSync(file, `\r\n// Правка ${String(counter)}\r\n`);
      }
    } else {
      edit(dump);
    }
    const listFile = path.join(work, `${tag}.txt`);
    writeFileSync(listFile, files.join('\n'));
    await stand.setup(`${tag}-load`, base, user, ['/LoadConfigFromFiles', dump, '-listFile', listFile, '-partial']);
    // Пустой комментарий — ключ -comment не передаётся вовсе: так помещает версию пользователь, не
    // заполнивший поле.
    const commentArgs = comment === '' ? [] : ['-comment', comment];
    await stand.setup(`${tag}-commit`, base, user, ['/ConfigurationRepositoryCommit', '-Objects', list, ...commentArgs]);
  };

  await commit(baseB, petrov, [CATALOG], 'Проверка наименования');
  await commit(baseB, petrov, [CATALOG, COMMON_MODULE], 'Два объекта в одной версии');
  await stand.setup('update-A', baseA, admin, ['/ConfigurationRepositoryUpdateCfg', '-force']);
  await commit(baseA, admin, [COMMON_MODULE], 'Правка от администратора\nвторая строка комментария');
  await stand.setup('label-2', baseB, petrov, ['/ConfigurationRepositorySetLabel', '-v', '2', '-name', 'Релиз 1.0', '-comment', 'Первый релиз']);
  await stand.setup('label-4', baseA, admin, ['/ConfigurationRepositorySetLabel', '-v', '4', '-name', 'Релиз 1.1', '-comment', 'Второй релиз']);
  // Версии 5 и 6 (issue #21): пустой комментарий и комментарий со спецсимволами XML — проверка
  // раскрытия сущностей в тексте crs:comment.
  await commit(baseA, admin, [COMMON_MODULE], '');
  // Двойной кавычки нет: командная строка Конфигуратора обрезает по ней комментарий.
  await commit(baseA, admin, [CATALOG], 'Спецсимволы: <тег> & \'апостроф\' > конец');
  return { baseA, baseB, commit };
}
