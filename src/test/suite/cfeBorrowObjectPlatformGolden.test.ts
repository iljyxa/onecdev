import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CfeBorrowService } from '../../infra/cfe/CfeBorrowService';

/**
 * #170: оболочка заимствованного объекта любого вида совпадает с выгрузкой платформы.
 *
 * Эталоны `src/test/fixtures/borrowed-object/<формат>/<Папка>/<Имя>.xml` сняты так: копия EVOLC
 * (для 2.20 — с `version="2.20"`) → `borrowObject(example/<формат>/src/cf, …)` для каждого вида
 * ниже → `ibcmd infobase config import --extension=EVOLC` → `ibcmd infobase config export
 * --extension=EVOLC` на 8.3.27 (2.20) и 8.5.1 (2.21). До исправления платформа отбивала
 * загрузку: ПВХ, ПВР, план счетов, бизнес-процесс и регистры бухгалтерии/расчёта — «отсутствует
 * один или более типов объекта» (неполный `<InternalInfo>`), критерий отбора, хранилище
 * настроек, внешний источник данных и сервис интеграции — «ожидаемое ChildObjects».
 *
 * Нормализуются только случайные идентификаторы (uuid объекта, TypeId/ValueId, ThisNode);
 * `ExtendedConfigurationObject`, BOM и EOL сравниваются как есть.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'src', 'test', 'fixtures', 'borrowed-object');

const CASES: readonly (readonly [kind: string, folder: string, name: string])[] = [
  ['Catalog', 'Catalogs', 'АвансовыйОтчетПрисоединенныеФайлы'],
  ['Document', 'Documents', 'АвансовыйОтчет'],
  ['Enum', 'Enums', 'PushУведомления'],
  ['Constant', 'Constants', 'ИспользоватьВозвраты'],
  ['InformationRegister', 'InformationRegisters', 'КонтактнаяИнформация'],
  ['AccumulationRegister', 'AccumulationRegisters', 'БонусныеБаллы'],
  ['AccountingRegister', 'AccountingRegisters', 'Хозрасчетный'],
  ['CalculationRegister', 'CalculationRegisters', 'Начисления'],
  ['ChartOfAccounts', 'ChartsOfAccounts', 'Хозрасчетный'],
  ['ChartOfCharacteristicTypes', 'ChartsOfCharacteristicTypes', 'ВидыСубконтоХозрасчетные'],
  ['ChartOfCalculationTypes', 'ChartsOfCalculationTypes', 'ОсновныеНачисления'],
  ['BusinessProcess', 'BusinessProcesses', 'Поручение'],
  ['Task', 'Tasks', 'ЗадачаИсполнителя'],
  ['ExchangePlan', 'ExchangePlans', 'Мобильные'],
  ['DefinedType', 'DefinedTypes', 'КонтактноеЛицо'],
  ['DocumentJournal', 'DocumentJournals', 'ДокументыСклада'],
  ['Report', 'Reports', 'Запасы'],
  ['DataProcessor', 'DataProcessors', 'Обработка1'],
  ['FilterCriterion', 'FilterCriteria', 'ДокументыКонтрагента'],
  ['SettingsStorage', 'SettingsStorages', 'ХранилищеВариантовОтчетов'],
  ['ExternalDataSource', 'ExternalDataSources', 'ИнтернетМагазин'],
  ['IntegrationService', 'IntegrationServices', 'СервисИнтеграции1'],
  // Вид без сгенерированных типов — `<InternalInfo/>` и без `<ChildObjects>`.
  ['CommonModule', 'CommonModules', 'GoogleПереводчик'],
];

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function normalize(xml: string): string {
  return xml
    .replace(new RegExp(` uuid="${GUID}"`, 'g'), ' uuid="UUID"')
    .replace(new RegExp(`<xr:(TypeId|ValueId|ThisNode)>${GUID}<`, 'g'), '<xr:$1>UUID<');
}

suite('CfeBorrowService — заимствованный объект любого вида как у выгрузки платформы (#170)', () => {
  for (const format of ['2.20', '2.21'] as const) {
    for (const [kind, folder, name] of CASES) {
      test(`${format}: ${kind}.${name} — байт-в-байт с эталоном`, () => {
        const cfDir = path.join(REPO_ROOT, 'example', format, 'src', 'cf');
        const extDir = fs.mkdtempSync(path.join(os.tmpdir(), `onecdev-borrow-object-${format}-`));
        try {
          fs.writeFileSync(path.join(extDir, 'Configuration.xml'), [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<MetaDataObject version="${format}">`,
            '\t<Configuration>',
            '\t\t<Properties><Name>Расширение</Name></Properties>',
            '\t\t<ChildObjects/>',
            '\t</Configuration>',
            '</MetaDataObject>',
            '',
          ].join('\n'), 'utf-8');

          new CfeBorrowService().borrowObject(cfDir, extDir, kind, name);

          const actual = fs.readFileSync(path.join(extDir, folder, `${name}.xml`), 'utf-8');
          const expected = fs.readFileSync(path.join(FIXTURES, format, folder, `${name}.xml`), 'utf-8');
          assert.strictEqual(normalize(actual), normalize(expected));
        } finally {
          fs.rmSync(extDir, { recursive: true, force: true });
        }
      });
    }
  }
});
