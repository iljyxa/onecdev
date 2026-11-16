import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  classifyPartialLoadRefusal,
  describeRepositoryLoadRefusal,
} from '../../infra/process/PartialLoadRefusal';
import { runUpdateExtension, runUpdateMainConfiguration } from '../../ui/commands/ext/ExtensionCommandRunner';
import { skipWithoutCorpus } from './support/corpus';

/**
 * #113: отказ частичной загрузки в базе, привязанной к хранилищу, не должен вести к предложению
 * полной загрузки — платформа отклоняет её всегда. Журналы `/Out` в фикстурах сняты с 8.5.1.1529:
 * файловая база, созданная из `example/2.21/src/cf` и помещённая в файловое хранилище, без захватов;
 * частичная загрузка `Catalogs/Номенклатура.xml` и полная загрузка выгрузки.
 */
const ROOT = path.resolve(__dirname, '../../../');
const FIXTURES = path.join(ROOT, 'src/test/fixtures/partial-load-refusal');
const NOT_LOCKED_OUT = path.join(FIXTURES, 'not-locked-8.5.1.txt');
const IN_REPOSITORY_OUT = path.join(FIXTURES, 'configuration-in-repository-8.5.1.txt');
const EXAMPLE_21 = path.join(ROOT, 'example/2.21/src');

function readOut(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
}

suite('classifyPartialLoadRefusal — причины отказа на журналах платформы (#113)', () => {
  test('объект не захвачен (журнал 8.5.1) → not-locked-in-repository с именем объекта', () => {
    assert.deepStrictEqual(classifyPartialLoadRefusal(readOut(NOT_LOCKED_OUT)), {
      kind: 'not-locked-in-repository',
      objects: ['Catalog.Номенклатура'],
    });
  });

  test('несколько незахваченных объектов, повторы схлопываются, порядок сохраняется', () => {
    const reason = [
      'Загрузка невозможна: объект метаданных AccumulationRegister.ТоварыНаСкладах не захвачен в хранилище!',
      'Загрузка невозможна: объект метаданных Catalog.Номенклатура не захвачен в хранилище!',
      'Загрузка невозможна: объект метаданных AccumulationRegister.ТоварыНаСкладах не захвачен в хранилище!',
    ].join('\n');
    assert.deepStrictEqual(classifyPartialLoadRefusal(reason), {
      kind: 'not-locked-in-repository',
      objects: ['AccumulationRegister.ТоварыНаСкладах', 'Catalog.Номенклатура'],
    });
  });

  test('полная загрузка в привязанную базу (журнал 8.5.1) → configuration-in-repository', () => {
    assert.deepStrictEqual(classifyPartialLoadRefusal(readOut(IN_REPOSITORY_OUT)), { kind: 'configuration-in-repository' });
  });

  test('расхождение идентификатора конфигурации → configuration-id-mismatch (обе формулировки)', () => {
    assert.strictEqual(
      classifyPartialLoadRefusal('Идентификатор загружаемой конфигурации отличается от сохраненной').kind,
      'configuration-id-mismatch'
    );
    assert.strictEqual(classifyPartialLoadRefusal('Ошибка частичной загрузки конфигурации').kind, 'configuration-id-mismatch');
  });

  test('отказ хранилища важнее формулировки «ошибка частичной загрузки» в том же журнале', () => {
    const reason = `Ошибка частичной загрузки\n${readOut(NOT_LOCKED_OUT)}`;
    assert.strictEqual(classifyPartialLoadRefusal(reason).kind, 'not-locked-in-repository');
  });

  test('прочая причина → other, сообщения хранилища нет', () => {
    const refusal = classifyPartialLoadRefusal('Ошибка при быстрой загрузке по причине: нет доступа к базе');
    assert.deepStrictEqual(refusal, { kind: 'other' });
    assert.strictEqual(describeRepositoryLoadRefusal(refusal, 'конфигурации "cf"'), undefined);
    assert.strictEqual(describeRepositoryLoadRefusal({ kind: 'configuration-id-mismatch' }, 'конфигурации "cf"'), undefined);
  });

  test('сообщения хранилища называют объекты и запрет полной загрузки', () => {
    const notLocked = describeRepositoryLoadRefusal({ kind: 'not-locked-in-repository', objects: ['Catalog.А', 'Document.Б'] }, 'конфигурации "cf"') ?? '';
    assert.ok(notLocked.includes('конфигурации "cf"'));
    assert.ok(notLocked.includes('не захвачены: Catalog.А, Document.Б.'));
    assert.ok(notLocked.includes('Полная загрузка в привязанную базу платформой запрещена.'));
    const inRepository = describeRepositoryLoadRefusal({ kind: 'configuration-in-repository' }, 'расширения "EVOLC"') ?? '';
    assert.ok(inRepository.includes('расширения "EVOLC"'));
    assert.ok(inRepository.includes('конфигурация базы помещена в хранилище'));
  });
});

type WindowStubs = Pick<typeof vscode.window, 'showErrorMessage' | 'showWarningMessage'>;

/**
 * Настоящий CLI `import-git-changes` и настоящий раннер; подменён только исполняемый файл
 * Конфигуратора (на стенде теста платформы нет): он кладёт в `/Out` журнал, снятый с платформы,
 * и завершается с кодом 1, как 1cv8 при отказе.
 */
