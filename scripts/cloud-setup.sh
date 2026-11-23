#!/usr/bin/env bash
# Прогрев проекта для облачной разработки: npm ci и сборка.
#
# Скрипт готовит зависимости и сборку проекта. В Claude Code его вызывает
# SessionStart-хук (.claude/settings.json).
# Причина разделения: Setup script выполняется ДО запуска Claude Code, и на этом этапе нет
# гарантированной привязки рабочей директории к клону репозитория — задокументирована только
# переменная $CLAUDE_PROJECT_DIR, которую Claude Code выставляет для хуков. Установка xvfb и
# системных библиотек Electron (нужны настоящему VS Code из @vscode/test-electron под npm test)
# не зависит от файлов проекта и живёт прямо в поле Setup script инлайн-текстом — см.
# README.md, раздел «Claude Code Cloud».
#
# CLAUDE_CODE_REMOTE=true выставляется только в облачной VM — локально хук выходит сразу,
# не мешая обычному npm run watch.
# В Codex Cloud скрипт запускается явно из Setup script с аргументом --codex.

set -euo pipefail

if [ "${1:-}" != "--codex" ] && [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Установка зависимостей (npm ci по package-lock.json)"
if [ "${1:-}" = "--codex" ]; then
  npm ci --ignore-scripts
else
  npm ci
fi

echo "==> Прогрев сборки: typecheck + vite + компиляция тестов"
npm run typecheck
npm run build:node
npm run build:webview
npm run test:compile

cat <<'HINT'

==> Готово.

Запуск тестов в headless-окружении — через виртуальный дисплей (xvfb ставится Setup script'ом
окружения, см. README.md):

    xvfb-run -a npm test

Прогон под конкретной версией VS Code:

    VSCODE_TEST_VERSION=1.85.0 xvfb-run -a npm test

Если исходящая сеть ограничена allowlist'ом, для скачивания VS Code нужен доступ к
update.code.visualstudio.com и vscode-cdn.azureedge.net. Команды, не требующие сети и дисплея
('npm run compile', 'npm run lint', 'npm run build'), работают в любом случае.
HINT
