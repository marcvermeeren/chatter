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

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
