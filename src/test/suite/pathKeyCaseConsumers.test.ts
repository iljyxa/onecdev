/**
 * #123: потребители общего ключа пути `pathKey` — кэш метаданных (поиск владельца при добавлении
 * дочернего элемента), команды заимствования и удаления метаданных, кэш сервиса агента
 * конфигуратора. На регистрозависимой ФС (Linux) пути, различающиеся только регистром, — разные
 * каталоги, и прежний ключ через `toLowerCase()` их склеивал.
 *
 * Команды вызываются напрямую, а не через `executeCommand`: их id уже зарегистрированы активным
 * расширением тестового хоста с его собственными сервисами, а тесту нужны сервисы поверх
 * временной копии выгрузки.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConfigEntry } from '../../domain/Configuration';
import {
  buildMetadataCacheScopeKey,
  buildMetadataCacheSnapshot,
  loadMetadataCache,
  saveMetadataCache,
  updateMetadataCacheAfterAdd,
  type MetadataCacheNode,
} from '../../infra/cache/MetadataCache';
import { CfeBorrowService } from '../../infra/cfe/CfeBorrowService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { pathKey } from '../../infra/fs/PathKey';
import { RepositoryService } from '../../infra/repository/RepositoryService';
import { parseConfigXml } from '../../infra/xml';
import { MetadataXmlCreator } from '../../infra/xml/MetadataXmlCreator';
import { MetadataXmlRemover } from '../../infra/xml/MetadataXmlRemover';
import type { CommandServices } from '../../ui/commands/_shared';
import { borrowToExtension } from '../../ui/commands/ext/BorrowToExtensionCommand';
import {
  getAgentOperationServiceForInteractiveDesigner,
  getAgentServiceCacheKey,
  getCachedAgentOperationService,
} from '../../ui/commands/ext/ExtensionCommandRunner';
import { removeMetadata } from '../../ui/commands/metadata/RemoveMetadataCommand';
import { DynamicPanelController } from '../../ui/views/dynamic-panel/DynamicPanelController';
import type { PropertiesViewController } from '../../ui/views/properties/PropertiesViewController';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { EXAMPLE_GENERATIONS, skipWithoutCorpus } from './support/corpus';

/** На регистронезависимой ФС два пути, различающиеся регистром, — один каталог: проверка бессмысленна. */
const CASE_SENSITIVE_FS = process.platform !== 'win32' && process.platform !== 'darwin';

function skipOnCaseInsensitiveFs(context: Mocha.Context): void {
  if (!CASE_SENSITIVE_FS) {
    context.skip();
  }
}

/** Путь, отличающийся от исходного только регистром имени файла/каталога. */
function upperCaseBasename(filePath: string): string {
  return path.join(path.dirname(filePath), path.basename(filePath).toUpperCase());
}

function copyCorpus(prefix: string, withExtension: boolean): { root: string; cfDir: string; extDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cfDir = path.join(root, 'src', 'cf');
  const extDir = path.join(root, 'src', 'cfe', 'EVOLC');
  fs.cpSync(EXAMPLE_GENERATIONS.cf21, cfDir, { recursive: true });
  if (withExtension) {
    fs.cpSync(EXAMPLE_GENERATIONS.cfe21, extDir, { recursive: true });
  }
  return { root, cfDir, extDir };
}

function findCacheNode(
  node: MetadataCacheNode,
  predicate: (node: MetadataCacheNode) => boolean
): MetadataCacheNode | undefined {
  if (predicate(node)) {
    return node;
  }
  for (const child of node.children) {
    const found = findCacheNode(child, predicate);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function scopeKeyOf(entry: ConfigEntry): string {
  return buildMetadataCacheScopeKey(entry, parseConfigXml(path.join(entry.rootPath, 'Configuration.xml')));
}

function workspaceFolderOf(root: string): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file(root), name: path.basename(root), index: 0 };
}

/** Канал вывода, копящий строки: тесту нужен только текст журнала команды. */
function createOutputChannel(lines: string[]): vscode.OutputChannel {
  return {
    appendLine: (line: string) => {
      lines.push(line);
    },
    show: () => undefined,
  } as unknown as vscode.OutputChannel;
}

/** Фейковый SecretStore на Map — структурный контракт vscode.SecretStorage (см. removeCommandsSupportReason.test.ts). */
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

