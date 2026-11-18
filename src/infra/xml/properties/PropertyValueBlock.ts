import { escapeXmlText, isEmptyPropertyValue } from '../XmlUtils';

/**
 * Сборка XML-блока значения одного свойства. Вынесено из `ObjectXmlReader`
 * без изменений поведения: тот же блок нужен писателю стандартных реквизитов
 * (`StandardAttributesBlock`), и вторая копия построителя разошлась бы с первой.
 */
export type PropertyValueKind = 'string' | 'boolean' | 'localizedString' | 'metadataReferenceList' | 'metadataFieldList';

export function buildPropertyValueBlock(
  propertyKey: string,
  valueKind: PropertyValueKind,
  value: string | boolean | string[],
  blockIndent: string
): string {
  if (valueKind === 'boolean') {
    return `<${propertyKey}>${value === true ? 'true' : 'false'}</${propertyKey}>`;
  }
  if (valueKind === 'metadataReferenceList') {
    const items = Array.isArray(value) ? value : [];
    if (items.length === 0) {
      return `<${propertyKey}/>`;
    }
    return [
      `<${propertyKey}>`,
      ...items.map((item) => `\t\t\t\t<xr:Item xsi:type="xr:MDObjectRef">${escapeXmlText(item)}</xr:Item>`),
      `\t\t\t</${propertyKey}>`,
    ].join('\n');
  }
  if (valueKind === 'metadataFieldList') {
    const items = Array.isArray(value) ? value : [];
    if (items.length === 0) {
      return `<${propertyKey}/>`;
    }
    return [
      `<${propertyKey}>`,
      ...items.map((item) => `\t\t\t\t<xr:Field>${escapeXmlText(item)}</xr:Field>`),
      `\t\t\t</${propertyKey}>`,
    ].join('\n');
  }
  // Сюда управление доходит только для 'string' и 'localizedString': boolean и
  // оба списочных вида обработаны выше и уже вернули свой блок (у них своя
  // пустота — пустой список).
  if (isEmptyPropertyValue(value)) {
    return `<${propertyKey}/>`;
  }
  if (valueKind === 'localizedString') {
    const content = escapeXmlText(typeof value === 'string' ? value : String(value));
    // Отступы — от места САМОГО свойства, а не фиксированные: блок пишется и на
    // корне объекта, и у дочернего элемента, где глубина другая. С хардкодом
    // цикл «очистить → заполнить заново» уводил `<v8:item>` на лишний уровень,
    // а закрывающий тег — в нулевую колонку.
    return [
      `<${propertyKey}>`,
      `${blockIndent}\t<v8:item>`,
      `${blockIndent}\t\t<v8:lang>ru</v8:lang>`,
      `${blockIndent}\t\t<v8:content>${content}</v8:content>`,
      `${blockIndent}\t</v8:item>`,
      `${blockIndent}</${propertyKey}>`,
    ].join('\n');
  }
  return `<${propertyKey}>${escapeXmlText(String(value))}</${propertyKey}>`;
}

export function updateLocalizedPropertyContent(propertyBlock: string, value: string | boolean | string[]): string {
  const content = escapeXmlText(typeof value === 'string' ? value : String(value));
  const contentRe = /(<v8:content>)[\s\S]*?(<\/v8:content>)/;
  // Парный блок свойства с САМОЗАКРЫТЫМ `<v8:content/>` внутри: в эталоне такой
  // формы нет ни разу (0 при 105 278 заполненных), и наш писатель её не создаёт —
  // пустое локализованное значение схлопывается в `<Synonym/>` целиком. Ветка
  // оставлена как защита от файла, отредактированного человеком вручную, и из
  // production недостижима.
  /* c8 ignore next 3 */
  if (!contentRe.test(propertyBlock)) {
    return propertyBlock.replace(/<v8:content\s*\/>/, () => `<v8:content>${content}</v8:content>`);
  }
  return propertyBlock.replace(contentRe, (_m, open: string, close: string) => `${open}${content}${close}`);
}
