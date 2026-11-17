import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StandaloneServerService } from '../../infra/standalone/StandaloneServerService';
import type { Logger } from '../../infra/support/Logger';
import { resolveConnectionFromSettings } from '../../ui/commands/ext/ExtensionCommandRunner';

/**
 * Issue #137: `env.json`, сохранённый редактором Windows с UTF-8 BOM, обязан читаться всеми
 * читателями подключения, а не только `RepositoryBindingStore`.
 */
suite('env.json с UTF-8 BOM (issue #137)', () => {
  let root: string;
  let envPath: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-env-bom-'));
    envPath = path.join(root, 'env.json');
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeEnvWithBom(defaults: Record<string, unknown>): void {
    fs.writeFileSync(envPath, `\uFEFF${JSON.stringify({ default: defaults }, null, 2)}`, 'utf-8');
  }

  test('ExtensionCommandRunner.resolveConnectionFromSettings разбирает подключение', async () => {
    const infoBasePath = path.join(root, 'build', 'ib');
    writeEnvWithBom({ '--ibconnection': `/F${infoBasePath}`, '--db-user': 'Админ' });

    const connection = await resolveConnectionFromSettings(envPath);

    assert.strictEqual(connection.infoBasePath, infoBasePath);
    assert.strictEqual(connection.userName, 'Админ');
  });

  test('ExtensionCommandRunner.resolveConnectionFromSettings: битый env.json — понятная ошибка с путём', async () => {
    fs.writeFileSync(envPath, '\uFEFF{ не json', 'utf-8');

    await assert.rejects(
      () => resolveConnectionFromSettings(envPath),
      (error: Error) => error.message.startsWith(`env.json повреждён (${envPath})`)
    );
  });

  test('StandaloneServerService берёт путь к платформе из env.json с BOM', () => {
    const platformPath = path.join(root, 'opt', '1cv8', 'x86_64', '8.5.1');
    writeEnvWithBom({ '--path': platformPath });
    const logger: Logger = { appendLine: () => undefined };

    const settings = new StandaloneServerService(root, logger).getSettingsSnapshot().settings;

    assert.strictEqual(settings.platformPath, platformPath);
  });
});
