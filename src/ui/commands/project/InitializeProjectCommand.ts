import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandServices } from '../_shared';
import { ensureEnvJson } from '../../../infra/repository/envJsonTemplate';

/**
 * Только каталоги, которыми пользуется расширение: корни выгрузки (`root = "src/cf"` в
 * `bsl-analyzer.toml`, расширения — `src/cfe/<Имя>`) и настройки рабочей области. Прежний
 * каркас vanessa-bootstrap (`doc`, `features`, `tools`, …) оставался пустым и выглядел мусором (#107).
 */
const PROJECT_DIRECTORIES = [
  '.vscode',
  path.join('src', 'cf'),
  path.join('src', 'cfe'),
] as const;

const GITIGNORE_RULES = [
  '# Локальные настройки подключения',
  'env.json',
  '',
  '# Артефакты сборки и временные файлы 1С',
  'build/',
  'out/',
  'temp/',
  'tmp/',
  '*.cf',
  '*.cfe',
  '*.epf',
  '*.erf',
  '*.dt',
  '*.log',
  '',
  // `.cursor/`, `.codex/` не игнорируются: туда, как и в `.claude/`, расширение ставит
  // проектные ИИ-роли (AiSkillsInstaller) — они часть проекта (#107).
  '# Служебные каталоги редакторов',
  '.vscode/',
  '.onecdev/',
] as const;

/**
 * Создаёт минимальный каркас проекта 1С: корни выгрузки `src/cf`/`src/cfe` (раскладка
 * vanessa-bootstrap), `env.json`, `bsl-analyzer.toml` и `.gitignore`.
 */
export function registerInitializeProjectCommand(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('onecdev.initializeProject', async () => {
      const rootPath = services.workspaceFolder.uri.fsPath;
      try {
        ensureProjectDirectoryIsEmpty(rootPath);
        createProjectDirectories(rootPath);
        ensureEnvJson(rootPath);
        services.bslAnalyzerConfigService.ensureExists([]);
        ensureGitignore(rootPath);
        await services.reloadEntries();
        services.refreshActionsView();
        await vscode.window.showInformationMessage('Структура проекта создана. Заполните env.json перед запуском операций.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(`Не удалось инициализировать проект.\n${message}`);
      }
    })
  );
}

/**
 * Защищает от инициализации поверх уже существующего проекта или произвольного набора файлов.
 */
export function ensureProjectDirectoryIsEmpty(rootPath: string): void {
  const entries = fs.readdirSync(rootPath);
  if (entries.length > 0) {
    throw new Error('Каталог проекта не пуст. Для инициализации нужен пустой каталог.');
  }
}

export function createProjectDirectories(rootPath: string): void {
  for (const directory of PROJECT_DIRECTORIES) {
    fs.mkdirSync(path.join(rootPath, directory), { recursive: true });
  }
}

export function ensureGitignore(rootPath: string): void {
  const gitignorePath = path.join(rootPath, '.gitignore');
  const existing = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf-8')
    : '';
  const existingRules = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  );
  const missingRules = GITIGNORE_RULES.filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('#') && !existingRules.has(trimmed);
  });

  if (missingRules.length === 0) {
    return;
  }

  const block = [
    '# Локальные настройки подключения и артефакты 1С',
    ...missingRules,
  ];
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const prefix = existing.length > 0 ? '\n' : '';
  fs.writeFileSync(gitignorePath, `${existing}${separator}${prefix}${block.join('\n')}\n`, 'utf-8');
}
