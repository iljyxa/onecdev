import * as assert from 'assert';
import { CRS_NAMESPACE } from '../../infra/xml/crs/CrsEnvelope';
import { CrsCallError, CrsFormatError } from '../../infra/repository/crs/CrsErrors';
import {
  booleanValue,
  crsChild,
  crsValues,
  decodeReturn,
  integerValue,
  stringValue,
} from '../../infra/xml/crs/CrsResponseReaders';
import { parseCrsXml, type CrsXmlElement } from '../../infra/xml/crs/CrsXmlReader';
import { readFixture } from './support/crsFixtures';

function root(...parts: string[]): CrsXmlElement {
  return parseCrsXml(readFixture(...parts).toString('utf-8'));
}

function formatError(action: () => unknown): CrsFormatError {
  try {
    action();
  } catch (e) {
    assert.ok(e instanceof CrsFormatError, String(e));
    return e;
  }
  return assert.fail('ожидался CrsFormatError');
}

suite('crs values: читатели ответа на снятых телах', () => {
  // Полная статистика с захватом Petrov: statMap, bindInfos и users с хешами.
  const statistic = root('tcp', 'lock-one', '18-conn-02-s2c-call_return.xml');
  const depot = root('tcp', 'lock-one', '02-conn-01-s2c-call_return.xml');
  // Ответ reviseDevObjects: verNum="-1" и пустые массивы (<crs:required/>).
  const revise = root('tcp', 'lock-one', '17-conn-02-s2c-call_return.xml');
  // Запись statMap о Справочник.Контрагенты — по индексам, без читателей под тестом.
  const entry = statistic.children[0].children[0];
  const second = entry.children[1];

  test('crsChild: цепочка обязательных элементов crs', () => {
    const major = crsChild(depot, 'info', 'info', 'version', 'major');
    assert.strictEqual(major.namespace, CRS_NAMESPACE);
    assert.strictEqual(major.name, 'crs:major');
    assert.strictEqual(crsChild(depot), depot);
  });

  test('crsChild: нет элемента — CrsFormatError с путём, без значений', () => {
    const top = formatError(() => crsChild(statistic, 'userInfo'));
    assert.ok(top.message.includes('crs:userInfo'), top.message);
    const nested = formatError(() => crsChild(statistic, 'users', 'value', 'second', 'password'));
    assert.ok(nested.message.includes('crs:users/crs:value/crs:second/crs:password'), nested.message);
    // Значения соседних элементов (здесь — хеши паролей) в сообщение не попадают.
    for (const error of [top, nested]) {
      assert.ok(!/[0-9a-f]{32}/.test(error.message), error.message);
    }
  });

  test('crsValues: элементы массивов statMap, bindInfos, users; пустой массив', () => {
    assert.strictEqual(crsValues(crsChild(statistic, 'statMap')).length, 1);
    assert.strictEqual(crsValues(crsChild(statistic, 'bindInfos')).length, 4);
    assert.strictEqual(crsValues(crsChild(statistic, 'users')).length, 4);
    assert.deepStrictEqual(crsValues(crsChild(revise, 'result', 'required')), []);
  });

  test('crsValues: элемент не массив (дети не crs:value) — CrsFormatError', () => {
    const error = formatError(() => crsValues(second));
    assert.ok(error.message.includes('crs:second'), error.message);
    assert.ok(error.message.includes('crs:verNum'), error.message);
  });

  test('stringValue, integerValue, booleanValue на настоящих элементах', () => {
    assert.strictEqual(stringValue(crsChild(entry, 'first')), '3e33ad69-478f-4f02-bad5-751699f70814');
    assert.strictEqual(stringValue(crsChild(second, 'revisorID')), 'e9772f67-67fe-408a-a325-b072d940915f');
    assert.strictEqual(integerValue(crsChild(second, 'verNum')), 1);
    assert.strictEqual(integerValue(crsChild(revise, 'result', 'requested', 'value', 'second', 'verNum')), -1);
    assert.strictEqual(integerValue(crsChild(depot, 'info', 'info', 'mode')), 80306);
    assert.strictEqual(booleanValue(crsChild(second, 'revised')), true);
    assert.strictEqual(booleanValue(crsChild(depot, 'info', 'isExtension')), false);
    assert.strictEqual(stringValue(crsChild(statistic, 'users', 'value', 'second', 'info', 'name')), 'Reader');
  });

  test('stringValue: нет атрибута value — CrsFormatError', () => {
    const error = formatError(() => stringValue(second));
    assert.ok(error.message.includes('crs:second'), error.message);
    formatError(() => integerValue(second));
    formatError(() => booleanValue(second));
  });

  test('integerValue и booleanValue: значение не того вида — CrsFormatError без значения', () => {
    const revisor = crsChild(second, 'revisorID');
    for (const error of [
      formatError(() => integerValue(revisor)),
      formatError(() => booleanValue(revisor)),
      formatError(() => booleanValue(crsChild(second, 'verNum'))),
      formatError(() => integerValue(crsChild(second, 'reviseDate'))),
    ]) {
      assert.ok(/crs:(revisorID|verNum|reviseDate)/.test(error.message), error.message);
      assert.ok(!error.message.includes('e9772f67'), error.message);
      assert.ok(!error.message.includes('2026-'), error.message);
    }
  });

  test('decodeReturn: результат декодера как есть', () => {
    assert.strictEqual(
      decodeReturn('DevDepot_depotInfo', depot, (r) => integerValue(crsChild(r, 'info', 'info', 'version', 'major'))),
      7,
    );
  });

  test('decodeReturn: CrsFormatError → malformed-response с методом и причиной', () => {
    try {
      decodeReturn('DevDepot_depotInfo', statistic, (r) => crsChild(r, 'info'));
      assert.fail('ожидался отказ');
    } catch (e) {
      assert.ok(e instanceof CrsCallError, String(e));
      assert.strictEqual(e.kind, 'malformed-response');
      assert.strictEqual(e.details.method, 'DevDepot_depotInfo');
      assert.ok(e.details.cause instanceof CrsFormatError);
      assert.ok(e.message.startsWith('DevDepot_depotInfo: '), e.message);
      assert.ok(e.message.includes('crs:info'), e.message);
    }
  });

  test('decodeReturn: ошибка декодера не CrsFormatError пробрасывается как есть (дефект кода, не ответа)', () => {
    const bug = new TypeError('дефект декодера');
    assert.throws(
      () =>
        decodeReturn('DevDepot_depotInfo', depot, () => {
          throw bug;
        }),
      (e: unknown) => e === bug,
    );
  });
});
