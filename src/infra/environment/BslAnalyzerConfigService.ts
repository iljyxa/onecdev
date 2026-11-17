import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../fs/AtomicFileWriter';
import { preserveBomAndEol } from '../xml/LineEndings';
import {
  applyServiceExclude,
  buildBslAnalyzerSourceConfig,
  findSourceSectionRange,
  mergeSourceLayout,
  scanSectionEntries,
  SERVICE_EXCLUDE_ENTRY,
} from './BslAnalyzerToml';
import {
  BSL_ANALYZER_SOURCE_EXCLUDE_MIN_VERSION,
  probeBslAnalyzerVersion,
  resolveSourceExcludeSupport,
  type SourceExcludeSupport,
} from './BslAnalyzerVersion';

const CONFIG_FILE_NAME = 'bsl-analyzer.toml';
const BOM = '﻿';

export interface ServiceExcludeReconcileResult {
  readonly action: 'added' | 'removed' | 'unchanged' | 'skipped';
  readonly support: SourceExcludeSupport;
  readonly reason?: 'no-config' | 'not-initialized' | 'unknown-version' | 'unsupported-format';
  readonly detail?: string;
  /**
   * В `[source]` после сверки остаётся ключ `exclude`: при `unsupported` — с пользовательскими
   * элементами (такую версию сервер не загрузит), при `unknown` — любой (загрузит ли, неизвестно).
   */
  readonly userExcludeRemains?: boolean;
}

/** Структурно совпадает с `BslAnalyzerBinary` слоя lsp — склейка в Container без импорта lsp в infra. */
export interface BslAnalyzerStartInput {
  readonly execPath: string;
  readonly custom: boolean;
  readonly installedVersion: string | undefined;
  readonly projectInitialized: boolean;
}

/**
 * Поддерживает `bsl-analyzer.toml` в актуальном состоянии для текущей структуры проекта.
 *
 * Служебный каталог расширения (`.onecdev`: временные выгрузки операций, кэши) bsl-analyzer
 * иначе индексирует как часть проекта (issue #112). Исключение через `[source].exclude` пишется
 * только при известной поддержке ключа: строгий разбор конфига у версий < 0.2.85 отверг бы файл.
 */
export class BslAnalyzerConfigService {
  private support: SourceExcludeSupport = 'unknown';

  constructor(private readonly workspaceRoot: string) {}

  setSourceExcludeSupport(support: SourceExcludeSupport): void {
    this.support = support;
  }

  get sourceExcludeSupport(): SourceExcludeSupport {
    return this.support;
  }

  /**
   * Создаёт конфиг, если его нет. Существующий файл не трогает, чтобы не затирать ручные настройки.
   */
  ensureExists(extensionRootPaths: readonly string[]): void {
    if (fs.existsSync(this.getConfigPath())) {
      return;
    }
    this.createConfig(extensionRootPaths);
  }

  /**
   * Обновляет в `[source]` только `root` и `extensions`; служебный элемент `exclude` — по
   * последней известной поддержке ключа. Остальное содержимое файла сохраняется дословно.
   */
  updateSource(extensionRootPaths: readonly string[]): void {
    const configPath = this.getConfigPath();
    if (!fs.existsSync(configPath)) {
      this.createConfig(extensionRootPaths);
      return;
    }
    this.editConfig((content) => {
      const merged = mergeSourceLayout(content, this.normalizeExtensionPaths(extensionRootPaths));
      if (this.support === 'unknown') {
        return merged;
      }
      const edit = applyServiceExclude(merged, this.support === 'supported' ? 'ensure' : 'remove');
      // Неподдерживаемый формат `exclude` — служебный элемент не трогаем, root/extensions обновляем.
      return edit.status === 'changed' ? edit.content : merged;
    });
  }

  getConfigPath(): string {
    return path.join(this.workspaceRoot, CONFIG_FILE_NAME);
  }

  /**
   * Приводит служебный элемент `[source].exclude` к текущей поддержке ключа. Файл не создаёт;
   * при неизвестной версии не меняет ни в какую сторону.
   */
  reconcileServiceExclude(): ServiceExcludeReconcileResult {
    const support = this.support;
    if (!fs.existsSync(this.getConfigPath())) {
      return { action: 'skipped', support, reason: 'no-config' };
    }
    if (support === 'unknown') {
      const content = normalizeText(fs.readFileSync(this.getConfigPath(), 'utf-8'));
      return { action: 'skipped', support, reason: 'unknown-version', userExcludeRemains: hasSourceExclude(content) };
    }

    let outcome: ServiceExcludeReconcileResult = { action: 'unchanged', support };
    this.editConfig((content) => {
      const edit = applyServiceExclude(content, support === 'supported' ? 'ensure' : 'remove');
      if (edit.status === 'unsupported-format') {
        outcome = { action: 'skipped', support, reason: 'unsupported-format', detail: edit.detail };
        return content;
      }
      const next = edit.status === 'changed' ? edit.content : content;
      if (support === 'supported') {
        outcome = { action: edit.status === 'changed' ? 'added' : 'unchanged', support };
      } else {
        outcome = {
          action: edit.status === 'changed' ? 'removed' : 'unchanged',
          support,
          userExcludeRemains: hasSourceExclude(next),
        };
      }
      return next;
    });
    return outcome;
  }

