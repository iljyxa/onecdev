import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CfeBorrowService } from '../../infra/cfe/CfeBorrowService';

/**
 * #141: корень `<MetaDataObject …>` заимствованного объекта и дескриптора заимствованной
 * формы пишется по ruleset формата расширения, а не одной строкой формата 2.21.
 *
 * Эталон — выгрузка платформы: заимствованная форма `Справочник.Контрагенты.ФормаЭлемента`,
 * загруженная в расширение и выгруженная обратно (`ibcmd infobase config import/export
 * --extension`), на 8.3.27 (2.20) и 8.5.1 (2.21) получает корень ровно такой же, как у
 * дескриптора формы основной конфигурации того же формата. Поэтому сравнение идёт с корнем
 * реального файла `example/<формат>/src/cf/…/Forms/ФормаЭлемента.xml` байт-в-байт.
 * `<UseInInterfaceCompatibilityMode>` у заимствованной формы платформа не пишет ни в 2.20,
 * ни в 2.21 — в отличие от собственной формы (`includeFormUseInInterfaceCompatibilityMode`).
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function rootLine(xml: string): string {
  // BOM платформы — перед первой строкой, корень всегда вторая строка.
  const line = xml.split(/\r?\n/).at(1) ?? '';
  assert.ok(line.startsWith('<MetaDataObject '), `вторая строка — не корень MetaDataObject: ${line}`);
  return line;
}

function borrowForm(format: '2.20' | '2.21'): { formMeta: string; object: string; cfDir: string } {
  const cfDir = path.join(REPO_ROOT, 'example', format, 'src', 'cf');
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), `onecdev-borrow-ruleset-${format}-`));
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

  new CfeBorrowService().borrowForm(cfDir, extDir, 'Catalog', 'Контрагенты', 'ФормаЭлемента');

  const catalogs = path.join(extDir, 'Catalogs');
  return {
    formMeta: fs.readFileSync(path.join(catalogs, 'Контрагенты', 'Forms', 'ФормаЭлемента.xml'), 'utf-8'),
    object: fs.readFileSync(path.join(catalogs, 'Контрагенты.xml'), 'utf-8'),
    cfDir,
  };
}

suite('CfeBorrowService — корень XML по ruleset формата (#141)', () => {
  for (const format of ['2.20', '2.21'] as const) {
    test(`${format}: корень дескриптора формы и объекта — как у выгрузки платформы`, () => {
      const { formMeta, object, cfDir } = borrowForm(format);
      const platformRoot = rootLine(fs.readFileSync(
        path.join(cfDir, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента.xml'), 'utf-8'
      ));

      assert.strictEqual(rootLine(formMeta), platformRoot);
      assert.strictEqual(rootLine(object), platformRoot);
      assert.ok(!formMeta.includes('UseInInterfaceCompatibilityMode'), formMeta);
    });
  }
});
