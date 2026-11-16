/**
 * Классификация отказа частичной загрузки конфигурации из файлов (`/LoadConfigFromFiles -partial`)
 * по тексту причины из журнала Конфигуратора. От класса зависит, есть ли смысл предлагать
 * пользователю полную загрузку: в базе, привязанной к хранилищу, платформа отклоняет её всегда
 * («текущая конфигурация помещена в хранилище»), и предложение лишь прячет истинную причину (#113).
 *
 * Строки сняты с платформы 8.5.1.1529 (на 8.3.27.2342 совпадают, стенд #108).
 */
export type PartialLoadRefusal =
  | { readonly kind: 'not-locked-in-repository'; readonly objects: readonly string[] }
  | { readonly kind: 'configuration-in-repository' }
  | { readonly kind: 'configuration-id-mismatch' }
  | { readonly kind: 'other' };

const NOT_LOCKED_RE = /объект метаданных\s+(\S+)\s+не захвачен в хранилище/gi;

export function classifyPartialLoadRefusal(reason: string): PartialLoadRefusal {
  // Отказ хранилища проверяется первым: он точнее и исключает полную загрузку.
  const objects = Array.from(new Set(Array.from(reason.matchAll(NOT_LOCKED_RE), (match) => match[1])));
  if (objects.length > 0) {
    return { kind: 'not-locked-in-repository', objects };
  }
  if (/текущая конфигурация помещена в хранилище/i.test(reason)) {
    return { kind: 'configuration-in-repository' };
  }
  if (/идентификатор[\s\S]*загружаемой конфигурации[\s\S]*отличается[\s\S]*сохраненной/i.test(reason)
    || /ошибка частичной загрузки/i.test(reason)) {
    return { kind: 'configuration-id-mismatch' };
  }
  return { kind: 'other' };
}

/**
 * Сообщение пользователю для отказа, при котором полная загрузка бессмысленна; `undefined` —
 * отказ не связан с хранилищем, и решение о полной загрузке остаётся за пользователем.
 */
export function describeRepositoryLoadRefusal(refusal: PartialLoadRefusal, targetLabel: string): string | undefined {
  if (refusal.kind === 'not-locked-in-repository') {
    return `Загрузка изменений ${targetLabel} отклонена платформой: база привязана к хранилищу, `
      + `а объекты не захвачены: ${refusal.objects.join(', ')}. `
      + 'Захватите их в хранилище или отмените их изменения. Полная загрузка в привязанную базу платформой запрещена.';
  }
  if (refusal.kind === 'configuration-in-repository') {
    return `Загрузка изменений ${targetLabel} отклонена платформой: конфигурация базы помещена в хранилище, `
      + 'полная загрузка запрещена. Захватите изменённые объекты в хранилище и повторите обновление.';
  }
  return undefined;
}
