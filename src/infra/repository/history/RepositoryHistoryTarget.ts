// Цель «Истории хранилища» по узлу дерева: корень — вся история цели, объект — история единицы
// хранилища, отфильтрованная сервером по uuid. Единица истории = единица захвата/помещения, поэтому
// путь — тем же правилом, что у захвата (resolveFullName → resolveUnitXmlRel), а не через MetaPathResolver:
// у формы это дескриптор `Forms/Имя.xml` со своим `<Form uuid>`, а не тело `Ext/Form.xml` и не владелец.
import * as path from 'path';
import { readMetadataRootUuidFile } from '../../xml/MetadataRootUuidReader';
import { resolveUnitXmlRel } from '../RepositoryObjectScope';
import { isRepositoryUnitNode, type RepositoryNodeRef, type RepositoryService } from '../RepositoryService';
import type { RepositoryHistoryObjectFilter } from './RepositoryHistoryModel';
import type { RepositoryHistoryScope } from './RepositoryHistoryService';

export type RepositoryHistoryTargetResolution =
  | { readonly kind: 'root'; readonly scope: RepositoryHistoryScope }
  | { readonly kind: 'object'; readonly scope: RepositoryHistoryScope & { readonly filter: RepositoryHistoryObjectFilter } }
  | { readonly kind: 'no-target' }
  | { readonly kind: 'unsupported-node' }
  | { readonly kind: 'no-uuid'; readonly fullName: string };

const ROOT_KINDS: ReadonlySet<string> = new Set(['configuration', 'extension']);

/**
 * Есть ли у узла своя история в хранилище: корень, объект верхнего уровня или подсистема, форма или
 * макет объекта (самостоятельные единицы). Реквизиты, ТЧ, команды хранятся внутри владельца, группы
 * дерева — не объекты. Без I/O: вызывается при построении меню.
 */
export const canShowRepositoryHistory = isRepositoryUnitNode;

/**
 * Область истории по узлу. Заголовок фильтра — полное имя единицы (`Справочник.X.Форма.Y`); сервис
 * заменит его заголовком из истории. Читает XML синхронно — только по команде пользователя.
 */
export function resolveRepositoryHistoryTarget(
  repositoryService: Pick<RepositoryService, 'resolveTargetByXmlPath' | 'resolveFullName'>,
  node: RepositoryNodeRef,
): RepositoryHistoryTargetResolution {
  const target = node.xmlPath ? repositoryService.resolveTargetByXmlPath(node.xmlPath) : null;
  if (!target) {
    return { kind: 'no-target' };
  }
  if (node.nodeKind !== undefined && ROOT_KINDS.has(node.nodeKind)) {
    return { kind: 'root', scope: { target } };
  }
  const fullName = canShowRepositoryHistory(node) ? repositoryService.resolveFullName(node) : null;
  if (!fullName) {
    return { kind: 'unsupported-node' };
  }
  const rel = resolveUnitXmlRel(target.configRoot, fullName);
  const objectId = rel === null ? null : readMetadataRootUuidFile(path.join(target.configRoot, rel));
  if (objectId === null) {
    return { kind: 'no-uuid', fullName };
  }
  return { kind: 'object', scope: { target, filter: { objectId, title: fullName } } };
}
