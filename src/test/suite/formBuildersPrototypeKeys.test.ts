import * as assert from 'assert';
import { buildFormXmlFromDefinition, withCollectedWarnings } from '../../infra/xml/form/FormBuilders';

/**
 * Ключи DSL формы приходят и от ИИ-агента через MCP (`compile_form`/`edit_form`). Имена, совпадающие
 * с членами `Object.prototype`, не должны находить «значение» в таблицах генератора (#144).
 */
suite('Генератор форм: ключи DSL с именами Object.prototype (#144)', () => {
  const PROTO_NAMES = ['constructor', 'toString', 'hasOwnProperty'] as const;

  function build(definition: Parameters<typeof buildFormXmlFromDefinition>[0]): string {
    return withCollectedWarnings(() => buildFormXmlFromDefinition(definition, '2.21')).result;
  }

  for (const name of PROTO_NAMES) {
    test(`свойство формы «${name}» пишется тегом по общему правилу`, () => {
      const tag = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      assert.ok(build({ properties: { [name]: 'x' } }).includes(`\n\t<${tag}>x</${tag}>\n`));
    });

    test(`тип реквизита «${name}» — неизвестный простой тип, а не значение из таблицы типов`, () => {
      const { result, warnings } = withCollectedWarnings(() =>
        buildFormXmlFromDefinition({ attributes: [{ name: 'Р', type: name }] }, '2.21'));
      assert.ok(result.includes(`<v8:Type>${name}</v8:Type>`), result);
      assert.ok(warnings.some((w) => w.includes(`Unrecognized bare type '${name}'`)), warnings.join('\n'));
    });

    test(`тип кнопки «${name}» пишется как есть`, () => {
      const xml = build({ elements: [{ button: 'Кнопка', command: 'Команда', type: name }] });
      assert.ok(xml.includes(`<Type>${name}</Type>`), xml);
    });

    test(`событие поля «${name}» — обработчик по общему правилу «имя элемента + событие»`, () => {
      const xml = build({
        elements: [{ input: 'Поле', path: 'Объект.Поле', on: [name] }],
        attributes: [{ name: 'Объект', type: 'CatalogObject.Контрагенты', main: true }],
      });
      assert.ok(xml.includes(`>Поле${name}</Event>`), xml);
    });
  }

  test('тип реквизита с префиксом-именем Object.prototype остаётся ссылкой cfg:', () => {
    assert.ok(build({ attributes: [{ name: 'Р', type: 'constructor.X' }] }).includes('<v8:Type>cfg:constructor.X</v8:Type>'));
  });

  test('известные таблицы по-прежнему работают: синоним типа, тип DCS, недопустимый тип, суффикс события', () => {
    const xml = build({
      elements: [{ input: 'Поле', path: 'Объект.Поле', on: ['OnChange'] }],
      attributes: [
        { name: 'Объект', type: 'CatalogObject.Контрагенты', main: true },
        { name: 'Настройки', type: 'DataCompositionSettings' },
      ],
    });
    assert.ok(xml.includes('<v8:Type>dcsset:DataCompositionSettings</v8:Type>'), xml);
    assert.ok(xml.includes('>ПолеПриИзменении</Event>'), xml);
    assert.throws(() => build({ attributes: [{ name: 'Р', type: 'FormDataTreeItem' }] }), /Invalid form attribute type 'FormDataTreeItem'/);
  });
});
