import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MetadataXmlCreator } from '../../infra/xml/MetadataXmlCreator';
import type { MetaKind } from '../../domain/MetaTypes';
import { skipWithoutCorpus } from './support/corpus';

/**
 * #129: без `InternalInfo` (и, где нужен, пустого `<ChildObjects/>`) платформа не загружает
 * созданный объект и отбивает импорт всей конфигурации. Состав `GeneratedType`:
 * ExternalDataSource и IntegrationService — как в реальной выгрузке `example/2.21`,
 * Sequence и WSReference — снят выгрузкой платформы 8.5.1 после импорта.
 */
const CASES: { kind: MetaKind; folder: string; types: string[]; childObjects: boolean; corpusXml?: string }[] = [
  {
    kind: 'ExternalDataSource', folder: 'ExternalDataSources', childObjects: true,
    types: ['ExternalDataSourceManager:Manager', 'ExternalDataSourceTablesManager:TablesManager', 'ExternalDataSourceCubesManager:CubesManager'],
    corpusXml: 'ExternalDataSources/ИнтернетМагазин.xml',
  },
  {
    kind: 'IntegrationService', folder: 'IntegrationServices', childObjects: true,
    types: ['IntegrationServiceManager:Manager'],
    corpusXml: 'IntegrationServices/СервисИнтеграции1.xml',
  },
  { kind: 'Sequence', folder: 'Sequences', childObjects: true, types: ['SequenceRecord:Record', 'SequenceManager:Manager', 'SequenceRecordSet:RecordSet'] },
  { kind: 'WSReference', folder: 'WSReferences', childObjects: false, types: ['WSReferenceManager:Manager'] },
];

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');

function generatedTypes(xml: string): string[] {
  return Array.from(xml.matchAll(/<xr:GeneratedType name="([^".]+)\.[^"]+" category="([^"]+)">/g), (match) => `${match[1]}:${match[2]}`);
}

suite('MetadataXmlCreator.addRootObject — InternalInfo и ChildObjects видов из #129', () => {
  suiteSetup(function () {
    skipWithoutCorpus(this);
  });

  for (const { kind, folder, types, childObjects, corpusXml } of CASES) {
    test(`${kind}: GeneratedType ${String(types.length)}, ChildObjects ${childObjects ? 'есть' : 'нет'}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-creator-ii-'));
      try {
        fs.copyFileSync(path.join(EXAMPLE_CF, 'Configuration.xml'), path.join(root, 'Configuration.xml'));
        const result = new MetadataXmlCreator().addRootObject({ configRoot: root, kind, name: 'Тест' });
        assert.strictEqual(result.success, true, result.errors.join('; '));

        const xml = fs.readFileSync(path.join(root, folder, 'Тест.xml'), 'utf-8');
        assert.deepStrictEqual(generatedTypes(xml), types);
        assert.strictEqual(xml.includes('<ChildObjects/>'), childObjects);
        if (corpusXml) {
          assert.deepStrictEqual(types, generatedTypes(fs.readFileSync(path.join(EXAMPLE_CF, corpusXml), 'utf-8')), 'состав как в выгрузке платформы');
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
