import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as vscode from 'vscode';
import { EXTENSION_MCP_TOOLS } from '../../infra/ai/AiMcpConfiguration';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { parseCrsAddress } from '../../infra/repository/crs/CrsAddress';
import { CrsClient } from '../../infra/repository/crs/CrsClient';
import { RepositoryHistoryService } from '../../infra/repository/history/RepositoryHistoryService';
import type { RepositoryHistorySessionResolution } from '../../infra/repository/history/RepositoryHistorySession';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { McpMetadataPathService } from '../../ui/mcp/McpMetadataPathService';
import { McpMutationGate } from '../../ui/mcp/registration/McpMutationGate';
import type { McpCommandServices, McpRegistrationDeps } from '../../ui/mcp/registration/McpRegistrationDeps';
import { registerRepositoryTools } from '../../ui/mcp/registration/McpRepositoryTools';
import { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import { tcpBodyProbe } from './support/crsFixtures';
import { assertNoHashes, inputsOf, STAND_VERSION } from './support/crsMethods';
import { RecordedTransport } from './support/crsRecordedTransport';

/**
 * MCP-инструмент onecdev_repository_history (#117): канонический путь → область истории → страница
 * истории без секретов. Настоящие дерево навигатора и McpMetadataPathService над копиями
 * example/2.21/src/cf и EVOLC, настоящие RepositoryService и RepositoryHistoryService; подменены лишь
 * разрешение сессии (нужны привязка и пароль из SecretStorage живого хранилища) и транспорт crs — он
 * отдаёт настоящие тела ответов crserver 8.5.1 (пробы стенда). Ожидаемые uuid — из ConfigDumpInfo.xml
 * копии, независимо от production-кода.
 */

const ROOT = path.resolve(__dirname, '../../../');
const EXAMPLE_CF = path.join(ROOT, 'example', '2.21', 'src', 'cf');
const EXAMPLE_EVOLC = path.join(ROOT, 'example', '2.21', 'src', 'cfe', 'EVOLC');
const TOOL = 'onecdev_repository_history';

const AUTH = { user: 'Admin', passwordHash: 'd41d8cd98f00b204e9800998ecf8427e' };
const LIST_ALL = tcpBodyProbe('probe-history-devdepotversions');
const LIST_UNKNOWN = tcpBodyProbe('probe-history-devdepotversions-object-unknown');
const PAGE_1_7 = tcpBodyProbe('probe-history-page-1-7');
const PAGE_2_4 = tcpBodyProbe('probe-history-page-2-4');
const PAGE_5_7 = tcpBodyProbe('probe-history-page-5-7');
const WRONG_PASSWORD = tcpBodyProbe('probe-history-wrong-password');
const USERS = tcpBodyProbe('probe-depot-users-no-bind').response;
const ALL_BODIES = [LIST_ALL, LIST_UNKNOWN, PAGE_1_7, PAGE_2_4, PAGE_5_7, WRONG_PASSWORD].flatMap((p) => [p.request, p.response]);

function secrets(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

function dumpInfoId(root: string, name: string): string {
  const text = fs.readFileSync(path.join(root, 'ConfigDumpInfo.xml'), 'utf-8');
  const match = new RegExp(`<Metadata name="${name.replace(/\./g, '\\.')}" id="([0-9a-f-]{36})"`).exec(text);
  assert.ok(match, `${name} нет в ConfigDumpInfo.xml`);
  return match[1];
}

interface ToolOutput {
  readonly target: string;
  readonly object?: { readonly objectId: string; readonly title: string };
  readonly total: number;
  readonly versions: readonly {
    readonly number: number;
    readonly author: string;
    readonly date: string;
    readonly comment: string;
    readonly label?: { readonly name: string; readonly comment: string; readonly author: string; readonly date: string };
    readonly configVersion: string;
    readonly changes: readonly { readonly objectId: string; readonly title: string; readonly kind: string }[];
    readonly changesTruncated: boolean;
  }[];
  readonly nextBeforeVersion?: number;
}

function textOf(result: CallToolResult): string {
  const part = result.content[0];
  return part.type === 'text' ? part.text : '';
}

/** Ответ инструмента без секретов: ни хеша пароля из тел обмена, ни 40-hex хеша версии. */
function assertClean(text: string): void {
  assertNoHashes(text, ...ALL_BODIES);
  assert.ok(!/[0-9a-f]{40}/i.test(text), `в ответе 40-hex хеш: ${text}`);
}

suite('McpRepositoryTools — onecdev_repository_history (#117)', () => {
  let workspaceRoot: string;
  let cacheRoot: string;
  let cf: string;
  let cfe: string;
  let treeProvider: MetadataTreeProvider;
  let paths: McpMetadataPathService;
  let repositoryService: RepositoryService;
  let history: RepositoryHistoryService;
  let handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
  let registered: { name: string; title: string; description: string; inputSchema: unknown }[];
  /** Исходы транспорта следующего клиента; каждый созданный клиент забирает очередь целиком. */
  let outcomes: Buffer[];
  let transports: RecordedTransport[];
  let resolved: RepositoryTarget[];
  let resolution: (target: RepositoryTarget) => RepositoryHistorySessionResolution;

  suiteSetup(() => {
    workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-mcp-history-')));
    cf = path.join(workspaceRoot, 'src', 'cf');
    cfe = path.join(workspaceRoot, 'src', 'cfe', 'EVOLC');
    fs.cpSync(EXAMPLE_CF, cf, { recursive: true });
    fs.cpSync(EXAMPLE_EVOLC, cfe, { recursive: true });
    // Объект без uuid в корне XML: история по нему не определяется.
    const goods = path.join(cf, 'Catalogs', 'Товары.xml');
    const text = fs.readFileSync(goods, 'utf-8');
    const stripped = text.replace(/<Catalog uuid="[^"]*"/, '<Catalog');
    assert.notStrictEqual(stripped, text);
    fs.writeFileSync(goods, stripped, 'utf-8');
    cacheRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-mcp-history-cache-')));
    treeProvider = new MetadataTreeProvider([{ rootPath: cf, kind: 'cf' }, { rootPath: cfe, kind: 'cfe' }], vscode.Uri.file(ROOT), cacheRoot);
    paths = new McpMetadataPathService(treeProvider);
  });
  suiteTeardown(() => {
    treeProvider.dispose();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  function register(repository: RepositoryService): void {
    const services = { repositoryService: repository, repositoryHistoryService: history } as unknown as McpCommandServices;
    const handlers = new Map<string, (args: Record<string, unknown>) => unknown>();
    registered = [];
    const server = {
      registerTool: (name: string, config: { title: string; description: string; inputSchema: unknown }, h: (args: Record<string, unknown>) => unknown) => {
        registered.push({ name, ...config });
        handlers.set(name, h);
      },
    };
    // Инструмент читает из deps только paths/services/gate: xmlEditor/properties/mutations
    // нужны мутирующим доменам и здесь намеренно не создаются.
    registerRepositoryTools(server as never, { services, paths, gate: new McpMutationGate(services) } as unknown as McpRegistrationDeps);
    const h = handlers.get(TOOL);
    assert.ok(h, `${TOOL} не зарегистрирован`);
    handler = async (args) => await Promise.resolve(h(args)) as CallToolResult;
  }

  setup(() => {
    outcomes = [];
    transports = [];
    resolved = [];
    resolution = (target) => ({
      kind: 'session',
      session: {
        key: `${target.configRoot}|tcp://127.0.0.1:1542/exp|Admin`,
        target,
        address: parseCrsAddress('tcp://127.0.0.1:1542/exp'),
        auth: AUTH,
        versionHint: STAND_VERSION,
      },
    });
    history = new RepositoryHistoryService({
      resolveSession: (target) => {
        resolved.push(target);
        return Promise.resolve(resolution(target));
      },
      createClient: (address, options) => {
        const transport = new RecordedTransport(outcomes.splice(0));
        transports.push(transport);
        return new CrsClient(transport, { alias: address.alias, version: options.version });
      },
      // Размер страницы сервиса намеренно отличается от размера по умолчанию у инструмента (20):
      // так видно, что инструмент передаёт свой размер, а не полагается на сервис.
      pageSize: 3,
      onError: (error) => assert.fail(String(error)),
    });
    repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(secrets(), workspaceRoot));
    register(repositoryService);
  });
  teardown(() => {
    history.dispose();
  });

  async function ok(args: Record<string, unknown>): Promise<ToolOutput> {
    const result = await handler(args);
    const text = textOf(result);
    assert.notStrictEqual(result.isError, true, text);
    assertClean(text);
    return JSON.parse(text) as ToolOutput;
  }

  async function failed(args: Record<string, unknown>): Promise<string> {
    const result = await handler(args);
    const text = textOf(result);
    assert.strictEqual(result.isError, true, text);
    assertClean(text);
    return text;
  }

  function displayName(root: string): string {
    const target = repositoryService.resolveTargetByConfigRoot(root);
    assert.ok(target);
    return target.displayName;
  }

  test('регистрация: один инструмент, схема path/configuration/limit/beforeVersion/maxChangesPerVersion, есть в EXTENSION_MCP_TOOLS', () => {
    assert.deepStrictEqual(registered.map((t) => t.name), [TOOL]);
    const shape = (registered[0].inputSchema as { shape: Record<string, { def?: { type?: string } }> }).shape;
    assert.deepStrictEqual(
      Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, field.def?.type === 'optional'])),
      { path: false, configuration: true, limit: true, beforeVersion: true, maxChangesPerVersion: true },
    );
    const entry = EXTENSION_MCP_TOOLS.find((tool) => tool.name === TOOL);
    assert.ok(entry, `${TOOL} отсутствует в EXTENSION_MCP_TOOLS`);
    assert.strictEqual(entry.profile, 'extension');
  });

  test('Конфигурация без limit — вся история цели, 20 версий на страницу: 7…1 одной страницей, метки', async () => {
    outcomes.push(LIST_ALL.response, PAGE_1_7.response, USERS);
    const output = await ok({ path: 'Конфигурация', configuration: cf });
    const sent = transports[0].requests.map((r) => inputsOf(r.body));
    assert.deepStrictEqual(sent[0].objRefs, []);
    assert.strictEqual(sent[1].params.get('beginVerNum'), '1');
    assert.strictEqual(sent[1].params.get('endVerNum'), '7');
    assert.deepStrictEqual(resolved.map((t) => t.configRoot), [cf]);

    assert.strictEqual(output.target, displayName(cf));
    assert.ok(!('object' in output));
    assert.ok(!('nextBeforeVersion' in output));
    assert.strictEqual(output.total, 7);
    assert.deepStrictEqual(output.versions.map((v) => v.number), [7, 6, 5, 4, 3, 2, 1]);

    // Независимый эталон — тот же запрос через сервис без инструмента: инструмент лишь проецирует модель.
    outcomes.push(LIST_ALL.response, PAGE_1_7.response, USERS);
    const target = repositoryService.resolveTargetByConfigRoot(cf);
    assert.ok(target);
    const direct = await history.query({ target, pageSize: 20 });
    assert.strictEqual(direct.kind, 'ok');
    const labelled = direct.history.versions.filter((v) => v.label !== undefined);
    assert.ok(labelled.length > 0 && labelled.length < direct.history.versions.length, 'в выборке нужны версии с меткой и без');
    assert.deepStrictEqual(output.versions, direct.history.versions.map((v) => ({
      number: v.verNum,
      author: v.author,
      date: v.date,
      comment: v.comment,
      ...(v.label === undefined ? {} : { label: { name: v.label.name, comment: v.label.comment, author: v.label.author, date: v.label.date } }),
      configVersion: v.configVersion,
      changes: v.changes.map((c) => ({ objectId: c.objectId, title: c.title, kind: c.kind })),
      changesTruncated: false,
    })));
  });

  test('limit и beforeVersion — страница 4…2, nextBeforeVersion для следующей; Расширение — своя цель', async () => {
    outcomes.push(LIST_ALL.response, PAGE_2_4.response, USERS);
    const output = await ok({ path: 'Расширение', configuration: cfe, limit: 3, beforeVersion: 5 });
    assert.deepStrictEqual(resolved.map((t) => t.configRoot), [cfe]);
    assert.strictEqual(output.target, displayName(cfe));
    assert.deepStrictEqual(output.versions.map((v) => v.number), [4, 3, 2]);
    assert.strictEqual(output.total, 4);
    assert.strictEqual(output.nextBeforeVersion, 2);
    assert.deepStrictEqual(transports[0].requests.map((r) => inputsOf(r.body).params.get('endVerNum')).slice(1, 2), ['4']);
  });

  test('первая страница с limit — nextBeforeVersion = младшая загруженная версия', async () => {
    outcomes.push(LIST_ALL.response, PAGE_5_7.response, USERS);
    const output = await ok({ path: 'Конфигурация', configuration: cf, limit: 3 });
    assert.deepStrictEqual(output.versions.map((v) => v.number), [7, 6, 5]);
    assert.ok(output.versions.every((v) => !('label' in v)));
    assert.strictEqual(output.total, 7);
    assert.strictEqual(output.nextBeforeVersion, 5);
  });

  test('maxChangesPerVersion: усечение списка изменений и признак changesTruncated; по умолчанию 100', async () => {
    outcomes.push(LIST_ALL.response, PAGE_1_7.response, USERS);
    const full = await ok({ path: 'Конфигурация', configuration: cf, maxChangesPerVersion: 1000 });
    outcomes.push(LIST_ALL.response, PAGE_1_7.response, USERS);
    const byDefault = await ok({ path: 'Конфигурация', configuration: cf });
    outcomes.push(LIST_ALL.response, PAGE_1_7.response, USERS);
    const one = await ok({ path: 'Конфигурация', configuration: cf, maxChangesPerVersion: 1 });
    outcomes.push(LIST_ALL.response, PAGE_1_7.response, USERS);
    const none = await ok({ path: 'Конфигурация', configuration: cf, maxChangesPerVersion: 0 });

    assert.ok(full.versions.some((v) => v.changes.length > 1), 'нужна версия с несколькими изменениями');
    assert.ok(full.versions.every((v) => v.changes.length <= 100 && !v.changesTruncated));
    assert.deepStrictEqual(byDefault, full);
    assert.deepStrictEqual(one.versions.map((v) => [v.changes, v.changesTruncated]), full.versions.map((v) => [v.changes.slice(0, 1), v.changes.length > 1]));
    assert.deepStrictEqual(none.versions.map((v) => [v.changes, v.changesTruncated]), full.versions.map((v) => [[], v.changes.length > 0]));
  });

  const objects: readonly [string, () => string, string, string][] = [
    ['справочник', () => cf, 'Справочники.Контрагенты', 'Catalog.Контрагенты'],
    ['форма — uuid дескриптора', () => cf, 'Справочники.Контрагенты.Форма.ФормаЭлемента', 'Catalog.Контрагенты.Form.ФормаЭлемента'],
    ['макет', () => cf, 'Справочники.Контрагенты.Макет.ЗагрузкаИзФайла', 'Catalog.Контрагенты.Template.ЗагрузкаИзФайла'],
    ['общая форма', () => cf, 'ОбщиеФормы.АЛКОВводРеквизитовОП', 'CommonForm.АЛКОВводРеквизитовОП'],
    ['вложенная подсистема', () => cf, 'Подсистема.Продажи.Розница', 'Subsystem.Продажи.Subsystem.Розница'],
    ['заимствованный справочник EVOLC', () => cfe, 'Справочники.Контрагенты', 'Catalog.Контрагенты'],
  ];
  for (const [name, root, canonical, dumpName] of objects) {
    test(`${name}: ${canonical} — фильтр по uuid XML копии с подчинёнными; неизвестный серверу объект — пустая история`, async () => {
      outcomes.push(LIST_UNKNOWN.response);
      const output = await ok({ path: canonical, configuration: root() });
      const expectedId = dumpInfoId(root(), dumpName);
      assert.strictEqual(transports[0].requests.length, 1);
      const sent = inputsOf(transports[0].requests[0].body);
      assert.deepStrictEqual(sent.objRefs, [expectedId]);
      assert.strictEqual(sent.params.get('recursive'), 'true');
      assert.strictEqual(sent.params.get('mask'), '4');
      assert.strictEqual(output.target, displayName(root()));
      assert.strictEqual(output.object?.objectId, expectedId);
      assert.ok(output.object.title.length > 0);
      assert.deepStrictEqual(output.versions, []);
      assert.strictEqual(output.total, 0);
      assert.ok(!('nextBeforeVersion' in output));
    });
  }

  test('заголовок объекта — полное имя единицы хранилища', async () => {
    outcomes.push(LIST_UNKNOWN.response);
    const output = await ok({ path: 'Справочники.Контрагенты.Форма.ФормаЭлемента', configuration: cf });
    assert.strictEqual(output.object?.title, 'Справочник.Контрагенты.Форма.ФормаЭлемента');
  });

  for (const canonical of ['Справочники.Контрагенты.ИНН', 'Справочники.Контрагенты.КонтактныеЛица']) {
    test(`${canonical}: история хранится по объекту-владельцу — ошибка с подсказкой, без сети`, async () => {
      const text = await failed({ path: canonical, configuration: cf });
      assert.ok(text.includes('по объекту-владельцу'), text);
      assert.ok(text.includes('Справочники.Контрагенты'), text);
      assert.deepStrictEqual(resolved, []);
      assert.deepStrictEqual(transports, []);
    });
  }

  for (const canonical of ['Catalog.Контрагенты', 'Catalogs.Контрагенты', 'Справочник.Контрагенты']) {
    test(`неканонический путь ${canonical} отбивается, без сети`, async () => {
      const text = await failed({ path: canonical, configuration: cf });
      assert.ok(text.includes('неизвестный корневой сегмент'), text);
      assert.deepStrictEqual(resolved, []);
    });
  }

  test('объект без uuid в XML — ошибка с полным именем, без сети', async () => {
    const text = await failed({ path: 'Справочники.Товары', configuration: cf });
    assert.ok(text.includes('Справочник.Товары'), text);
    assert.deepStrictEqual(resolved, []);
  });

  test('выгрузка вне рабочей области хранилища — ошибка цели, без сети', async () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-mcp-history-other-')));
    try {
      register(new RepositoryService(elsewhere, new ProjectSecretStorage(secrets(), elsewhere)));
      const text = await failed({ path: 'Конфигурация', configuration: cf });
      assert.ok(text.includes('Не удалось определить конфигурацию'), text);
      assert.deepStrictEqual(resolved, []);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  const refusals: readonly [string, RepositoryHistorySessionResolution, RegExp][] = [
    ['не подключено', { kind: 'disconnected' }, /не подключен/],
    ['файловое хранилище — подсказка про отчёт Конфигуратора', { kind: 'file-repository' }, /отчёт.*Конфигуратор/],
    ['неверный адрес', { kind: 'failed', failure: { code: 'invalid-address', message: 'Неверный адрес хранилища.' } }, /^Неверный адрес хранилища\.$/],
  ];
  for (const [name, refused, pattern] of refusals) {
    test(`${name} — ошибка инструмента без сетевых вызовов`, async () => {
      resolution = () => refused;
      const text = await failed({ path: 'Конфигурация', configuration: cf });
      assert.match(text, pattern);
      assert.deepStrictEqual(transports, []);
    });
  }

  test('отказ сервера (неверный пароль) — ошибка инструмента без хеша пароля', async () => {
    outcomes.push(WRONG_PASSWORD.response);
    const text = await failed({ path: 'Конфигурация', configuration: cf });
    assert.ok(text.length > 0);
    assertNoHashes(text, WRONG_PASSWORD.request, WRONG_PASSWORD.response, transports[0].requests[0].body);
  });
});
