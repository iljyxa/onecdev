import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FormToolsService } from '../../infra/xml/form/FormToolsService';
import { skipWithoutCorpus } from './support/corpus';

/**
 * Форма списка регистра (#128): у регистра расчёта стандартного реквизита `Period` нет, есть
 * `RegistrationPeriod`. Колонка `Список.Period` давала при импорте 8.5.1 «Неверный путь к данным».
 * Регистры накопления и бухгалтерии сохраняют `Список.Period`. Фикстуры — реальная выгрузка.
 */
const CASES: { folder: string; name: string; periodPath: string; absentPath: string }[] = [
  { folder: 'CalculationRegisters', name: 'Начисления', periodPath: 'Список.RegistrationPeriod', absentPath: 'Список.Period' },
  { folder: 'AccumulationRegisters', name: 'ТоварыНаСкладах', periodPath: 'Список.Period', absentPath: 'Список.RegistrationPeriod' },
  { folder: 'AccountingRegisters', name: 'Хозрасчетный', periodPath: 'Список.Period', absentPath: 'Список.RegistrationPeriod' },
];

suite('FormToolsService.addForm — колонка периода в форме списка регистра (#128)', () => {
  suiteSetup(function () {
    skipWithoutCorpus(this);
  });

  for (const version of ['2.20', '2.21']) {
    for (const { folder, name, periodPath, absentPath } of CASES) {
      test(`${version}: ${folder}/${name} → ${periodPath}`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-form-register-'));
        try {
          fs.mkdirSync(path.join(root, folder));
          const objectPath = path.join(root, folder, `${name}.xml`);
          fs.copyFileSync(path.resolve(__dirname, '../../../example', version, 'src', 'cf', folder, `${name}.xml`), objectPath);

          new FormToolsService().addForm({ objectPath, formName: 'ФормаСписка', purpose: 'List' });

          const formXml = fs.readFileSync(path.join(root, folder, name, 'Forms', 'ФормаСписка', 'Ext', 'Form.xml'), 'utf-8');
          assert.ok(formXml.includes(`<DataPath>${periodPath}</DataPath>`), formXml);
          assert.ok(!formXml.includes(`<DataPath>${absentPath}</DataPath>`), formXml);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});
