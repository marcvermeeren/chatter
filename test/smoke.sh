#!/bin/sh
# Chatter smoke tests. Runs against an isolated state dir + scratch repos,
# no Herdr server needed (agent lookups degrade to an empty roster).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HERDR_PLUGIN_STATE_DIR="$TMP/state"
export HERDR_PLUGIN_CONFIG_DIR="$TMP/config"
export HERDR_BIN_PATH="/nonexistent-herdr"   # forces empty live roster
unset HERDR_PANE_ID || true                  # caller is the human
mkdir -p "$HERDR_PLUGIN_STATE_DIR" "$HERDR_PLUGIN_CONFIG_DIR"

CH="node --no-warnings $ROOT/bin/chatter.js"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   - $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }
check() { # check <desc> <cmd...>
  desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else fail "$desc"; fi
}

REPO="$TMP/repo-a"
mkdir -p "$REPO" && git -C "$REPO" init -q
cd "$REPO"

echo "# basics"
check "iam sets human name"            $CH iam tester
$CH whoami | grep -q tester && ok "whoami reports tester" || fail "whoami reports tester"
check "note round-trip"                $CH note "hello world" --type discovery
$CH notes hello | grep -q "hello world" && ok "notes search" || fail "notes search"
check "question opens"                 $CH ask "what is up?"
$CH questions | grep -q "what is up" && ok "questions lists open" || fail "questions lists open"
QID=$($CH questions --json | node -e "console.log(JSON.parse(require('fs').readFileSync(0))[0].id)")
check "question answered"              $CH answer "$QID" "not much"
$CH agents --json | node -e "JSON.parse(require('fs').readFileSync(0))" && ok "--json parses" || fail "--json parses"
$CH stats >/dev/null 2>&1 && ok "stats runs" || fail "stats runs"

echo "# H2: 20 parallel task creates -> 20 unique ids, zero failures"
i=1; while [ $i -le 20 ]; do $CH task create "concurrent $i" >/dev/null 2>&1 & i=$((i+1)); done; wait
COUNT=$($CH task list --json | node -e "const t=JSON.parse(require('fs').readFileSync(0));console.log(t.length)")
UNIQ=$($CH task list --json | node -e "const t=JSON.parse(require('fs').readFileSync(0));console.log(new Set(t.map(x=>x.id)).size)")
[ "$COUNT" = "20" ] && [ "$UNIQ" = "20" ] && ok "20 tasks, 20 unique ids" || fail "expected 20/20, got $COUNT/$UNIQ"

echo "# L8: message content is preserved verbatim"
$CH post "preserve --json please" >/dev/null 2>&1
$CH chat --json | grep -q "preserve --json please" && ok "post keeps --json in body" || fail "post keeps --json in body"
$CH send ghost "flags --queue-like --verbose inside" --queue >/dev/null 2>&1 \
  && $CH log --grep verbose --json | grep -q "flags --queue-like --verbose inside" \
  && ok "send body with flags survives (--queue trailing)" || fail "send body with flags survives"

echo "# M7: assignee validated on create"
$CH task create "typo test" --assignee does-not-exist >/dev/null 2>&1 && fail "ghost assignee accepted" || ok "ghost assignee refused"

echo "# M6: startup never clobbers a non-symlink"
FAKEHOME="$TMP/home"; mkdir -p "$FAKEHOME/.local/bin"
echo "#!/bin/sh" > "$FAKEHOME/.local/bin/chatter"; chmod +x "$FAKEHOME/.local/bin/chatter"
HOME="$FAKEHOME" $CH _startup >/dev/null 2>&1
[ -L "$FAKEHOME/.local/bin/chatter" ] && fail "regular file was replaced" || ok "regular file left alone"

echo "# M5: iam refuses a registered agent name"
sqlite3 "$(ls "$HERDR_PLUGIN_STATE_DIR"/repos/*/chatter.db | head -1)" \
  "INSERT OR IGNORE INTO agents (name, registered_at, last_seen_at) VALUES ('takenname','x','x')" 2>/dev/null
$CH iam takenname >/dev/null 2>&1 && fail "registered name adopted" || ok "registered agent name refused"

echo "# repo isolation"
REPO_B="$TMP/repo-b"; mkdir -p "$REPO_B" && git -C "$REPO_B" init -q
cd "$REPO_B"
$CH notes 2>/dev/null | grep -q "hello world" && fail "repo B sees repo A notes" || ok "repo B is an empty universe"
cd "$TMP"
$CH notes >/dev/null 2>&1 && fail "runs outside a repo" || ok "refuses outside a git repo"