suite('ExtensionCommandRunner — обновление при отказе частичной загрузки (#113)', () => {
  const windowRef = vscode.window as WindowStubs;
  let originals: WindowStubs;
  let tempDir: string;
  let errors: string[];
  let warnings: string[];
  let errorAnswer: string | undefined;

  suiteSetup(function () {
    // Подменный Конфигуратор — POSIX-скрипт; на Windows его не исполнить.
    if (process.platform === 'win32') {
      this.skip();
    }
    skipWithoutCorpus(this);
  });

  setup(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onecdev-partial-refusal-')));
    errors = [];
    warnings = [];
    errorAnswer = undefined;
    originals = { showErrorMessage: vscode.window.showErrorMessage, showWarningMessage: vscode.window.showWarningMessage };
    windowRef.showErrorMessage = ((message: string) => {
      errors.push(message);
      return Promise.resolve(errorAnswer);
    });
    windowRef.showWarningMessage = ((message: string) => {
      warnings.push(message);
      return Promise.resolve(undefined);
    });
  });

  teardown(() => {
    windowRef.showErrorMessage = originals.showErrorMessage;
    windowRef.showWarningMessage = originals.showWarningMessage;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function prepareWorkspace(outContent: string): vscode.WorkspaceFolder {
    const configRoot = path.join(tempDir, 'src', 'cf');
    fs.mkdirSync(configRoot, { recursive: true });
    fs.copyFileSync(path.join(EXAMPLE_21, 'cf', 'Configuration.xml'), path.join(configRoot, 'Configuration.xml'));
    fs.cpSync(path.join(EXAMPLE_21, 'cf', 'Languages'), path.join(configRoot, 'Languages'), { recursive: true });
    fs.cpSync(path.join(EXAMPLE_21, 'cfe', 'EVOLC'), path.join(tempDir, 'src', 'cfe', 'EVOLC'), { recursive: true });

    const outFixture = path.join(tempDir, 'designer-out.txt');
    fs.writeFileSync(outFixture, outContent, 'utf-8');
    const designer = path.join(tempDir, '1cv8');
    fs.writeFileSync(designer, [
      '#!/bin/sh',
      'prev=""',
      'for arg in "$@"; do',
      `  if [ "$prev" = "/Out" ]; then cp "${outFixture}" "$arg"; fi`,
      '  prev="$arg"',
      'done',
      'exit 1',
      '',
    ].join('\n'), 'utf-8');
    fs.chmodSync(designer, 0o755);
    fs.writeFileSync(path.join(tempDir, 'env.json'), JSON.stringify({
      default: { '--ibconnection': `/F${path.join(tempDir, 'ib')}`, '--db-user': 'Admin', '--db-pwd': '', '--path': designer },
    }), 'utf-8');
    return { uri: vscode.Uri.file(tempDir), name: 'partial-refusal', index: 0 };
  }

  function createChannel(): { channel: vscode.OutputChannel; lines: string[]; shown: number[] } {
    const lines: string[] = [];
    const shown: number[] = [];
    const channel = {
      appendLine: (line: string) => { lines.push(line); },
      show: () => { shown.push(1); },
    } as unknown as vscode.OutputChannel;
    return { channel, lines, shown };
  }

  test('CF: объект не захвачен → ошибка с именем объекта, без предложения полной загрузки; «Открыть журнал» открывает канал', async () => {
    const workspaceFolder = prepareWorkspace(fs.readFileSync(NOT_LOCKED_OUT, 'utf-8'));
    const { channel, lines, shown } = createChannel();
    errorAnswer = 'Открыть журнал';

    const result = await runUpdateMainConfiguration('cf', path.join(tempDir, 'src', 'cf'), workspaceFolder, channel, false);

    assert.strictEqual(result, false);
    assert.deepStrictEqual(warnings, [], 'модальное предложение полной загрузки показываться не должно');
    assert.strictEqual(errors.length, 1, errors.join('\n'));
    assert.ok(errors[0].includes('не захвачены: Catalog.Номенклатура.'), errors[0]);
    assert.ok(lines.some((line) => line.includes('[update-configuration] Загрузка изменений конфигурации "cf" отклонена платформой')), lines.join('\n'));
    assert.ok(!lines.some((line) => line.includes('sync-configuration-full')), 'полная загрузка не запускается');
    await Promise.resolve();
    assert.strictEqual(shown.length, 1, 'кнопка «Открыть журнал» должна открыть канал');
  });

  test('CFE: конфигурация помещена в хранилище → ошибка хранилища, без предложения полной загрузки', async () => {
    const workspaceFolder = prepareWorkspace(fs.readFileSync(IN_REPOSITORY_OUT, 'utf-8'));
    const { channel, shown } = createChannel();

    const result = await runUpdateExtension('EVOLC', path.join(tempDir, 'src', 'cfe', 'EVOLC'), workspaceFolder, channel, false);

    assert.strictEqual(result, false);
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(errors.length, 1, errors.join('\n'));
    assert.ok(errors[0].includes('расширения "EVOLC"') && errors[0].includes('помещена в хранилище'), errors[0]);
    await Promise.resolve();
    assert.strictEqual(shown.length, 0, 'без нажатия «Открыть журнал» канал не открывается');
  });

  test('прочий отказ → прежнее модальное предложение полной загрузки; отказ пользователя логируется', async () => {
    const workspaceFolder = prepareWorkspace('\uFEFFНепредвиденная ошибка Конфигуратора\n');
    const { channel, lines } = createChannel();

    const result = await runUpdateMainConfiguration('cf', path.join(tempDir, 'src', 'cf'), workspaceFolder, channel, false);

    assert.strictEqual(result, false);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes('Выполнить полную загрузку?'), warnings[0]);
    assert.deepStrictEqual(errors, []);
    assert.ok(lines.includes('[update-configuration] Частичная загрузка конфигурации "cf" недоступна, запрашиваю подтверждение полной загрузки.'), lines.join('\n'));
    assert.ok(lines.includes('[update-configuration] Полная загрузка отклонена пользователем.'));
  });
});
