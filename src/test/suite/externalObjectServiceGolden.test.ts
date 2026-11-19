import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExternalObjectService } from '../../infra/xml';

/**
 * Байт-в-байт характеризация ExternalObjectService ДО дробления на подфайлы
 * (src/infra/xml/external/*). Инвариант проекта: любой рефактор генератора XML
 * обязан предваряться golden-тестом, фиксирующим полный текст каждого файла,
 * а не подстроки. Эти тесты — страховочная сеть: они должны остаться зелёными
 * после дробления, иначе рефактор изменил поведение, а не только структуру кода.
 *
 * Единственный источник недетерминизма — crypto.randomUUID() внутри newUuid().
 * uuid-атрибуты содержимого не участвуют в бизнес-контракте (валидируются только
 * формой GUID_PATTERN), поэтому перед сравнением с эталоном они нормализуются
 * в плейсхолдер "<UUID>" через regex — единственная точка, где допустима
 * не-точная строка; весь остальной текст (переводы строк, отступы, BOM,
 * самозакрытие тегов) сравнивается буквально.
 */
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

function readNormalized(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8').replace(UUID_RE, '<UUID>');
}

suite('ExternalObjectService — байт-golden характеризация (предусловие дробления на infra/xml/external/*)', () => {
  test('createExternalDataProcessor: полный байтовый эталон XML объекта и ObjectModule.bsl', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-golden-epf-'));
    const service = new ExternalObjectService();
    service.createExternalDataProcessor({ name: 'ТестоваяОбработка', synonym: 'Тестовая обработка', outputDir: root });

    const objectXml = path.join(root, 'ТестоваяОбработка.xml');
    const modulePath = path.join(root, 'ТестоваяОбработка', 'Ext', 'ObjectModule.bsl');

    const expectedObjectXml = '﻿<?xml version="1.0" encoding="UTF-8"?>\r\n'
      + '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.17">\r\n'
      + '\t<ExternalDataProcessor uuid="<UUID>">\r\n'
      + '\t\t<InternalInfo>\r\n'
      + '\t\t\t<xr:ContainedObject>\r\n'
      + '\t\t\t\t<xr:ClassId><UUID></xr:ClassId>\r\n'
      + '\t\t\t\t<xr:ObjectId><UUID></xr:ObjectId>\r\n'
      + '\t\t\t</xr:ContainedObject>\r\n'
      + '\t\t\t<xr:GeneratedType name="ExternalDataProcessorObject.ТестоваяОбработка" category="Object">\r\n'
      + '\t\t\t\t<xr:TypeId><UUID></xr:TypeId>\r\n'
      + '\t\t\t\t<xr:ValueId><UUID></xr:ValueId>\r\n'
      + '\t\t\t</xr:GeneratedType>\r\n'
      + '\t\t</InternalInfo>\r\n'
      + '\t\t<Properties>\r\n'
      + '\t\t\t<Name>ТестоваяОбработка</Name>\r\n'
      + '\t\t\t<Synonym>\r\n'
      + '\t\t\t\t<v8:item>\r\n'
      + '\t\t\t\t\t<v8:lang>ru</v8:lang>\r\n'
      + '\t\t\t\t\t<v8:content>Тестовая обработка</v8:content>\r\n'
      + '\t\t\t\t</v8:item>\r\n'
      + '\t\t\t</Synonym>\r\n'
      + '\t\t\t<Comment/>\r\n'
      + '\t\t\t<DefaultForm/>\r\n'
      + '\t\t\t<AuxiliaryForm/>\r\n'
      + '\t\t</Properties>\r\n'
      + '\t\t<ChildObjects/>\r\n'
      + '\t</ExternalDataProcessor>\r\n'
      + '</MetaDataObject>';
    assert.strictEqual(readNormalized(objectXml), expectedObjectXml);

    const expectedObjectModule = '﻿#Область ОписаниеПеременных\r\n'
      + '\r\n'
      + '#КонецОбласти\r\n'
      + '\r\n'
      + '#Область ПрограммныйИнтерфейс\r\n'
      + '\r\n'
      + '#КонецОбласти\r\n'
      + '\r\n'
      + '#Область СлужебныеПроцедурыИФункции\r\n'
      + '\r\n'
      + '#КонецОбласти\r\n';
    assert.strictEqual(fs.readFileSync(modulePath, 'utf-8'), expectedObjectModule);
  });

  test('createExternalReport (withSkd): полный байтовый эталон XML отчёта, ObjectModule.bsl, дескриптора и тела СКД-шаблона', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-golden-erf-'));
    const service = new ExternalObjectService();
    service.createExternalReport({ name: 'ТестовыйОтчет', synonym: 'Тестовый отчет', outputDir: root, withSkd: true });

    const objectXml = path.join(root, 'ТестовыйОтчет.xml');
    const modulePath = path.join(root, 'ТестовыйОтчет', 'Ext', 'ObjectModule.bsl');
    const skdDescriptor = path.join(root, 'ТестовыйОтчет', 'Templates', 'ОсновнаяСхемаКомпоновкиДанных.xml');
    const skdBody = path.join(root, 'ТестовыйОтчет', 'Templates', 'ОсновнаяСхемаКомпоновкиДанных', 'Ext', 'Template.xml');

    const expectedObjectXml = '﻿<?xml version="1.0" encoding="UTF-8"?>\r\n'
      + '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.17">\r\n'
      + '\t<ExternalReport uuid="<UUID>">\r\n'
      + '\t\t<InternalInfo>\r\n'
      + '\t\t\t<xr:ContainedObject>\r\n'
      + '\t\t\t\t<xr:ClassId><UUID></xr:ClassId>\r\n'
      + '\t\t\t\t<xr:ObjectId><UUID></xr:ObjectId>\r\n'
      + '\t\t\t</xr:ContainedObject>\r\n'
      + '\t\t\t<xr:GeneratedType name="ExternalReportObject.ТестовыйОтчет" category="Object">\r\n'
      + '\t\t\t\t<xr:TypeId><UUID></xr:TypeId>\r\n'
      + '\t\t\t\t<xr:ValueId><UUID></xr:ValueId>\r\n'
      + '\t\t\t</xr:GeneratedType>\r\n'
      + '\t\t</InternalInfo>\r\n'
      + '\t\t<Properties>\r\n'
      + '\t\t\t<Name>ТестовыйОтчет</Name>\r\n'
      + '\t\t\t<Synonym>\r\n'
      + '\t\t\t\t<v8:item>\r\n'
      + '\t\t\t\t\t<v8:lang>ru</v8:lang>\r\n'
      + '\t\t\t\t\t<v8:content>Тестовый отчет</v8:content>\r\n'
      + '\t\t\t\t</v8:item>\r\n'
      + '\t\t\t</Synonym>\r\n'
      + '\t\t\t<Comment/>\r\n'
      + '\t\t\t<DefaultForm/>\r\n'
      + '\t\t\t<AuxiliaryForm/>\r\n'
      + '\t\t\t<MainDataCompositionSchema>ExternalReport.ТестовыйОтчет.Template.ОсновнаяСхемаКомпоновкиДанных</MainDataCompositionSchema>\r\n'
      + '\t\t\t<DefaultSettingsForm/>\r\n'
      + '\t\t\t<AuxiliarySettingsForm/>\r\n'
      + '\t\t\t<DefaultVariantForm/>\r\n'
      + '\t\t\t<VariantsStorage/>\r\n'
      + '\t\t\t<SettingsStorage/>\r\n'
      + '\t\t</Properties>\r\n'
      + '\t\t<ChildObjects>\r\n'
      + '\t\t\t<Template>ОсновнаяСхемаКомпоновкиДанных</Template>\r\n'
      + '\t\t</ChildObjects>\r\n'
      + '\t</ExternalReport>\r\n'
      + '</MetaDataObject>';
    assert.strictEqual(readNormalized(objectXml), expectedObjectXml);

    const expectedObjectModule = '﻿#Область ОписаниеПеременных\r\n'
      + '\r\n'
      + '#КонецОбласти\r\n'
      + '\r\n'
      + '#Область ПрограммныйИнтерфейс\r\n'
      + '\r\n'
      + '#КонецОбласти\r\n'
      + '\r\n'
      + '#Область СлужебныеПроцедурыИФункции\r\n'
      + '\r\n'
      + '#КонецОбласти\r\n';
    assert.strictEqual(fs.readFileSync(modulePath, 'utf-8'), expectedObjectModule);

    const expectedSkdDescriptor = '﻿<?xml version="1.0" encoding="UTF-8"?>\r\n'
      + '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.17">\r\n'
      + '\t<Template uuid="<UUID>">\r\n'
      + '\t\t<Properties>\r\n'
      + '\t\t\t<Name>ОсновнаяСхемаКомпоновкиДанных</Name>\r\n'
      + '\t\t\t<Synonym>\r\n'
      + '\t\t\t\t<v8:item>\r\n'
      + '\t\t\t\t\t<v8:lang>ru</v8:lang>\r\n'
      + '\t\t\t\t\t<v8:content>Основная схема компоновки данных</v8:content>\r\n'
      + '\t\t\t\t</v8:item>\r\n'
      + '\t\t\t</Synonym>\r\n'
      + '\t\t\t<Comment/>\r\n'
      + '\t\t\t<TemplateType>DataCompositionSchema</TemplateType>\r\n'
      + '\t\t</Properties>\r\n'
      + '\t</Template>\r\n'
      + '</MetaDataObject>';
    assert.strictEqual(readNormalized(skdDescriptor), expectedSkdDescriptor);

    const expectedSkdBody = '﻿<?xml version="1.0" encoding="UTF-8"?>\r\n'
      + '<DataCompositionSchema xmlns="http://v8.1c.ru/8.1/data-composition-system/schema"\r\n'
      + '\t\txmlns:dcscom="http://v8.1c.ru/8.1/data-composition-system/common"\r\n'
      + '\t\txmlns:dcscor="http://v8.1c.ru/8.1/data-composition-system/core"\r\n'
      + '\t\txmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings"\r\n'
      + '\t\txmlns:v8="http://v8.1c.ru/8.1/data/core"\r\n'
      + '\t\txmlns:v8ui="http://v8.1c.ru/8.1/data/ui"\r\n'
      + '\t\txmlns:xs="http://www.w3.org/2001/XMLSchema"\r\n'
      + '\t\txmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\r\n'
      + '\t<dataSource>\r\n'
      + '\t\t<name>ИсточникДанных1</name>\r\n'
      + '\t\t<dataSourceType>Local</dataSourceType>\r\n'
      + '\t</dataSource>\r\n'
      + '</DataCompositionSchema>';
    assert.strictEqual(fs.readFileSync(skdBody, 'utf-8'), expectedSkdBody);
  });

  test('addHelp: полный байтовый эталон Ext/Help.xml (с версией формата) и Ext/Help/ru.html', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-golden-help-'));
    const service = new ExternalObjectService();
    service.createExternalDataProcessor({ name: 'ОбработкаСпоСправкой', synonym: 'Обработка со справкой', outputDir: root });

    const objectXml = path.join(root, 'ОбработкаСпоСправкой.xml');
    service.addHelp({ objectPath: objectXml, lang: 'ru' });

    const helpXml = path.join(root, 'ОбработкаСпоСправкой', 'Ext', 'Help.xml');
    const helpHtml = path.join(root, 'ОбработкаСпоСправкой', 'Ext', 'Help', 'ru.html');

    // Версия формата справки берётся из detectFormatVersion — при отсутствии
    // родительского Configuration.xml в дереве временного каталога используется
    // дефолт "2.17" (SCAFFOLD_FORMAT_VERSION), как и в самом XML объекта.
    const expectedHelpXml = '﻿<?xml version="1.0" encoding="UTF-8"?>\r\n'
      + '<Help xmlns="http://v8.1c.ru/8.3/xcf/extrnprops" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.17">\r\n'
      + '\t<Page>ru</Page>\r\n'
      + '</Help>';
    assert.strictEqual(fs.readFileSync(helpXml, 'utf-8'), expectedHelpXml);

    // buildHelpHtml не добавляет завершающий перевод строки — запись нового файла (#165) его
    // и не добавляет: эталон заканчивается без перевода строки, переводы внутри — CRLF.
    const expectedHelpHtml = '﻿<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.0 Transitional//EN">\r\n'
      + '<html>\r\n'
      + '<head>\r\n'
      + '    <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>\r\n'
      + '    <link rel="stylesheet" type="text/css" href="v8help://service_book/service_style"/>\r\n'
      + '</head>\r\n'
      + '<body>\r\n'
      + '    <h1>ОбработкаСпоСправкой</h1>\r\n'
      + '    <p>Описание.</p>\r\n'
      + '</body>\r\n'
      + '</html>';
    assert.strictEqual(fs.readFileSync(helpHtml, 'utf-8'), expectedHelpHtml);
  });

  test('initBspRegistration + addBspCommand (ПечатнаяФорма, с targets): полный байтовый эталон модуля объекта', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-golden-bsp-print-'));
    const service = new ExternalObjectService();
    service.createExternalDataProcessor({ name: 'ПечатьЗаказаGolden', outputDir: root });

    const objectXml = path.join(root, 'ПечатьЗаказаGolden.xml');
    const modulePath = path.join(root, 'ПечатьЗаказаGolden', 'Ext', 'ObjectModule.bsl');

    service.initBspRegistration({
      objectPath: objectXml,
      kind: 'ПечатнаяФорма',
      targets: ['Документ.ЗаказПокупателя'],
    });
    service.addBspCommand({
      objectPath: objectXml,
      identifier: 'ПечатьСводки',
      presentation: 'Печать сводки',
    });

    // Репрезентативный вид с targets: регистрация добавляет назначение и печатный
    // обработчик-заглушку (buildPrintProcedureStub), addBspCommand — второй пункт
    // меню и печатную ветку (ensurePrintHandler/buildPrintBranch).
    const expected = '﻿#Область ОписаниеПеременных\r\n'
      + '\r\n'
      + '#КонецОбласти\r\n'
      + '\r\n'
      + '#Область ПрограммныйИнтерфейс\r\n'
      + '\r\n'
      + 'Функция СведенияОВнешнейОбработке() Экспорт\r\n'
      + '\r\n'
      + '\tМетаданныеОбработки = Метаданные();\r\n'
      + '\r\n'
      + '\tПараметрыРегистрации = ДополнительныеОтчетыИОбработки.СведенияОВнешнейОбработке("2.2.2.1");\r\n'
      + '\tПараметрыРегистрации.Вид    = ДополнительныеОтчетыИОбработкиКлиентСервер.ВидОбработкиПечатнаяФорма();\r\n'
      + '\tПараметрыРегистрации.Версия = "1.0";\r\n'
      + '\r\n'
      + '\tПараметрыРегистрации.Назначение.Добавить("Документ.ЗаказПокупателя");\r\n'
      + '\r\n'
      + '\tНоваяКоманда = ПараметрыРегистрации.Команды.Добавить();\r\n'
      + '\tНоваяКоманда.Представление        = МетаданныеОбработки.Представление();\r\n'
      + '\tНоваяКоманда.Идентификатор        = МетаданныеОбработки.Имя;\r\n'
      + '\tНоваяКоманда.Использование        = ДополнительныеОтчетыИОбработкиКлиентСервер.ТипКомандыВызовСерверногоМетода();\r\n'
      + '\tНоваяКоманда.ПоказыватьОповещение = Ложь;\r\n'
      + '\tНоваяКоманда.Модификатор = "ПечатьMXL";\r\n'
      + '\tНоваяКоманда = ПараметрыРегистрации.Команды.Добавить();\r\n'
      + '\tНоваяКоманда.Представление        = НСтр("ru = \'Печать сводки\'");\r\n'
      + '\tНоваяКоманда.Идентификатор        = "ПечатьСводки";\r\n'
      + '\tНоваяКоманда.Использование        = ДополнительныеОтчетыИОбработкиКлиентСервер.ТипКомандыВызовСерверногоМетода();\r\n'
      + '\tНоваяКоманда.ПоказыватьОповещение = Ложь;\r\n'
      + '\tНоваяКоманда.Модификатор = "ПечатьMXL";\r\n'
      + '\r\n'
      + '\r\n'
      + '\tВозврат ПараметрыРегистрации;\r\n'
      + '\r\n'
      + 'КонецФункции\r\n'
      + '\r\n'
      + 'Процедура Печать(МассивОбъектов, КоллекцияПечатныхФорм, ОбъектыПечати, ПараметрыВывода) Экспорт\r\n'
      + '\r\n'
      + '\t// TODO: Реализация\r\n'
      + '\r\n'
      + '\tПечатнаяФорма = УправлениеПечатью.СведенияОПечатнойФорме(КоллекцияПечатныхФорм, "ПечатьСводки");\r\n'
      + '\tЕсли ПечатнаяФорма <> Неопределено Тогда\r\n'
      + '\t\tПечатнаяФорма.ТабличныйДокумент = СформироватьПечатьСводки(МассивОбъектов, ОбъектыПечати);\r\n'
      + '\t\tПечатнаяФорма.СинонимМакета = НСтр("ru = \'Печать сводки\'");\r\n'
      + '\tКонецЕсли;\r\n'
      + '\r\n'
      + 'КонецПроцедуры\r\n'
      + '\r\n'
      + '#КонецОбласти\r\n'
      + '\r\n'
      + '#Область СлужебныеПроцедурыИФункции\r\n'
      + '\r\n'
      + '#КонецОбласти\r\n';
    assert.strictEqual(fs.readFileSync(modulePath, 'utf-8'), expected);
  });

  test('initBspRegistration + addBspCommand (ДополнительнаяОбработка, без targets): полный байтовый эталон модуля объекта', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-golden-bsp-noargs-'));
    const service = new ExternalObjectService();
    service.createExternalDataProcessor({ name: 'ДопОбработкаGolden', outputDir: root });

    const objectXml = path.join(root, 'ДопОбработкаGolden.xml');
    const modulePath = path.join(root, 'ДопОбработкаGolden', 'Ext', 'ObjectModule.bsl');

    service.initBspRegistration({ objectPath: objectXml, kind: 'ДополнительнаяОбработка' });
    service.addBspCommand({
      objectPath: objectXml,
      identifier: 'ВыполнитьОбработку',
      presentation: 'Выполнить обработку',
      commandType: 'ВызовСерверногоМетода',
    });

    // Репрезентативный вид без targets (ДополнительнаяОбработка не требует
    // назначения) — регистрация не содержит блока "Назначение.Добавить", а
    // серверная команда вставляется через ensureServerCommandHandler в новую
    // процедуру ВыполнитьКоманду с двумя аргументами (нецелевой вид).
    const expected = '﻿#Область ОписаниеПеременных\r\n'
      + '\r\n'
      + '#КонецОбласти\r\n'
      + '\r\n'
      + '#Область ПрограммныйИнтерфейс\r\n'
      + '\r\n'
      + 'Функция СведенияОВнешнейОбработке() Экспорт\r\n'
      + '\r\n'
      + '\tМетаданныеОбработки = Метаданные();\r\n'
      + '\r\n'
      + '\tПараметрыРегистрации = ДополнительныеОтчетыИОбработки.СведенияОВнешнейОбработке("2.2.2.1");\r\n'
      + '\tПараметрыРегистрации.Вид    = ДополнительныеОтчетыИОбработкиКлиентСервер.ВидОбработкиДополнительнаяОбработка();\r\n'
      + '\tПараметрыРегистрации.Версия = "1.0";\r\n'
      + '\r\n'
      + '\tНоваяКоманда = ПараметрыРегистрации.Команды.Добавить();\r\n'
      + '\tНоваяКоманда.Представление        = МетаданныеОбработки.Представление();\r\n'
      + '\tНоваяКоманда.Идентификатор        = МетаданныеОбработки.Имя;\r\n'
      + '\tНоваяКоманда.Использование        = ДополнительныеОтчетыИОбработкиКлиентСервер.ТипКомандыОткрытиеФормы();\r\n'
      + '\tНоваяКоманда.ПоказыватьОповещение = Ложь;\r\n'
      + '\tНоваяКоманда = ПараметрыРегистрации.Команды.Добавить();\r\n'
      + '\tНоваяКоманда.Представление        = НСтр("ru = \'Выполнить обработку\'");\r\n'
      + '\tНоваяКоманда.Идентификатор        = "ВыполнитьОбработку";\r\n'
      + '\tНоваяКоманда.Использование        = ДополнительныеОтчетыИОбработкиКлиентСервер.ТипКомандыВызовСерверногоМетода();\r\n'
      + '\tНоваяКоманда.ПоказыватьОповещение = Ложь;\r\n'
      + '\r\n'
      + '\tВозврат ПараметрыРегистрации;\r\n'
      + '\r\n'
      + 'КонецФункции\r\n'
      + '\r\n'
      + 'Процедура ВыполнитьКоманду(ИдентификаторКоманды, ПараметрыВыполненияКоманды) Экспорт\r\n'
      + '\r\n'
      + '\tЕсли ИдентификаторКоманды = "ВыполнитьОбработку" Тогда\r\n'
      + '\t\t// TODO: Реализация ВыполнитьОбработку\r\n'
      + '\tКонецЕсли;\r\n'
      + '\r\n'
      + 'КонецПроцедуры\r\n'
      + '\r\n'
      + '#КонецОбласти\r\n'
      + '\r\n'
      + '#Область СлужебныеПроцедурыИФункции\r\n'
      + '\r\n'
      + '#КонецОбласти\r\n';
    assert.strictEqual(fs.readFileSync(modulePath, 'utf-8'), expected);
  });
});
