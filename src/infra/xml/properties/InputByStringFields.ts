import { getDefaultStandardAttributeIndexing } from '../../../domain/StandardAttribute';
import { extractChildMetaElementXml, extractSimpleTag } from '../XmlUtils';

/**
 * Индексируется ли поле объекта — кандидат в «поля ввода по строке».
 *
 * У стандартного реквизита `xr:Indexing` в выгрузке не бывает (0 вхождений и в
 * шаблонах умолчаний платформы, и в корпусе), поэтому его индексация берётся
 * только из умолчаний домена, а XML объекта не читается. У реквизита,
 * измерения и ресурса — собственный `<Indexing>`.
 */
export function isInputByStringFieldIndexed(objectXml: string, objectKind: string, tag: string, name: string): boolean {
  if (tag === 'StandardAttribute') {
    const defaultIndexing = getDefaultStandardAttributeIndexing(objectKind, name);
    return defaultIndexing !== undefined && defaultIndexing !== 'DontIndex';
  }
  const elementXml = extractChildMetaElementXml(objectXml, tag, name);
  const indexing = elementXml ? extractSimpleTag(elementXml, 'Indexing') : undefined;
  return indexing ? indexing !== 'DontIndex' : false;
}
