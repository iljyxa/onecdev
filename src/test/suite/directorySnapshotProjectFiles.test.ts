import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectSnapshotProjectFiles } from '../../infra/agent/DirectorySnapshot';

const EVOLC = path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC');

/**
 * Набор файлов проекта, затронутых заменой каталога выгрузкой (подавление перезагрузки дерева и
 * пометка изменённых). Одна реализация для агента и выгрузки расширения из базы (#135).
 */
suite('collectSnapshotProjectFiles (#135)', () => {
  let root: string;
  let source: string;
  let target: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-snapshot-files-'));
    source = path.join(root, 'dump');
    target = path.join(root, 'project', 'src', 'cfe', 'EVOLC');
    fs.cpSync(EVOLC, source, { recursive: true });
    fs.cpSync(EVOLC, target, { recursive: true });
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const rel = (files: readonly string[]): string[] =>
    files.map((file) => path.relative(target, file).split(path.sep).join('/')).sort();

  test('файлы выгрузки и удалённые из неё файлы проекта — по путям проекта; служебные файлы не попадают', () => {
    // Выгрузка без справочника, который в проекте есть (удалён в базе), — вместе с модулем.
    fs.rmSync(path.join(source, 'Catalogs', 'ев_РабочийПроцесс.xml'));
    fs.rmSync(path.join(source, 'Catalogs', 'ев_РабочийПроцесс'), { recursive: true });
    // Макеты: текстовый, двоичный, HTML — попадают; посторонние файлы — нет.
    const templateExt = path.join(source, 'Catalogs', 'Контрагенты', 'Templates', 'Макет', 'Ext');
    fs.mkdirSync(path.join(templateExt, 'Template'), { recursive: true });
    fs.writeFileSync(path.join(templateExt, 'Template.txt'), 'т');
    fs.writeFileSync(path.join(templateExt, 'Template.bin'), 'б');
    fs.writeFileSync(path.join(templateExt, 'Template', 'index.html'), '<html/>');
    fs.writeFileSync(path.join(source, 'readme.md'), 'посторонний');
    fs.writeFileSync(path.join(target, 'notes.txt'), 'посторонний, удалён из выгрузки');

    const files = collectSnapshotProjectFiles(source, target);

    assert.deepStrictEqual(rel(files), [
      'Catalogs/Контрагенты.xml',
      'Catalogs/Контрагенты/Templates/Макет/Ext/Template.bin',
      'Catalogs/Контрагенты/Templates/Макет/Ext/Template.txt',
      'Catalogs/Контрагенты/Templates/Макет/Ext/Template/index.html',
      'Catalogs/Номенклатура.xml',
      'Catalogs/ев_РабочийПроцесс.xml',
      'Catalogs/ев_РабочийПроцесс/Ext/ObjectModule.bsl',
      'ConfigDumpInfo.xml',
      'Configuration.xml',
      'Languages/Русский.xml',
      'Roles/ев_ОсновнаяРоль.xml',
    ]);
  });

  test('каталога проекта ещё нет — только файлы выгрузки; выгрузки нет — пусто', () => {
    fs.rmSync(target, { recursive: true });
    assert.strictEqual(collectSnapshotProjectFiles(source, target).length, 8);
    assert.deepStrictEqual(collectSnapshotProjectFiles(path.join(root, 'нет'), path.join(root, 'тоже нет')), []);
  });
});
