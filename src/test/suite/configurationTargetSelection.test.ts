/**
 * Issue #42 — неинтерактивный выбор целей импорта/обновления конфигураций
 * (`src/ui/commands/ext/configurationTargetSelection.ts`).
 *
 * Модуль без `vscode`/`fs`/`path`: чистые функции над списком кандидатов.
 * Кандидаты — реальные имена и корни фикстур `example/2.21/src/cf`
 * (`ТорговыйУчет`) и `example/2.21/src/cfe/EVOLC`; интерактивный выбор
 * передаётся параметром, поэтому вместо QuickPick — записывающая функция.
 */
import * as assert from 'assert';
import * as path from 'path';
import {
  type ConfigurationSelectionScope,
  type ConfigurationTarget,
  type ConfigurationTargetRequest,
  type ConfigurationTargetSelection,
  isConfigurationTargetRequest,
  orderConfigurationTargets,
  parseConfigurationSelectionArgs,
  resolveConfigurationTargets,
  selectConfigurationTargets,
} from '../../ui/commands/ext/configurationTargetSelection';

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const EXAMPLE_CFE_EVOLC = path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC');
const CF: ConfigurationTarget = { kind: 'cf', name: 'ТорговыйУчет', rootPath: EXAMPLE_CF };
const CFE: ConfigurationTarget = { kind: 'cfe', name: 'EVOLC', rootPath: EXAMPLE_CFE_EVOLC };

const SCOPES: readonly ConfigurationSelectionScope[] = ['import', 'update'];

type InvalidOutcome = Extract<ConfigurationTargetSelection<ConfigurationTarget>, { kind: 'invalid' }>['outcome'];

function invalidOutcome(selection: ConfigurationTargetSelection<ConfigurationTarget>): InvalidOutcome {
  if (selection.kind !== 'invalid') {
    assert.fail(`ожидался исход invalid, получен ${JSON.stringify(selection)}`);
  }
  return selection.outcome;
}

function throwingPicker(): Promise<ConfigurationTarget[] | undefined> {
  throw new Error('picker не должен вызываться при явном запросе выбора');
}