  /**
   * Подготовка перед стартом клиента: версия сервера → поддержка `exclude` → сверка файла.
   * Автоскачанный сервер берёт версию из `version.txt` (запуск загрузчика мог бы качать бинарь),
   * пользовательский путь — пробой `--version`.
   */
  async prepareForStart(
    input: BslAnalyzerStartInput,
    probe: (execPath: string) => Promise<string | undefined> = (execPath) => probeBslAnalyzerVersion(execPath)
  ): Promise<ServiceExcludeReconcileResult> {
    const versionText = input.custom ? await probe(input.execPath) : input.installedVersion;
    this.setSourceExcludeSupport(resolveSourceExcludeSupport(versionText));
    if (!input.projectInitialized) {
      return { action: 'skipped', support: this.support, reason: 'not-initialized' };
    }
    return this.reconcileServiceExclude();
  }

  private createConfig(extensionRootPaths: readonly string[]): void {
    writeFileAtomic(this.getConfigPath(), buildBslAnalyzerSourceConfig(
      this.normalizeExtensionPaths(extensionRootPaths),
      { serviceExclude: this.support === 'supported' }
    ));
  }

  /**
   * Правка существующего файла: разбор идёт по тексту без BOM и с LF, запись — с BOM и стилем
   * переводов строк исходника. Без изменений файл не пишется: новый mtime заставил бы сервер
   * перечитать проект.
   */
  private editConfig(edit: (content: string) => string): void {
    const configPath = this.getConfigPath();
    const original = fs.readFileSync(configPath, 'utf-8');
    const content = normalizeText(original);
    const next = edit(content);
    if (next !== content) {
      writeFileAtomic(configPath, preserveBomAndEol(original, next));
    }
  }

  private normalizeExtensionPaths(extensionRootPaths: readonly string[]): string[] {
    const result = new Set<string>();
    for (const extensionRootPath of extensionRootPaths) {
      const relative = path
        .relative(this.workspaceRoot, extensionRootPath)
        .split(path.sep)
        .join('/');
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        result.add(relative);
      }
    }
    return [...result].sort((left, right) => left.localeCompare(right));
  }
}

/**
 * Строка для канала вывода по итогу сверки; `undefined` — сообщать нечего (штатное «без изменений»).
 * `[lsp][warn]` — для ситуаций, при которых сервер может не загрузить проект или анализирует лишнее.
 */
export function formatServiceExcludeLog(result: ServiceExcludeReconcileResult): string | undefined {
  const prefix = '[lsp] bsl-analyzer.toml:';
  const warn = '[lsp][warn] bsl-analyzer.toml:';
  const userExcludeWarning = `в [source].exclude остались пользовательские элементы — версии bsl-analyzer ниже ${BSL_ANALYZER_SOURCE_EXCLUDE_MIN_VERSION} не загрузят такой конфиг`;
  switch (result.action) {
    case 'added':
      return `${prefix} служебный каталог ${SERVICE_EXCLUDE_ENTRY} добавлен в [source].exclude`;
    case 'removed':
      return `${warn} служебный каталог ${SERVICE_EXCLUDE_ENTRY} убран из [source].exclude — версия bsl-analyzer ниже ${BSL_ANALYZER_SOURCE_EXCLUDE_MIN_VERSION} не поддерживает ключ`
        + (result.userExcludeRemains ? `; ${userExcludeWarning}` : '');
    case 'unchanged':
      return result.support === 'unsupported' && result.userExcludeRemains ? `${warn} ${userExcludeWarning}` : undefined;
    case 'skipped':
      return formatSkipped(result, prefix, warn);
  }
}

function formatSkipped(result: ServiceExcludeReconcileResult, prefix: string, warn: string): string {
  switch (result.reason) {
    case 'no-config':
      return `${prefix} файла нет — исключение ${SERVICE_EXCLUDE_ENTRY} не настраивается`;
    case 'not-initialized':
      return `${prefix} проект не инициализирован — исключение ${SERVICE_EXCLUDE_ENTRY} не настраивается`;
    case 'unsupported-format':
      return `${warn} формат не поддерживается, исключение ${SERVICE_EXCLUDE_ENTRY} не изменено: ${result.detail ?? ''}`;
    default:
      return result.userExcludeRemains
        ? `${warn} версия bsl-analyzer не определена, а в [source] есть ключ exclude — версии ниже ${BSL_ANALYZER_SOURCE_EXCLUDE_MIN_VERSION} не загрузят такой конфиг`
        : `${prefix} версия bsl-analyzer не определена — исключение ${SERVICE_EXCLUDE_ENTRY} не изменяется`;
  }
}

function normalizeText(text: string): string {
  return (text.startsWith(BOM) ? text.slice(BOM.length) : text).replace(/\r\n?/g, '\n');
}

function hasSourceExclude(content: string): boolean {
  const range = findSourceSectionRange(content);
  return range !== undefined
    && scanSectionEntries(content.slice(range.bodyStart, range.end)).some((entry) => entry.key === 'exclude');
}
