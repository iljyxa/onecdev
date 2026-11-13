import * as fs from 'fs';
import * as assert from 'assert';
import * as path from 'path';
import {
  buildCommonFormReference,
  buildFormPickerOptions,
  buildOwnFormReference,
  getEmptyFormPickerMessage,
} from '../../ui/views/properties/formPickerOptions';
import { parseConfigXml, parseObjectXml } from '../../infra/xml';
import { EXAMPLE_ROOT, skipWithoutCorpus } from './support/corpus';

/**
 * Варианты выбора формы: пикер обязан предлагать и собственные формы объекта, и
 * общие формы конфигурации. Раньше он знал только собственные — у отчёта и
 * константы, где почти все ссылки ведут на общие формы, он был пуст всегда.
 */
suite('formPickerOptions — варианты выбора формы', () => {
  test('только собственные формы: ссылка «<Вид>.<Имя>.Form.<Форма>», порядок по алфавиту', () => {
    const options = buildFormPickerOptions({
      ownerKind: 'Catalog',
      ownerName: 'Контрагенты',
      ownForms: ['ФормаСписка', 'ФормаЭлемента', 'ФормаВыбора'],
      commonForms: [],
    });

    assert.deepStrictEqual(options, [
      { label: 'ФормаВыбора', reference: 'Catalog.Контрагенты.Form.ФормаВыбора', source: 'own' },
      { label: 'ФормаСписка', reference: 'Catalog.Контрагенты.Form.ФормаСписка', source: 'own' },
      { label: 'ФормаЭлемента', reference: 'Catalog.Контрагенты.Form.ФормаЭлемента', source: 'own' },
    ]);
  });

  test('только общие формы: ссылка «CommonForm.<Форма>» — случай отчёта и константы', () => {
    const options = buildFormPickerOptions({
      ownerKind: 'Report',
      ownerName: 'ОстаткиТоваров',
      ownForms: [],
      commonForms: ['ФормаОтчета', 'ФормаВариантаОтчета'],
    });

    assert.deepStrictEqual(options, [
      { label: 'ФормаВариантаОтчета', reference: 'CommonForm.ФормаВариантаОтчета', source: 'common' },
      { label: 'ФормаОтчета', reference: 'CommonForm.ФормаОтчета', source: 'common' },
    ]);
  });

  test('и собственные, и общие: свои идут первыми (в эталоне их 3 163 против 283 общих)', () => {
    const options = buildFormPickerOptions({
      ownerKind: 'Report',
      ownerName: 'Продажи',
      ownForms: ['ФормаОтчета'],
      commonForms: ['АльфаФорма', 'ФормаНастроекОтчета'],
    });

    assert.deepStrictEqual(options.map((option) => [option.source, option.reference]), [
      ['own', 'Report.Продажи.Form.ФормаОтчета'],
      ['common', 'CommonForm.АльфаФорма'],
      ['common', 'CommonForm.ФормаНастроекОтчета'],
    ]);
  });

  test('ни одной формы: список пуст, а сообщение называет обе причины сразу', () => {
    const options = buildFormPickerOptions({
      ownerKind: 'DataProcessor',
      ownerName: 'Пустая',
      ownForms: [],
      commonForms: [],
    });

    assert.deepStrictEqual(options, []);
    const message = getEmptyFormPickerMessage();
    assert.ok(message.includes('собственных форм'), `в сообщении нет причины «нет своих форм»: ${message}`);
    assert.ok(message.includes('общих форм'), `в сообщении нет причины «нет общих форм»: ${message}`);
  });

  test('безымянные формы отбрасываются: пустая ссылка в XML недопустима', () => {
    const options = buildFormPickerOptions({
      ownerKind: 'Catalog',
      ownerName: 'Товары',
      ownForms: ['', 'ФормаСписка'],
      commonForms: ['', 'ОбщаяФорма'],
    });

    assert.deepStrictEqual(options.map((option) => option.label), ['ФормаСписка', 'ОбщаяФорма']);
  });

  test('совпадение имён своей и общей формы не схлопывается: разные ссылки, обе доступны', () => {
    const options = buildFormPickerOptions({
      ownerKind: 'Report',
      ownerName: 'Продажи',
      ownForms: ['ФормаОтчета'],
      commonForms: ['ФормаОтчета'],
    });

    assert.deepStrictEqual(options, [
      { label: 'ФормаОтчета', reference: 'Report.Продажи.Form.ФормаОтчета', source: 'own' },
      { label: 'ФормаОтчета', reference: 'CommonForm.ФормаОтчета', source: 'common' },
    ]);
    // Различить их человек может только по ссылке — она и уходит в description
    // элемента списка, поэтому обязана быть разной.
    assert.notStrictEqual(options[0].reference, options[1].reference);
  });

  test('порядок внутри группы — русская локаль, а не коды символов', () => {
    const options = buildFormPickerOptions({
      ownerKind: 'Catalog',
      ownerName: 'Товары',
      ownForms: ['Ёмкость', 'Единица', 'Ежедневная'],
      commonForms: [],
    });

    // В порядке кодовых точек «Ё» (U+0401) идёт ПЕРЕД «Е» (U+0415) — наивная
    // сортировка поставила бы «Ёмкость» первой. Русская локаль ставит Ё как Е.
    assert.deepStrictEqual(options.map((option) => option.label), ['Единица', 'Ежедневная', 'Ёмкость']);
  });

  test('конструкторы ссылок дают ровно две формы записи, снятые с эталона', () => {
    assert.strictEqual(buildOwnFormReference('Report', 'Продажи', 'ФормаОтчета'), 'Report.Продажи.Form.ФормаОтчета');
    assert.strictEqual(buildCommonFormReference('ФормаОтчета'), 'CommonForm.ФормаОтчета');
  });
});

