/**
 * Опции формы подключения к хранилищу и создания хранилища (issues #184, #185): какие флаги
 * Конфигуратора относятся к какому режиму, их подписи, подсказки и значения по умолчанию, и
 * построение аргументов команд `repository-bind` / `repository-create` из значений формы.
 * Тексты живут здесь, рядом с ключами платформы, а webview только рисует полученное описание.
 */

export type RepositoryConnectionMode = 'connect' | 'create';

/**
 * Правило поддержки для объектов поставщика — значения `-ChangesAllowedRule` /
 * `-ChangesNotRecommendedRule` команды `/ConfigurationRepositoryCreate`. Перечисление и русские
 * названия — из XSD платформы (`SupportRulesForNewObjects`). Прежние значения формы `allow` /
 * `dontAllow` платформа 8.5.1 отвергает: создание хранилища завершается с кодом 1.
 */
export type RepositorySupportRule = 'ObjectNotEditable' | 'ObjectIsEditableSupportEnabled' | 'ObjectNotSupported';

export interface RepositorySupportRuleOption {
  readonly value: RepositorySupportRule;
  readonly label: string;
}

export const REPOSITORY_SUPPORT_RULES: readonly RepositorySupportRuleOption[] = [
  { value: 'ObjectNotEditable', label: 'Объект поставщика не редактируется' },
  { value: 'ObjectIsEditableSupportEnabled', label: 'Объект поставщика редактируется с сохранением поддержки' },
  { value: 'ObjectNotSupported', label: 'Объект поставщика снят с поддержки' },
];

/** Значения опций формы; набор полей, который учитывается, зависит от режима. */
export interface RepositoryConnectionOptionValues {
  readonly forceBindAlreadyBindedUser?: boolean;
  readonly forceReplaceCfg?: boolean;
  readonly allowConfigurationChanges?: boolean;
  readonly changesAllowedRule?: string;
  readonly changesNotRecommendedRule?: string;
  readonly noBind?: boolean;
}

export type RepositoryFlagOptionId = 'forceBindAlreadyBindedUser' | 'forceReplaceCfg' | 'allowConfigurationChanges' | 'noBind';
export type RepositoryRuleOptionId = 'changesAllowedRule' | 'changesNotRecommendedRule';

export interface RepositoryFlagOptionDescriptor {
  readonly kind: 'flag';
  readonly id: RepositoryFlagOptionId;
  readonly label: string;
  readonly hint: string;
  readonly defaultValue: boolean;
}

export interface RepositoryRuleOptionDescriptor {
  readonly kind: 'rule';
  readonly id: RepositoryRuleOptionId;
  readonly label: string;
  readonly hint: string;
  readonly defaultValue: RepositorySupportRule;
  /** Флаг, без которого правило не передаётся и в форме скрыто. */
  readonly requires: 'allowConfigurationChanges';
}

export type RepositoryOptionDescriptor = RepositoryFlagOptionDescriptor | RepositoryRuleOptionDescriptor;

/** Описание формы для webview: опции режима в порядке показа и справочник правил. */
export interface RepositoryConnectionFormDescription {
  readonly options: readonly RepositoryOptionDescriptor[];
  readonly supportRules: readonly RepositorySupportRuleOption[];
}

/**
 * Таблицы описаний по `id`: компилятор проверяет, что у каждого `id` есть описание нужного вида,
 * поэтому значение по умолчанию берётся без поиска и приведения типа (issue #203).
 */
const FLAG_OPTIONS: { readonly [K in RepositoryFlagOptionId]: RepositoryFlagOptionDescriptor & { readonly id: K } } = {
  forceBindAlreadyBindedUser: {
    kind: 'flag',
    id: 'forceBindAlreadyBindedUser',
    label: 'Принудительно перепривязать пользователя хранилища',
    hint: 'Если этот пользователь хранилища уже привязан к другой базе, привязка переносится на текущую. '
      + 'Прежняя база теряет связь с хранилищем, захваченные из неё объекты остаются захваченными.',
    // Обычный сценарий — переподключение базы, когда пользователь уже привязан к другой базе.
    defaultValue: true,
  },
  forceReplaceCfg: {
    kind: 'flag',
    id: 'forceReplaceCfg',
    label: 'Принудительно заменить конфигурацию',
    hint: 'Если конфигурация базы не пустая, она заменяется конфигурацией из хранилища. '
      + 'Изменения в базе, не помещённые в хранилище, будут потеряны.',
    defaultValue: true,
  },
  allowConfigurationChanges: {
    kind: 'flag',
    id: 'allowConfigurationChanges',
    label: 'Разрешить изменения конфигурации',
    hint: 'Нужно, если конфигурация на поддержке поставщика без возможности изменения: при создании '
      + 'хранилища платформа включает возможность изменений и применяет к объектам поставщика правила ниже.',
    defaultValue: false,
  },
  noBind: {
    kind: 'flag',
    id: 'noBind',
    label: 'Не привязывать проект к хранилищу',
    hint: 'Хранилище создаётся, но текущая база к нему не подключается, и проект не помечается подключённым.',
    defaultValue: false,
  },
};

