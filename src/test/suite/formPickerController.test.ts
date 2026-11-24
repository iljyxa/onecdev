import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BasedOnXmlService } from '../../infra/xml/BasedOnXmlService';
import { ConfigurationXmlEditor } from '../../infra/xml/ConfigurationXmlEditor';
import { ExchangePlanContentService } from '../../infra/xml/ExchangePlanContentService';
import { MetadataXmlCreator } from '../../infra/xml/MetadataXmlCreator';
import { SubsystemXmlService } from '../../infra/xml/SubsystemXmlService';
import { MetadataNode } from '../../ui/tree/TreeNode';
import type { NodeKind } from '../../ui/tree/TreeNode';
import { PropertiesViewController } from '../../ui/views/properties/PropertiesViewController';
import { TypeRegistryService } from '../../ui/views/properties/TypeRegistryService';
import { getEmptyFormPickerMessage } from '../../ui/views/properties/formPickerOptions';
import type { ObjectPropertiesCollection } from '../../ui/views/properties/_types';

/**
 * Путь пикера форм ЦЕЛИКОМ, от сообщения webview до записи в XML.
 *
 * Чистый `formPickerOptions` покрыт отдельно, но вся польза правки проходит
 * через маппинг аргументов в контроллере: перепутанные `ownerKind`/`ownerName`
 * или `'Form'` вместо `'CommonForm'` не ловятся ни одним тестом чистого модуля.
 * Поэтому здесь поднимается настоящий контроллер на настоящей временной
 * выгрузке, а сообщение идёт через публичный `handleWebviewMessage`.
 */

interface FormPickerPrivateApi {
  handleOpenFormPicker(key?: string): Promise<void>;
  setFormProperty(key: string | undefined, formReference: string | null): void;
  activeProperties: ObjectPropertiesCollection;
}

type QuickPickItemWithOption = vscode.QuickPickItem & { option?: { reference: string } };

type QuickPickSelection = QuickPickItemWithOption | readonly QuickPickItemWithOption[] | undefined;
let quickPickSelector: (items: readonly QuickPickItemWithOption[]) => QuickPickSelection | Promise<QuickPickSelection>;
let quickPickCalls: QuickPickItemWithOption[][] = [];
let infoMessages: string[] = [];
let warningMessages: string[] = [];
let errorMessages: string[] = [];
let originals: {
  showQuickPick: typeof vscode.window.showQuickPick;
  showInformationMessage: typeof vscode.window.showInformationMessage;
  showWarningMessage: typeof vscode.window.showWarningMessage;
  showErrorMessage: typeof vscode.window.showErrorMessage;
} | undefined;

function installDialogStubs(): void {
  const windowRef = vscode.window as unknown as {
    showQuickPick: typeof vscode.window.showQuickPick;
    showInformationMessage: typeof vscode.window.showInformationMessage;
    showWarningMessage: typeof vscode.window.showWarningMessage;
    showErrorMessage: typeof vscode.window.showErrorMessage;
  };
  originals = {
    showQuickPick: windowRef.showQuickPick,
    showInformationMessage: windowRef.showInformationMessage,
    showWarningMessage: windowRef.showWarningMessage,
    showErrorMessage: windowRef.showErrorMessage,
  };
  // Перегрузок showQuickPick несколько — стабу нужна ровно одна форма.
  windowRef.showQuickPick = ((items: readonly QuickPickItemWithOption[]) => {
    quickPickCalls.push([...items]);
    return Promise.resolve(quickPickSelector(items));
  }) as unknown as typeof vscode.window.showQuickPick;
  windowRef.showInformationMessage = ((message: string) => {
    infoMessages.push(message);
    return Promise.resolve(undefined);
  });
  windowRef.showWarningMessage = ((message: string) => {
    warningMessages.push(message);
    return Promise.resolve(undefined);
  });
  windowRef.showErrorMessage = ((message: string) => {
    errorMessages.push(message);
    return Promise.resolve(undefined);
  });
}

