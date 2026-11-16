// Читатели ответа crs:call_return: обязательные элементы и атрибут value. Отказ — CrsFormatError с путём
// и именем элемента, без значений: в ответах лежат хеши паролей и пути баз.
import { CRS_NAMESPACE } from './CrsEnvelope';
import { CrsCallError, CrsFormatError } from '../../repository/crs/CrsErrors';
import { childElement, type CrsXmlElement } from './CrsXmlReader';

const INTEGER = /^-?\d+$/;

/** Цепочка обязательных дочерних элементов crs; нет — CrsFormatError с путём, без содержимого. */
export function crsChild(parent: CrsXmlElement, ...path: string[]): CrsXmlElement {
  let current = parent;
  path.forEach((local, i) => {
    const next = childElement(current, CRS_NAMESPACE, local);
    if (next === undefined) {
      const trail = path.slice(0, i + 1).map((p) => `crs:${p}`).join('/');
      throw new CrsFormatError(`ответ crs: в ${parent.name} нет ${trail}`);
    }
    current = next;
  });
  return current;
}

/** Дочерние crs:value — элементы массивов (statMap, bindInfos, users); иной дочерний элемент — отказ. */
export function crsValues(parent: CrsXmlElement): CrsXmlElement[] {
  const stranger = parent.children.find((child) => child.namespace !== CRS_NAMESPACE || child.local !== 'value');
  if (stranger !== undefined) {
    throw new CrsFormatError(`ответ crs: в массиве ${parent.name} элемент ${stranger.name}`);
  }
  return [...parent.children];
}

/** Атрибут value обязателен: пустая строка — значение, отсутствие — другой формат. */
export function stringValue(element: CrsXmlElement): string {
  const value = element.attributes.get('value');
  if (value === undefined) {
    throw new CrsFormatError(`ответ crs: у ${element.name} нет атрибута value`);
  }
  return value;
}

export function integerValue(element: CrsXmlElement): number {
  const value = stringValue(element);
  if (!INTEGER.test(value)) {
    throw new CrsFormatError(`ответ crs: ${element.name} — не целое число`);
  }
  return Number(value);
}

export function booleanValue(element: CrsXmlElement): boolean {
  const value = stringValue(element);
  if (value !== 'true' && value !== 'false') {
    throw new CrsFormatError(`ответ crs: ${element.name} — не логическое значение`);
  }
  return value === 'true';
}

/** CrsFormatError декодера → CrsCallError('malformed-response', …, { method, cause }); прочее — как есть. */
export function decodeReturn<T>(method: string, root: CrsXmlElement, decode: (root: CrsXmlElement) => T): T {
  try {
    return decode(root);
  } catch (e) {
    if (e instanceof CrsFormatError) {
      throw new CrsCallError('malformed-response', `${method}: ${e.message}`, { method, cause: e });
    }
    throw e;
  }
}
