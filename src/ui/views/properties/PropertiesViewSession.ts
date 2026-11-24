import { setImmediate } from 'node:timers/promises';
import type { MetadataNode } from '../../tree/TreeNode';
import type { PropertiesViewState } from './_types';
import { isRemovedNode } from './isRemovedNode';

export type PropertiesPanelState =
  | { readonly generation: number; readonly kind: 'properties'; readonly view: PropertiesViewState }
  | { readonly generation: number; readonly kind: 'empty'; readonly message?: string };

type PostState = (state: PropertiesPanelState) => void;

export class PropertiesViewSession {
  private activeNode: MetadataNode | undefined;
  private host: PostState | undefined;
  private generation = 0;
  private request = 0;
  private publishedGeneration: number | undefined;

  constructor(
    private readonly read: (node: MetadataNode) => PropertiesViewState | null | Promise<PropertiesViewState | null>
  ) {}

  setHost(host: PostState | undefined): Promise<void> {
    this.host = host;
    this.generation++;
    return this.refresh();
  }

  selectNode(node: MetadataNode | undefined): Promise<void> {
    if (node !== this.activeNode) {
      this.activeNode = node;
      this.generation++;
    }
    return this.refresh();
  }

  getActiveNode(): MetadataNode | undefined {
    return this.activeNode;
  }

  handleMetadataRemoved(node: MetadataNode): Promise<void> | undefined {
    if (this.activeNode && isRemovedNode(this.activeNode, node)) {
      return this.selectNode(undefined);
    }
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation && generation === this.publishedGeneration;
  }

  async refresh(): Promise<void> {
    const { host, activeNode, generation } = this;
    if (!host) {
      return;
    }
    const request = ++this.request;
    if (activeNode) {
      // Сначала отдаём управление обработчику навигатора. Серия быстрых
      // переключений успевает отменить чтение до обращения к XML.
      await setImmediate();
      if (request !== this.request || generation !== this.generation) {
        return;
      }
    }
    const view = activeNode ? await this.read(activeNode) : null;
    if (request === this.request && generation === this.generation) {
      this.publishedGeneration = view ? generation : undefined;
      host(view
        ? { generation, kind: 'properties', view }
        : { generation, kind: 'empty', message: activeNode ? 'Для выбранного объекта свойства недоступны.' : undefined });
    }
  }
}
