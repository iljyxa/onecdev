/**
 * Единый реестр типов метаданных 1С — центральный источник правды.
 *
 * Здесь описаны ВСЕ типы объектов, поддерживаемые расширением:
 *  - отображение (иконка, лейблы, группа дерева, порядок);
 *  - выгрузка (папка в структуре XML, дочерние теги);
 *  - поведение (слоты BSL-модулей, команда одиночного клика, ключ схемы свойств).
 *
 * Правило: добавление нового типа метаданных — ОДНА запись в этом объекте.
 * Любое расширение функциональности должно читать данные отсюда, а не
 * заводить параллельные словари.
 */
import type { ChildTag } from './ChildTag';
import type { ModuleSlot, OpenModuleCommandId } from './ModuleSlot';

/** Группа дерева, в которую попадает тип */
export type MetaGroup =
  /** Корневые виды (сама конфигурация/расширение) */
  | 'root'
  /** Группа «Общие» (подсистемы, общие модули, …) */
  | 'common'
  /** Группа верхнего уровня (справочники, документы, отчёты, …) */
  | 'top'
  /** Подветка группы «Документы» (нумераторы, последовательности) */
  | 'documents-branch'
  /** Служебные группы и дочерние элементы — в дереве формируются контекстно */
  | 'child'
  | 'service';

/** Описание типа метаданных */
export interface MetaTypeDef {
  /** Имя типа в XML-выгрузке (совпадает с тегом в `<ChildObjects>`) */
  kind: MetaKind;
  /** Подпись типа в единственном числе — для заголовка панели свойств */
  label: string;
  /** Подпись во множественном числе — для группы в дереве */
  pluralLabel: string;
  /** Каталог в структуре выгрузки 1С (например `Catalogs`). Отсутствует у служебных типов */
  folder?: string;
  /** Имя SVG без расширения (в `src/icons/{light,dark}/<icon>.svg`) */
  icon: string;
  /** Группа дерева */
  group: MetaGroup;
  /** Порядок в группе (меньше — выше) */
  groupOrder: number;
  /** Дочерние теги, ожидаемые внутри объекта (реквизиты, ТЧ, формы и т.п.) */
  childTags?: readonly ChildTag[];
  /**
   * Показывать единственный дочерний тег напрямую под объектом, без промежуточной
   * группы («URL-шаблоны», «Реквизиты» и т.п.). Применимо к типам, у которых
   * дочерние элементы сами являются под-объектами и в конфигураторе 1С висят
   * прямо на узле объекта (HTTP-сервис → URL-шаблон). Требует ровно одного
   * `childTags`; кнопка «Добавить» переезжает на сам узел объекта.
   */
  flatChildren?: boolean;
  /**
   * Допустимые слоты BSL-модулей для этого типа.
   * Если поле задано — только перечисленные слоты разрешено создавать.
   * Если не задано — тип не проверяется (консервативно разрешаем).
   */
  modules?: readonly ModuleSlot[];
  /** Команда по одиночному клику по узлу этого типа */
  singleClickCommand?: OpenModuleCommandId;
  /** Ключ схемы свойств в `infra/xml/PropertySchema.ts` */
  propertySchema?: string;
  /**
   * Каноничный сегмент пути 1С для построения MCP-путей.
   *
   * - Для корневых типов с коллекцией — **множественное число** русское
   *   CamelCase без пробелов (`Справочники`, `Документы`, `РегистрыСведений`).
   * - Для псевдо-корней `configuration`/`extension` — `Конфигурация`/`Расширение`.
   * - Для типа `Subsystem` — `Подсистема` (единственное число, потому что
   *   подсистемы по правилам канона размещаются без удвоения сегмента).
   * - Для дочерних типов (`Attribute`, `TabularSection`, …) и служебных
   *   групп поле не задаётся — у них собственный сегмент из `ChildTag`.
   */
  pathSegment?: string;
  /**
   * Английское имя типа метаданных в стиле EDT/XML (`Catalog`, `Document`,
   * `InformationRegister`, `CommonModule`). Используется в производных
   * ссылочных типах (`CatalogRef`/`DocumentRef`/…) и при сериализации.
   * По умолчанию совпадает с `kind` (англ. ключом реестра).
   */
  englishKind?: string;
  /**
   * classID вида в протоколе хранилища (crs): сервер называет объекты истории парами
   * `<classID>.<имя>`. Значения сняты с crserver 8.5.1 (example/crs/8.5.1/tcp/history-full-config,
   * объект каждого вида); у вида без снятого classID поле не задаётся.
   */
  repositoryClassId?: string;
}

