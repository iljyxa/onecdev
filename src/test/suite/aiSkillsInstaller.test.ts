import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AI_SKILLS_PLATFORMS,
  AiSkillsInstaller,
} from '../../infra/skills/AiSkillsInstaller';

suite('AiSkillsInstaller', () => {
  test('устанавливает проектные роли Codex без скриптов внешнего репозитория', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-ai-roles-'));
    try {
      const platform = AI_SKILLS_PLATFORMS.find((item) => item.id === 'codex') ?? AI_SKILLS_PLATFORMS[0];
      const installer = new AiSkillsInstaller({ appendLine: () => undefined });
      const result = installer.installProjectRoles({
        projectRoot: root,
        platform,
      });

      const mcpRolePath = path.join(root, '.codex', 'skills', 'onecdev-mcp-required', 'SKILL.md');
      const content = fs.readFileSync(mcpRolePath, 'utf-8');
      assert.strictEqual(result.installedCount, 5);
      assert.ok(content.includes('onecdev_get_properties'));
      assert.ok(content.includes('Не запускай Python/PowerShell-скрипты'));
      assert.ok(!content.includes('github.com/Nikolay-Shirokov/cc-1c-skills'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('для Cursor пишет роли в .cursor/rules и не удаляет существующие правила', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-ai-roles-cursor-'));
    try {
      const platform = AI_SKILLS_PLATFORMS.find((item) => item.id === 'cursor') ?? AI_SKILLS_PLATFORMS[0];
      const rulesDir = path.join(root, '.cursor', 'rules');
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(rulesDir, 'project_rules.mdc'), 'custom rule', 'utf-8');

      const installer = new AiSkillsInstaller({ appendLine: () => undefined });
      installer.installProjectRoles({
        projectRoot: root,
        platform,
      });

      const mcpRulePath = path.join(rulesDir, 'onecdev-mcp-required.mdc');
      const content = fs.readFileSync(mcpRulePath, 'utf-8');
      assert.ok(content.includes('alwaysApply: true'));
      assert.ok(content.includes('onecdev_search_metadata'));
      assert.strictEqual(fs.readFileSync(path.join(rulesDir, 'project_rules.mdc'), 'utf-8'), 'custom rule');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('для OpenCode пишет инструкции и подключает их через opencode.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-ai-roles-opencode-'));
    try {
      const platform = AI_SKILLS_PLATFORMS.find((item) => item.id === 'opencode') ?? AI_SKILLS_PLATFORMS[0];
      fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify({
        instructions: ['docs/project-rules.md'],
        mcp: {
          onecdev: {
            type: 'remote',
            url: 'http://127.0.0.1:44444/mcp',
            enabled: false,
          },
          other: {
            type: 'remote',
            url: 'https://example.com/mcp',
          },
        },
      }), 'utf-8');

      const installer = new AiSkillsInstaller({ appendLine: () => undefined });
      installer.installProjectRoles({
        projectRoot: root,
        platform,
      });

      const rolePath = path.join(root, '.opencode', 'instructions', 'onecdev-mcp-required.md');
      const config = JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf-8')) as {
        instructions: string[];
        mcp: {
          onecdev: {
            type: string;
            url: string;
            enabled: boolean;
          };
          other: {
            type: string;
            url: string;
          };
        };
      };
      const content = fs.readFileSync(rolePath, 'utf-8');
      assert.ok(content.includes('Не редактируй XML-файлы 1С напрямую'));
      assert.ok(content.includes('Для добавления используй отдельный инструмент на каждый тип'));
      assert.ok(config.instructions.includes('docs/project-rules.md'));
      assert.ok(config.instructions.includes('.opencode/instructions/*.md'));
      assert.strictEqual(config.mcp.onecdev.enabled, true);
      assert.strictEqual(config.mcp.onecdev.url, 'http://127.0.0.1:44444/mcp');
      assert.strictEqual(config.mcp.other.url, 'https://example.com/mcp');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('для Claude Code always-apply роли встраиваются в CLAUDE.md, остальные в .claude/skills', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-ai-roles-claude-'));
    try {
      const platform = AI_SKILLS_PLATFORMS.find((item) => item.id === 'claude-code') ?? AI_SKILLS_PLATFORMS[0];
      const installer = new AiSkillsInstaller({ appendLine: () => undefined });
      const result = installer.installProjectRoles({
        projectRoot: root,
        platform,
      });

      const claudeMdPath = path.join(root, 'CLAUDE.md');
      const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
      assert.ok(claudeMd.includes('<!-- onecdev:claude-roles:start -->'));
      assert.ok(claudeMd.includes('<!-- onecdev:claude-roles:end -->'));
      assert.ok(claudeMd.includes('onecdev: обязательная работа через MCP'));
      assert.ok(claudeMd.includes('onecdev: senior 1C developer'));

      // на диске остаются только on-demand скиллы
      const skillsRoot = path.join(root, '.claude', 'skills');
      assert.ok(!fs.existsSync(path.join(skillsRoot, 'onecdev-mcp-required')));
      assert.ok(!fs.existsSync(path.join(skillsRoot, 'onecdev-1c-developer')));
      assert.ok(fs.existsSync(path.join(skillsRoot, 'onecdev-bsp-developer', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(skillsRoot, 'onecdev-metadata-manager', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(skillsRoot, 'onecdev-bsl-module-standards', 'SKILL.md')));

      // installedCount считает и always-apply, и on-demand
      assert.strictEqual(result.installedCount, 5);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('для Claude Code повторная установка перезаписывает блок CLAUDE.md между маркерами', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-ai-roles-claude-update-'));
    try {
      const platform = AI_SKILLS_PLATFORMS.find((item) => item.id === 'claude-code') ?? AI_SKILLS_PLATFORMS[0];
      const claudeMdPath = path.join(root, 'CLAUDE.md');
      const userContent = [
        '# Мой проект',
        '',
        'Пользовательские правила, которые нельзя терять.',
        '',
        '<!-- onecdev:claude-roles:start -->',
        'старое содержимое блока',
        '<!-- onecdev:claude-roles:end -->',
        '',
        '## После блока',
        'еще пользовательский текст',
        '',
      ].join('\n');
      fs.writeFileSync(claudeMdPath, userContent, 'utf-8');

      const installer = new AiSkillsInstaller({ appendLine: () => undefined });
      installer.installProjectRoles({
        projectRoot: root,
        platform,
      });

      const updated = fs.readFileSync(claudeMdPath, 'utf-8');
      assert.ok(updated.includes('Пользовательские правила, которые нельзя терять.'));
      assert.ok(updated.includes('После блока'));
      assert.ok(updated.includes('еще пользовательский текст'));
      assert.ok(!updated.includes('старое содержимое блока'));
      assert.ok(updated.includes('onecdev: обязательная работа через MCP'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('для Claude Code чистит устаревшие сгенерированные always-apply скиллы', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-ai-roles-claude-cleanup-'));
    try {
      const platform = AI_SKILLS_PLATFORMS.find((item) => item.id === 'claude-code') ?? AI_SKILLS_PLATFORMS[0];
      const skillsRoot = path.join(root, '.claude', 'skills');
      const staleSkillDir = path.join(skillsRoot, 'onecdev-mcp-required');
      fs.mkdirSync(staleSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(staleSkillDir, 'SKILL.md'),
        `---\nname: onecdev-mcp-required\n---\n<!-- onecdev:generated-role -->\nстарая версия\n`,
        'utf-8'
      );
      // пользовательский скилл с тем же id-каталогом, но без маркера — не удаляется
      const userSkillDir = path.join(skillsRoot, 'onecdev-1c-developer');
      fs.mkdirSync(userSkillDir, { recursive: true });
      fs.writeFileSync(path.join(userSkillDir, 'SKILL.md'), '---\nname: onecdev-1c-developer\n---\nручной\n', 'utf-8');

      const installer = new AiSkillsInstaller({ appendLine: () => undefined });
      installer.installProjectRoles({
        projectRoot: root,
        platform,
      });

      assert.ok(!fs.existsSync(staleSkillDir));
      assert.ok(fs.existsSync(path.join(userSkillDir, 'SKILL.md')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('для OpenCode читает JSONC-конфиг и не теряет MCP-серверы', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-ai-roles-opencode-jsonc-'));
    try {
      const platform = AI_SKILLS_PLATFORMS.find((item) => item.id === 'opencode') ?? AI_SKILLS_PLATFORMS[0];
      fs.writeFileSync(path.join(root, 'opencode.json'), [
        '{',
        '  "$schema": "https://opencode.ai/config.json",',
        '  // существующий MCP нельзя терять',
        '  "mcp": {',
        '    "onecdev": {',
        '      "type": "remote",',
        '      "url": "http://127.0.0.1:38481/mcp",',
        '    },',
        '  },',
        '}',
      ].join('\n'), 'utf-8');

      const installer = new AiSkillsInstaller({ appendLine: () => undefined });
      installer.installProjectRoles({
        projectRoot: root,
        platform,
      });

      const config = JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf-8')) as {
        instructions: string[];
        mcp: {
          onecdev: {
            enabled: boolean;
          };
        };
      };
      assert.ok(config.instructions.includes('.opencode/instructions/*.md'));
      assert.strictEqual(config.mcp.onecdev.enabled, true);
      assert.ok(!fs.existsSync(path.join(root, 'opencode.json.bak')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