suite('formPickerOptions — сшивка с реальной выгрузкой example/', () => {
  suiteSetup(function () {
    skipWithoutCorpus(this);
  });

  function commonFormsOf(configRoot: string): string[] {
    return parseConfigXml(path.join(configRoot, 'Configuration.xml')).childObjects.get('CommonForm') ?? [];
  }

  test('отчёт со своей формой получает и свои, и общие формы', function () {
    const configRoot = path.join(EXAMPLE_ROOT, '2.21', 'src', 'cf');
    const commonForms = commonFormsOf(configRoot);
    assert.ok(commonForms.length > 0, 'в эталонной выгрузке должны быть общие формы');
    // Первый отчёт эталона с собственной формой. В корпусе форка таких отчётов нет — тест
    // оживает, когда корпус их получит (авторский брал АнализБазыКонтрагентов).
    const reportsDir = path.join(configRoot, 'Reports');
    const withOwnForm = fs.readdirSync(reportsDir)
      .filter((name) => name.endsWith('.xml'))
      .sort()
      .map((name) => ({
        name: path.basename(name, '.xml'),
        forms: (parseObjectXml(path.join(reportsDir, name))?.children ?? [])
          .filter((child) => child.tag === 'Form')
          .map((child) => child.name),
      }))
      .find((report) => report.forms.length > 0);
    if (!withOwnForm) {
      this.skip();
    }
    const reportOptions = buildFormPickerOptions({
      ownerKind: 'Report',
      ownerName: withOwnForm.name,
      ownForms: withOwnForm.forms,
      commonForms,
    });
    assert.ok(reportOptions.some((option) => option.source === 'own'), 'своя форма отчёта должна быть в списке');
    assert.ok(
      commonForms.every((form) => reportOptions.some((option) => option.reference === `CommonForm.${form}`)),
      'все общие формы должны быть доступны для выбора'
    );
  });

  test('константа получает непустой список из общих форм', () => {
    const configRoot = path.join(EXAMPLE_ROOT, '2.21', 'src', 'cf');
    const commonForms = commonFormsOf(configRoot);
    assert.ok(commonForms.length > 0, 'в эталонной выгрузке должны быть общие формы');
    // Константа: собственных форм у неё не бывает вовсе — без общих список был бы пуст.
    const constantName = fs.readdirSync(path.join(configRoot, 'Constants'))
      .filter((name) => name.endsWith('.xml'))
      .sort()[0];
    assert.ok(constantName, 'в эталонной выгрузке должна быть константа');
    const constantOptions = buildFormPickerOptions({
      ownerKind: 'Constant',
      ownerName: path.basename(constantName, '.xml'),
      ownForms: [],
      commonForms,
    });
    assert.strictEqual(constantOptions.length, commonForms.length);
    assert.ok(constantOptions.every((option) => option.source === 'common'));
  });
});
