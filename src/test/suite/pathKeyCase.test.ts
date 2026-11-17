import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathKey, slashPathKey } from '../../infra/fs/PathKey';
import { MetadataXmlRemover } from '../../infra/xml/MetadataXmlRemover';
import { planReadonlyTransitions } from '../../ui/readonly/readonlyTransitionPlan';
import { skipWithoutCorpus } from './support/corpus';

/**
 * #123: ключ сравнения путей через `toLowerCase()` склеивал на регистрозависимой ФС (Linux)
 * разные файлы. Общий ключ `pathKey` учитывает платформу; на нём — план readonly-переходов и
 * наборы исключений при удалении объекта метаданных.
 */
suite('pathKey — ключ пути с учётом регистрочувствительности платформы (#123)', () => {
  const PLATFORM_CASES: { platform: NodeJS.Platform; caseInsensitive: boolean }[] = [
    { platform: 'linux', caseInsensitive: false },
    { platform: 'win32', caseInsensitive: true },
    { platform: 'darwin', caseInsensitive: true },
  ];

  for (const { platform, caseInsensitive } of PLATFORM_CASES) {
    test(`${platform}: регистр ${caseInsensitive ? 'не различается' : 'различается'}, путь абсолютный`, () => {
      const upper = pathKey('Catalogs/Контрагенты/Ext/ObjectModule.bsl', platform);
      const lower = pathKey('catalogs/контрагенты/ext/objectmodule.bsl', platform);
      assert.strictEqual(upper === lower, caseInsensitive);
      assert.ok(path.isAbsolute(upper));
    });
  }

  test('платформа по умолчанию — текущая ОС', () => {
    assert.strictEqual(pathKey('A/B.bsl'), pathKey('A/B.bsl', process.platform));
  });

  test('slashPathKey: разделители — `/`, регистр — по правилу платформы', () => {
    const key = slashPathKey('Catalogs\\Контрагенты/Ext\\ObjectModule.bsl', 'linux');
    assert.ok(!key.includes('\\'));
    assert.ok(key.endsWith('Ext/ObjectModule.bsl'), key);
    assert.ok(slashPathKey('Catalogs/Контрагенты.xml', 'win32').endsWith('catalogs/контрагенты.xml'));
    assert.strictEqual(slashPathKey('A/B.bsl'), slashPathKey('A/B.bsl', process.platform));
  });

  test('planReadonlyTransitions: два открытых файла, различающиеся регистром, — две записи на linux, одна на win32', () => {
    const configRoot = path.resolve('/проект/src/cf');
    const first = path.join(configRoot, 'Catalogs', 'Контрагенты', 'Ext', 'ObjectModule.bsl');
    const second = path.join(configRoot, 'Catalogs', 'Контрагенты', 'Ext', 'objectmodule.bsl');
    const plan = (platform: NodeJS.Platform) => planReadonlyTransitions({
      openFiles: [{ path: first, visible: true }, { path: second, visible: true }],
      changedOwnerFullNames: ['Справочник.Контрагенты'],
      allObjects: [],
      configRoot,
      ownerChainOf: () => ['Справочник.Контрагенты'],
      isRestricted: () => true,
      platform,
    });
    assert.deepStrictEqual(plan('linux').applyNow.map((item) => item.path), [first, second]);
    assert.deepStrictEqual(plan('win32').applyNow.map((item) => item.path), [first]);
  });
});

suite('MetadataXmlRemover — коллизия путей по регистру на регистрозависимой ФС (#123)', () => {
  test('файл в каталоге, отличающемся от каталога объекта только регистром, — не часть объекта: ссылка в нём блокирует удаление', function () {
    skipWithoutCorpus(this);
    // На регистронезависимой ФС два таких каталога невозможны.
    if (process.platform === 'win32' || process.platform === 'darwin') {
      this.skip();
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-path-case-'));
    try {
      const configRoot = path.join(root, 'cf');
      fs.cpSync(path.resolve(__dirname, '../../../example/2.21/src/cf'), configRoot, { recursive: true });
      // Каталог объекта Catalogs/Контрагенты исключается из поиска ссылок; рядом — другой
      // каталог Catalogs/КОНТРАГЕНТЫ со ссылкой на удаляемый объект.
      const foreignModule = path.join(configRoot, 'Catalogs', 'КОНТРАГЕНТЫ', 'Ext', 'ObjectModule.bsl');
      fs.mkdirSync(path.dirname(foreignModule), { recursive: true });
      fs.writeFileSync(foreignModule, 'Ссылка = Справочники.Контрагенты.ПустаяСсылка();\n', 'utf-8');

      const result = new MetadataXmlRemover().removeRootObject({ configRoot, kind: 'Catalog', name: 'Контрагенты' });

      assert.strictEqual(result.success, false, 'удаление должно быть заблокировано найденной ссылкой');
      assert.ok(result.references.some((reference) => reference.filePath === foreignModule), JSON.stringify(result.references));
      assert.ok(fs.existsSync(path.join(configRoot, 'Catalogs', 'Контрагенты.xml')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('объект без собственного каталога (константа): исключается только его XML, удаление проходит', function () {
    skipWithoutCorpus(this);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-path-case-flat-'));
    try {
      const configRoot = path.join(root, 'cf');
      fs.cpSync(path.resolve(__dirname, '../../../example/2.21/src/cf'), configRoot, { recursive: true });
      const constantXml = path.join(configRoot, 'Constants', 'ИспользоватьВозвраты.xml');
      assert.ok(!fs.existsSync(path.join(configRoot, 'Constants', 'ИспользоватьВозвраты')), 'фикстура: у константы нет каталога');

      const result = new MetadataXmlRemover().removeRootObject({ configRoot, kind: 'Constant', name: 'ИспользоватьВозвраты' });

      assert.deepStrictEqual(result.references.filter((reference) => reference.filePath === constantXml), [], 'свой XML — не ссылка');
      assert.strictEqual(result.success, result.references.length === 0, JSON.stringify(result.references));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
