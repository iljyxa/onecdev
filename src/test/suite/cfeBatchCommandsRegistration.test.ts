/**
 * Тесты регистрации команд `onecdev.dumpAllExtensionsToCfe` /
 * `onecdev.loadAllExtensionsFromCfe` (`src/ui/commands/ext/CfeBatchCommands.ts`)
 * и их паритета с `package.json → contributes.commands`.
 *
 * Окружение — то же, что у `cfFileCommandsRegistration.test.ts`: реальное
 * расширение в тестовом Extension Host не активируется (нет открытой рабочей
 * папки), поэтому прямой вызов регистратора с фейковым контекстом не
 * конфликтует с настоящей регистрацией той же команды.
 *
 * Тела команд по контракту ОБЯЗАНЫ проверять общий `ConfigurationOperationGuard`
 * ПЕРВЫМ действием и выходить раньше, чем тронуты остальные поля `services`
 * (диалоги, выбор каталога): именно поэтому в тестах с занятым guard'ом в
 * заглушке `services` есть только он — если бы проверка не сработала первой,
 * обращение к отсутствующим полям бросило бы исключение. Главное свойство:
 * команда, увидев чужую аренду, НЕ освобождает её (иначе параллельная операция
 * над той же базой осталась бы без защиты).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandServices } from '../../ui/commands/_shared';
import { registerCommands } from '../../ui/commands/CommandRegistry';
import { registerCfeBatchCommands } from '../../ui/commands/ext/CfeBatchCommands';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';

const ROOT = path.resolve(__dirname, '../../..');

const DUMP_COMMAND_ID = 'onecdev.dumpAllExtensionsToCfe';
const LOAD_COMMAND_ID = 'onecdev.loadAllExtensionsFromCfe';
const BATCH_COMMAND_IDS: readonly string[] = [DUMP_COMMAND_ID, LOAD_COMMAND_ID];

interface DeclaredCommand {
  readonly command?: string;
  readonly title?: string;
  readonly enablement?: string;
}

/** Минимальный дубль `ExtensionContext`: `registerCommand` использует только массив подписок. */
function createFakeContext(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

function disposeAll(context: vscode.ExtensionContext): void {
  for (const disposable of context.subscriptions) {
    disposable.dispose();
  }
}

function readDeclaredCommands(): DeclaredCommand[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
    contributes?: { commands?: DeclaredCommand[] };
  };
  return manifest.contributes?.commands ?? [];
}