suite('MetadataCache — добавление дочернего элемента: поиск владельца по pathKey (#123)', () => {
  let root: string;
  let cfDir: string;
  let entry: ConfigEntry;

  setup(function () {
    skipWithoutCorpus(this, EXAMPLE_GENERATIONS.cf21);
    ({ root, cfDir } = copyCorpus('onecdev-cache-child-', false));
    entry = { rootPath: cfDir, kind: 'cf' };
    saveMetadataCache(root, buildMetadataCacheSnapshot(scopeKeyOf(entry), entry));
  });

  teardown(() => {
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function ownerNodeOf(snapshotRoot: MetadataCacheNode, xmlPath: string): MetadataCacheNode | undefined {
    return findCacheNode(snapshotRoot, (node) => node.type === 'Catalog' && node.xmlPath === xmlPath);
  }

  test('реквизит, добавленный в справочник, точечно попадает в узел владельца', () => {
    const ownerXml = path.join(cfDir, 'Catalogs', 'Контрагенты.xml');
    const added = new MetadataXmlCreator().addChildElement({ ownerObjectXmlPath: ownerXml, childTag: 'Attribute', name: 'КодПоПатчу123' });
    assert.ok(added.success, JSON.stringify(added));

    const result = updateMetadataCacheAfterAdd(root, entry, { kind: 'child', ownerObjectXmlPath: ownerXml, childTag: 'Attribute' }, 'КодПоПатчу123');

    assert.strictEqual(result.updatedPartially, true, 'владелец найден в кэше — полная пересборка не нужна');
    const owner = ownerNodeOf(result.snapshot.root, ownerXml);
    assert.ok(owner, 'узел владельца в снимке');
    assert.ok(findCacheNode(owner, (node) => node.type === 'Attribute' && node.name === 'КодПоПатчу123'), 'новый реквизит в дереве владельца');
    const persisted = loadMetadataCache(root, scopeKeyOf(entry));
    assert.ok(persisted && findCacheNode(persisted.root, (node) => node.name === 'КодПоПатчу123'), 'обновлённый снимок сохранён');
  });

  test('узел с совпадающим путём без дочерних тегов (константа) — не владелец: кэш пересобирается целиком', () => {
    const constantXml = path.join(cfDir, 'Constants', 'ИспользоватьВозвраты.xml');
    const cached = loadMetadataCache(root, scopeKeyOf(entry));
    assert.ok(cached && findCacheNode(cached.root, (node) => node.type === 'Constant' && node.xmlPath === constantXml), 'фикстура: константа есть в кэше');

    const result = updateMetadataCacheAfterAdd(root, entry, { kind: 'child', ownerObjectXmlPath: constantXml, childTag: 'Attribute' }, 'Любое');

    assert.strictEqual(result.updatedPartially, false);
  });

  test('путь владельца в другом регистре на регистрозависимой ФС — другой файл: владелец не найден', function () {
    skipOnCaseInsensitiveFs(this);
    const ownerXml = path.join(cfDir, 'Catalogs', 'Контрагенты.xml');

    const result = updateMetadataCacheAfterAdd(
      root,
      entry,
      { kind: 'child', ownerObjectXmlPath: upperCaseBasename(ownerXml), childTag: 'Attribute' },
      'Любое'
    );

    assert.strictEqual(result.updatedPartially, false, 'прежний ключ toLowerCase() склеил бы пути и обновил чужой узел');
    assert.ok(ownerNodeOf(result.snapshot.root, ownerXml), 'полная пересборка сохраняет настоящего владельца');
  });
});

type BorrowWindowStubs = Pick<typeof vscode.window, 'showWarningMessage' | 'showInformationMessage'>;

suite('BorrowToExtensionCommand — сравнение корней и узлов по pathKey (#123)', () => {
  const windowRef = vscode.window as BorrowWindowStubs;
  let originals: BorrowWindowStubs | undefined;
  let warnings: string[];
  let infos: string[];
  let root: string | undefined;

  setup(function () {
    skipWithoutCorpus(this, EXAMPLE_GENERATIONS.cf21, EXAMPLE_GENERATIONS.cfe21);
    warnings = [];
    infos = [];
    originals = {
      showWarningMessage: vscode.window.showWarningMessage,
      showInformationMessage: vscode.window.showInformationMessage,
    };
    windowRef.showWarningMessage = ((message: string) => {
      warnings.push(message);
      return Promise.resolve(undefined);
    });
    windowRef.showInformationMessage = ((message: string) => {
      infos.push(message);
      return Promise.resolve(undefined);
    });
  });

  teardown(() => {
    if (originals) {
      // setup мог пропустить тест без корпуса до подмены окна.
      windowRef.showWarningMessage = originals.showWarningMessage;
      windowRef.showInformationMessage = originals.showInformationMessage;
    }
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  interface BorrowHarness {
    readonly services: CommandServices;
    readonly log: string[];
    readonly revealCalls: ((node: MetadataNode) => boolean)[];
  }

  /**
   * Сервисы, которые команда трогает на пути заимствования: реальный `CfeBorrowService` поверх
   * временной копии; дерево — источник записей и приёмник снимка кэша (сам виджет тесту не нужен);
   * `revealTreeNode` сохраняет предикат, чтобы проверить, какой узел команда считает заимствованным.
   */
  function createHarness(workspaceRoot: string, entries: ConfigEntry[], revealNode: MetadataNode | undefined): BorrowHarness {
    const log: string[] = [];
    const revealCalls: ((node: MetadataNode) => boolean)[] = [];
    const services = {
      workspaceFolder: workspaceFolderOf(workspaceRoot),
      outputChannel: createOutputChannel(log),
      cfeBorrowService: new CfeBorrowService(),
      treeProvider: {
        getEntries: () => entries,
        applyCacheSnapshot: () => true,
        refresh: () => undefined,
      },
      suppressConfigurationReloadForFiles: () => undefined,
      markChangedConfigurationByFiles: () => undefined,
      reloadEntries: () => Promise.resolve(),
      revealTreeNode: (predicate: (node: MetadataNode) => boolean) => {
        revealCalls.push(predicate);
        return Promise.resolve(revealNode ? predicate(revealNode) : false);
      },
    } as unknown as CommandServices;
    return { services, log, revealCalls };
  }

  function catalogNode(xmlPath: string, name: string): MetadataNode {
    return new MetadataNode({ label: name, nodeKind: 'Catalog', xmlPath }, vscode.TreeItemCollapsibleState.None);
  }

  test('источник — само расширение: заимствование отклоняется', async () => {
    const corpus = copyCorpus('onecdev-borrow-source-', true);
    root = corpus.root;
    const node = catalogNode(path.join(corpus.extDir, 'Catalogs', 'Контрагенты.xml'), 'Контрагенты');
    const harness = createHarness(root, [
      { rootPath: corpus.cfDir, kind: 'cf' },
      { rootPath: corpus.extDir, kind: 'cfe' },
    ], undefined);

    await borrowToExtension(node, harness.services);

    assert.deepStrictEqual(warnings, ['Нельзя заимствовать объекты из другого расширения.']);
    assert.deepStrictEqual(harness.revealCalls, []);
  });

  test('заимствованный справочник находится в дереве по пути объекта в расширении', async () => {
    const corpus = copyCorpus('onecdev-borrow-reveal-', true);
    root = corpus.root;
    const borrowedXml = path.join(corpus.extDir, 'Catalogs', 'Банки.xml');
    assert.ok(!fs.existsSync(borrowedXml), 'фикстура: Банки ещё не заимствованы');
    const harness = createHarness(root, [
      { rootPath: corpus.cfDir, kind: 'cf' },
      { rootPath: corpus.extDir, kind: 'cfe' },
    ], catalogNode(borrowedXml, 'Банки'));

    await borrowToExtension(catalogNode(path.join(corpus.cfDir, 'Catalogs', 'Банки.xml'), 'Банки'), harness.services);

    assert.ok(fs.existsSync(borrowedXml), 'объект заимствован в расширение');
    assert.deepStrictEqual(infos, ['Объект "Catalog.Банки" успешно добавлен в расширение.']);
    assert.strictEqual(harness.revealCalls.length, 1);
    assert.ok(!harness.log.some((line) => line.includes('Не удалось найти заимствованный узел')), harness.log.join('\n'));
  });

  test('узел, путь которого отличается регистром, на регистрозависимой ФС — не заимствованный объект', async function () {
    skipOnCaseInsensitiveFs(this);
    const corpus = copyCorpus('onecdev-borrow-reveal-case-', true);
    root = corpus.root;
    const borrowedXml = path.join(corpus.extDir, 'Catalogs', 'Банки.xml');
    const harness = createHarness(root, [
      { rootPath: corpus.cfDir, kind: 'cf' },
      { rootPath: corpus.extDir, kind: 'cfe' },
    ], catalogNode(upperCaseBasename(borrowedXml), 'Банки'));

    await borrowToExtension(catalogNode(path.join(corpus.cfDir, 'Catalogs', 'Банки.xml'), 'Банки'), harness.services);

    assert.ok(fs.existsSync(borrowedXml));
    assert.ok(
      harness.log.includes('[borrow][warn] Не удалось найти заимствованный узел в дереве: Catalog.Банки'),
      harness.log.join('\n')
    );
  });
});

suite('RemoveMetadataCommand — пересборка кэша записи после удаления (#123)', () => {
  const windowRef = vscode.window as Pick<typeof vscode.window, 'showQuickPick' | 'showErrorMessage' | 'showInformationMessage'>;
  let originals: Pick<typeof vscode.window, 'showQuickPick' | 'showErrorMessage' | 'showInformationMessage'> | undefined;
  let errors: string[];
  let root: string | undefined;

  setup(function () {
    skipWithoutCorpus(this, EXAMPLE_GENERATIONS.cf21);
    errors = [];
    originals = {
      showQuickPick: vscode.window.showQuickPick,
      showErrorMessage: vscode.window.showErrorMessage,
      showInformationMessage: vscode.window.showInformationMessage,
    };
    // Подтверждение удаления — выбор пункта «Удалить», как сделал бы пользователь.
    windowRef.showQuickPick = (() => Promise.resolve({ label: 'Удалить' })) as unknown as typeof vscode.window.showQuickPick;
    windowRef.showErrorMessage = ((message: string) => {
      errors.push(message);
      return Promise.resolve(undefined);
    });
    windowRef.showInformationMessage = (() => Promise.resolve(undefined));
  });

  teardown(() => {
    if (originals) {
      // setup мог пропустить тест без корпуса до подмены окна.
      windowRef.showQuickPick = originals.showQuickPick;
      windowRef.showErrorMessage = originals.showErrorMessage;
      windowRef.showInformationMessage = originals.showInformationMessage;
    }
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  /** Без поддержки и привязки к хранилищу удаление не запрещено; UI-адресаты post-mutation пути — пустые приёмники. */
  function createServices(workspaceRoot: string, entries: ConfigEntry[]): CommandServices {
    return {
      workspaceFolder: workspaceFolderOf(workspaceRoot),
      outputChannel: createOutputChannel([]),
      repositoryService: new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot)),
      metadataXmlRemover: new MetadataXmlRemover(),
      treeProvider: { getEntries: () => entries, refresh: () => undefined },
      suppressConfigurationReloadForFiles: () => undefined,
      markChangedConfigurationByFiles: () => undefined,
      dynamicPanelController: { handleMetadataRemoved: () => undefined },
      subsystemEditorViewProvider: { handleMetadataRemoved: () => undefined },
      refreshActionsView: () => undefined,
    } as unknown as CommandServices;
  }

  function removalNode(cfDir: string): MetadataNode {
    return new MetadataNode(
      {
        label: 'КолонкиКалендарейСотрудников',
        nodeKind: 'Catalog',
        xmlPath: path.join(cfDir, 'Catalogs', 'КолонкиКалендарейСотрудников.xml'),
        canRemoveMetadata: true,
      },
      vscode.TreeItemCollapsibleState.None
    );
  }

  test('удалённый справочник пропадает из сохранённого кэша записи', async () => {
    const corpus = copyCorpus('onecdev-remove-cache-', false);
    root = corpus.root;
    const entry: ConfigEntry = { rootPath: corpus.cfDir, kind: 'cf' };

    await removeMetadata(removalNode(corpus.cfDir), createServices(root, [entry]));

    assert.deepStrictEqual(errors, []);
    assert.ok(!fs.existsSync(path.join(corpus.cfDir, 'Catalogs', 'КолонкиКалендарейСотрудников.xml')));
    const cached = loadMetadataCache(root, scopeKeyOf(entry));
    assert.ok(cached, 'кэш записи пересобран и сохранён после удаления');
    assert.ok(findCacheNode(cached.root, (node) => node.type === 'Catalog' && node.name === 'Контрагенты'), 'остальные объекты в кэше');
    assert.strictEqual(findCacheNode(cached.root, (node) => node.name === 'КолонкиКалендарейСотрудников'), undefined);
  });

  test('запись с корнем в другом регистре на регистрозависимой ФС — чужая выгрузка: кэш не пишется', async function () {
    skipOnCaseInsensitiveFs(this);
    const corpus = copyCorpus('onecdev-remove-cache-case-', false);
    root = corpus.root;
    const foreignEntry: ConfigEntry = { rootPath: upperCaseBasename(corpus.cfDir), kind: 'cf' };

    await removeMetadata(removalNode(corpus.cfDir), createServices(root, [foreignEntry]));

    assert.deepStrictEqual(errors, []);
    assert.ok(!fs.existsSync(path.join(corpus.cfDir, 'Catalogs', 'КолонкиКалендарейСотрудников.xml')), 'удаление выполнено');
    assert.ok(!fs.existsSync(path.join(root, '.onecdev', 'meta')), 'кэш чужой записи не создаётся');
  });
});

suite('ExtensionCommandRunner — ключ кэша сервиса агента по pathKey (#123)', () => {
  test('ключ совпадает с pathKey текущей платформы; на регистрозависимой ФС регистр различается', () => {
    const workspaceRoot = path.join(os.tmpdir(), 'Проект', 'Src');
    assert.strictEqual(getAgentServiceCacheKey(workspaceRoot), pathKey(workspaceRoot));
    assert.strictEqual(
      getAgentServiceCacheKey(workspaceRoot) === getAgentServiceCacheKey(upperCaseBasename(workspaceRoot)),
      !CASE_SENSITIVE_FS
    );
  });

  test('без env.json агент не найден: предупреждение в журнал, неудачный старт не оседает в кэше', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-agent-key-'));
    const workspaceRoot = path.join(parent, 'workspace');
    fs.mkdirSync(workspaceRoot);
    try {
      const log: string[] = [];
      const folder = workspaceFolderOf(workspaceRoot);

      const result = await getAgentOperationServiceForInteractiveDesigner(folder, createOutputChannel(log));

      assert.strictEqual(result, undefined);
      assert.ok(log.some((line) => line.startsWith('[agent][warn]') && line.includes('Не найден env.json')), log.join('\n'));
      assert.strictEqual(getCachedAgentOperationService(folder), undefined);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

suite('DynamicPanelController — сброс свойств удалённого объекта по pathKey (#123)', () => {
  const configRoot = EXAMPLE_GENERATIONS.cf21;
  let controller: DynamicPanelController | undefined;
  let clearedProperties: number;

  setup(() => {
    clearedProperties = 0;
    // Проверка вложенности пути не обращается к свойствам; от контроллера свойств нужен
    // только сброс активного узла — по нему и видно, что панель очищена.
    const propertiesController = {
      setActiveNode: () => undefined,
      clearActiveNode: () => {
        clearedProperties++;
      },
      getViewState: () => undefined,
    } as unknown as PropertiesViewController;
    controller = new DynamicPanelController(propertiesController);
  });

  teardown(() => {
    controller?.dispose();
    controller = undefined;
  });

  function formNode(objectDirName: string): MetadataNode {
    return new MetadataNode(
      { label: 'ФормаЭлемента', nodeKind: 'Form', xmlPath: path.join(configRoot, 'Catalogs', objectDirName, 'Forms', 'ФормаЭлемента.xml') },
      vscode.TreeItemCollapsibleState.None
    );
  }

  const removedCatalog = (): MetadataNode => new MetadataNode(
    { label: 'Контрагенты', nodeKind: 'Catalog', xmlPath: path.join(configRoot, 'Catalogs', 'Контрагенты.xml'), canRemoveMetadata: true },
    vscode.TreeItemCollapsibleState.None
  );

  test('форма внутри каталога удалённого справочника — свойства сбрасываются', () => {
    assert.ok(controller);
    controller.replaceActiveNode(formNode('Контрагенты'));

    controller.handleMetadataRemoved(removedCatalog());

    assert.strictEqual(controller.getActiveNode(), undefined);
    assert.strictEqual(clearedProperties, 1);
  });

  test('каталог, отличающийся регистром, на регистрозависимой ФС — другой объект: свойства остаются', function () {
    skipOnCaseInsensitiveFs(this);
    assert.ok(controller);
    const foreign = formNode('КОНТРАГЕНТЫ');
    controller.replaceActiveNode(foreign);

    controller.handleMetadataRemoved(removedCatalog());

    assert.strictEqual(controller.getActiveNode(), foreign);
    assert.strictEqual(clearedProperties, 0);
  });
});