const RULE_OPTIONS: { readonly [K in RepositoryRuleOptionId]: RepositoryRuleOptionDescriptor & { readonly id: K } } = {
  changesAllowedRule: {
    kind: 'rule',
    id: 'changesAllowedRule',
    label: 'Правило для объектов с правилом поставки «Изменения разрешены»',
    hint: 'Какой режим поддержки получат объекты, которые поставщик разрешает изменять.',
    defaultValue: 'ObjectIsEditableSupportEnabled',
    requires: 'allowConfigurationChanges',
  },
  changesNotRecommendedRule: {
    kind: 'rule',
    id: 'changesNotRecommendedRule',
    label: 'Правило для объектов с правилом поставки «Изменения не рекомендуются»',
    hint: 'Какой режим поддержки получат объекты, изменять которые поставщик не рекомендует.',
    defaultValue: 'ObjectNotEditable',
    requires: 'allowConfigurationChanges',
  },
};

const CONNECT_OPTIONS: readonly RepositoryOptionDescriptor[] = [
  FLAG_OPTIONS.forceBindAlreadyBindedUser,
  FLAG_OPTIONS.forceReplaceCfg,
];

const CREATE_OPTIONS: readonly RepositoryOptionDescriptor[] = [
  FLAG_OPTIONS.allowConfigurationChanges,
  RULE_OPTIONS.changesAllowedRule,
  RULE_OPTIONS.changesNotRecommendedRule,
  FLAG_OPTIONS.noBind,
];

export function describeRepositoryConnectionForm(mode: RepositoryConnectionMode): RepositoryConnectionFormDescription {
  return {
    options: mode === 'connect' ? CONNECT_OPTIONS : CREATE_OPTIONS,
    supportRules: REPOSITORY_SUPPORT_RULES,
  };
}

/** Значение флага формы; не заданный явно флаг берёт значение по умолчанию своего описания. */
function flag(values: RepositoryConnectionOptionValues, id: RepositoryFlagOptionId): boolean {
  return values[id] ?? FLAG_OPTIONS[id].defaultValue;
}

/** Допустимое значение правила; постороннее заменяется значением по умолчанию, а не уходит в Конфигуратор. */
function rule(values: RepositoryConnectionOptionValues, id: RepositoryRuleOptionId): RepositorySupportRule {
  const value = values[id];
  const known = REPOSITORY_SUPPORT_RULES.find((item) => item.value === value);
  return known?.value ?? RULE_OPTIONS[id].defaultValue;
}

export function buildRepositoryBindArgs(values: RepositoryConnectionOptionValues): string[] {
  return [
    ...(flag(values, 'forceBindAlreadyBindedUser') ? ['-ForceBindAlreadyBindedUser'] : []),
    ...(flag(values, 'forceReplaceCfg') ? ['-ForceReplaceCfg'] : []),
  ];
}

/**
 * Правила передаются только вместе с `-AllowConfigurationChanges`: по синтаксису платформы это
 * одна группа параметров, и без разрешения изменений правила не применяются.
 */
export function buildRepositoryCreateArgs(values: RepositoryConnectionOptionValues): string[] {
  return [
    ...(flag(values, 'allowConfigurationChanges')
      ? ['-AllowConfigurationChanges',
        '-ChangesAllowedRule', rule(values, 'changesAllowedRule'),
        '-ChangesNotRecommendedRule', rule(values, 'changesNotRecommendedRule')]
      : []),
    ...(flag(values, 'noBind') ? ['-NoBind'] : []),
  ];
}

/** Привязывает ли создание хранилища проект к нему (без `-NoBind`). */
export function createBindsProject(values: RepositoryConnectionOptionValues): boolean {
  return !flag(values, 'noBind');
}