suite('CfeBatchCommands — регистрация dumpAllExtensionsToCfe/loadAllExtensionsFromCfe', function () {
  // Обращения к реестру команд Extension Host (`getCommands(true)`,
  // `executeCommand`) — межпроцессный round-trip, задержка которого зависит от
  // нагрузки на хост, а не от нашей логики. Гейт покрытия гоняет прогон восемью
  // порциями параллельно, и дефолтных 2000 мс образцу (`cfFileCommandsRegistration`)
  // уже не хватало — он флейкал не воспроизводясь при одиночном запуске. Проверки
  // остаются детерминированными: расширяется только бюджет ожидания внешнего вызова.
  this.timeout(30_000);

  test('registerCfeBatchCommands регистрирует РОВНО две команды — обе пакетные, ничего лишнего', async () => {
    const before = new Set(await vscode.commands.getCommands(true));
    const context = createFakeContext();
    registerCfeBatchCommands(context, {} as unknown as CommandServices);
    try {
      const added = (await vscode.commands.getCommands(true)).filter((id) => !before.has(id));
      assert.deepStrictEqual([...added].sort(), [...BATCH_COMMAND_IDS].sort());
    } finally {
      disposeAll(context);
    }
  });

  test('CommandRegistry.registerCommands реально подключает пакетные команды (не только прямой вызов регистратора из теста)', async () => {
    // `registerCommands` зовётся только из `Container.bootstrap`, который в
    // тестовом Extension Host не исполняется: опечатка в имени регистратора
    // внутри проводки осталась бы незамеченной без этого теста.
    const context = createFakeContext();
    registerCommands(context, {} as unknown as CommandServices);
    try {
      const registered = await vscode.commands.getCommands(true);
      for (const id of BATCH_COMMAND_IDS) {
        assert.ok(registered.includes(id), `${id} должна быть зарегистрирована через CommandRegistry.registerCommands`);
      }
    } finally {
      disposeAll(context);
    }
  });

  test('паритет с package.json, направление 1: обе команды объявлены с непустым title и enablement по !onecdev.isUpdatingConfigurations', () => {
    const declared = readDeclaredCommands();
    for (const id of BATCH_COMMAND_IDS) {
      const entry = declared.find((item) => item.command === id);
      assert.ok(entry, `команда ${id} должна быть объявлена в package.json → contributes.commands`);
      assert.ok(entry.title && entry.title.trim().length > 0, `у команды ${id} должен быть title`);
      // Обе команды меняют/читают базу через тот же общий замок, что импорт и
      // обновление: параллельный запуск повредил бы данные.
      assert.strictEqual(
        entry.enablement,
        '!onecdev.isUpdatingConfigurations',
        `enablement ${id} обязан быть "!onecdev.isUpdatingConfigurations": "${String(entry.enablement)}"`
      );
    }
  });

  test('паритет с package.json, направление 2: каждая объявленная пакетная команда реально регистрируется, а каждая зарегистрированная — объявлена', async () => {
    const declaredBatch = readDeclaredCommands()
      .map((item) => item.command)
      .filter((id): id is string => typeof id === 'string' && /^onecdev\.(dump|load)AllExtensions/.test(id));

    const before = new Set(await vscode.commands.getCommands(true));
    const context = createFakeContext();
    registerCfeBatchCommands(context, {} as unknown as CommandServices);
    try {
      const registeredBatch = (await vscode.commands.getCommands(true)).filter((id) => !before.has(id));
      assert.deepStrictEqual([...declaredBatch].sort(), [...registeredBatch].sort(),
        'множество объявленных в package.json и зарегистрированных пакетных команд должно совпадать (иначе «команда есть в меню, но не работает» или «работает, но не видна»)');
    } finally {
      disposeAll(context);
    }
  });

  test('ни пакетная команда, ни её объявление не пересекаются с одиночными dump/load CF (разные id)', () => {
    assert.ok(!BATCH_COMMAND_IDS.includes('onecdev.dumpConfigurationToCf'));
    assert.ok(!BATCH_COMMAND_IDS.includes('onecdev.loadConfigurationFromCf'));
    const declared = readDeclaredCommands().map((item) => item.command);
    assert.ok(declared.includes('onecdev.dumpConfigurationToCf'), 'одиночные команды остаются объявленными');
    assert.ok(declared.includes('onecdev.loadConfigurationFromCf'), 'одиночные команды остаются объявленными');
  });

  /** Guard, уже занятый чужой операцией, и заглушка `services`, в которой есть только он. */
  function busyServices(): { guard: ConfigurationOperationGuard; release: () => void; services: CommandServices } {
    const guard = new ConfigurationOperationGuard();
    const lease = guard.tryAcquire('Чужая операция');
    assert.ok(lease, 'подготовка теста: guard обязан быть свободен в начале');
    return {
      guard,
      release: () => lease.release(),
      services: { configurationOperationGuard: guard } as unknown as CommandServices,
    };
  }

  for (const commandId of BATCH_COMMAND_IDS) {
    test(`${commandId}: при занятом guard'е команда не стартует и НЕ освобождает чужую аренду`, async () => {
      const busy = busyServices();
      const context = createFakeContext();
      registerCfeBatchCommands(context, busy.services);
      try {
        // В заглушке только guard: если проверка не сработала ПЕРВОЙ, тело
        // команды обратилось бы к отсутствующим полям, и executeCommand отклонился бы.
        await assert.doesNotReject(Promise.resolve(vscode.commands.executeCommand(commandId)));
        assert.strictEqual(busy.guard.heldBy, 'Чужая операция',
          'команда не должна была ни повторно брать, ни освобождать чужую аренду');
      } finally {
        disposeAll(context);
        busy.release();
      }
      assert.strictEqual(busy.guard.isBusy, false, 'после теста guard освобождён нами же');
    });

    test(`${commandId}: вызов из контекстного меню узла (передан node) при занятом guard'е ведёт себя так же — аренда не трогается`, async () => {
      const busy = busyServices();
      const context = createFakeContext();
      registerCfeBatchCommands(context, busy.services);
      try {
        await assert.doesNotReject(Promise.resolve(vscode.commands.executeCommand(commandId, {
          nodeKind: 'extensions-root',
          label: 'Расширения',
        })));
        assert.strictEqual(busy.guard.heldBy, 'Чужая операция');
      } finally {
        disposeAll(context);
        busy.release();
      }
    });
  }
});
