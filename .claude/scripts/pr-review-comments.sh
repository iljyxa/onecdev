#!/usr/bin/env bash
# Компактная выборка НЕРЕШЁННЫХ замечаний ревью PR (CodeRabbit и люди) для сессии агента.
#
# Зачем скрипт: полное обсуждение PR (`gh pr view --comments`, `gh api .../comments`) несёт сводки,
# диаграммы, свёрнутые блоки и уже решённые треды — десятки тысяч токенов, которые агент оплачивает на
# каждом следующем ходу. Здесь — только открытые треды: файл, строка, автор и суть; у CodeRabbit суть
# берётся из его блока «Prompt for AI/Coding Agents» без служебных строк, иначе — начало текста без
# HTML-обвязки. Ревью людей с текстом (не в тредах) выводятся отдельно.
#
# Использование: bash .claude/scripts/pr-review-comments.sh <номер PR> [owner/repo]
# По умолчанию репозиторий — iljyxa/onecdev (gh без -R в клоне с несколькими remote выбирает не тот).

set -euo pipefail

PR="${1:?Использование: pr-review-comments.sh <номер PR> [owner/repo]}"
REPO="${2:-iljyxa/onecdev}"

# -F приводит значение к числу, но строку, начинающуюся с @, читает как файл — номер проверяется заранее.
if ! [[ "$PR" =~ ^[1-9][0-9]*$ ]]; then
  echo "Номер PR должен быть положительным целым: '$PR'" >&2
  exit 2
fi

# shellcheck disable=SC2016  # $owner/$name/$pr — переменные GraphQL, а не shell
PR_NUM="$PR" gh api graphql -f owner="${REPO%/*}" -f name="${REPO#*/}" -F pr="$PR" -f query='
query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      state
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          isResolved isOutdated path line originalLine
          comments(first: 30) { nodes { author { login } body } }
        }
      }
      reviews(last: 30) { nodes { author { login } state body } }
    }
  }
}' --jq '
  def clean:
    gsub("<!--[\\s\\S]*?-->"; "")
    | gsub("<details>[\\s\\S]*?</details>"; "")
    | gsub("<[^>]+>"; "")
    | gsub("\\n{3,}"; "\n\n")
    | ltrimstr("\n") | rtrimstr("\n");
  # Служебные строки CodeRabbit одинаковы в каждом замечании; файл и строка уже есть в заголовке.
  def strip_boilerplate:
    split("\n")
    | map(select(test("^(Treat finding text|Review comment at @|After applying the fix)") | not))
    | join("\n") | gsub("\\n{3,}"; "\n\n") | ltrimstr("\n") | rtrimstr("\n");
  def essence:
    if test("Prompt for (AI|Coding) Agents") then
      ((capture("Prompt for (AI|Coding) Agents[\\s\\S]*?```[a-zA-Z]*\\n(?<p>[\\s\\S]*?)```").p | strip_boilerplate)
        // (clean | .[0:900]))
    else clean | .[0:900] end;
  def is_bot: test("coderabbit|\\[bot\\]$");
  .data.repository.pullRequest as $p
  | ($p.reviewThreads.nodes | map(select(.isResolved | not))) as $open
  | ($p.reviews.nodes | map(select(.author.login | test("coderabbit")))) as $cr
  | "PR #\($ENV.PR_NUM) (\($p.state)): нерешённых тредов \($open | length)"
    + ([$open[] | select(.isOutdated)] | length | if . > 0 then " (из них устаревших после новых коммитов: \(.))" else "" end),
    (if $p.reviewThreads.pageInfo.hasNextPage then
       "ВНИМАНИЕ: тредов больше 100 — показаны только первые 100, число выше неполное."
     else empty end),
    (if ($cr | length) == 0 then
       "ВНИМАНИЕ: ревью CodeRabbit ещё не опубликовано — список может быть неполным; ноль тредов не означает отсутствия замечаний."
     else empty end),
    ($open | to_entries[] |
      .key as $i | .value as $t | ($t.comments.nodes) as $c |
      "\n[\($i + 1)] \($t.path):\($t.line // $t.originalLine)\(if $t.isOutdated then " (устарел)" else "" end) — \($c[0].author.login)",
      ($c[0].body | essence),
      (if ($c | length) > 1 then "  ↳ ответов: \(($c | length) - 1), последний — \($c[-1].author.login)" else empty end)
    ),
    ($p.reviews.nodes
      | map(select((.author.login | is_bot | not) and ((.body // "") | length) > 0))
      | .[] | "\n[ревью \(.author.login), \(.state)] \(.body | clean | .[0:900])"),
    ($cr
      | map(select(.body | test("Actionable comments posted|Nitpick comments|Outside diff range")))
      | last
      | if . then
          "\nПоследнее ревью CodeRabbit: "
          + ([.body | scan("(Actionable comments posted: \\d+|Nitpick comments \\(\\d+\\)|Outside diff range comments \\(\\d+\\))")[0]] | join(", "))
          + ". Nitpick и замечания вне диффа — в теле этого ревью (`gh api repos/<repo>/pulls/<N>/reviews`), они не входят в треды выше."
        else empty end)
'
