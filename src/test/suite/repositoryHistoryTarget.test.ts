import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { canShowRepositoryHistory, resolveRepositoryHistoryTarget } from '../../infra/repository/history/RepositoryHistoryTarget';
import { RepositoryService, type RepositoryNodeRef } from '../../infra/repository/RepositoryService';

/**
 * Цель истории хранилища по узлу дерева (#117): корень — вся история, объект — история единицы
 * хранилища с фильтром по uuid её собственного XML (для формы и макета — дескриптор, а не владелец).
 * Узлы — как их строит дерево; выгрузки — копии example/2.21/src/cf и EVOLC. Ожидаемый uuid —
 * из ConfigDumpInfo.xml копии, независимо от production-кода.
 */

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const EXAMPLE_EVOLC = path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC');

type Root = 'cf' | 'cfe';

interface Harness {
  readonly workspaceRoot: string;
  readonly roots: Record<Root, string>;
  readonly service: RepositoryService;
}

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

const at = (h: Harness, root: Root, rel: string): string => path.join(h.roots[root], rel);

function childNode(h: Harness, nodeKind: string, label: string | undefined, ownerRel: string, root: Root = 'cf'): RepositoryNodeRef {
  const owner = at(h, root, ownerRel);
  return { nodeKind, ...(label === undefined ? {} : { label }), xmlPath: owner, metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: owner } };
}

suite('RepositoryHistoryTarget (#117)', () => {
  let h: Harness;

  setup(() => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-history-target-'));
    const roots: Record<Root, string> = { cf: path.join(workspaceRoot, 'src', 'cf'), cfe: path.join(workspaceRoot, 'src', 'cfe', 'EVOLC') };
    fs.cpSync(EXAMPLE_CF, roots.cf, { recursive: true });
    fs.cpSync(EXAMPLE_EVOLC, roots.cfe, { recursive: true });
    h = { workspaceRoot, roots, service: new RepositoryService(workspaceRoot, new ProjectSecretStorage(secrets(), workspaceRoot)) };
  });
  teardown(() => {
    fs.rmSync(h.workspaceRoot, { recursive: true, force: true });
  });

  const roots: readonly [string, Root, 'cf' | 'cfe'][] = [['configuration', 'cf', 'cf'], ['extension', 'cfe', 'cfe']];
  for (const [nodeKind, root, configKind] of roots) {
    test(`корень ${nodeKind} — вся история цели без фильтра`, () => {
      const result = resolveRepositoryHistoryTarget(h.service, { nodeKind, xmlPath: at(h, root, 'Configuration.xml') });
      assert.strictEqual(result.kind, 'root');
      assert.strictEqual(result.scope.target.configRoot, h.roots[root]);
      assert.strictEqual(result.scope.target.configKind, configKind);
      assert.strictEqual(result.scope.filter, undefined);
    });
  }

  const objects: readonly { readonly name: string; readonly root: Root; readonly node: (h: Harness) => RepositoryNodeRef; readonly dumpName: string; readonly title: string }[] = [
    { name: 'справочник', root: 'cf', node: (x) => ({ nodeKind: 'Catalog', label: 'Контрагенты', xmlPath: at(x, 'cf', 'Catalogs/Контрагенты.xml') }), dumpName: 'Catalog.Контрагенты', title: 'Справочник.Контрагенты' },
    { name: 'форма справочника', root: 'cf', node: (x) => childNode(x, 'Form', 'ФормаЭлемента', 'Catalogs/Контрагенты.xml'), dumpName: 'Catalog.Контрагенты.Form.ФормаЭлемента', title: 'Справочник.Контрагенты.Форма.ФормаЭлемента' },
    { name: 'макет справочника', root: 'cf', node: (x) => childNode(x, 'Template', 'ЗагрузкаИзФайла', 'Catalogs/Контрагенты.xml'), dumpName: 'Catalog.Контрагенты.Template.ЗагрузкаИзФайла', title: 'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла' },
    { name: 'общая форма', root: 'cf', node: (x) => ({ nodeKind: 'CommonForm', label: 'АЛКОВводРеквизитовОП', xmlPath: at(x, 'cf', 'CommonForms/АЛКОВводРеквизитовОП.xml') }), dumpName: 'CommonForm.АЛКОВводРеквизитовОП', title: 'ОбщаяФорма.АЛКОВводРеквизитовОП' },
    { name: 'общий макет', root: 'cf', node: (x) => ({ nodeKind: 'CommonTemplate', label: 'Макет', xmlPath: at(x, 'cf', 'CommonTemplates/Макет.xml') }), dumpName: 'CommonTemplate.Макет', title: 'ОбщийМакет.Макет' },
    { name: 'вложенная подсистема', root: 'cf', node: (x) => ({ nodeKind: 'Subsystem', label: 'Розница', xmlPath: at(x, 'cf', 'Subsystems/Продажи/Subsystems/Розница.xml') }), dumpName: 'Subsystem.Продажи.Subsystem.Розница', title: 'Подсистема.Продажи.Подсистема.Розница' },
    { name: 'EVOLC: заимствованный справочник', root: 'cfe', node: (x) => ({ nodeKind: 'Catalog', label: 'Контрагенты', xmlPath: at(x, 'cfe', 'Catalogs/Контрагенты.xml') }), dumpName: 'Catalog.Контрагенты', title: 'Справочник.Контрагенты' },
    { name: 'EVOLC: собственный справочник', root: 'cfe', node: (x) => ({ nodeKind: 'Catalog', label: 'ев_РабочийПроцесс', xmlPath: at(x, 'cfe', 'Catalogs/ев_РабочийПроцесс.xml') }), dumpName: 'Catalog.ев_РабочийПроцесс', title: 'Справочник.ев_РабочийПроцесс' },
  ];
  for (const o of objects) {
    test(`${o.name} — фильтр по uuid XML единицы`, () => {
      const result = resolveRepositoryHistoryTarget(h.service, o.node(h));
      assert.strictEqual(result.kind, 'object', JSON.stringify(result));
      assert.strictEqual(result.scope.target.configRoot, h.roots[o.root]);
      assert.deepStrictEqual(result.scope.filter, { objectId: dumpInfoId(h.roots[o.root], o.dumpName), title: o.title });
    });
  }

  test('форма — uuid дескриптора формы, а не владельца', () => {
    const result = resolveRepositoryHistoryTarget(h.service, childNode(h, 'Form', 'ФормаЭлемента', 'Catalogs/Контрагенты.xml'));
    assert.strictEqual(result.kind, 'object');
    assert.notStrictEqual(result.scope.filter.objectId, dumpInfoId(h.roots.cf, 'Catalog.Контрагенты'));
  });

  const unsupported: readonly [string, (x: Harness) => RepositoryNodeRef][] = [
    ['реквизит', (x) => childNode(x, 'Attribute', 'ИНН', 'Catalogs/Контрагенты.xml')],
    ['табличная часть', (x) => childNode(x, 'TabularSection', 'КонтактныеЛица', 'Catalogs/Контрагенты.xml')],
    ['группа «Общие»', (x) => ({ nodeKind: 'group-common', xmlPath: at(x, 'cf', 'Configuration.xml') })],
    ['форма без имени (полного имени нет)', (x) => childNode(x, 'Form', undefined, 'Catalogs/Контрагенты.xml')],
  ];
  for (const [name, node] of unsupported) {
    test(`${name} — unsupported-node`, () => {
      assert.deepStrictEqual(resolveRepositoryHistoryTarget(h.service, node(h)), { kind: 'unsupported-node' });
    });
  }

  test('узел вне выгрузки и узел без xmlPath — no-target', () => {
    const outside = path.join(h.workspaceRoot, 'Чужой.xml');
    fs.writeFileSync(outside, '<x/>');
    assert.deepStrictEqual(resolveRepositoryHistoryTarget(h.service, { nodeKind: 'Catalog', label: 'Чужой', xmlPath: outside }), { kind: 'no-target' });
    assert.deepStrictEqual(resolveRepositoryHistoryTarget(h.service, { nodeKind: 'Catalog', label: 'Контрагенты' }), { kind: 'no-target' });
  });

  test('XML единицы нет (форма удалена, дерево устарело) — no-uuid с полным именем', () => {
    const node = childNode(h, 'Form', 'НетТакойФормы', 'Catalogs/Контрагенты.xml');
    assert.deepStrictEqual(resolveRepositoryHistoryTarget(h.service, node), { kind: 'no-uuid', fullName: 'Справочник.Контрагенты.Форма.НетТакойФормы' });
  });

  test('у корневого элемента XML нет uuid — no-uuid', () => {
    const file = at(h, 'cf', 'Catalogs/Банки.xml');
    const id = dumpInfoId(h.roots.cf, 'Catalog.Банки');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(`uuid="${id}"`, ''));
    const node = { nodeKind: 'Catalog', label: 'Банки', xmlPath: file };
    assert.deepStrictEqual(resolveRepositoryHistoryTarget(h.service, node), { kind: 'no-uuid', fullName: 'Справочник.Банки' });
  });
});