/** Все допустимые идентификаторы типов (строковая литералная сумма) */
export type MetaKind =
  // корни
  | 'configuration'
  | 'extension'
  | 'extensions-root'
  // служебные группы дерева
  | 'group-common'
  | 'group-type'
  | 'NumeratorsBranch'
  | 'SequencesBranch'
  // общие
  | 'Subsystem'
  | 'CommonModule'
  | 'SessionParameter'
  | 'CommonAttribute'
  | 'Role'
  | 'CommonForm'
  | 'CommonCommand'
  | 'CommandGroup'
  | 'CommonPicture'
  | 'CommonTemplate'
  | 'XDTOPackage'
  | 'StyleItem'
  | 'DefinedType'
  | 'FunctionalOption'
  | 'FunctionalOptionsParameter'
  | 'SettingsStorage'
  | 'Style'
  | 'WSReference'
  | 'WebSocketClient'
  | 'IntegrationService'
  | 'Bot'
  | 'Interface'
  | 'PaletteColor'
  | 'Language'
  | 'HTTPService'
  | 'WebService'
  // верхний уровень
  | 'Constant'
  | 'Catalog'
  | 'Document'
  | 'DocumentNumerator'
  | 'Enum'
  | 'InformationRegister'
  | 'AccumulationRegister'
  | 'AccountingRegister'
  | 'CalculationRegister'
  | 'Report'
  | 'DataProcessor'
  | 'BusinessProcess'
  | 'Task'
  | 'ExchangePlan'
  | 'ChartOfCharacteristicTypes'
  | 'ChartOfAccounts'
  | 'ChartOfCalculationTypes'
  | 'DocumentJournal'
  | 'ScheduledJob'
  | 'EventSubscription'
  | 'FilterCriterion'
  | 'Sequence'
  | 'ExternalDataSource'
  // дочерние
  | 'StandardAttribute'
  | 'Attribute'
  | 'AddressingAttribute'
  | 'TabularSection'
  | 'Column'
  | 'Form'
  | 'Command'
  | 'Template'
  | 'Dimension'
  | 'Resource'
  | 'EnumValue'
  | 'URLTemplate'
  | 'Method';

/** Сокращённый конструктор записи для ReadOnly Record */
const metaDef = (d: MetaTypeDef): MetaTypeDef => d;

/**
 * Центральный реестр. Не менять структуру без обновления `AGENTS.md`.
 */
