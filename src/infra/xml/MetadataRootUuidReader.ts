import * as fs from 'fs';

// Первый элемент внутри <MetaDataObject> (комментарии перед ним допустимы) — корень объекта выгрузки.
const ROOT_ELEMENT = /<MetaDataObject\b[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<[A-Za-z][\w.:-]*\b([^>]*)>/;
const UUID_ATTRIBUTE = /\suuid="([^"]*)"/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * uuid объекта метаданных из XML выгрузки: атрибут `uuid` корневого элемента внутри
 * `<MetaDataObject>` (`<Catalog uuid>`, `<Form uuid>` дескриптора формы, `<Configuration uuid>`).
 * Он же — идентификатор объекта в протоколе хранилища, поэтому им фильтруется история. Атрибуты
 * вложенных элементов (реквизиты, ТЧ) не рассматриваются; нет uuid или не GUID — `null`.
 */
export function readMetadataRootUuid(xmlText: string): string | null {
  const attributes = ROOT_ELEMENT.exec(xmlText.replace(/^\uFEFF/, ''))?.[1];
  const uuid = attributes === undefined ? undefined : UUID_ATTRIBUTE.exec(attributes)?.[1];
  return uuid !== undefined && GUID.test(uuid) ? uuid.toLowerCase() : null;
}

/** То же по файлу; файл не читается — `null`. Читает синхронно — только по команде пользователя. */
export function readMetadataRootUuidFile(xmlPath: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(xmlPath, 'utf-8');
  } catch {
    return null;
  }
  return readMetadataRootUuid(text);
}