function restoreDialogStubs(): void {
  if (!originals) {
    return;
  }
  const windowRef = vscode.window as unknown as Record<string, unknown>;
  windowRef.showQuickPick = originals.showQuickPick;
  windowRef.showInformationMessage = originals.showInformationMessage;
  windowRef.showWarningMessage = originals.showWarningMessage;
  windowRef.showErrorMessage = originals.showErrorMessage;
  originals = undefined;
}

function createController(): PropertiesViewController {
  return new PropertiesViewController(
    new SubsystemXmlService(),
    new ExchangePlanContentService(),
    new TypeRegistryService(),
    new ConfigurationXmlEditor(),
    new BasedOnXmlService(),
    {
      refreshActiveView: () => undefined,
      replaceActiveNode: () => undefined,
    }
  );
}

function makeNode(nodeKind: NodeKind, label: string, xmlPath?: string): MetadataNode {
  return new MetadataNode({ label, nodeKind, xmlPath }, vscode.TreeItemCollapsibleState.None);
}

/** Временная выгрузка: Configuration.xml с общими формами (по списку) и отчёт. */
function createDump(commonForms: readonly string[], options: { withOwnForm?: boolean } = {}): {
  configRoot: string;
  configXmlPath: string;
  reportXmlPath: string;
} {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-form-picker-'));
  const configXmlPath = path.join(configRoot, 'Configuration.xml');
  fs.writeFileSync(
    configXmlPath,
    '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<MetaDataObject version="2.21">\n'
    + '  <Configuration>\n'
    + '    <Properties>\n'
    + '      <Name>ТестоваяКонфигурация</Name>\n'
    + '      <Synonym/>\n'
    + '      <DefaultReportVariantForm/>\n'
    + '    </Properties>\n'
    + `    <ChildObjects>${commonForms.map((name) => `<CommonForm>${name}</CommonForm>`).join('')}</ChildObjects>\n`
    + '  </Configuration>\n'
    + '</MetaDataObject>',
    'utf-8'
  );

  const creator = new MetadataXmlCreator();
  assert.strictEqual(creator.addRootObject({ configRoot, kind: 'Report', name: 'ОтчётПикер' }).success, true);
  const reportXmlPath = path.join(configRoot, 'Reports', 'ОтчётПикер.xml');
  if (options.withOwnForm === true) {
    assert.strictEqual(
      creator.addChildElement({ ownerObjectXmlPath: reportXmlPath, childTag: 'Form', name: 'ФормаОтчёта' }).success,
      true
    );
  }
  return { configRoot, configXmlPath, reportXmlPath };
}