export const META_TYPES: Readonly<Record<MetaKind, MetaTypeDef>> = {
  // ── Корни ─────────────────────────────────────────────────────────────
  configuration: metaDef({
    kind: 'configuration', label: 'Конфигурация', pluralLabel: 'Конфигурации',
    icon: 'parameter', group: 'root', groupOrder: 0,
    pathSegment: 'Конфигурация', englishKind: 'Configuration',
    repositoryClassId: 'cf4abeab-37b2-11d4-940f-008048da11f9',
  }),
  extension: metaDef({
    kind: 'extension', label: 'Расширение', pluralLabel: 'Расширения',
    icon: 'extensionMosaic', group: 'root', groupOrder: 0,
    pathSegment: 'Расширение', englishKind: 'Extension',
  }),
  'extensions-root': metaDef({
    kind: 'extensions-root', label: 'Расширения', pluralLabel: 'Расширения',
    icon: 'extensionMosaic', group: 'service', groupOrder: 0,
  }),

  // ── Служебные группы ──────────────────────────────────────────────────
  'group-common': metaDef({
    kind: 'group-common', label: 'Группа "Общие"', pluralLabel: 'Общие',
    icon: 'common', group: 'service', groupOrder: 0,
  }),
  'group-type': metaDef({
    kind: 'group-type', label: 'Группа объектов', pluralLabel: 'Группы объектов',
    icon: 'folder', group: 'service', groupOrder: 0,
  }),
  NumeratorsBranch: metaDef({
    kind: 'NumeratorsBranch', label: 'Нумераторы', pluralLabel: 'Нумераторы',
    icon: 'documentNumerator', group: 'documents-branch', groupOrder: 0,
  }),
  SequencesBranch: metaDef({
    kind: 'SequencesBranch', label: 'Последовательности', pluralLabel: 'Последовательности',
    icon: 'sequence', group: 'documents-branch', groupOrder: 1,
  }),

  // ── Общие (порядок как в конфигураторе) ───────────────────────────────
  Subsystem: metaDef({ kind: 'Subsystem', label: 'Подсистема', pluralLabel: 'Подсистемы',
    folder: 'Subsystems', icon: 'subsystem', group: 'common', groupOrder: 10,
    pathSegment: 'Подсистема', englishKind: 'Subsystem',
    repositoryClassId: '37f2fa9a-b276-11d4-9435-004095e12fc7' }),
  CommonModule: metaDef({ kind: 'CommonModule', label: 'Общий модуль', pluralLabel: 'Общие модули',
    folder: 'CommonModules', icon: 'commonModule', group: 'common', groupOrder: 20,
    modules: ['CommonModule'], singleClickCommand: 'openCommonModuleCode',
    pathSegment: 'ОбщиеМодули', englishKind: 'CommonModule',
    repositoryClassId: '0fe48980-252d-11d6-a3c7-0050bae0a776' }),
  SessionParameter: metaDef({ kind: 'SessionParameter', label: 'Параметр сеанса', pluralLabel: 'Параметры сеанса',
    folder: 'SessionParameters', icon: 'sessionParameter', group: 'common', groupOrder: 30,
    propertySchema: 'sessionParameter',
    pathSegment: 'ПараметрыСеанса', englishKind: 'SessionParameter',
    repositoryClassId: '24c43748-c938-45d0-8d14-01424a72b11e' }),
  Role: metaDef({ kind: 'Role', label: 'Роль', pluralLabel: 'Роли',
    folder: 'Roles', icon: 'role', group: 'common', groupOrder: 40,
    pathSegment: 'Роли', englishKind: 'Role',
    repositoryClassId: '09736b02-9cac-4e3f-b4f7-d3e9576ab948' }),
  CommonAttribute: metaDef({ kind: 'CommonAttribute', label: 'Общий реквизит', pluralLabel: 'Общие реквизиты',
    folder: 'CommonAttributes', icon: 'attribute', group: 'common', groupOrder: 50,
    propertySchema: 'commonAttribute',
    pathSegment: 'ОбщиеРеквизиты', englishKind: 'CommonAttribute',
    repositoryClassId: '15794563-ccec-41f6-a83c-ec5f7b9a5bc1' }),
  ExchangePlan: metaDef({ kind: 'ExchangePlan', label: 'План обмена', pluralLabel: 'Планы обмена',
    folder: 'ExchangePlans', icon: 'exchangePlan', group: 'common', groupOrder: 60,
    childTags: ['StandardAttribute', 'Attribute', 'TabularSection', 'Form', 'Command', 'Template'],
    modules: ['Object', 'Manager'], propertySchema: 'exchangePlan',
    pathSegment: 'ПланыОбмена', englishKind: 'ExchangePlan',
    repositoryClassId: '857c4a91-e5f4-4fac-86ec-787626f1c108' }),
  FilterCriterion: metaDef({ kind: 'FilterCriterion', label: 'Критерий отбора', pluralLabel: 'Критерии отбора',
    folder: 'FilterCriteria', icon: 'filterCriteria', group: 'common', groupOrder: 70,
    pathSegment: 'КритерииОтбора', englishKind: 'FilterCriterion',
    repositoryClassId: '3e7bfcc0-067d-11d6-a3c7-0050bae0a776' }),
  EventSubscription: metaDef({ kind: 'EventSubscription', label: 'Подписка на события', pluralLabel: 'Подписки на события',
    folder: 'EventSubscriptions', icon: 'eventSubscription', group: 'common', groupOrder: 80,
    pathSegment: 'ПодпискиНаСобытия', englishKind: 'EventSubscription',
    repositoryClassId: '4e828da6-0f44-4b5b-b1c0-a2b3cfe7bdcc' }),
  ScheduledJob: metaDef({ kind: 'ScheduledJob', label: 'Регламентное задание', pluralLabel: 'Регламентные задания',
    folder: 'ScheduledJobs', icon: 'scheduledJob', group: 'common', groupOrder: 90,
    propertySchema: 'scheduledJob',
    pathSegment: 'РегламентныеЗадания', englishKind: 'ScheduledJob',
    repositoryClassId: '11bdaf85-d5ad-4d91-bb24-aa0eee139052' }),
  // Bot / WebSocketClient / Interface / PaletteColor — не входят в таблицу корней
  // канона MCP (`docs/mcp-paths.md`, 2.1), но парсер `parseCanonicalPath` строит корни
  // из META_TYPES и уже принимает их. pathSegment выставлен по той же конвенции
  // CamelCase-множественного, чтобы дополнение таблицы не требовало правки реестра.
  // TODO: подтвердить названия, когда они появятся в MCP-таблицах.
  Bot: metaDef({ kind: 'Bot', label: 'Бот', pluralLabel: 'Боты',
    folder: 'Bots', icon: 'common', group: 'common', groupOrder: 100,
    pathSegment: 'Боты', englishKind: 'Bot',
    repositoryClassId: '6e6dc072-b7ac-41e7-8f88-278d25b6da2a' }),
  FunctionalOption: metaDef({ kind: 'FunctionalOption', label: 'Функциональная опция', pluralLabel: 'Функциональные опции',
    folder: 'FunctionalOptions', icon: 'parameter', group: 'common', groupOrder: 110,
    pathSegment: 'ФункциональныеОпции', englishKind: 'FunctionalOption',
    repositoryClassId: 'af547940-3268-434f-a3e7-e47d6d2638c3' }),
  FunctionalOptionsParameter: metaDef({ kind: 'FunctionalOptionsParameter', label: 'Параметр функциональной опции',
    pluralLabel: 'Параметры функциональных опций',
    folder: 'FunctionalOptionsParameters', icon: 'parameter', group: 'common', groupOrder: 120,
    pathSegment: 'ПараметрыФункциональныхОпций', englishKind: 'FunctionalOptionsParameter',
    repositoryClassId: '30d554db-541e-4f62-8970-a1c6dcfeb2bc' }),
  DefinedType: metaDef({ kind: 'DefinedType', label: 'Определяемый тип', pluralLabel: 'Определяемые типы',
    folder: 'DefinedTypes', icon: 'parameter', group: 'common', groupOrder: 130,
    pathSegment: 'ОпределяемыеТипы', englishKind: 'DefinedType',
    repositoryClassId: 'c045099e-13b9-4fb6-9d50-fca00202971e' }),
  SettingsStorage: metaDef({ kind: 'SettingsStorage', label: 'Хранилище настроек', pluralLabel: 'Хранилища настроек',
    folder: 'SettingsStorages', icon: 'common', group: 'common', groupOrder: 140,
    pathSegment: 'ХранилищаНастроек', englishKind: 'SettingsStorage',
    repositoryClassId: '46b4cd97-fd13-4eaa-aba2-3bddd7699218' }),
  CommonCommand: metaDef({ kind: 'CommonCommand', label: 'Общая команда', pluralLabel: 'Общие команды',
    folder: 'CommonCommands', icon: 'command', group: 'common', groupOrder: 150,
    modules: ['CommonCommand'], singleClickCommand: 'openCommandModule', propertySchema: 'command',
    pathSegment: 'ОбщиеКоманды', englishKind: 'CommonCommand',
    repositoryClassId: '2f1a5187-fb0e-4b05-9489-dc5dd6412348' }),
  CommandGroup: metaDef({ kind: 'CommandGroup', label: 'Группа команд', pluralLabel: 'Группы команд',
    folder: 'CommandGroups', icon: 'command', group: 'common', groupOrder: 160,
    pathSegment: 'ГруппыКоманд', englishKind: 'CommandGroup',
    repositoryClassId: '1c57eabe-7349-44b3-b1de-ebfeab67b47d' }),
  CommonForm: metaDef({ kind: 'CommonForm', label: 'Общая форма', pluralLabel: 'Общие формы',
    folder: 'CommonForms', icon: 'form', group: 'common', groupOrder: 170,
    modules: ['CommonForm'], singleClickCommand: 'openFormModule',
    pathSegment: 'ОбщиеФормы', englishKind: 'CommonForm',
    repositoryClassId: '07ee8426-87f1-11d5-b99c-0050bae0a95d' }),
  CommonTemplate: metaDef({ kind: 'CommonTemplate', label: 'Общий макет', pluralLabel: 'Общие макеты',
    folder: 'CommonTemplates', icon: 'template', group: 'common', groupOrder: 180,
    pathSegment: 'ОбщиеМакеты', englishKind: 'CommonTemplate',
    repositoryClassId: '0c89c792-16c3-11d5-b96b-0050bae0a95d' }),
  CommonPicture: metaDef({ kind: 'CommonPicture', label: 'Общая картинка', pluralLabel: 'Общие картинки',
    folder: 'CommonPictures', icon: 'picture', group: 'common', groupOrder: 190,
    pathSegment: 'ОбщиеКартинки', englishKind: 'CommonPicture',
    repositoryClassId: '7dcd43d9-aca5-4926-b549-1842e6a4e8cf' }),
  XDTOPackage: metaDef({ kind: 'XDTOPackage', label: 'XDTO-пакет', pluralLabel: 'XDTO-пакеты',
    folder: 'XDTOPackages', icon: 'common', group: 'common', groupOrder: 200,
    pathSegment: 'XDTOПакеты', englishKind: 'XDTOPackage',
    repositoryClassId: 'cc9df798-7c94-4616-97d2-7aa0b7bc515e' }),
  WebService: metaDef({ kind: 'WebService', label: 'Web-сервис', pluralLabel: 'Web-сервисы',
    folder: 'WebServices', icon: 'ws', group: 'common', groupOrder: 210,
    modules: ['Service'], singleClickCommand: 'openServiceModule',
    pathSegment: 'WebСервисы', englishKind: 'WebService',
    repositoryClassId: '8657032e-7740-4e1d-a3ba-5dd6e8afb78f' }),
  HTTPService: metaDef({ kind: 'HTTPService', label: 'HTTP-сервис', pluralLabel: 'HTTP-сервисы',
    folder: 'HTTPServices', icon: 'http', group: 'common', groupOrder: 220,
    childTags: ['URLTemplate'], flatChildren: true,
    modules: ['Service'], singleClickCommand: 'openServiceModule',
    pathSegment: 'HTTPСервисы', englishKind: 'HTTPService',
    repositoryClassId: '0fffc09c-8f4c-47cc-b41c-8d5c5a221d79' }),
  WSReference: metaDef({ kind: 'WSReference', label: 'WS-ссылка', pluralLabel: 'WS-ссылки',
    folder: 'WSReferences', icon: 'wsLink', group: 'common', groupOrder: 230,
    pathSegment: 'WSСсылки', englishKind: 'WSReference',
    repositoryClassId: 'd26096fb-7a5d-4df9-af63-47d04771fa9b' }),
  WebSocketClient: metaDef({ kind: 'WebSocketClient', label: 'WebSocket-клиент', pluralLabel: 'WebSocket-клиенты',
    folder: 'WebSocketClients', icon: 'ws', group: 'common', groupOrder: 240,
    pathSegment: 'WebSocketКлиенты', englishKind: 'WebSocketClient',
    repositoryClassId: 'a7641777-7813-45c6-96ef-9d51587a6ac6' }),
  IntegrationService: metaDef({ kind: 'IntegrationService', label: 'Сервис интеграции', pluralLabel: 'Сервисы интеграции',
    folder: 'IntegrationServices', icon: 'http', group: 'common', groupOrder: 250,
    pathSegment: 'СервисыИнтеграции', englishKind: 'IntegrationService',
    repositoryClassId: 'bf3420b0-f6f9-41a0-b83a-fe9d4ab0b65d' }),
  PaletteColor: metaDef({ kind: 'PaletteColor', label: 'Цвет палитры', pluralLabel: 'Цвета палитры',
    icon: 'style', group: 'common', groupOrder: 260,
    pathSegment: 'ЦветаПалитры', englishKind: 'PaletteColor',
    repositoryClassId: '102f6202-43fa-40b0-8898-acd3876daacb' }),
  StyleItem: metaDef({ kind: 'StyleItem', label: 'Элемент стиля', pluralLabel: 'Элементы стиля',
    folder: 'StyleItems', icon: 'style', group: 'common', groupOrder: 270,
    pathSegment: 'ЭлементыСтиля', englishKind: 'StyleItem',
    repositoryClassId: '58848766-36ea-4076-8800-e91eb49590d7' }),
  Style: metaDef({ kind: 'Style', label: 'Стиль', pluralLabel: 'Стили',
    folder: 'Styles', icon: 'style', group: 'common', groupOrder: 280,
    pathSegment: 'Стили', englishKind: 'Style',
    repositoryClassId: '3e5404af-6ef8-4c73-ad11-91bd2dfac4c8' }),
  Language: metaDef({ kind: 'Language', label: 'Язык', pluralLabel: 'Языки',
    folder: 'Languages', icon: 'parameter', group: 'common', groupOrder: 290,
    pathSegment: 'Языки', englishKind: 'Language',
    repositoryClassId: '9cd510ce-abfc-11d4-9434-004095e12fc7' }),
  Interface: metaDef({ kind: 'Interface', label: 'Интерфейс', pluralLabel: 'Интерфейсы',
    folder: 'Interfaces', icon: 'common', group: 'common', groupOrder: 300,
    pathSegment: 'Интерфейсы', englishKind: 'Interface',
    repositoryClassId: '39bddf6a-0c3c-452b-921c-d99cfa1c2f1b' }),

  // ── Верхний уровень ───────────────────────────────────────────────────
  Constant: metaDef({ kind: 'Constant', label: 'Константа', pluralLabel: 'Константы',
    folder: 'Constants', icon: 'constant', group: 'top', groupOrder: 10,
    modules: ['ValueManager'], propertySchema: 'constant',
    pathSegment: 'Константы', englishKind: 'Constant',
    repositoryClassId: '0195e80c-b157-11d4-9435-004095e12fc7' }),
  Catalog: metaDef({ kind: 'Catalog', label: 'Справочник', pluralLabel: 'Справочники',
    folder: 'Catalogs', icon: 'catalog', group: 'top', groupOrder: 20,
    childTags: ['StandardAttribute', 'Attribute', 'TabularSection', 'Form', 'Command', 'Template'],
    modules: ['Object', 'Manager'], propertySchema: 'catalog',
    pathSegment: 'Справочники', englishKind: 'Catalog',
    repositoryClassId: 'cf4abea6-37b2-11d4-940f-008048da11f9' }),
  Document: metaDef({ kind: 'Document', label: 'Документ', pluralLabel: 'Документы',
    folder: 'Documents', icon: 'document', group: 'top', groupOrder: 30,
    childTags: ['StandardAttribute', 'Attribute', 'TabularSection', 'Form', 'Command', 'Template'],
    modules: ['Object', 'Manager'], propertySchema: 'document',
    pathSegment: 'Документы', englishKind: 'Document',
    repositoryClassId: '061d872a-5787-460e-95ac-ed74ea3a3e84' }),
  DocumentNumerator: metaDef({ kind: 'DocumentNumerator', label: 'Нумератор документов', pluralLabel: 'Нумераторы',
    folder: 'DocumentNumerators', icon: 'documentNumerator', group: 'documents-branch', groupOrder: 0,
    pathSegment: 'Нумераторы', englishKind: 'DocumentNumerator',
    repositoryClassId: '36a8e346-9aaa-4af9-bdbd-83be3c177977' }),
  Sequence: metaDef({ kind: 'Sequence', label: 'Последовательность', pluralLabel: 'Последовательности',
    folder: 'Sequences', icon: 'sequence', group: 'documents-branch', groupOrder: 1,
    pathSegment: 'Последовательности', englishKind: 'Sequence',
    repositoryClassId: 'bc587f20-35d9-11d6-a3c7-0050bae0a776' }),
  DocumentJournal: metaDef({ kind: 'DocumentJournal', label: 'Журнал документов', pluralLabel: 'Журналы документов',
    folder: 'DocumentJournals', icon: 'documentJournal', group: 'top', groupOrder: 40,
    childTags: ['StandardAttribute', 'Form', 'Command', 'Template'],
    modules: ['Manager'],
    pathSegment: 'ЖурналыДокументов', englishKind: 'DocumentJournal',
    repositoryClassId: '4612bd75-71b7-4a5c-8cc5-2b0b65f9fa0d' }),
  Enum: metaDef({ kind: 'Enum', label: 'Перечисление', pluralLabel: 'Перечисления',
    folder: 'Enums', icon: 'enum', group: 'top', groupOrder: 50,
    childTags: ['StandardAttribute', 'EnumValue', 'Form', 'Command', 'Template'], modules: ['Manager'],
    pathSegment: 'Перечисления', englishKind: 'Enum',
    repositoryClassId: 'f6a80749-5ad7-400b-8519-39dc5dff2542' }),
  Report: metaDef({ kind: 'Report', label: 'Отчёт', pluralLabel: 'Отчёты',
    folder: 'Reports', icon: 'report', group: 'top', groupOrder: 60,
    childTags: ['StandardAttribute', 'Attribute', 'TabularSection', 'Form', 'Command', 'Template'],
    modules: ['Object', 'Manager'],
    pathSegment: 'Отчеты', englishKind: 'Report',
    repositoryClassId: '631b75a0-29e2-11d6-a3c7-0050bae0a776' }),
  DataProcessor: metaDef({ kind: 'DataProcessor', label: 'Обработка', pluralLabel: 'Обработки',
    folder: 'DataProcessors', icon: 'dataProcessor', group: 'top', groupOrder: 70,
    childTags: ['StandardAttribute', 'Attribute', 'TabularSection', 'Form', 'Command', 'Template'],
    modules: ['Object', 'Manager'],
    pathSegment: 'Обработки', englishKind: 'DataProcessor',
    repositoryClassId: 'bf845118-327b-4682-b5c6-285d2a0eb296' }),
  ChartOfCharacteristicTypes: metaDef({ kind: 'ChartOfCharacteristicTypes', label: 'План видов характеристик',
    pluralLabel: 'Планы видов характеристик',
    folder: 'ChartsOfCharacteristicTypes', icon: 'chartsOfCharacteristicType', group: 'top', groupOrder: 80,
    childTags: ['StandardAttribute', 'Attribute', 'TabularSection', 'Form', 'Command', 'Template'],
    modules: ['Object', 'Manager'],
    pathSegment: 'ПланыВидовХарактеристик', englishKind: 'ChartOfCharacteristicTypes',
    repositoryClassId: '82a1b659-b220-4d94-a9bd-14d757b95a48' }),
  ChartOfAccounts: metaDef({ kind: 'ChartOfAccounts', label: 'План счетов', pluralLabel: 'Планы счетов',
    folder: 'ChartsOfAccounts', icon: 'chartsOfAccount', group: 'top', groupOrder: 90,
    childTags: ['StandardAttribute', 'Attribute', 'TabularSection', 'Form', 'Command', 'Template'],
    modules: ['Object', 'Manager'],
    pathSegment: 'ПланыСчетов', englishKind: 'ChartOfAccounts',
    repositoryClassId: '238e7e88-3c5f-48b2-8a3b-81ebbecb20ed' }),
  ChartOfCalculationTypes: metaDef({ kind: 'ChartOfCalculationTypes', label: 'План видов расчёта',
    pluralLabel: 'Планы видов расчёта',
    folder: 'ChartsOfCalculationTypes', icon: 'chartsOfCalculationType', group: 'top', groupOrder: 100,
    childTags: ['StandardAttribute', 'Attribute', 'TabularSection', 'Form', 'Command', 'Template'],
    modules: ['Object', 'Manager'],
    pathSegment: 'ПланыВидовРасчета', englishKind: 'ChartOfCalculationTypes',
    repositoryClassId: '30b100d6-b29f-47ac-aec7-cb8ca8a54767' }),
  InformationRegister: metaDef({ kind: 'InformationRegister', label: 'Регистр сведений', pluralLabel: 'Регистры сведений',
    folder: 'InformationRegisters', icon: 'informationRegister', group: 'top', groupOrder: 110,
    childTags: ['StandardAttribute', 'Dimension', 'Resource', 'Attribute', 'Form', 'Command', 'Template'],
    modules: ['Manager', 'RecordSet'],
    pathSegment: 'РегистрыСведений', englishKind: 'InformationRegister',
    repositoryClassId: '13134201-f60b-11d5-a3c7-0050bae0a776' }),
  AccumulationRegister: metaDef({ kind: 'AccumulationRegister', label: 'Регистр накопления', pluralLabel: 'Регистры накопления',
    folder: 'AccumulationRegisters', icon: 'accumulationRegister', group: 'top', groupOrder: 120,
    childTags: ['StandardAttribute', 'Dimension', 'Resource', 'Attribute', 'Form', 'Command', 'Template'],
    modules: ['Manager', 'RecordSet'],
    pathSegment: 'РегистрыНакопления', englishKind: 'AccumulationRegister',
    repositoryClassId: 'b64d9a40-1642-11d6-a3c7-0050bae0a776' }),
  AccountingRegister: metaDef({ kind: 'AccountingRegister', label: 'Регистр бухгалтерии', pluralLabel: 'Регистры бухгалтерии',
    folder: 'AccountingRegisters', icon: 'accountingRegister', group: 'top', groupOrder: 130,
    childTags: ['StandardAttribute', 'Dimension', 'Resource', 'Attribute', 'Form', 'Command', 'Template'],
    modules: ['Manager', 'RecordSet'],
    pathSegment: 'РегистрыБухгалтерии', englishKind: 'AccountingRegister',
    repositoryClassId: '2deed9b8-0056-4ffe-a473-c20a6c32a0bc' }),
  CalculationRegister: metaDef({ kind: 'CalculationRegister', label: 'Регистр расчёта', pluralLabel: 'Регистры расчёта',
    folder: 'CalculationRegisters', icon: 'calculationRegister', group: 'top', groupOrder: 140,
    childTags: ['StandardAttribute', 'Dimension', 'Resource', 'Attribute', 'Form', 'Command', 'Template'],
    modules: ['Manager', 'RecordSet'],
    pathSegment: 'РегистрыРасчета', englishKind: 'CalculationRegister',
    repositoryClassId: 'f2de87a8-64e5-45eb-a22d-b3aedab050e7' }),
  BusinessProcess: metaDef({ kind: 'BusinessProcess', label: 'Бизнес-процесс', pluralLabel: 'Бизнес-процессы',
    folder: 'BusinessProcesses', icon: 'businessProcess', group: 'top', groupOrder: 150,
    childTags: ['StandardAttribute', 'Attribute', 'TabularSection', 'Form', 'Command', 'Template'],
    modules: ['Object', 'Manager'],
    pathSegment: 'БизнесПроцессы', englishKind: 'BusinessProcess',
    repositoryClassId: 'fcd3404e-1523-48ce-9bc0-ecdb822684a1' }),
  Task: metaDef({ kind: 'Task', label: 'Задача', pluralLabel: 'Задачи',
    folder: 'Tasks', icon: 'task', group: 'top', groupOrder: 160,
    childTags: ['StandardAttribute', 'Attribute', 'AddressingAttribute', 'TabularSection', 'Form', 'Command', 'Template'],
    modules: ['Object', 'Manager'],
    pathSegment: 'Задачи', englishKind: 'Task',
    repositoryClassId: '3e63355c-1378-4953-be9b-1deb5fb6bec5' }),
  ExternalDataSource: metaDef({ kind: 'ExternalDataSource', label: 'Внешний источник данных', pluralLabel: 'Внешние источники данных',
    folder: 'ExternalDataSources', icon: 'externalDataSource', group: 'top', groupOrder: 170,
    pathSegment: 'ВнешниеИсточникиДанных', englishKind: 'ExternalDataSource',
    repositoryClassId: '5274d9fc-9c3a-4a71-8f5e-a0db8ab23de5' }),

  // ── Дочерние элементы объектов ────────────────────────────────────────
  StandardAttribute: metaDef({ kind: 'StandardAttribute', label: 'Стандартный реквизит', pluralLabel: 'Стандартные реквизиты',
    icon: 'attribute', group: 'child', groupOrder: 0, propertySchema: 'standardAttribute' }),
  Attribute: metaDef({ kind: 'Attribute', label: 'Реквизит', pluralLabel: 'Реквизиты',
    icon: 'attribute', group: 'child', groupOrder: 0, propertySchema: 'typedField' }),
  AddressingAttribute: metaDef({ kind: 'AddressingAttribute', label: 'Реквизит адресации', pluralLabel: 'Реквизиты адресации',
    icon: 'attribute', group: 'child', groupOrder: 0, propertySchema: 'typedField' }),
  TabularSection: metaDef({ kind: 'TabularSection', label: 'Табличная часть', pluralLabel: 'Табличные части',
    icon: 'tabularSection', group: 'child', groupOrder: 0, propertySchema: 'tabularSection' }),
  Column: metaDef({ kind: 'Column', label: 'Колонка', pluralLabel: 'Колонки',
    icon: 'attribute', group: 'child', groupOrder: 0, propertySchema: 'typedField' }),
  Form: metaDef({ kind: 'Form', label: 'Форма', pluralLabel: 'Формы',
    icon: 'form', group: 'child', groupOrder: 0,
    modules: ['ChildForm'], singleClickCommand: 'openFormModule', propertySchema: 'form',
    repositoryClassId: 'fdf816d2-1ead-11d5-b975-0050bae0a95d' }),
  Command: metaDef({ kind: 'Command', label: 'Команда', pluralLabel: 'Команды',
    icon: 'command', group: 'child', groupOrder: 0,
    modules: ['ChildCommand'], singleClickCommand: 'openCommandModule', propertySchema: 'command' }),
  Template: metaDef({ kind: 'Template', label: 'Макет', pluralLabel: 'Макеты',
    icon: 'template', group: 'child', groupOrder: 0, propertySchema: 'template',
    repositoryClassId: '3daea016-69b7-4ed4-9453-127911372fe6' }),
  Dimension: metaDef({ kind: 'Dimension', label: 'Измерение', pluralLabel: 'Измерения',
    icon: 'dimension', group: 'child', groupOrder: 0, propertySchema: 'typedField' }),
  Resource: metaDef({ kind: 'Resource', label: 'Ресурс', pluralLabel: 'Ресурсы',
    icon: 'resource', group: 'child', groupOrder: 0, propertySchema: 'typedField' }),
  EnumValue: metaDef({ kind: 'EnumValue', label: 'Значение перечисления', pluralLabel: 'Значения',
    icon: 'enum', group: 'child', groupOrder: 0, propertySchema: 'enumValue' }),
  URLTemplate: metaDef({ kind: 'URLTemplate', label: 'URL-шаблон', pluralLabel: 'URL-шаблоны',
    icon: 'http', group: 'child', groupOrder: 0, childTags: ['Method'], propertySchema: 'urlTemplate' }),
  Method: metaDef({ kind: 'Method', label: 'Метод', pluralLabel: 'Методы',
    icon: 'command', group: 'child', groupOrder: 0, propertySchema: 'httpMethod' }),
};

