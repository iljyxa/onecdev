import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { selectPropertiesViewId } from '../../ui/views/properties/propertiesViewPlacement';
import { PropertiesViewSession } from '../../ui/views/properties/PropertiesViewSession';
import type { PropertiesViewState } from '../../ui/views/properties/_types';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { createFakeMemento, createUniversalPanelFixture } from './support/universalPanelHarness';

suite('Отдельная панель свойств (#205)', () => {
  const node = (label: string) => new MetadataNode({ label, nodeKind: 'Catalog' }, vscode.TreeItemCollapsibleState.None);

  test('выбирает вторичную панель с VS Code 1.106 и запасное размещение в Cursor', () => {
    assert.equal(selectPropertiesViewId('1.85.0', 'Visual Studio Code'), 'onecdevPropertiesInNavigator');
    assert.equal(selectPropertiesViewId('1.105.9', 'Visual Studio Code'), 'onecdevPropertiesInNavigator');
    assert.equal(selectPropertiesViewId('1.106.0', 'Visual Studio Code'), 'onecdevProperties');
    assert.equal(selectPropertiesViewId('1.107.0-insider', 'Visual Studio Code - Insiders'), 'onecdevProperties');
    assert.equal(selectPropertiesViewId('2.0.0', 'Visual Studio Code'), 'onecdevProperties');
    assert.equal(selectPropertiesViewId('1.147.0', 'Cursor'), 'onecdevPropertiesInNavigator');
    assert.equal(selectPropertiesViewId('unknown', 'Visual Studio Code'), 'onecdevPropertiesInNavigator');
  });

  test('читает последнее выделение только у видимой панели', async () => {
    const reads: string[] = [];
    const states: string[] = [];
    const session = new PropertiesViewSession((selected) => {
      reads.push(selected.textLabel);
      return null;
    });
    await session.selectNode(node('Первый'));
    const second = node('Второй');
    await session.selectNode(second);
    await session.refresh();
    assert.deepEqual(reads, []);

    await session.setHost((state) => states.push(state.kind));
    assert.deepEqual(reads, ['Второй']);
    assert.deepEqual(states, ['empty']);

    await session.setHost(undefined);
    await session.selectNode(undefined);
    await session.refresh();
    assert.deepEqual(reads, ['Второй']);
    await session.setHost((state) => states.push(state.kind));
    assert.deepEqual(states, ['empty', 'empty']);
    assert.equal(session.getActiveNode(), undefined);
  });

  test('не начинает чтение для выделения, сменившегося до следующего оборота цикла', async () => {
    const reads: string[] = [];
    const session = new PropertiesViewSession((selected) => {
      reads.push(selected.textLabel);
      return null;
    });
    await session.setHost(() => undefined);
    const latest = node('Последний');
    await Promise.all([session.selectNode(node('Первый')), session.selectNode(latest)]);
    await session.selectNode(latest);
    assert.deepEqual(reads, ['Последний', 'Последний']);
  });

  test('навигатор передаёт выбор и восстанавливает его после повторного открытия', () => {
    const state = createFakeMemento();
    const selections: (MetadataNode | undefined)[] = [];
    const onSelection = (selected: MetadataNode | undefined) => { selections.push(selected); };
    const first = createUniversalPanelFixture(state, onSelection);
    try {
      const config = first.rootNodes.find((item) => item.kind === 'configuration');
      const extensions = first.rootNodes.find((item) => item.kind === 'extensions-root');
      assert.ok(config);
      assert.ok(extensions);
      first.send({ type: 'command', command: 'selectNode', payload: { nodeId: config.id } });
      first.send({ type: 'command', command: 'selectNode', payload: { nodeId: extensions.id } });
      first.send({ type: 'command', command: 'selectNode', payload: { nodeId: config.id } });
      first.send({ type: 'command', command: 'nodeDefault', payload: { nodeId: config.id } });
      assert.deepEqual(selections.map((selected) => selected?.textLabel), [
        config.label, undefined, config.label, config.label,
      ]);

      const reopened = createUniversalPanelFixture(state, onSelection);
      try {
        assert.equal(selections.length, 5);
        assert.equal(selections[4]?.textLabel, config.label);
      } finally {
        reopened.dispose();
      }
    } finally {
      first.dispose();
    }
  });

  test('очищает панель только при удалении текущего объекта или его владельца', async () => {
    const session = new PropertiesViewSession(() => null);
    const ownerXml = path.join('/project/src/cf', 'Catalogs', 'Банки.xml');
    const child = (label: string, tabularSectionName: string, xmlPath = ownerXml) => new MetadataNode({
      label, nodeKind: 'Column', xmlPath,
      metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: ownerXml, tabularSectionName },
    }, vscode.TreeItemCollapsibleState.None);
    const selected = child('Код', 'Счета');

    await session.selectNode(selected);
    await session.handleMetadataRemoved(node('Группа'));
    await session.handleMetadataRemoved(child('Код', 'Связи'));
    await session.handleMetadataRemoved(child('Другой', 'Счета'));
    assert.equal(session.getActiveNode(), selected);

    await session.handleMetadataRemoved(child('Код', 'Счета', path.join('/project/src/cf', 'temp.xml')));
    assert.equal(session.getActiveNode(), undefined);

    await session.selectNode(selected);
    await session.handleMetadataRemoved(child('Код', 'Счета'));
    assert.equal(session.getActiveNode(), undefined);

    const owner = new MetadataNode({ label: 'Банки', nodeKind: 'Catalog', xmlPath: ownerXml }, vscode.TreeItemCollapsibleState.None);
    await session.selectNode(node('Группа'));
    await session.handleMetadataRemoved(owner);
    assert.equal(session.getActiveNode()?.textLabel, 'Группа');

    await session.selectNode(selected);
    await session.handleMetadataRemoved(owner);
    assert.equal(session.getActiveNode(), undefined);
  });

  test('отбрасывает ответ предыдущего выделения и ответ скрытой панели', async () => {
    const first = node('Первый');
    const second = node('Второй');
    const pending: ((value: PropertiesViewState | null) => void)[] = [];
    const states: number[] = [];
    const session = new PropertiesViewSession(() => new Promise((resolve) => pending.push(resolve)));
    await session.setHost((state) => states.push(state.generation));
    const oldRead = session.selectNode(first);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const newRead = session.selectNode(second);
    await new Promise<void>((resolve) => setImmediate(resolve));
    pending[1]({ title: second.textLabel, readonly: false, sections: [] });
    await newRead;
    pending[0](null);
    await oldRead;
    assert.equal(states.length, 2);
    assert.ok(session.isCurrent(states[1]));
    assert.equal(session.isCurrent(states[0]), false);

    const lastRead = session.refresh();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await session.setHost(undefined);
    pending[2](null);
    await lastRead;
    assert.equal(states.length, 2);
    assert.equal(session.isCurrent(states[1]), false);
  });
});
