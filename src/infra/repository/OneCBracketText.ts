// Скобочный текст 1С (`{uuid,"текст",{...},4,...}`) — внутренний формат платформы: в нём записаны описания
// таблиц файла 1CD и полезная нагрузка исключений сервера хранилища. Один разборщик для обоих, поэтому
// ошибка нейтральная (BracketFormatError): потребитель сам переводит её в ошибку своего уровня.
// Разбор итеративный (стек в массиве) по таблице переходов: любой токен не на своём месте — одна и та же
// ошибка формата, без отдельных веток на каждый случай. Корень ровно один: хвост после него — ошибка.

/** Строка в кавычках; удвоенные кавычки внутри раскрыты. */
export interface BracketString {
  readonly quoted: string;
}
/** Голый атом (uuid, число) — строка как есть. */
export type BracketValue = string | BracketString | BracketList;
export type BracketList = readonly BracketValue[];

/** Нарушение скобочного формата; сообщение — причина и смещение, без содержимого (в нём бывают пути и имена). */
export class BracketFormatError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = 'BracketFormatError';
  }
}

type Token = 'open' | 'close' | 'comma' | 'value';
type State = 'start' | 'afterOpen' | 'afterValue' | 'afterComma' | 'done';

const TRANSITIONS: Readonly<Record<State, Partial<Record<Token, State>>>> = {
  start: { open: 'afterOpen' },
  afterOpen: { open: 'afterOpen', close: 'afterValue', value: 'afterValue' },
  afterValue: { comma: 'afterComma', close: 'afterValue' },
  afterComma: { open: 'afterOpen', value: 'afterValue' },
  done: {},
};

const TOKEN = /\s*("(?:[^"]|"")*"|[{},]|[^\s{},"]+)/y;
const PUNCTUATION: ReadonlyMap<string, Token> = new Map([
  ['{', 'open'],
  ['}', 'close'],
  [',', 'comma'],
]);

export function parseBracketText(text: string): BracketList {
  const s = text.replace(/^\uFEFF/, '').trimEnd();
  // Держатель корня внизу стека: у любого открываемого списка есть куда себя положить.
  const holder: BracketValue[] = [];
  const stack: BracketValue[][] = [holder];
  let state: State = 'start';
  let pos = 0;
  while (pos < s.length) {
    TOKEN.lastIndex = pos;
    const match = TOKEN.exec(s);
    if (match === null) {
      throw new BracketFormatError('скобочный текст: незавершённая строка или недопустимый символ', pos);
    }
    const token = match[1];
    const kind = PUNCTUATION.get(token) ?? 'value';
    const next: State | undefined = TRANSITIONS[state][kind];
    if (next === undefined) {
      throw new BracketFormatError(`скобочный текст: неожиданный токен после ${state}`, pos);
    }
    pos = TOKEN.lastIndex;
    state = next;
    const current = stack[stack.length - 1];
    if (kind === 'open') {
      const list: BracketValue[] = [];
      current.push(list);
      stack.push(list);
    } else if (kind === 'close') {
      stack.pop();
      state = stack.length === 1 ? 'done' : state;
    } else if (kind === 'value') {
      current.push(token.startsWith('"') ? { quoted: token.slice(1, -1).replace(/""/g, '"') } : token);
    }
  }
  if (state !== 'done') {
    throw new BracketFormatError('скобочный текст: не завершён', s.length);
  }
  return holder[0] as BracketList;
}

/** Строка в кавычках или атом — как текст; список или отсутствие элемента — undefined. */
export function bracketScalar(value: BracketValue | undefined): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  return value === undefined || Array.isArray(value) ? undefined : (value as BracketString).quoted;
}