suite('Пикер формы — путь от сообщения webview до записи в XML', () => {
  setup(() => {
    quickPickCalls = [];
    infoMessages = [];
    warningMessages = [];
    errorMessages = [];
    quickPickSelector = () => undefined;
    installDialogStubs();
  });

  teardown(() => {
    restoreDialogStubs();
  });

  test('отчёт с общими формами: в XML записана ровно CommonForm.<Имя>', async () => {
    const dump = createDump(['ФормаОтчета', 'ФормаВариантаОтчета'], { withOwnForm: false });
    const controller = createController();
    controller.setActiveNode(makeNode('Report', 'ОтчётПикер', dump.reportXmlPath));
    quickPickSelector = (items) => items.find((item) => item.label === 'ФормаВариантаОтчета');

    await controller.handleWebviewMessage({ type: 'openFormPicker', key: 'DefaultVariantForm' });

    const xml = fs.readFileSync(dump.reportXmlPath, 'utf-8');
    assert.ok(
      xml.includes('<DefaultVariantForm>CommonForm.ФормаВариантаОтчета</DefaultVariantForm>'),
      `ожидалась ссылка на общую форму, получено:\n${/<DefaultVariantForm>.*/.exec(xml)?.[0] ?? '(тега нет)'}`
    );
    // Своих форм у отчёта нет — весь список состоит из общих форм конфигурации.
    assert.deepStrictEqual(
      quickPickCalls[0].map((item) => item.description),
      ['CommonForm.ФормаВариантаОтчета', 'CommonForm.ФормаОтчета']
    );
  });

  test('объект со своей формой: ссылка «<Вид>.<Имя>.Form.<Форма>», своя форма идёт первой', async () => {
    const dump = createDump(['ФормаОтчета'], { withOwnForm: true });
    const controller = createController();
    controller.setActiveNode(makeNode('Report', 'ОтчётПикер', dump.reportXmlPath));
    quickPickSelector = (items) => items[0];

    await controller.handleWebviewMessage({ type: 'openFormPicker', key: 'DefaultForm' });

    // Порядок важен: первой предлагается собственная форма объекта.
    assert.deepStrictEqual(
      quickPickCalls[0].map((item) => item.description),
      ['Report.ОтчётПикер.Form.ФормаОтчёта', 'CommonForm.ФормаОтчета']
    );
    const xml = fs.readFileSync(dump.reportXmlPath, 'utf-8');
    assert.ok(
      xml.includes('<DefaultForm>Report.ОтчётПикер.Form.ФормаОтчёта</DefaultForm>'),
      `ожидалась ссылка на собственную форму, получено:\n${/<DefaultForm>.*/.exec(xml)?.[0] ?? '(тега нет)'}`
    );
  });

  test('ни своих, ни общих форм: сообщение называет обе причины, XML не тронут', async () => {
    const dump = createDump([], { withOwnForm: false });
    const before = fs.readFileSync(dump.reportXmlPath, 'utf-8');
    const controller = createController();
    controller.setActiveNode(makeNode('Report', 'ОтчётПикер', dump.reportXmlPath));

    await controller.handleWebviewMessage({ type: 'openFormPicker', key: 'DefaultForm' });

    assert.deepStrictEqual(infoMessages, [getEmptyFormPickerMessage()]);
    assert.strictEqual(quickPickCalls.length, 0, 'пустой список показывать нельзя');
    assert.strictEqual(fs.readFileSync(dump.reportXmlPath, 'utf-8'), before, 'XML не должен меняться');
  });

  test('отмена пикера: записи не происходит', async () => {
    const dump = createDump(['ФормаОтчета'], { withOwnForm: false });
    const before = fs.readFileSync(dump.reportXmlPath, 'utf-8');
    const controller = createController();
    controller.setActiveNode(makeNode('Report', 'ОтчётПикер', dump.reportXmlPath));
    quickPickSelector = () => undefined;

    await controller.handleWebviewMessage({ type: 'openFormPicker', key: 'DefaultForm' });

    assert.strictEqual(quickPickCalls.length, 1, 'список показать были обязаны');
    assert.strictEqual(fs.readFileSync(dump.reportXmlPath, 'utf-8'), before, 'после отмены XML не меняется');
  });

  test('выбор формы и отложенная правка не записываются в узел, выбранный позже (#205)', async () => {
    const first = createDump(['ФормаПервого']);
    const second = createDump(['ФормаВторого']);
    const controller = createController();
    try {
      const secondNode = makeNode('Report', 'ОтчётПикер', second.reportXmlPath);
      controller.setActiveNode(secondNode);
      quickPickSelector = (items) => items[0];
      await controller.handleWebviewMessage({ type: 'openFormPicker', key: 'DefaultVariantForm' });
      const firstXml = fs.readFileSync(first.reportXmlPath, 'utf-8');
      const secondXml = fs.readFileSync(second.reportXmlPath, 'utf-8');

      controller.setActiveNode(makeNode('Report', 'ОтчётПикер', first.reportXmlPath));
      let openPicker!: (complete: () => void) => void;
      const pickerOpen = new Promise<() => void>((resolve) => { openPicker = resolve; });
      quickPickSelector = (items) => new Promise((resolve) => {
        openPicker(() => { resolve(items[0]); });
      });

      const pendingPick = controller.handleWebviewMessage({ type: 'openFormPicker', key: 'DefaultForm' });
      const completePicker = await pickerOpen;
      const queuedEdit = controller.handleWebviewMessage({ type: 'clearFormProperty', key: 'DefaultVariantForm' });
      controller.setActiveNode(secondNode);
      completePicker();
      await Promise.all([pendingPick, queuedEdit]);

      assert.strictEqual(fs.readFileSync(first.reportXmlPath, 'utf-8'), firstXml);
      const secondAfter = fs.readFileSync(second.reportXmlPath, 'utf-8');
      assert.ok(!secondAfter.includes('CommonForm.ФормаПервого'), 'выбор формы первого отчёта попал во второй');
      assert.ok(secondAfter.includes('<DefaultVariantForm>CommonForm.ФормаВторого</DefaultVariantForm>'),
        'ожидавшая в очереди правка попала во второй отчёт');
      assert.strictEqual(secondAfter, secondXml);
    } finally {
      fs.rmSync(first.configRoot, { recursive: true, force: true });
      fs.rmSync(second.configRoot, { recursive: true, force: true });
    }
  });

  test('выбор типа применяется к исходному реквизиту и отменяется при смене узла (#205)', async () => {
    const { configRoot } = createDump([]);
    const creator = new MetadataXmlCreator();
    const catalogXml = path.join(configRoot, 'Catalogs', 'СправочникПикер.xml');
    const attribute = (label: string) => new MetadataNode({
      label, nodeKind: 'Attribute', xmlPath: catalogXml,
      metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: catalogXml },
    }, vscode.TreeItemCollapsibleState.None);
    try {
      assert.ok(creator.addRootObject({ configRoot, kind: 'Catalog', name: 'СправочникПикер' }).success);
      assert.ok(creator.addChildElement({ ownerObjectXmlPath: catalogXml, childTag: 'Attribute', name: 'Первый' }).success);
      assert.ok(creator.addChildElement({ ownerObjectXmlPath: catalogXml, childTag: 'Attribute', name: 'Второй' }).success);
      const controller = createController();
      const first = attribute('Первый');
      const second = attribute('Второй');
      controller.setActiveNode(first);
      assert.ok(controller.getViewState()?.sections.flatMap((section) => section.controls).some((item) => item.id === 'Type'));
      await controller.handleWebviewMessage({ type: 'openTypePicker' });
      quickPickSelector = () => [];
      await controller.handleWebviewMessage({ type: 'openTypePicker' });
      quickPickSelector = (items) => {
        const choice = items.find((item) => item.description === 'Boolean');
        assert.ok(choice);
        return [choice];
      };
      await controller.handleWebviewMessage({ type: 'openTypePicker' });
      const updated = fs.readFileSync(catalogXml, 'utf-8');
      assert.ok(updated.includes('xs:boolean'));
      quickPickSelector = (items) => {
        const choice = items.find((item) => item.description === 'Date');
        assert.ok(choice);
        controller.setActiveNode(second);
        assert.ok(controller.getViewState());
        return [choice];
      };
      await controller.handleWebviewMessage({ type: 'openTypePicker' });
      assert.strictEqual(fs.readFileSync(catalogXml, 'utf-8'), updated);
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });

  test('ссылка выбора не добавляется в справочник, выбранный позднее (#205)', async () => {
    const { configRoot } = createDump([]);
    const creator = new MetadataXmlCreator();
    const firstXml = path.join(configRoot, 'Catalogs', 'Первый.xml');
    const secondXml = path.join(configRoot, 'Catalogs', 'Второй.xml');
    try {
      assert.ok(creator.addRootObject({ configRoot, kind: 'Catalog', name: 'Первый' }).success);
      assert.ok(creator.addRootObject({ configRoot, kind: 'Catalog', name: 'Второй' }).success);
      assert.ok(creator.addRootObject({ configRoot, kind: 'Document', name: 'Заказ' }).success);
      const controller = createController();
      const first = makeNode('Catalog', 'Первый', firstXml);
      const second = makeNode('Catalog', 'Второй', secondXml);
      controller.setActiveNode(first);
      assert.ok(controller.getViewState());
      await controller.handleWebviewMessage({ type: 'openMetadataReferencePicker', key: 'BasedOn' });
      const untouched = fs.readFileSync(secondXml, 'utf-8');
      quickPickSelector = (items) => {
        const choice = items.find((item) => item.description === 'Document.Заказ');
        assert.ok(choice);
        controller.setActiveNode(second);
        assert.ok(controller.getViewState());
        return choice;
      };
      await controller.handleWebviewMessage({ type: 'openMetadataReferencePicker', key: 'BasedOn' });
      assert.strictEqual(fs.readFileSync(secondXml, 'utf-8'), untouched);
      assert.strictEqual(quickPickCalls.length, 2);
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });

  test('выбор подсистемы отменяется при смене отчёта (#205)', async () => {
    const { configRoot, reportXmlPath } = createDump([]);
    const creator = new MetadataXmlCreator();
    try {
      assert.ok(creator.addRootObject({ configRoot, kind: 'Subsystem', name: 'ГруппаОтчётов' }).success);
      assert.ok(creator.addRootObject({ configRoot, kind: 'Subsystem', name: 'ОбщиеОтчёты' }).success);
      assert.ok(creator.addRootObject({ configRoot, kind: 'Report', name: 'ДругойОтчёт' }).success);
      const subsystemXml = path.join(configRoot, 'Subsystems', 'ГруппаОтчётов.xml');
      const otherSubsystemXml = path.join(configRoot, 'Subsystems', 'ОбщиеОтчёты.xml');
      const otherReportXml = path.join(configRoot, 'Reports', 'ДругойОтчёт.xml');
      const controller = createController();
      const first = makeNode('Report', 'ОтчётПикер', reportXmlPath);
      const second = makeNode('Report', 'ДругойОтчёт', otherReportXml);
      controller.setActiveNode(first);
      await controller.handleWebviewMessage({ type: 'openSubsystemMembershipPicker' });
      quickPickSelector = (items) => items.find((item) => item.description === 'ГруппаОтчётов');
      await controller.handleWebviewMessage({ type: 'openSubsystemMembershipPicker' });
      const updated = fs.readFileSync(subsystemXml, 'utf-8');
      assert.ok(updated.includes('Report.ОтчётПикер'));
      const untouched = fs.readFileSync(otherSubsystemXml, 'utf-8');
      quickPickSelector = (items) => {
        const choice = items.find((item) => item.description === 'ОбщиеОтчёты');
        assert.ok(choice);
        controller.setActiveNode(second);
        return choice;
      };
      await controller.handleWebviewMessage({ type: 'openSubsystemMembershipPicker' });
      assert.strictEqual(fs.readFileSync(subsystemXml, 'utf-8'), updated);
      assert.strictEqual(fs.readFileSync(otherSubsystemXml, 'utf-8'), untouched);
      assert.strictEqual(quickPickCalls.length, 3);
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });

  test('переименование сохраняет выделение нового узла (#205)', async () => {
    const { configRoot, reportXmlPath } = createDump([]);
    try {
      const controller = createController();
      controller.setActiveNode(makeNode('Report', 'ОтчётПикер', reportXmlPath));
      assert.ok(controller.getViewState());
      await controller.handleWebviewMessage({ type: 'propertyChanged', key: 'Name', value: 'ОтчётПослеПравки' });
      const renamedXml = path.join(configRoot, 'Reports', 'ОтчётПослеПравки.xml');
      assert.ok(fs.existsSync(renamedXml));
      assert.strictEqual(controller.getActiveNode()?.xmlPath, renamedXml);
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });

  test('clearFormProperty очищает значение свойства формы', async () => {
    const dump = createDump(['ФормаОтчета'], { withOwnForm: false });
    const controller = createController();
    controller.setActiveNode(makeNode('Report', 'ОтчётПикер', dump.reportXmlPath));
    quickPickSelector = (items) => items[0];
    await controller.handleWebviewMessage({ type: 'openFormPicker', key: 'DefaultForm' });
    assert.ok(fs.readFileSync(dump.reportXmlPath, 'utf-8').includes('<DefaultForm>CommonForm.ФормаОтчета</DefaultForm>'));

    await controller.handleWebviewMessage({ type: 'clearFormProperty', key: 'DefaultForm' });

    const xml = fs.readFileSync(dump.reportXmlPath, 'utf-8');
    assert.ok(
      !xml.includes('CommonForm.ФормаОтчета'),
      `значение свойства формы должно быть очищено, получено:\n${/<DefaultForm>.*/.exec(xml)?.[0] ?? '(тега нет)'}`
    );
  });

  test('корень конфигурации: формы уровня приложения тоже выбираются и пишутся в Configuration.xml', async () => {
    const dump = createDump(['ФормаВариантаОтчета'], { withOwnForm: false });
    const controller = createController();
    controller.setActiveNode(makeNode('configuration', 'ТестоваяКонфигурация', dump.configXmlPath));
    quickPickSelector = (items) => items[0];

    await controller.handleWebviewMessage({ type: 'openFormPicker', key: 'DefaultReportVariantForm' });

    // У конфигурации собственных форм не бывает — список целиком из общих.
    assert.deepStrictEqual(quickPickCalls[0].map((item) => item.description), ['CommonForm.ФормаВариантаОтчета']);
    const xml = fs.readFileSync(dump.configXmlPath, 'utf-8');
    assert.ok(
      xml.includes('<DefaultReportVariantForm>CommonForm.ФормаВариантаОтчета</DefaultReportVariantForm>'),
      `ожидалась запись формы уровня приложения, получено:\n${/<DefaultReportVariantForm>.*/.exec(xml)?.[0] ?? '(тега нет)'}`
    );
  });

  test('корень конфигурации: clearFormProperty очищает форму уровня приложения в Configuration.xml', async () => {
    const dump = createDump(['ФормаВариантаОтчета'], { withOwnForm: false });
    const controller = createController();
    controller.setActiveNode(makeNode('configuration', 'ТестоваяКонфигурация', dump.configXmlPath));
    quickPickSelector = (items) => items[0];
    await controller.handleWebviewMessage({ type: 'openFormPicker', key: 'DefaultReportVariantForm' });
    assert.ok(fs.readFileSync(dump.configXmlPath, 'utf-8').includes('CommonForm.ФормаВариантаОтчета'));

    await controller.handleWebviewMessage({ type: 'clearFormProperty', key: 'DefaultReportVariantForm' });

    const xml = fs.readFileSync(dump.configXmlPath, 'utf-8');
    assert.ok(
      !xml.includes('CommonForm.ФормаВариантаОтчета'),
      `форма уровня приложения должна быть очищена, получено:\n${/<DefaultReportVariantForm.*/.exec(xml)?.[0] ?? '(тега нет)'}`
    );
  });

  test('повторный выбор той же формы конфигурации: файл не переписывается, ошибки нет', async () => {
    const dump = createDump(['ФормаВариантаОтчета'], { withOwnForm: false });
    const controller = createController();
    controller.setActiveNode(makeNode('configuration', 'ТестоваяКонфигурация', dump.configXmlPath));
    quickPickSelector = (items) => items[0];
    await controller.handleWebviewMessage({ type: 'openFormPicker', key: 'DefaultReportVariantForm' });
    const afterFirst = fs.readFileSync(dump.configXmlPath, 'utf-8');

    await controller.handleWebviewMessage({ type: 'openFormPicker', key: 'DefaultReportVariantForm' });

    assert.strictEqual(fs.readFileSync(dump.configXmlPath, 'utf-8'), afterFirst, 'повтор не должен менять файл');
    assert.deepStrictEqual(errorMessages, [], 'повтор того же значения — не ошибка');
  });

  test('свойства формы нет в Configuration.xml: тег дописывается на каноническое место', async () => {
    const dump = createDump(['ФормаОтчета'], { withOwnForm: false });
    const controller = createController();
    controller.setActiveNode(makeNode('configuration', 'ТестоваяКонфигурация', dump.configXmlPath));
    quickPickSelector = (items) => items[0];

    // Тега <DefaultConstantsForm/> в фикстуре нет. РАНЬШЕ редактор отказывал: канона
    // порядка не существовало, и дописать тег можно было только в конец, мимо
    // xs:sequence, — отказ был меньшим злом. Теперь канон снят с эталона
    // (ROOT_PROPERTY_ORDER), и отказывать больше не за что: у ключа есть ранг, тег
    // встаёт на своё место. Ветка отказа осталась для ключа БЕЗ ранга и покрыта на
    // уровне редактора (configurationXmlEditorPropertyOrder.test.ts).
    await controller.handleWebviewMessage({ type: 'openFormPicker', key: 'DefaultConstantsForm' });

    assert.deepStrictEqual(errorMessages, [], 'отказа быть не должно');
    const updated = fs.readFileSync(dump.configXmlPath, 'utf-8');
    assert.ok(
      updated.includes('<DefaultConstantsForm>CommonForm.ФормаОтчета</DefaultConstantsForm>'),
      `свойство не записано: ${updated}`
    );

    // Позиция, а не только наличие: DefaultConstantsForm — последний ключ канона
    // конфигурации (ранг 71 из 72, сразу после CompatibilityMode), поэтому он
    // обязан встать ПОСЛЕ уже присутствующего DefaultReportVariantForm.
    assert.ok(
      updated.indexOf('<DefaultReportVariantForm') < updated.indexOf('<DefaultConstantsForm'),
      `нарушен порядок свойств: ${updated}`
    );
  });

  test('свойство только для чтения: показывается предупреждение, список не открывается', async () => {
    const dump = createDump(['ФормаОтчета'], { withOwnForm: false });
    const before = fs.readFileSync(dump.reportXmlPath, 'utf-8');
    const controller = createController();
    controller.setActiveNode(makeNode('Report', 'ОтчётПикер', dump.reportXmlPath));
    const api = controller as unknown as FormPickerPrivateApi;
    api.activeProperties = [
      { key: 'DefaultForm', title: 'Основная форма', kind: 'string', value: '', readonly: true },
    ];

    await controller.handleWebviewMessage({ type: 'openFormPicker', key: 'DefaultForm' });

    assert.strictEqual(quickPickCalls.length, 0, 'для readonly-свойства список открывать нельзя');
    assert.strictEqual(warningMessages.length, 1, 'ожидалось предупреждение о readonly-свойстве');
    assert.strictEqual(fs.readFileSync(dump.reportXmlPath, 'utf-8'), before);
  });

  test('сообщение без ключа свойства: пикер не открывается', async () => {
    const dump = createDump(['ФормаОтчета'], { withOwnForm: false });
    const controller = createController();
    controller.setActiveNode(makeNode('Report', 'ОтчётПикер', dump.reportXmlPath));

    await controller.handleWebviewMessage({ type: 'openFormPicker' });

    assert.strictEqual(quickPickCalls.length, 0);
    assert.deepStrictEqual(infoMessages, []);
  });

  test('без активного узла приватный вход в пикер не падает и ничего не показывает', async () => {
    const controller = createController();
    controller.clearActiveNode();

    // Через handleWebviewMessage эта ветка недостижима (там свой ранний выход по
    // activeNode), но метод вызывается и напрямую — защитный guard обязан жить.
    await (controller as unknown as FormPickerPrivateApi).handleOpenFormPicker('DefaultForm');

    assert.strictEqual(quickPickCalls.length, 0);
  });

  test('узел без xmlPath: общие формы не читаются, список пуст', async () => {
    const controller = createController();
    controller.setActiveNode(makeNode('Report', 'ОтчётБезФайла'));

    await controller.handleWebviewMessage({ type: 'openFormPicker', key: 'DefaultForm' });

    assert.deepStrictEqual(infoMessages, [getEmptyFormPickerMessage()]);
    assert.strictEqual(quickPickCalls.length, 0);
  });

  test('нечитаемый Configuration.xml: общие формы не читаются, список пуст', async () => {
    const dump = createDump([], { withOwnForm: false });
    // Configuration.xml удалён — parseConfigXml бросает, контроллер обязан
    // отдать пустой список, а не уронить обработку сообщения.
    fs.rmSync(dump.configXmlPath);
    const controller = createController();
    controller.setActiveNode(makeNode('Report', 'ОтчётПикер', dump.reportXmlPath));

    await controller.handleWebviewMessage({ type: 'openFormPicker', key: 'DefaultForm' });

    assert.deepStrictEqual(infoMessages, [getEmptyFormPickerMessage()]);
    assert.strictEqual(quickPickCalls.length, 0);
  });

  test('корень конфигурации без xmlPath: записать некуда, выбор формы отклоняется предупреждением', () => {
    // Через handleOpenFormPicker сюда не попасть (без xmlPath список пуст и пикер
    // не открывается), но setFormProperty вызывается и напрямую — отказ обязателен,
    // а не падение на отсутствующем пути.
    const controller = createController();
    controller.setActiveNode(makeNode('configuration', 'ТестоваяКонфигурация'));

    (controller as unknown as FormPickerPrivateApi).setFormProperty('DefaultReportVariantForm', 'CommonForm.Форма');

    assert.deepStrictEqual(warningMessages, ['Выбор формы доступен только для корневого объекта метаданных.']);
    assert.deepStrictEqual(errorMessages, []);
  });

  test('Configuration.xml пропал после открытия панели: ошибка записи показывается пользователю', () => {
    const dump = createDump(['ФормаОтчета'], { withOwnForm: false });
    const controller = createController();
    controller.setActiveNode(makeNode('configuration', 'ТестоваяКонфигурация', dump.configXmlPath));
    fs.rmSync(dump.configXmlPath);

    (controller as unknown as FormPickerPrivateApi).setFormProperty('DefaultReportVariantForm', 'CommonForm.ФормаОтчета');

    assert.strictEqual(errorMessages.length, 1);
    assert.ok(errorMessages[0].includes('Не найден файл'), errorMessages[0]);
    assert.ok(!fs.existsSync(dump.configXmlPath), 'файл не должен быть создан заново');
  });

  test('Owners: пикер предлагает справочники конфигурации по алфавиту и записывает выбранный владелец', async () => {
    const dump = createDump([], { withOwnForm: false });
    const creator = new MetadataXmlCreator();
    for (const name of ['Яблоки', 'Бананы', 'Подчинённый']) {
      assert.strictEqual(creator.addRootObject({ configRoot: dump.configRoot, kind: 'Catalog', name }).success, true);
    }
    const childXmlPath = path.join(dump.configRoot, 'Catalogs', 'Подчинённый.xml');
    const controller = createController();
    controller.setActiveNode(makeNode('Catalog', 'Подчинённый', childXmlPath));
    (controller as unknown as FormPickerPrivateApi).activeProperties = [
      { key: 'Owners', title: 'Владельцы', kind: 'metadataReferenceList', value: { items: [] } },
    ];
    quickPickSelector = (items) => items.find((item) => item.description === 'Catalog.Бананы');

    await controller.handleWebviewMessage({ type: 'openMetadataReferencePicker', key: 'Owners' });

    assert.deepStrictEqual(
      quickPickCalls[0].map((item) => [item.label, item.description]),
      [
        ['Справочники.Бананы', 'Catalog.Бананы'],
        ['Справочники.Подчинённый', 'Catalog.Подчинённый'],
        ['Справочники.Яблоки', 'Catalog.Яблоки'],
      ]
    );
    const xml = fs.readFileSync(childXmlPath, 'utf-8');
    assert.ok(/<Owners>[\s\S]*Catalog\.Бананы[\s\S]*<\/Owners>/.test(xml), xml);
    assert.deepStrictEqual(errorMessages, []);
  });
});
