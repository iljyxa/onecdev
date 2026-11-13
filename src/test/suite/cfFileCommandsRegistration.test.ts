/**
 * Тесты регистрации команд `v8vscedit.dumpConfigurationToCf` /
 * `v8vscedit.loadConfigurationFromCf` (`src/ui/commands/ext/CfFileCommands.ts`)
 * и их паритета с `package.json → contributes.commands`.
 *
 * ВАЖНО про окружение теста: реальное расширение (`src/extension.ts`) в
 * тестовом Extension Host НЕ активируется — `activate()` возвращает
 * `undefined` сразу же, если нет открытой рабочей папки
 * (`vscode.workspace.workspaceFolders` пуст, а `src/test/runTests.ts` не
 * передаёт папку в `launchArgs`), и `Container.bootstrap` (а значит и
 * реальная регистрация всех `v8vscedit.*` команд) не вызывается. Поэтому
 * вызов `registerCfFileCommands` здесь напрямую с фейковым контекстом НЕ
 * конфликтует с реальной регистрацией той же команды — это тот же приём,
 * которым в этом проекте ещё никто не пользовался (см. обоснование в
 * `extensionListParser.test.ts`, почему обычно строят только чистые функции),
 * но здесь он безопасен именно из-за пустого workspace в тестовом хосте.
 *
 * Тела команд `v8vscedit.dumpConfigurationToCf`/`v8vscedit.loadConfigurationFromCf`
 * по контракту ОБЯЗАНЫ проверять общий `ConfigurationOperationGuard` ПЕРВЫМ
 * действием и возвращаться раньше, чем произойдёт обращение к остальным полям
 * `services` (диалоги выбора файла и т.п.) — именно поэтому в тестах ниже, где
 * guard предварительно занят, в заглушке `services` есть только он: если бы
 * проверка не сработала первой, попытка обратиться к отсутствующим полям
 * заглушки бросила бы исключение, и `executeCommand` отклонился бы.
 *
 * `CfFileCommands.ts` на фазе «красный» ещё не существовал — лениво грузится
 * через `tryRequireProductionModule`.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandServices } from '../../ui/commands/_shared';
// registerCommands — единственная точка проводки ВСЕХ v8vscedit.*-команд
// (Container.bootstrap её не вызывает в тестовом Extension Host — см. шапку
// файла), поэтому файл существует всегда (не «красный» модуль задания) и
// импортируется статически.
import { registerCommands } from '../../ui/commands/CommandRegistry';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import { tryRequireProductionModule } from './support/tryRequireProductionModule';

const ROOT = path.resolve(__dirname, '../../..');

interface CfFileCommandsModule {
  registerCfFileCommands(context: vscode.ExtensionContext, services: CommandServices): void;
}

const DUMP_COMMAND_ID = 'v8vscedit.dumpConfigurationToCf';
const LOAD_COMMAND_ID = 'v8vscedit.loadConfigurationFromCf';

/** Минимальный реальный `ExtensionContext`-дубль: единственное, что использует `registerCommand`, — массив подписок. */
function createFakeContext(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

function disposeAll(context: vscode.ExtensionContext): void {
  for (const disposable of context.subscriptions) {
    disposable.dispose();
  }
}

function readDeclaredCommands(): { command?: string; title?: string; enablement?: string }[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
    contributes?: { commands?: { command?: string; title?: string; enablement?: string }[] };
  };
  return manifest.contributes?.commands ?? [];
}

