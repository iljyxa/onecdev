import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EXAMPLE_ROOT, hasCorpus } from './corpus';

/**
 * Корень эталонных выгрузок 1С (генерации формата 2.20 и 2.21) и признак его
 * наличия — реэкспорт из `support/corpus.ts`: знание о корпусе одно на проект,
 * здесь оставлено только ради привычного для тестов форм имени `hasFormCorpus`.
 */
export { EXAMPLE_ROOT };

/**
 * Рекурсивно находит все `Form.xml` под заданным корнем. Используется для
 * широкого sweep-теста (регресс «ноль ложных срабатываний» по всему корпусу
 * эталонов) и для курируемого списка форм-носителей.
 */
export function findAllFormXmlFiles(root: string): string[] {
  // Каталог `example/` лежит в .gitignore, поэтому на чистом клоне его нет.
  // Обход вызывается на этапе ЗАГРУЗКИ модуля (генерация тестов в цикле), и
  // необработанный ENOENT здесь рушит весь прогон Mocha целиком, а не помечает
  // тесты упавшими — никакой MOCHA_GREP от этого не спасает. Поэтому
  // отсутствие корня — пустой список, а видимость пропуска даёт hasFormCorpus().
  if (!fs.existsSync(root)) {
    return [];
  }
  const result: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === 'Form.xml') {
        result.push(full);
      }
    }
  };
  walk(root);
  return result;
}

/**
 * Пишет XML формы во временный каталог со структурой `<root>/Форма/Ext/Form.xml`,
 * как ожидает `resolveFormXmlPath`. Возвращает путь к записанному файлу.
 */
export function writeFormCopy(xml: string, root?: string): string {
  const base = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-formids-'));
  const dir = path.join(base, 'Форма', 'Ext');
  fs.mkdirSync(dir, { recursive: true });
  const formPath = path.join(dir, 'Form.xml');
  fs.writeFileSync(formPath, xml, 'utf-8');
  return formPath;
}

/** Есть ли локальный корпус эталонов: без него корпус-зависимые сьюты пропускаются, а не падают. */
export function hasFormCorpus(): boolean {
  return hasCorpus();
}

/**
 * Форма-донор корпуса форка для тестов, которым нужна реальная выгрузка формы «вообще»
 * (BOM + CRLF, элементы с контекстными меню и подсказками, таблица, реквизит `Объект`),
 * а не конкретная конструкция: `Catalogs/Контрагенты/Forms/ФормаЭлемента` генерации 2.20.
 * Элементы: InputField «Код» id=1, ContextMenu id=2, ExtendedTooltip id=3 … максимум id=31;
 * реквизит формы «Объект» id=1 (пересекается с id элемента — это разные пространства).
 */
export const DONOR_FORM = path.join(
  EXAMPLE_ROOT, '2.20', 'src', 'cf', 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext', 'Form.xml'
);

/**
 * Пропускает тест, если форма-носитель нужной ему конструкции отсутствует в корпусе.
 * Корпус форка меньше авторского: части конструкций (`BaseForm` заимствованной формы,
 * `AdditionalColumns`, специальные поля) в нём нет. Тест не удаляется — он оживает, когда
 * корпус получит носитель.
 */
export function skipWithoutFormFixture(context: Mocha.Context, formPath: string): void {
  if (!fs.existsSync(formPath)) {
    context.skip();
  }
}