suite('canShowRepositoryHistory — без I/O (#117)', () => {
  const owner = { rootMetaKind: 'Catalog', ownerObjectXmlPath: '/нет/Catalogs/Контрагенты.xml' };
  const cases: readonly [string, Pick<RepositoryNodeRef, 'nodeKind' | 'metaContext'>, boolean][] = [
    ['configuration', { nodeKind: 'configuration' }, true],
    ['extension', { nodeKind: 'extension' }, true],
    ['Catalog', { nodeKind: 'Catalog' }, true],
    ['Subsystem', { nodeKind: 'Subsystem' }, true],
    ['CommonForm', { nodeKind: 'CommonForm' }, true],
    ['CommonTemplate', { nodeKind: 'CommonTemplate' }, true],
    ['Form с владельцем', { nodeKind: 'Form', metaContext: owner }, true],
    ['Template с владельцем', { nodeKind: 'Template', metaContext: owner }, true],
    ['Form без владельца', { nodeKind: 'Form' }, false],
    ['Attribute', { nodeKind: 'Attribute', metaContext: owner }, false],
    ['TabularSection', { nodeKind: 'TabularSection', metaContext: owner }, false],
    ['Command', { nodeKind: 'Command', metaContext: owner }, false],
    ['group-common', { nodeKind: 'group-common' }, false],
    ['extensions-root', { nodeKind: 'extensions-root' }, false],
    ['без вида', {}, false],
  ];
  for (const [name, node, expected] of cases) {
    test(`${name} → ${String(expected)}`, () => {
      assert.strictEqual(canShowRepositoryHistory(node), expected);
    });
  }
});
