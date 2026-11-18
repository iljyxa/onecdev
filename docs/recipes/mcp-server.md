# Рецепты: Встроенный MCP-сервер

Часть справочника [«какие файлы трогать»](../change-recipes.md). Если требуется править сверх списка — задача решается в другом слое.

- **Изменение жизненного цикла/безопасности встроенного MCP-сервера** (порт, идентичность процесса,
  graceful shutdown, Host/Origin, отличается от «новый MCP-инструмент» из раздела выше): чистая логика —
  в `infra/mcp/` (`McpServerIdentity`, `McpStartDecision`, `McpPortProbe`, `McpConflictPrompt`, `McpHost`,
  без `vscode`) → тонкий адаптер конкретного эндпоинта/диалога — `ui/mcp/V8McpServer.ts` (HTTP-роутинг,
  служебные `/identity`+`/shutdown` — не MCP-инструменты) и `Container` (чтение настроек `onecdev.mcp.*`,
  показ диалога конфликта порта). См. [mcp-server-lifecycle.md](../mcp-server-lifecycle.md).
