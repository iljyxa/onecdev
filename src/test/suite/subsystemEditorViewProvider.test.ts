/**
 * Issue #110: редактор состава подсистемы показывал «Редактирование подсистемы запрещено…»
 * сразу при открытии заблокированной подсистемы. Vue-приложение после монтирования шлёт
 * `{ type: 'ready' }`, а `handleMessage` проверял блокировку до разбора типа сообщения.
 *
 * Состояние поддержки — настоящее: `ParentConfigurations.bin` из `example/`. Подсистема `Закупки`
 * стоит на поставке с запретом редактирования; редактируемый случай — её копия с UUID вне поставки
 * (собственная подсистема, режим поддержки `None`).
 * Подменены только панель (headless-хост, см. `fakeWebviewPanel`) и вывод уведомлений.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SubsystemEditorViewProvider } from '../../ui/views/subsystem/SubsystemEditorViewProvider';
import { SubsystemXmlService } from '../../infra/xml/SubsystemXmlService';
import { SupportInfoService } from '../../infra/support/SupportInfoService';
import { RepositoryService } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { buildSupportFixtureRoot, EXAMPLE_CF_ROOTS, type SupportFixtureRoot } from './support/realConfigFixtures';
import { type FakeWebviewPanelFactory, installFakeWebviewPanels } from './support/fakeWebviewPanel';

const EXTENSION_ROOT = path.resolve(__dirname, '../../../');
const LOCKED_WARNING = 'Редактирование подсистемы запрещено текущим состоянием поддержки или хранилища.';
const ADDED_REF = 'Catalog.Контрагенты';
const REMOVED_REF = 'AccumulationRegister.ТоварыНаСкладах';
const SUPPLIED_UUID = '1da42a03-3c15-4d27-b172-2d2c4d253442';
const OWN_UUID = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';

function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

const silentChannel = { appendLine: () => undefined } as unknown as vscode.OutputChannel;

/** Даёт обработчику сообщения пройти очередь обновлений (`enqueueUpdate`). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  readonly fixture: SupportFixtureRoot;
  readonly subsystemXmlPath: string;
  readonly provider: SubsystemEditorViewProvider;
  readonly mutations: (readonly string[])[];
}

function createHarness(locked: boolean): Harness {
  const fixture = buildSupportFixtureRoot('normal');
  const subsystemsDir = path.join(fixture.configRoot, 'Subsystems');
  fs.mkdirSync(subsystemsDir, { recursive: true });
  const subsystemXmlPath = path.join(subsystemsDir, 'Закупки.xml');
  const sourceXml = fs.readFileSync(path.join(EXAMPLE_CF_ROOTS['2.21'], 'Subsystems', 'Закупки.xml'), 'utf-8');
  assert.ok(sourceXml.includes(SUPPLIED_UUID), 'UUID поставки Закупки в фикстуре изменился');
  fs.writeFileSync(subsystemXmlPath, locked ? sourceXml : sourceXml.replace(SUPPLIED_UUID, OWN_UUID));

  const supportService = new SupportInfoService(silentChannel);
  supportService.loadConfig(fixture.configRoot);
  const repositoryService = new RepositoryService(
    fixture.tempDir,
    new ProjectSecretStorage(createFakeSecretStore(), fixture.tempDir)
  );
  const mutations: (readonly string[])[] = [];
  const provider = new SubsystemEditorViewProvider(
    new SubsystemXmlService(),
    supportService,
    repositoryService,
    vscode.Uri.file(EXTENSION_ROOT),
    silentChannel,
    (changedFiles) => { mutations.push(changedFiles); }
  );
  return { fixture, subsystemXmlPath, provider, mutations };
}

suite('SubsystemEditorViewProvider — сообщения редактора подсистемы (issue #110)', () => {
  let panels: FakeWebviewPanelFactory;
  let warnings: string[];
  let originalShowWarning: typeof vscode.window.showWarningMessage;
  let harness: Harness | undefined;

  setup(() => {
    panels = installFakeWebviewPanels();
    warnings = [];
    const windowRef = vscode.window as Pick<typeof vscode.window, 'showWarningMessage'>;
    originalShowWarning = windowRef.showWarningMessage;
    windowRef.showWarningMessage = ((message: string) => {
      warnings.push(message);
      return Promise.resolve(undefined);
    });
  });

  teardown(() => {
    harness?.provider.dispose();
    harness?.fixture.dispose();
    harness = undefined;
    (vscode.window as Pick<typeof vscode.window, 'showWarningMessage'>).showWarningMessage = originalShowWarning;
    panels.restore();
  });

  function open(locked: boolean): { harness: Harness; receive: (message: unknown) => void } {
    harness = createHarness(locked);
    harness.provider.show('Закупки', harness.subsystemXmlPath);
    const [panel] = panels.panels;
    return { harness, receive: panel.receive };
  }

  [
    { name: 'ready после монтирования', message: { type: 'ready' } },
    { name: 'сообщение другого типа', message: { type: 'request', requestId: '1', name: 'browse' } },
    { name: 'неизвестная команда', message: { type: 'command', command: 'refresh' } },
  ].forEach(({ name, message }) => {
    test(`${name} для заблокированной подсистемы не даёт предупреждения и не меняет XML`, async () => {
      const { harness: h, receive } = open(true);
      const before = fs.readFileSync(h.subsystemXmlPath, 'utf-8');

      receive(message);
      await flush();

      assert.deepStrictEqual(warnings, []);
      assert.deepStrictEqual(h.mutations, []);
      assert.strictEqual(fs.readFileSync(h.subsystemXmlPath, 'utf-8'), before);
    });
  });

  test('addContent для заблокированной подсистемы даёт предупреждение и не меняет XML', async () => {
    const { harness: h, receive } = open(true);
    const before = fs.readFileSync(h.subsystemXmlPath, 'utf-8');

    receive({ type: 'command', command: 'addContent', payload: { ref: ADDED_REF } });
    await flush();

    assert.deepStrictEqual(warnings, [LOCKED_WARNING]);
    assert.deepStrictEqual(h.mutations, []);
    assert.strictEqual(fs.readFileSync(h.subsystemXmlPath, 'utf-8'), before);
  });

  test('ready для редактируемой подсистемы игнорируется, addContent добавляет объект в состав', async () => {
    const { harness: h, receive } = open(false);
    const before = fs.readFileSync(h.subsystemXmlPath, 'utf-8');

    receive({ type: 'ready' });
    await flush();
    assert.strictEqual(fs.readFileSync(h.subsystemXmlPath, 'utf-8'), before);

    receive({ type: 'command', command: 'addContent', payload: { ref: ADDED_REF } });
    await flush();

    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(h.mutations, [[h.subsystemXmlPath]]);
    assert.ok(fs.readFileSync(h.subsystemXmlPath, 'utf-8').includes(`>${ADDED_REF}</xr:Item>`));
  });

  test('removeContent для редактируемой подсистемы убирает объект из состава', async () => {
    const { harness: h, receive } = open(false);
    assert.ok(fs.readFileSync(h.subsystemXmlPath, 'utf-8').includes(`>${REMOVED_REF}</xr:Item>`));

    receive({ type: 'command', command: 'removeContent', payload: { ref: REMOVED_REF } });
    await flush();

    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(h.mutations, [[h.subsystemXmlPath]]);
    assert.ok(!fs.readFileSync(h.subsystemXmlPath, 'utf-8').includes(`>${REMOVED_REF}</xr:Item>`));
  });
});