echo "# ledger + brief"
cd "$REPO"
DBFILE=$(ls "$HERDR_PLUGIN_STATE_DIR"/repos/*/chatter.db | head -1)
KINDS=$(sqlite3 "$DBFILE" "SELECT DISTINCT kind FROM events ORDER BY kind" | tr '\n' ' ')
echo "$KINDS" | grep -q "task_created" && echo "$KINDS" | grep -q "question_opened" \
  && echo "$KINDS" | grep -q "question_answered" && echo "$KINDS" | grep -q "note_created" \
  && ok "ledger records events ($KINDS)" || fail "ledger missing kinds (got: $KINDS)"
$CH task create "brief test task" >/dev/null 2>&1
OUT=$($CH brief --json)
echo "$OUT" | node -e "const b=JSON.parse(require('fs').readFileSync(0)); if(!Array.isArray(b.lines)||!b.lines.length) process.exit(1)" \
  && ok "brief --json returns lines" || fail "brief --json returns lines"
echo "$OUT" | grep -q "brief test task" && ok "brief shows new task" || fail "brief shows new task"
# The default-window call above advanced the caller's mark: the same task
# must NOT reappear in the next default brief.
sleep 1
$CH brief | grep -q "brief test task" && fail "brief mark did not advance" || ok "brief mark advances (task not repeated)"
$CH brief 2h | grep -q "brief test task" && ok "explicit window still sees it" || fail "explicit window still sees it"

echo "# data + purge"
cd "$REPO"
$CH data | grep -q "repo-a" && ok "data lists universes" || fail "data lists universes"
$CH purge repo-a | grep -q "would delete" && ok "purge defaults to dry run" || fail "purge defaults to dry run"
$CH data | grep -q "repo-a" && ok "dry run deleted nothing" || fail "dry run deleted nothing"
REPO_C="$TMP/repo-c"; mkdir -p "$REPO_C" && git -C "$REPO_C" init -q
( cd "$REPO_C" && $CH note "orphan bait" >/dev/null 2>&1 )
rm -rf "$REPO_C"
$CH data | grep -q "ORPHAN" && ok "orphan detected" || fail "orphan detected"
$CH purge --orphans --yes | grep -q "deleted" && ok "orphan purged" || fail "orphan purged"
$CH data | grep -q "ORPHAN" && fail "orphan still listed" || ok "orphan gone from data"
$CH purge --older-than 0h --yes >/dev/null 2>&1 && ok "older-than trim runs" || fail "older-than trim runs"

echo "# boundary lint: repo-scoped code must not touch the session-wide roster"
if grep -n 'sessionAgents' "$ROOT/src/commands.js" "$ROOT/src/board.js" "$ROOT/bin/chatter.js" >/dev/null 2>&1; then
  fail "sessionAgents leaked into repo-scoped code (commands/board/bin)"
else
  ok "session-wide roster quarantined to team.js/setup.js"
fi
grep -q 'teamAgents' "$ROOT/src/commands.js" && grep -q 'teamAgents' "$ROOT/src/board.js" \
  && ok "repo-scoped surfaces use teamAgents(d)" || fail "repo-scoped surfaces use teamAgents(d)"
grep -rn 'liveAgents(' "$ROOT/src" "$ROOT/bin" >/dev/null 2>&1 \
  && fail "old liveAgents() name still referenced" || ok "old liveAgents() name fully retired"

echo "# spawn (failure path — no herdr available here)"
$CH spawn helper --kind codex >/dev/null 2>&1 && fail "spawn succeeded without herdr?" || ok "spawn fails gracefully without herdr"

echo "# setup --yes + doctor"
SETHOME="$TMP/sethome"; mkdir -p "$SETHOME/.config/herdr" "$SETHOME/.local/bin"
cd "$REPO"
HOME="$SETHOME" $CH setup --yes --name smoketester >/dev/null 2>&1 && ok "setup --yes runs" || fail "setup --yes runs"
grep -q 'ui.toast' "$SETHOME/.config/herdr/config.toml" && ok "toast block written" || fail "toast block written"
grep -q 'chatter.open-chat' "$SETHOME/.config/herdr/config.toml" && ok "keybinding written" || fail "keybinding written"
HOME="$SETHOME" $CH setup --yes --name smoketester >/dev/null 2>&1
N=$(grep -c 'ui.toast' "$SETHOME/.config/herdr/config.toml")
[ "$N" = "1" ] && ok "setup is idempotent (no duplicate blocks)" || fail "duplicate blocks after rerun ($N)"
printf '[ui.toast]\ndelivery = "off"\n' > "$SETHOME/.config/herdr/config.toml"
HOME="$SETHOME" $CH setup --yes --name smoketester >/dev/null 2>&1
grep -q 'delivery = "off"' "$SETHOME/.config/herdr/config.toml" && ok "existing [ui.toast] respected" || fail "existing [ui.toast] overwritten"
$CH doctor >/dev/null 2>&1; RC=$?
[ "$RC" = "0" ] || [ "$RC" = "1" ] && ok "doctor runs (exit $RC)" || fail "doctor crashed"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