suite('CfFileCommands — регистрация dumpConfigurationToCf/loadConfigurationFromCf', function () {
  // Тесты сьюта ходят в реестр команд Extension Host (`getCommands(true)`,
  // `executeCommand`) — это межпроцессный round-trip, чья задержка зависит от
  // нагрузки на хост, а не от нашей логики. Гейт покрытия гоняет прогон восемью
  // порциями параллельно, и дефолтных 2000 мс там не хватало: сьют дважды падал
  // по таймауту и не воспроизводился при одиночном запуске. Это не маскировка
  // недетерминизма — сама проверка детерминирована, расширяется только бюджет
  // ожидания внешнего вызова. Роняя ПОРЦИЮ, такой флейк обесценивал весь прогон.
  this.timeout(30_000);

  let commandsMod: CfFileCommandsModule | undefined;

  suiteSetup(() => {
    commandsMod = tryRequireProductionModule('../../../ui/commands/ext/CfFileCommands') as CfFileCommandsModule | undefined;
  });

  test('модуль CfFileCommands.ts существует', () => {
    assert.ok(commandsMod, 'src/ui/commands/ext/CfFileCommands.ts ещё не реализован (ожидаемо на фазе «красный» TDD)');
  });

  function commands(): CfFileCommandsModule {
    if (!commandsMod) {
      assert.fail('CfFileCommands.ts не реализован — см. первый тест сьюта');
    }
    return commandsMod;
  }

  // ─── Часть 4, F.22: обе команды реально регистрируются в vscode.commands ───

  test('после registerCfFileCommands обе команды присутствуют в vscode.commands.getCommands(true)', async () => {
    const context = createFakeContext();
    commands().registerCfFileCommands(context, {} as unknown as CommandServices);
    try {
      const registered = await vscode.commands.getCommands(true);
      assert.ok(registered.includes(DUMP_COMMAND_ID), `${DUMP_COMMAND_ID} должна быть зарегистрирована`);
      assert.ok(registered.includes(LOAD_COMMAND_ID), `${LOAD_COMMAND_ID} должна быть зарегистрирована`);
    } finally {
      disposeAll(context);
    }
  });

  // ─── Возврат со стадии qa-e2e: `registerCfFileCommands` реально подключён
  // к общей проводке `CommandRegistry.registerCommands` (а не только вызывается
  // напрямую тестом выше) — `registerCommands()` зовётся только из
  // `Container.bootstrap`, который в тестовом Extension Host не исполняется
  // (см. шапку файла), поэтому опечатка в имени регистратора внутри
  // `registerCommands` осталась бы незамеченной без этого теста. ───

  test('CommandRegistry.registerCommands реально регистрирует dumpConfigurationToCf/loadConfigurationFromCf (доказывает, что registerCfFileCommands подключён в общую проводку, а не только вызывается напрямую)', async () => {
    const context = createFakeContext();
    // Пустая заглушка `services` безопасна: все ~20 регистраторов, которые
    // вызывает `registerCommands`, обращаются к полям `services` только ВНУТРИ
    // тел команд (замыкания `vscode.commands.registerCommand(id, () => {...})`),
    // а не в момент самой регистрации — проверено прогоном этого теста.
    registerCommands(context, {} as unknown as CommandServices);
    try {
      const registered = await vscode.commands.getCommands(true);
      assert.ok(registered.includes(DUMP_COMMAND_ID),
        `${DUMP_COMMAND_ID} должна быть зарегистрирована через CommandRegistry.registerCommands`);
      assert.ok(registered.includes(LOAD_COMMAND_ID),
        `${LOAD_COMMAND_ID} должна быть зарегистрирована через CommandRegistry.registerCommands`);
    } finally {
      disposeAll(context);
    }
  });

  // ─── Часть 4, F.23: паритет с package.json ───

  test('обе команды объявлены в package.json contributes.commands с enablement', () => {
    const declared = readDeclaredCommands();
    for (const id of [DUMP_COMMAND_ID, LOAD_COMMAND_ID]) {
      const entry = declared.find((item) => item.command === id);
      assert.ok(entry, `команда ${id} должна быть объявлена в package.json → contributes.commands`);
      assert.ok(entry.title && entry.title.trim().length > 0, `у команды ${id} должен быть title`);
      assert.ok(entry.enablement?.includes('v8vscedit.isUpdatingConfigurations'),
        `у команды ${id} enablement обязан ссылаться на v8vscedit.isUpdatingConfigurations (защита от параллельного запуска): "${String(entry.enablement)}"`);
    }
  });

  // ─── Часть 4, F.21: интеграция с общим guard'ом операций ───

  for (const commandId of [LOAD_COMMAND_ID, DUMP_COMMAND_ID]) {
    test(`${commandId} не запускает операцию, если guard уже занят другой операцией (guard остаётся занятым как был)`, async () => {
      const guard = new ConfigurationOperationGuard();
      const lease = guard.tryAcquire('Чужая операция');
      assert.ok(lease, 'подготовка теста: guard обязан быть свободен в начале');

      const context = createFakeContext();
      commands().registerCfFileCommands(context, { configurationOperationGuard: guard } as unknown as CommandServices);
      try {
        // В заглушке `services` только guard: если бы проверка не сработала
        // первой, тело команды обратилось бы к отсутствующим полям заглушки и
        // executeCommand отклонился бы с TypeError — этого не происходит.
        await assert.doesNotReject(Promise.resolve(vscode.commands.executeCommand(commandId)));
        assert.strictEqual(guard.heldBy, 'Чужая операция',
          'команда не должна была трогать чужую аренду (ни повторно брать, ни освобождать)');
      } finally {
        disposeAll(context);
        lease.release();
      }
    });
  }
});
