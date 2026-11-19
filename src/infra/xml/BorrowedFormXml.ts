import { findDirectElementRanges, findNestingAwareElementRange } from './XmlUtils';

/**
 * Сборка `Ext/Form.xml` заимствованной формы из `Ext/Form.xml` исходной формы конфигурации.
 *
 * Расширение получает форму без собственных изменений: верхний уровень — только командная панель
 * формы, `BaseForm` — снимок состава исходной формы (командная панель и элементы) с очищенными
 * ссылками на команды, пути к данным и обработчики, которых в расширении нет.
 *
 * Состав и порядок сняты с выгрузки платформы (`ibcmd` import → export, 8.3.27 / формат 2.20 и
 * 8.5.1 / формат 2.21, #167), от версии формата они не зависят — версия `BaseForm` берётся из
 * исходной формы:
 *  - пустой `<ChildItems/>` верхнего уровня платформа не выгружает;
 *  - `AutoCommandBar` формы платформа пишет всегда — и на верхнем уровне, и в `BaseForm`; без
 *    него в исходнике она подставляет `<AutoCommandBar name="" id="-1"/>`, с ним — сохраняет;
 *  - у формы объекта/группы (исходная форма несёт `UseForFoldersAndItems` — платформа оставляет
 *    его только им, у формы списка выбрасывает) на уровне, где есть кнопка (`<Button>` в командной
 *    панели или элементах), платформа дописывает `<UseForFoldersAndItems>Items` перед
 *    `AutoCommandBar` — именно `Items`, какое бы значение ни стояло в исходнике;
 *  - фрагменты исходной формы внутри `BaseForm` сдвинуты на уровень вложенности глубже.
 *
 * Модуль чистый (строка на входе — строка на выходе); BOM и CRLF добавляет `writeNewExportFile`.
 */

const DEFAULT_XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
const DEFAULT_FORM_VERSION = '2.17';
const EMPTY_AUTO_COMMAND_BAR = '<AutoCommandBar name="" id="-1"/>';
const USE_FOR_ITEMS = '<UseForFoldersAndItems>Items</UseForFoldersAndItems>';

export function buildBorrowedFormExtXml(sourceFormXml: string): string {
  const source = sourceFormXml.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const xmlDecl = /^(<\?xml[^?]*\?>)/.exec(source)?.[1] ?? DEFAULT_XML_DECL;
  const formTag = /(<Form[^>]*>)/.exec(source)?.[1] ?? '<Form>';
  const formVersion = /version="([^"]+)"/.exec(formTag)?.[1] ?? DEFAULT_FORM_VERSION;

  // Прямые дети <Form> с учётом вложенности: нежадный поиск обрывался на ChildItems
  // таблицы/группы, и BaseForm получал незакрытые теги — платформа отклоняла загрузку расширения.
  const formRange = findNestingAwareElementRange(source, 'Form');
  // Рукописный файл без корня <Form> → пустой состав элементов.
  const formInner = formRange ? source.slice(formRange.openEnd, formRange.closeStart) : '';
  const directChild = (tag: string): string | undefined => {
    const range = findDirectElementRanges(formInner, tag).at(0);
    return range ? cleanFormFragment(formInner.slice(range.start, range.end)) : undefined;
  };

  const autoCommandBar = directChild('AutoCommandBar') ?? EMPTY_AUTO_COMMAND_BAR;
  const childItems = directChild('ChildItems');
  const usesFoldersAndItems = findDirectElementRanges(formInner, 'UseForFoldersAndItems').length > 0;
  const useForFoldersAndItems = (fragments: readonly string[], depth: number): string[] =>
    usesFoldersAndItems && fragments.some(hasButton) ? ['\t'.repeat(depth) + USE_FOR_ITEMS] : [];

  return [
    xmlDecl,
    formTag,
    ...useForFoldersAndItems([autoCommandBar], 1),
    indentFragment(autoCommandBar, 1),
    `\t<Attributes/>`,
    `\t<BaseForm version="${formVersion}">`,
    ...useForFoldersAndItems([autoCommandBar, childItems ?? ''], 2),
    indentFragment(autoCommandBar, 2),
    ...(childItems ? [indentFragment(childItems, 2)] : []),
    `\t\t<Attributes/>`,
    `\t</BaseForm>`,
    `</Form>`,
  ].join('\n');
}

function hasButton(fragment: string): boolean {
  return /<Button[\s/>]/.test(fragment);
}

/**
 * Команды, пути к данным и обработчики исходной формы в расширении — битые ссылки (реквизитов и
 * команд формы у заимствования нет), поэтому они очищаются. Литералы замен без `$`-шаблонов.
 */
function cleanFormFragment(xml: string): string {
  return xml
    .replace(/ xmlns(?::\w+)?="[^"]*"/g, '')
    .replace(/<CommandName>[^<]*<\/CommandName>/g, '<CommandName>0</CommandName>')
    .replace(/\s*<DataPath>[^<]*<\/DataPath>/g, '')
    .replace(/\s*<TitleDataPath>[^<]*<\/TitleDataPath>/g, '')
    .replace(/\s*<RowPictureDataPath>[^<]*<\/RowPictureDataPath>/g, '')
    .replace(/\s*<ExcludedCommand>[^<]*<\/ExcludedCommand>/g, '')
    .replace(/\s*<Events>[\s\S]*?<\/Events>/g, '');
}

/**
 * Фрагмент прямого ребёнка `<Form>` (в исходнике — глубина 1) на глубину `depth`: первая строка
 * получает отступ целиком, остальные строки разметки — разницу глубин. Строка разметки начинается
 * с `<` после отступа (литеральный `<` в тексте экранирован); продолжение многострочного текста
 * узла не трогается — это содержимое, а не отступ.
 */
function indentFragment(fragment: string, depth: number): string {
  const extra = '\t'.repeat(depth - 1);
  return fragment
    .split('\n')
    .map((line, index) => {
      if (index === 0) {
        return '\t'.repeat(depth) + line;
      }
      return /^\t*</.test(line) ? extra + line : line;
    })
    .join('\n');
}