// ── Доступ к реестру ────────────────────────────────────────────────────

/** Возвращает описание типа по идентификатору; выбрасывает исключение, если тип неизвестен */
export function getMetaType(kind: MetaKind): MetaTypeDef {
  return META_TYPES[kind];
}

/** Короткое имя типа (label) */
export function getMetaLabel(kind: MetaKind): string {
  return META_TYPES[kind].label;
}

/** Имя иконки для типа (без пути и расширения) */
export function getMetaIcon(kind: MetaKind): string {
  return META_TYPES[kind].icon;
}

/** Возвращает все типы указанной группы, отсортированные по `groupOrder` */
export function getMetaTypesByGroup(group: MetaGroup): MetaTypeDef[] {
  return Object.values(META_TYPES)
    .filter((def) => def.group === group)
    .sort((a, b) => a.groupOrder - b.groupOrder);
}

/**
 * Вид метаданных по classID протокола хранилища (без учёта регистра); неизвестный — `undefined`.
 * Карта выводится из `META_TYPES`, а не ведётся отдельно.
 */
export function getMetaKindByRepositoryClassId(classId: string): MetaKind | undefined {
  return KIND_BY_REPOSITORY_CLASS_ID.get(classId.toLowerCase());
}

const KIND_BY_REPOSITORY_CLASS_ID: ReadonlyMap<string, MetaKind> = new Map(
  Object.values(META_TYPES).flatMap((def): [string, MetaKind][] =>
    def.repositoryClassId === undefined ? [] : [[def.repositoryClassId, def.kind]]
  )
);

/** Возвращает папку выгрузки по типу или `null`, если у типа нет файлов на диске или тип неизвестен */
export function getMetaFolder(kind: MetaKind): string | null {
  // Доступ по индексу может вернуть undefined в рантайме, если извне пришёл невалидный ключ
  // (например, из as-каста при разборе чужой ChildObjects-секции), хотя тип это и не отражает.
  const def = META_TYPES[kind] as MetaTypeDef | undefined;
  return def?.folder ?? null;
}

/**
 * Возвращает `true`, если данный слот модуля допустим для указанного типа.
 * Когда тип неизвестен или поле `modules` не задано — разрешаем (консервативно).
 * Используется перед созданием нового BSL-файла, чтобы не порождать файлы,
 * которые платформа 1С не распознаёт как свойства объекта метаданных.
 */
export function isModuleSlotValid(kind: string, slot: ModuleSlot): boolean {
  const def = (META_TYPES as Readonly<Record<string, MetaTypeDef | undefined>>)[kind];
  if (!def?.modules) {
    return true;
  }
  return def.modules.includes(slot);
}