suite('configurationTargetSelection (issue #42)', () => {
  suite('isConfigurationTargetRequest', () => {
    const VALID: readonly ConfigurationTargetRequest[] = [
      { mode: 'auto' },
      { mode: 'all' },
      { mode: 'names', names: ['A'] },
    ];
    VALID.forEach((value) => {
      test(`true: ${JSON.stringify(value)}`, () => {
        assert.strictEqual(isConfigurationTargetRequest(value), true);
      });
    });

    const INVALID: readonly { label: string; value: unknown }[] = [
      { label: 'undefined', value: undefined },
      { label: 'null', value: null },
      { label: 'строка "auto"', value: 'auto' },
      {
        label: 'узел дерева (NodeArg)',
        value: { xmlPath: path.join(EXAMPLE_CF, 'Configuration.xml'), nodeKind: 'configuration', label: 'Основная конфигурация' },
      },
      { label: 'неизвестный mode', value: { mode: 'x' } },
      { label: 'names без массива', value: { mode: 'names' } },
      { label: 'names строкой', value: { mode: 'names', names: 'A' } },
      { label: 'names с не-строкой', value: { mode: 'names', names: [1] } },
      { label: 'names пустой', value: { mode: 'names', names: [] } },
    ];
    INVALID.forEach(({ label, value }) => {
      test(`false: ${label}`, () => {
        assert.strictEqual(isConfigurationTargetRequest(value), false);
      });
    });
  });

  suite('parseConfigurationSelectionArgs', () => {
    test('{} → auto', () => {
      assert.deepStrictEqual(parseConfigurationSelectionArgs({}), { ok: true, request: { mode: 'auto' } });
    });

    test('{all:false} → auto', () => {
      assert.deepStrictEqual(parseConfigurationSelectionArgs({ all: false }), { ok: true, request: { mode: 'auto' } });
    });

    test('{all:true} → all', () => {
      assert.deepStrictEqual(parseConfigurationSelectionArgs({ all: true }), { ok: true, request: { mode: 'all' } });
    });

    test('{configurations:[EVOLC]} → names', () => {
      assert.deepStrictEqual(
        parseConfigurationSelectionArgs({ configurations: ['EVOLC'] }),
        { ok: true, request: { mode: 'names', names: ['EVOLC'] } }
      );
    });

    test('trim и дедупликация без учёта регистра, порядок первого вхождения', () => {
      assert.deepStrictEqual(
        parseConfigurationSelectionArgs({ configurations: ['EVOLC', ' evolc ', 'ТорговыйУчет'] }),
        { ok: true, request: { mode: 'names', names: ['EVOLC', 'ТорговыйУчет'] } }
      );
    });

    test('{configurations:[A], all:false} → names', () => {
      assert.deepStrictEqual(
        parseConfigurationSelectionArgs({ configurations: ['A'], all: false }),
        { ok: true, request: { mode: 'names', names: ['A'] } }
      );
    });

    const ERRORS: readonly { label: string; args: { configurations?: string[]; all?: boolean }; mentions: string }[] = [
      { label: 'configurations вместе с all:true', args: { configurations: ['A'], all: true }, mentions: 'all' },
      { label: 'пустой configurations', args: { configurations: [] }, mentions: 'configurations' },
      { label: 'пустое имя', args: { configurations: [''] }, mentions: 'configurations' },
      { label: 'пробельное имя', args: { configurations: ['  '] }, mentions: 'configurations' },
    ];
    ERRORS.forEach(({ label, args, mentions }) => {
      test(`ошибка: ${label}`, () => {
        const result = parseConfigurationSelectionArgs(args);
        assert.ok(!result.ok, 'ожидалась ошибка формы аргументов');
        assert.ok(result.error.includes(mentions), `текст ошибки должен упоминать ${mentions}`);
      });
    });
  });

  suite('resolveConfigurationTargets', () => {
    SCOPES.forEach((scope) => {
      suite(`scope=${scope}`, () => {
        test('auto, один кандидат → selected', () => {
          assert.deepStrictEqual(
            resolveConfigurationTargets([CF], { mode: 'auto' }, scope),
            { kind: 'selected', targets: [CF] }
          );
        });

        test('auto, два кандидата → invalid selection-required, available в порядке кандидатов', () => {
          const { message, ...rest } = invalidOutcome(resolveConfigurationTargets([CFE, CF], { mode: 'auto' }, scope));
          assert.deepStrictEqual(rest, {
            status: 'invalid-selection',
            reason: 'selection-required',
            available: [CFE.name, CF.name],
          });
          assert.ok(message.includes(CF.name) && message.includes(CFE.name), message);
          assert.ok(message.includes('configurations') && message.includes('all'), message);
        });

        test('all → все кандидаты', () => {
          assert.deepStrictEqual(
            resolveConfigurationTargets([CF, CFE], { mode: 'all' }, scope),
            { kind: 'selected', targets: [CF, CFE] }
          );
        });

        test('names точно → выбранный кандидат', () => {
          assert.deepStrictEqual(
            resolveConfigurationTargets([CF, CFE], { mode: 'names', names: ['ТорговыйУчет'] }, scope),
            { kind: 'selected', targets: [CF] }
          );
        });

        test('names без учёта регистра: "evolc" → EVOLC', () => {
          assert.deepStrictEqual(
            resolveConfigurationTargets([CF, CFE], { mode: 'names', names: ['evolc'] }, scope),
            { kind: 'selected', targets: [CFE] }
          );
        });

        test('names двух — порядок кандидатов, а не запроса', () => {
          assert.deepStrictEqual(
            resolveConfigurationTargets([CF, CFE], { mode: 'names', names: ['EVOLC', 'ТорговыйУчет'] }, scope),
            { kind: 'selected', targets: [CF, CFE] }
          );
        });

        test('неизвестное имя → invalid unknown-names с unknown и available', () => {
          const { message, ...rest } = invalidOutcome(
            resolveConfigurationTargets([CF, CFE], { mode: 'names', names: ['Нет'] }, scope)
          );
          assert.deepStrictEqual(rest, {
            status: 'invalid-selection',
            reason: 'unknown-names',
            available: [CF.name, CFE.name],
            unknown: ['Нет'],
          });
          assert.ok(message.includes('Нет'), message);
        });

        test('смесь известного и неизвестного → invalid без частичного выбора', () => {
          const outcome = invalidOutcome(
            resolveConfigurationTargets([CF, CFE], { mode: 'names', names: ['EVOLC', 'Нет'] }, scope)
          );
          assert.deepStrictEqual(outcome.unknown, ['Нет']);
        });

        test('ё не равно е: "ТорговыйУчёт" не совпадает с "ТорговыйУчет"', () => {
          const outcome = invalidOutcome(resolveConfigurationTargets([CF], { mode: 'names', names: ['ТорговыйУчёт'] }, scope));
          assert.deepStrictEqual(outcome.unknown, ['ТорговыйУчёт']);
        });

        test('cf и cfe с одинаковым нормализованным именем → выбраны оба', () => {
          const sameNamedCfe: ConfigurationTarget = { kind: 'cfe', name: 'торговыйучет', rootPath: EXAMPLE_CFE_EVOLC };
          assert.deepStrictEqual(
            resolveConfigurationTargets([CF, sameNamedCfe], { mode: 'names', names: ['ТОРГОВЫЙУЧЕТ'] }, scope),
            { kind: 'selected', targets: [CF, sameNamedCfe] }
          );
        });
      });
    });

    test('тексты selection-required различаются для import и update', () => {
      const messages = SCOPES.map((scope) => invalidOutcome(resolveConfigurationTargets([CF, CFE], { mode: 'auto' }, scope)).message);
      assert.notStrictEqual(messages[0], messages[1]);
    });

    test('тексты unknown-names различаются для import и update', () => {
      const messages = SCOPES.map((scope) => invalidOutcome(resolveConfigurationTargets([CF], { mode: 'names', names: ['Нет'] }, scope)).message);
      assert.notStrictEqual(messages[0], messages[1]);
    });
  });

  suite('selectConfigurationTargets', () => {
    test('request undefined → picker вызван один раз со всеми кандидатами, подмножество → selected', async () => {
      const calls: ConfigurationTarget[][] = [];
      const selection = await selectConfigurationTargets([CF, CFE], undefined, 'import', (candidates) => {
        calls.push(candidates);
        return Promise.resolve([CFE]);
      });
      assert.deepStrictEqual(calls, [[CF, CFE]]);
      assert.deepStrictEqual(selection, { kind: 'selected', targets: [CFE] });
    });

    [undefined, []].forEach((picked) => {
      test(`request undefined, picker вернул ${JSON.stringify(picked)} → cancelled`, async () => {
        const selection = await selectConfigurationTargets([CF, CFE], undefined, 'update', () => Promise.resolve(picked));
        assert.deepStrictEqual(selection, { kind: 'cancelled' });
      });
    });

    const REQUESTS: readonly { request: ConfigurationTargetRequest; expected: ConfigurationTarget[] }[] = [
      { request: { mode: 'auto' }, expected: [CF] },
      { request: { mode: 'all' }, expected: [CF] },
      { request: { mode: 'names', names: ['ТорговыйУчет'] }, expected: [CF] },
    ];
    REQUESTS.forEach(({ request, expected }) => {
      test(`request ${JSON.stringify(request)} → picker не вызван`, async () => {
        const selection = await selectConfigurationTargets([CF], request, 'import', throwingPicker);
        assert.deepStrictEqual(selection, { kind: 'selected', targets: expected });
      });
    });
  });

  suite('orderConfigurationTargets', () => {
    test('cf раньше cfe, затем по имени; вход не мутирован', () => {
      const extA: ConfigurationTarget = { kind: 'cfe', name: 'AExt', rootPath: EXAMPLE_CFE_EVOLC };
      const input: readonly ConfigurationTarget[] = [CFE, extA, CF];
      const snapshot = [...input];

      const ordered = orderConfigurationTargets(input);

      assert.deepStrictEqual(ordered, [CF, extA, CFE]);
      assert.deepStrictEqual(input, snapshot);
      assert.notStrictEqual(ordered, input);
    });

    [[CF, CFE], [CFE, CF]].forEach((input) => {
      test(`${input.map((target) => target.kind).join(',')} → cf,cfe`, () => {
        assert.deepStrictEqual(orderConfigurationTargets(input), [CF, CFE]);
      });
    });
  });
});
