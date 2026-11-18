---
description: Механические sanity-чеки из docs/project-rules.md — compile, lint, build и 8 rg-проверок архитектурных инвариантов. Без запуска тестов.
allowed-tools: Bash
---

Запусти sanity-чеки из раздела «Sanity-чек после изменений» `docs/project-rules.md`. Выполняй ровно эти проверки и сообщай результат каждой:

```bash
npm run compile                                                        # 0 ошибок
npm run lint                                                           # 0 ошибок и предупреждений
rg "typeToFolder\s*:" src                                             # ожидается 0
rg "import .* from 'vscode'" src/domain src/infra                     # ожидается 0
rg "from ['\"].*cli|from ['\"].*/cli" src/domain src/infra            # ожидается 0
rg "require\(|readFileSync" src/domain                                # ожидается 0
rg "FOLDER_MAP|FOLDER_RU" src                                         # ожидается 0
rg "crs:snapshots|commitObjects|updateObjects|11223344" src --glob '!src/test/**'   # ожидается 0
rg "crs:data" src --glob '!src/test/**' --glob '!src/infra/repository/crs/CrsHistory.ts'   # ожидается 0
rg "base64|atob\(" src/infra/repository/crs/CrsHistory.ts             # ожидается 0
npm run build                                                          # Vite собирается
```

Верни сводку: каждая проверка — PASS/FAIL с количеством совпадений. Код завершения `rg` — как в `qa-gate.sh`: `1` (нет совпадений) — PASS, `0` — FAIL с совпадениями, `2+` — FAIL с текстом ошибки (например, нет каталога: отсутствие вывода тут не означает «чисто»). Если что-то не 0 — это нарушение архитектурного инварианта, укажи где. Не исправляй сам — это задача `/review`/разработчика.
