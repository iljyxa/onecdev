import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BasedOnXmlService } from '../../infra/xml/BasedOnXmlService';
import { ConfigurationXmlEditor } from '../../infra/xml/ConfigurationXmlEditor';
import { ExchangePlanContentService } from '../../infra/xml/ExchangePlanContentService';
import { SubsystemXmlService } from '../../infra/xml/SubsystemXmlService';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { PropertiesViewController } from '../../ui/views/properties/PropertiesViewController';
import { TypeRegistryService } from '../../ui/views/properties/TypeRegistryService';

interface WindowStubs {
  showQuickPick: typeof vscode.window.showQuickPick;
  showErrorMessage: typeof vscode.window.showErrorMessage;
}

/**
 * #150: отказ записи «Ввод на основании» (нет блока <Properties>) панель раньше
 * проглатывала — ни ошибки, ни обновления. Теперь причина писателя доходит до
 * пользователя через showErrorMessage.
 */
suite('PropertiesViewController — отказ записи «Ввод на основании» (#150)', () => {
  let originals: WindowStubs | undefined;
  let errorMessages: string[];

  setup(() => {
    errorMessages = [];
    const windowRef = vscode.window as unknown as WindowStubs;
    originals = { showQuickPick: windowRef.showQuickPick, showErrorMessage: windowRef.showErrorMessage };
    // Перегрузок showQuickPick несколько — стабу нужна одна: выбрать документ.
    windowRef.showQuickPick = ((items: readonly { canonical?: string }[]) =>
      Promise.resolve(items.find((item) => item.canonical === 'Document.Заказ'))) as unknown as typeof vscode.window.showQuickPick;
    windowRef.showErrorMessage = ((message: string) => {
      errorMessages.push(message);
      return Promise.resolve(undefined);
    });
  });

  teardown(() => {
    if (originals) {
      Object.assign(vscode.window as unknown as WindowStubs, originals);
      originals = undefined;
    }
  });

  test('добавление ссылки в объект без <Properties> показывает ошибку и не обновляет панель', async () => {
    const outcome = await pickBasedOnDocument('<MetaDataObject><Catalog><ChildObjects/></Catalog></MetaDataObject>');

    assert.strictEqual(errorMessages.length, 1, `ожидалась одна ошибка, получено: ${JSON.stringify(errorMessages)}`);
    assert.ok(errorMessages[0].includes('<Properties>'), errorMessages[0]);
    assert.strictEqual(outcome.refreshCount, 0);
  });

  test('успешное добавление ссылки обновляет панель без сообщения об ошибке', async () => {
    const outcome = await pickBasedOnDocument(
      '<MetaDataObject><Catalog><Properties><Name>Клиенты</Name><BasedOn/></Properties></Catalog></MetaDataObject>'
    );

    assert.deepStrictEqual(errorMessages, []);
    assert.strictEqual(outcome.refreshCount, 1);
    assert.ok(fs.readFileSync(outcome.catalogPath, 'utf-8').includes('Document.Заказ'));
  });
});

/** Временная выгрузка со справочником (XML задаёт тест) и документом; выбор документа в пикере BasedOn. */
async function pickBasedOnDocument(catalogXml: string): Promise<{ refreshCount: number; catalogPath: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-based-on-ui-'));
  fs.mkdirSync(path.join(root, 'Catalogs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Documents'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'Configuration.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<MetaDataObject><Configuration><Properties><Name>Тест</Name></Properties>'
      + '<ChildObjects><Catalog>Клиенты</Catalog><Document>Заказ</Document></ChildObjects></Configuration></MetaDataObject>',
    'utf-8'
  );
  const catalogPath = path.join(root, 'Catalogs', 'Клиенты.xml');
  fs.writeFileSync(catalogPath, `<?xml version="1.0" encoding="utf-8"?>\n${catalogXml}`, 'utf-8');
  fs.writeFileSync(
    path.join(root, 'Documents', 'Заказ.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<MetaDataObject><Document><Properties><Name>Заказ</Name><BasedOn/></Properties></Document></MetaDataObject>',
    'utf-8'
  );

  let refreshCount = 0;
  const controller = new PropertiesViewController(
    new SubsystemXmlService(),
    new ExchangePlanContentService(),
    new TypeRegistryService(),
    new ConfigurationXmlEditor(),
    new BasedOnXmlService(),
    {
      refreshActiveView: () => {
        refreshCount += 1;
      },
      replaceActiveNode: () => undefined,
    }
  );
  const node = new MetadataNode({ label: 'Клиенты', nodeKind: 'Catalog', xmlPath: catalogPath }, vscode.TreeItemCollapsibleState.None);
  controller.buildRenderContext(node, []);

  await controller.handleWebviewMessage({ type: 'openMetadataReferencePicker', key: 'BasedOn' });
  return { refreshCount, catalogPath };
}
