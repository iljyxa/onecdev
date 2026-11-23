import * as assert from 'assert';
import {
  buildRepositoryBindArgs,
  buildRepositoryCreateArgs,
  createBindsProject,
  describeRepositoryConnectionForm,
  REPOSITORY_SUPPORT_RULES,
} from '../../infra/repository/RepositoryConnectionOptions';

/**
 * Опции формы хранилища (issues #184, #185): набор опций по режиму и аргументы Конфигуратора.
 * Значения правил поддержки сверены с платформой 8.5.1 и 8.3.27 на конфигурации на поддержке
 * (`Ext/ParentConfigurations/ТорговыйУчет.cf` фикстур example/2.21 и example/2.20): `/ConfigurationRepositoryCreate
 * -AllowConfigurationChanges -ChangesAllowedRule allow …` завершается с кодом 1, значения ниже —
 * «Создание хранилища конфигурации успешно завершено».
 */
suite('RepositoryConnectionOptions — опции формы хранилища (issues #184, #185)', () => {
  test('правила поддержки — перечисление платформы SupportRulesForNewObjects', () => {
    assert.deepStrictEqual(REPOSITORY_SUPPORT_RULES.map((rule) => rule.value),
      ['ObjectNotEditable', 'ObjectIsEditableSupportEnabled', 'ObjectNotSupported']);
  });

  test('connect: только флаги привязки, оба включены по умолчанию, у каждого есть подсказка', () => {
    const { options } = describeRepositoryConnectionForm('connect');
    assert.deepStrictEqual(options.map((option) => [option.id, option.defaultValue]),
      [['forceBindAlreadyBindedUser', true], ['forceReplaceCfg', true]]);
    assert.ok(options.every((option) => option.hint.length > 0));
    assert.ok(options[1].hint.includes('будут потеряны'), options[1].hint);
  });

  test('create: разрешение изменений, два правила под ним и NoBind', () => {
    const form = describeRepositoryConnectionForm('create');
    assert.deepStrictEqual(form.options.map((option) => [option.id, option.defaultValue]), [
      ['allowConfigurationChanges', false],
      ['changesAllowedRule', 'ObjectIsEditableSupportEnabled'],
      ['changesNotRecommendedRule', 'ObjectNotEditable'],
      ['noBind', false],
    ]);
    assert.deepStrictEqual(form.options.filter((option) => option.kind === 'rule').map((option) => option.requires),
      ['allowConfigurationChanges', 'allowConfigurationChanges']);
    assert.strictEqual(form.supportRules, REPOSITORY_SUPPORT_RULES);
    assert.ok(form.options.every((option) => option.hint.length > 0));
  });

  const bindCases: { values: Parameters<typeof buildRepositoryBindArgs>[0]; expected: string[] }[] = [
    { values: {}, expected: ['-ForceBindAlreadyBindedUser', '-ForceReplaceCfg'] },
    { values: { forceBindAlreadyBindedUser: false }, expected: ['-ForceReplaceCfg'] },
    { values: { forceBindAlreadyBindedUser: true, forceReplaceCfg: false }, expected: ['-ForceBindAlreadyBindedUser'] },
    // Опции создания в режиме подключения не участвуют.
    { values: { forceBindAlreadyBindedUser: false, forceReplaceCfg: false, noBind: true, allowConfigurationChanges: true }, expected: [] },
  ];
  for (const { values, expected } of bindCases) {
    test(`bind ${JSON.stringify(values)} → ${JSON.stringify(expected)}`, () => {
      assert.deepStrictEqual(buildRepositoryBindArgs(values), expected);
    });
  }

  const createCases: { values: Parameters<typeof buildRepositoryCreateArgs>[0]; expected: string[] }[] = [
    { values: {}, expected: [] },
    // Без разрешения изменений правила не передаются, даже если пришли из формы.
    { values: { changesAllowedRule: 'ObjectNotSupported', changesNotRecommendedRule: 'ObjectNotSupported', forceReplaceCfg: true }, expected: [] },
    {
      values: { allowConfigurationChanges: true },
      expected: ['-AllowConfigurationChanges', '-ChangesAllowedRule', 'ObjectIsEditableSupportEnabled',
        '-ChangesNotRecommendedRule', 'ObjectNotEditable'],
    },
    {
      values: { allowConfigurationChanges: true, changesAllowedRule: 'ObjectNotSupported', changesNotRecommendedRule: 'ObjectIsEditableSupportEnabled', noBind: true },
      expected: ['-AllowConfigurationChanges', '-ChangesAllowedRule', 'ObjectNotSupported',
        '-ChangesNotRecommendedRule', 'ObjectIsEditableSupportEnabled', '-NoBind'],
    },
    // Прежние значения формы платформа отвергает — подставляется значение по умолчанию.
    {
      values: { allowConfigurationChanges: true, changesAllowedRule: 'allow', changesNotRecommendedRule: 'dontAllow' },
      expected: ['-AllowConfigurationChanges', '-ChangesAllowedRule', 'ObjectIsEditableSupportEnabled',
        '-ChangesNotRecommendedRule', 'ObjectNotEditable'],
    },
    { values: { noBind: true }, expected: ['-NoBind'] },
  ];
  for (const { values, expected } of createCases) {
    test(`create ${JSON.stringify(values)} → ${JSON.stringify(expected)}`, () => {
      assert.deepStrictEqual(buildRepositoryCreateArgs(values), expected);
    });
  }

  test('createBindsProject — без NoBind проект привязывается', () => {
    assert.strictEqual(createBindsProject({}), true);
    assert.strictEqual(createBindsProject({ noBind: false }), true);
    assert.strictEqual(createBindsProject({ noBind: true }), false);
  });
});
