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
git -C "$REPO" -c user.email=t@t -c user.name=t commit --allow-empty -q -m init
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

echo "# behavioral isolation (fake herdr: agents live in two repos)"
export FAKE_CALLS="$TMP/herdr-calls.log"
export FAKE_ROSTER="$TMP/roster.json"
: > "$FAKE_CALLS"
REPO_B2="$TMP/repo-b"   # created above, has its own universe
cat > "$FAKE_ROSTER" <<EOF
{"result":{"agents":[
  {"name":"alpha","pane_id":"w1:p1","agent_status":"idle","agent":"claude","workspace_id":"w1","cwd":"$REPO"},
  {"name":"beta","pane_id":"w1:p2","agent_status":"idle","agent":"claude","workspace_id":"w1","cwd":"$REPO_B2"},
  {"name":"moved","pane_id":"w1:p3","agent_status":"idle","agent":"pi","workspace_id":"w1","cwd":"$REPO_B2"}
]}}
EOF
# 'moved' registered in repo A historically, but its pane now works in repo B.
ADB=$(ls "$HERDR_PLUGIN_STATE_DIR"/repos/repo-a-*/chatter.db)
sqlite3 "$ADB" "INSERT OR REPLACE INTO agents (name,pane_id,cwd,repo_root,registered_at,last_seen_at) VALUES ('moved','w1:p3','$REPO','$REPO','x','x')"
cd "$REPO"
CHF="env HERDR_BIN_PATH=$ROOT/test/fake-herdr node --no-warnings $ROOT/bin/chatter.js"
OUT=$($CHF agents)
echo "$OUT" | grep -q "alpha" && ok "roster shows in-repo live agent" || fail "roster shows in-repo live agent"
echo "$OUT" | grep -q "beta" && fail "roster leaks other repo's agent" || ok "roster excludes other repo's agent"
echo "$OUT" | grep "moved" | grep -q "offline" && ok "moved-away agent shows offline, not live" || fail "moved-away agent shows offline"
$CHF send beta "hi" >/dev/null 2>&1 && fail "send to other-repo agent accepted" || ok "send to other-repo agent refused"
: > "$FAKE_CALLS"
$CHF send moved "hi" 2>/dev/null | grep -q queued && ok "send to moved-away agent queues" || fail "send to moved-away agent queues"
grep -q "agent prompt" "$FAKE_CALLS" && fail "H1 REGRESSION: injected into moved-away agent" || ok "no injection to moved-away agent (H1)"
: > "$FAKE_CALLS"
$CHF send alpha "hi" 2>/dev/null | grep -q delivered && ok "send to in-repo agent delivers" || fail "send to in-repo agent delivers"
grep -q "agent prompt w1:p1" "$FAKE_CALLS" && ok "prompt went to alpha's pane" || fail "prompt went to alpha's pane"
: > "$FAKE_CALLS"
$CHF post "@everyone hello" >/dev/null 2>&1
grep -c "agent prompt" "$FAKE_CALLS" | grep -qx "1" && grep -q "agent prompt w1:p1" "$FAKE_CALLS" \
  && ok "@everyone reaches only this repo's team" || fail "@everyone crossed the repo boundary"
$CHF brief 1h 2>/dev/null | grep -q "agents: 1 idle" && ok "brief counts this repo's team only" || fail "brief counts this repo's team only"
echo "# spawn v2: worktree default, --tab explicit"
: > "$FAKE_CALLS"
OUT=$($CHF spawn helper2 --kind pi 2>&1)
grep -q "worktree create --cwd" "$FAKE_CALLS" && grep -q "branch agents/helper2" "$FAKE_CALLS" \
  && ok "spawn creates a worktree on agents/<handle>" || fail "spawn creates a worktree"
grep -q "tab create" "$FAKE_CALLS" && fail "worktree spawn also made a tab" || ok "no tab for worktree spawn"
grep -q "agent start helper2" "$FAKE_CALLS" && ok "agent started in worktree pane" || fail "agent started in worktree pane"
echo "$OUT" | grep -q "new worktree" && ok "output names the worktree setup" || fail "output names the worktree setup"
# Commitless repo: worktree spawn must refuse with guidance, not a raw git error.
REPO_EMPTY="$TMP/repo-empty"; mkdir -p "$REPO_EMPTY" && git -C "$REPO_EMPTY" init -q
( cd "$REPO_EMPTY" && $CHF spawn babyagent --kind pi 2>&1 | grep -q "no commits yet" ) \
  && ok "commitless repo gets a clear spawn refusal" || fail "commitless repo spawn message"
( cd "$REPO_EMPTY" && : > "$FAKE_CALLS"; $CHF spawn babyagent --kind pi >/dev/null 2>&1; \
  grep -q "worktree create" "$FAKE_CALLS" ) && fail "worktree create attempted on unborn HEAD" || ok "no worktree attempted on unborn HEAD"

# Shell-not-ready race: two busy refusals, then success — spawn must retry.
echo 2 > "$TMP/busy-count"
: > "$FAKE_CALLS"
FAKE_BUSY="$TMP/busy-count" $CHF spawn helper4 --kind pi >/dev/null 2>&1 \
  && ok "spawn retries through agent_pane_busy" || fail "spawn retries through agent_pane_busy"
STARTS=$(grep -c "agent start helper4" "$FAKE_CALLS")
[ "$STARTS" = "3" ] && ok "retried exactly until the shell was ready ($STARTS starts)" || fail "unexpected retry count: $STARTS"
: > "$FAKE_CALLS"
$CHF spawn helper3 --kind pi --tab >/dev/null 2>&1
grep -q "tab create" "$FAKE_CALLS" && ok "--tab uses same-checkout tab" || fail "--tab uses same-checkout tab"
grep -q "worktree create" "$FAKE_CALLS" && fail "--tab still made a worktree" || ok "--tab made no worktree"

echo "# role: display label via chatter"
: > "$FAKE_CALLS"
$CHF role alpha "Data / API" >/dev/null 2>&1
grep -q "pane rename w1:p1 Data / API" "$FAKE_CALLS" && ok "role renames the pane through herdr" || fail "role renames the pane"
$CHF agents | grep -q "Data / API · @alpha" && ok "roster shows display · @handle" || fail "roster shows display · @handle"
# 'moved' is registered in repo A, so it resolves — the permission check must fire.
ROLE_OUT=$(HERDR_PANE_ID=w1:p1 env HERDR_BIN_PATH="$ROOT/test/fake-herdr" FAKE_CALLS="$FAKE_CALLS" FAKE_ROSTER="$FAKE_ROSTER" node --no-warnings "$ROOT/bin/chatter.js" role moved "Sneaky retitle" 2>&1)
echo "$ROLE_OUT" | grep -q "only set their own" && ok "agent cannot retitle a teammate" || fail "agent retitle not blocked: $ROLE_OUT"
# Cross-repo target refused even earlier, by the boundary itself.
ROLE_OUT2=$(HERDR_PANE_ID=w1:p1 env HERDR_BIN_PATH="$ROOT/test/fake-herdr" FAKE_CALLS="$FAKE_CALLS" FAKE_ROSTER="$FAKE_ROSTER" node --no-warnings "$ROOT/bin/chatter.js" role beta "x" 2>&1)
echo "$ROLE_OUT2" | grep -q "no agent" && ok "cross-repo retitle blocked by the boundary" || fail "cross-repo retitle: $ROLE_OUT2"
echo "# departure: reap, forget, and departed exclusion"
$CHF send moved "will be stuck" --queue >/dev/null 2>&1
env HERDR_PLUGIN_EVENT_JSON='{"type":"pane_closed","pane_id":"w1:p3"}' HERDR_BIN_PATH="$ROOT/test/fake-herdr" \
  FAKE_CALLS="$FAKE_CALLS" FAKE_ROSTER="$FAKE_ROSTER" HERDR_PLUGIN_STATE_DIR="$HERDR_PLUGIN_STATE_DIR" \
  node --no-warnings "$ROOT/bin/chatter.js" _reap | grep -q "departed" && ok "_reap marks the closed pane's agent departed" || fail "_reap marks departed"
$CHF agents | grep -q "moved" && fail "departed agent still in default roster" || ok "departed agent hidden from roster"
$CHF agents --all | grep "moved" | grep -q "departed" && ok "--all shows it as departed" || fail "--all shows departed"
$CHF send moved "hi again" >/dev/null 2>&1 && fail "send to departed accepted without --queue" || ok "send to departed refused"
$CHF brief 1h | grep -q "queued for departed" && ok "brief flags stuck mail" || fail "brief flags stuck mail"
$CHF forget moved | grep -q "dropped" && ok "forget drops queued mail" || fail "forget drops queued mail"
$CHF brief 1h | grep -q "queued for departed" && fail "stuck-mail flag persists after forget" || ok "stuck-mail flag cleared"
# Workspace-level teardown (worktree.removed carries only the workspace id) —
# and one closed pane must never reap the whole workspace.
sqlite3 "$ADB" "INSERT OR REPLACE INTO agents (name,pane_id,registered_at,last_seen_at) VALUES ('gamma','w7:p1','x','x'),('delta','w7:p2','x','x')"
REAP="env HERDR_BIN_PATH=$ROOT/test/fake-herdr FAKE_CALLS=$FAKE_CALLS FAKE_ROSTER=$FAKE_ROSTER HERDR_PLUGIN_STATE_DIR=$HERDR_PLUGIN_STATE_DIR node --no-warnings $ROOT/bin/chatter.js _reap"
env HERDR_PLUGIN_EVENT="pane.closed" HERDR_PLUGIN_EVENT_JSON='{"type":"pane_closed","pane_id":"w7:p1","workspace_id":"w7"}' $REAP >/dev/null
G=$(sqlite3 "$ADB" "SELECT departed_at IS NOT NULL FROM agents WHERE name='gamma'")
D=$(sqlite3 "$ADB" "SELECT departed_at IS NOT NULL FROM agents WHERE name='delta'")
[ "$G" = "1" ] && [ "$D" = "0" ] && ok "pane.closed reaps only its own pane" || fail "pane.closed overreach (gamma=$G delta=$D)"
env HERDR_PLUGIN_EVENT="worktree.removed" HERDR_PLUGIN_EVENT_JSON='{"type":"worktree_removed","workspace_id":"w7","worktree":{"path":"/x"}}' $REAP | grep -q departed \
  && ok "worktree.removed reaps by workspace id" || fail "worktree.removed reaps by workspace id"
D2=$(sqlite3 "$ADB" "SELECT departed_at IS NOT NULL FROM agents WHERE name='delta'")
[ "$D2" = "1" ] && ok "workspace teardown retired the remaining agent" || fail "workspace teardown retired delta"
unset FAKE_CALLS FAKE_ROSTER

echo "# human-only gates"
HP_OUT=$(HERDR_PANE_ID=w1:p1 env HERDR_BIN_PATH="$ROOT/test/fake-herdr" FAKE_CALLS="$TMP/herdr-calls.log" FAKE_ROSTER="$TMP/roster.json" node --no-warnings "$ROOT/bin/chatter.js" purge --all --yes 2>&1)
echo "$HP_OUT" | grep -q "human-only" && ok "agent cannot purge" || fail "agent purge not blocked: $HP_OUT"
HI_OUT=$(HERDR_PANE_ID=w1:p1 env HERDR_BIN_PATH="$ROOT/test/fake-herdr" FAKE_CALLS="$TMP/herdr-calls.log" FAKE_ROSTER="$TMP/roster.json" node --no-warnings "$ROOT/bin/chatter.js" iam evil 2>&1)
echo "$HI_OUT" | grep -q "human-only" && ok "agent cannot change human identity" || fail "agent iam not blocked: $HI_OUT"
ls "$HERDR_PLUGIN_STATE_DIR"/repos/*/chatter.db >/dev/null 2>&1 && ok "universes survived blocked purge" || fail "universes survived blocked purge"

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

echo "# help logo is TTY-only (agents pipe help constantly)"
HELP_OUT=$($CH help)   # command substitution => stdout is a pipe, not a TTY
echo "$HELP_OUT" | grep -q "$(printf '\033')" && fail "piped help emits escape sequences" || ok "piped help is escape-free"
echo "$HELP_OUT" | grep -q '▄' && fail "piped help includes the block logo" || ok "piped help has no block art"
echo "$HELP_OUT" | grep -q "chatter agents" && ok "piped help still lists commands" || fail "piped help lists commands"

echo "# CLI spawn streams its stages"
: > "$TMP/herdr-calls.log"
SPAWN_OUT=$(env HERDR_BIN_PATH="$ROOT/test/fake-herdr" FAKE_CALLS="$TMP/herdr-calls.log" FAKE_ROSTER="$TMP/roster.json" \
  node --no-warnings "$ROOT/bin/chatter.js" spawn helper6 --kind pi 2>&1)
S_LINE=$(echo "$SPAWN_OUT" | grep -n "starting" | head -1 | cut -d: -f1)
U_LINE=$(echo "$SPAWN_OUT" | grep -n "is up" | head -1 | cut -d: -f1)
[ -n "$S_LINE" ] && [ -n "$U_LINE" ] && [ "$S_LINE" -lt "$U_LINE" ] \
  && ok "spawn prints a 'starting' stage before 'is up' ($S_LINE < $U_LINE)" \
  || fail "spawn progress not streamed (starting=$S_LINE up=$U_LINE)"

echo "# header: numbered universe tabs only where number keys work (board)"
node -e "
const { headerBar } = require('$ROOT/src/board.js');
const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const files = ['/s/repos/alpha-11111111/chatter.db', '/s/repos/beta-22222222/chatter.db'];
const chat = strip(headerBar(files[0], 80));
const board = strip(headerBar(files[0], 80, files));
if (!chat.includes('#alpha') || chat.includes('[1 ')) process.exit(1);   // chat: repo name only
if (!board.includes('[1 alpha]') || !board.includes('[2 beta]')) process.exit(1);
" && ok "chat header is repo-only, board keeps its tabs" || fail "chat header is repo-only, board keeps its tabs"

echo "# chat-in-a-tab placement"
grep -q 'id = "open-chat-tab"' "$ROOT/herdr-plugin.toml" && ok "manifest declares open-chat-tab" || fail "manifest declares open-chat-tab"
grep -q '_open_chat_tab' "$ROOT/herdr-plugin.toml" && grep -q '_open_chat_tab' "$ROOT/bin/chatter.js" \
  && ok "_open_chat_tab dispatch is wired" || fail "_open_chat_tab dispatch is wired"
node -e "const c=require('$ROOT/src/commands.js'); process.exit(typeof c.hookOpenChatTab === 'function' ? 0 : 1)" \
  && ok "hookOpenChatTab resolves" || fail "hookOpenChatTab resolves"

echo "# spawn (failure path — no herdr available here)"
$CH spawn helper --kind codex >/dev/null 2>&1 && fail "spawn succeeded without herdr?" || ok "spawn fails gracefully without herdr"

echo "# update: linked checkout (a throwaway fixture — never this repo)"
UPD="$TMP/upd"; UPDHOME="$TMP/updhome"; UPDCALLS="$TMP/upd-calls.log"
mkdir -p "$UPD" "$UPDHOME/.local/bin"; : > "$UPDCALLS"
git init -q --bare "$UPD/origin.git"
git init -q "$UPD/seed"
( cd "$UPD/seed" && git config user.email t@example.com && git config user.name tester \
  && git checkout -q -b main \
  && printf 'id = "chatter"\nversion = "0.1.0"\n' > herdr-plugin.toml \
  && git add -A && git commit -qm v1 \
  && git remote add origin "$UPD/origin.git" && git push -q origin main ) >/dev/null 2>&1
git -C "$UPD/origin.git" symbolic-ref HEAD refs/heads/main
git clone -q "$UPD/origin.git" "$UPD/root" 2>/dev/null
# origin moves ahead, carrying a version bump
( cd "$UPD/seed" && printf 'id = "chatter"\nversion = "0.2.0"\n' > herdr-plugin.toml \
  && git add -A && git commit -qm v2 && git push -q origin main ) >/dev/null 2>&1

cat > "$TMP/upd.js" <<'JS'
const u = require(process.env.UPD_SRC);
const r = u.runUpdate(
  { source: JSON.parse(process.env.UPD_SOURCE), root: process.env.UPD_ROOT },
  { check: process.env.UPD_CHECK === '1' });
console.log(`ok=${r.ok} ${r.lines.join(' | ')}`);
JS
updrun() { # updrun <sourceJSON> <root> <check 0|1>
  env HOME="$UPDHOME" HERDR_BIN_PATH="$ROOT/test/fake-herdr" FAKE_CALLS="$UPDCALLS" \
    UPD_SRC="$ROOT/src/update.js" UPD_SOURCE="$1" UPD_ROOT="$2" UPD_CHECK="$3" \
    node --no-warnings "$TMP/upd.js" 2>&1
}

updrun '{"kind":"local"}' "$UPD/root" 1 | grep -q "update available" \
  && ok "--check sees the new commit on origin" || fail "--check sees the new commit"
OUT=$(updrun '{"kind":"local"}' "$UPD/root" 0)
echo "$OUT" | grep -q "v0.1.0 → v0.2.0" && ok "update reports the version bump" || fail "update reports the version bump ($OUT)"
echo "$OUT" | grep -q "fast-forwarded" && ok "update fast-forwards the checkout" || fail "update fast-forwards"
grep -q "plugin link $UPD/root" "$UPDCALLS" && ok "update re-registers the manifest" || fail "update re-registers the manifest"
[ "$(grep -c 'version = "0.2.0"' "$UPD/root/herdr-plugin.toml")" = "1" ] && ok "checkout really advanced" || fail "checkout really advanced"
updrun '{"kind":"local"}' "$UPD/root" 1 | grep -q "up to date" && ok "--check is quiet once current" || fail "--check quiet once current"
updrun '{"kind":"local"}' "$UPD/root" 0 | grep -q "already up to date (v0.2.0)" \
  && ok "a second update is a no-op" || fail "a second update is a no-op"

# A checkout that is AHEAD of its remote (this is where the work happens) is
# current, not behind.
( cd "$UPD/root" && git config user.email t@example.com && git config user.name tester \
  && printf 'id = "chatter"\nversion = "0.3.0"\n' > herdr-plugin.toml && git add -A && git commit -qm ahead ) >/dev/null 2>&1
updrun '{"kind":"local"}' "$UPD/root" 1 | grep -q "up to date" \
  && ok "a checkout ahead of origin is not 'behind'" || fail "checkout ahead misreported as behind"
( cd "$UPD/root" && git reset -q --hard origin/main ) >/dev/null 2>&1

echo "x" >> "$UPD/root/herdr-plugin.toml"
DIRTY=$(updrun '{"kind":"local"}' "$UPD/root" 0)
echo "$DIRTY" | grep -q "ok=false" && echo "$DIRTY" | grep -q "uncommitted changes" \
  && ok "dirty checkout refuses to update" || fail "dirty checkout refused ($DIRTY)"
( cd "$UPD/root" && git checkout -q -- herdr-plugin.toml ) >/dev/null 2>&1

mkdir -p "$TMP/notgit"
updrun '{"kind":"local"}' "$TMP/notgit" 0 | grep -q "not a git checkout" \
  && ok "a non-git plugin root fails clearly" || fail "non-git plugin root message"
updrun '{}' "$UPD/root" 0 | grep -q "not registered with Herdr" \
  && ok "an unregistered plugin fails clearly" || fail "unregistered plugin message"

echo "# update: github install reinstalls"
: > "$UPDCALLS"
updrun '{"kind":"github","owner":"marcvermeeren","repo":"chatter"}' "$UPD/root" 0 >/dev/null 2>&1
grep -q "plugin install marcvermeeren/chatter --yes" "$UPDCALLS" \
  && ok "github source reinstalls through herdr" || fail "github source reinstalls"
grep -q "worktree create\|git pull" "$UPDCALLS" && fail "github path touched a checkout" || ok "github path pulls nothing"
: > "$UPDCALLS"
updrun '{"kind":"github","owner":"o","repo":"r","subdir":"plugins/chatter","requested_ref":"v9"}' "$UPD/root" 0 >/dev/null 2>&1
grep -q "plugin install o/r/plugins/chatter --yes --ref v9" "$UPDCALLS" \
  && ok "subdir and pinned ref survive the reinstall" || fail "subdir/ref survive the reinstall"

echo "# update: CLI wrapper reads the registry, humans only"
cat > "$TMP/plugins-local.json" <<EOF
{"result":{"plugins":[{"plugin_id":"chatter","version":"0.2.0","plugin_root":"$UPD/root","source":{"kind":"local"}}]}}
EOF
UPDCLI="env HOME=$UPDHOME HERDR_BIN_PATH=$ROOT/test/fake-herdr FAKE_CALLS=$UPDCALLS FAKE_ROSTER=$TMP/roster.json FAKE_PLUGINS=$TMP/plugins-local.json"
$UPDCLI node --no-warnings "$ROOT/bin/chatter.js" update --check 2>&1 | grep -q "up to date" \
  && ok "chatter update --check runs off the registry" || fail "chatter update --check off the registry"
AG_OUT=$(HERDR_PANE_ID=w1:p1 $UPDCLI node --no-warnings "$ROOT/bin/chatter.js" update 2>&1)
echo "$AG_OUT" | grep -q "human-only" && ok "agents cannot update the plugin" || fail "agent update not blocked: $AG_OUT"
$UPDCLI node --no-warnings "$ROOT/bin/chatter.js" doctor 2>&1 | grep -q "chatter is up to date" \
  && ok "doctor reports update state as a note" || fail "doctor reports update state"
$UPDCLI node --no-warnings "$ROOT/bin/chatter.js" help | grep -q "chatter update" \
  && ok "help documents update" || fail "help documents update"

echo "# setup --yes + doctor"
SETHOME="$TMP/sethome"; mkdir -p "$SETHOME/.config/herdr" "$SETHOME/.local/bin"
cd "$REPO"
HOME="$SETHOME" $CH setup --yes --name smoketester >/dev/null 2>&1 && ok "setup --yes runs" || fail "setup --yes runs"
grep -q 'ui.toast' "$SETHOME/.config/herdr/config.toml" && ok "toast block written" || fail "toast block written"
grep -q 'chatter.open-chat' "$SETHOME/.config/herdr/config.toml" && ok "keybinding written" || fail "keybinding written"
grep -q 'command = "chatter.open-chat-tab"' "$SETHOME/.config/herdr/config.toml" \
  && ok "tab keybinding written" || fail "tab keybinding written"
grep -q 'key = "prefix+alt+t"' "$SETHOME/.config/herdr/config.toml" \
  && ok "tab keybinding uses prefix+alt+t" || fail "tab keybinding uses prefix+alt+t"
HOME="$SETHOME" $CH setup --yes --name smoketester >/dev/null 2>&1
N=$(grep -c 'ui.toast' "$SETHOME/.config/herdr/config.toml")
[ "$N" = "1" ] && ok "setup is idempotent (no duplicate blocks)" || fail "duplicate blocks after rerun ($N)"
NC=$(grep -c 'command = "chatter.open-chat"' "$SETHOME/.config/herdr/config.toml")
NT=$(grep -c 'command = "chatter.open-chat-tab"' "$SETHOME/.config/herdr/config.toml")
[ "$NC" = "1" ] && [ "$NT" = "1" ] && ok "both keybindings stay singular on rerun" || fail "duplicate keybindings (popup=$NC tab=$NT)"

# Each binding is judged on its own: a taken tab key must not block the popup
# one, and must never overwrite the key its owner already claimed.
CONFHOME="$TMP/confhome"; mkdir -p "$CONFHOME/.config/herdr" "$CONFHOME/.local/bin"
printf '[[keys.command]]\nkey = "prefix+alt+t"\ntype = "spawn_tab"\ndescription = "mine"\n' \
  > "$CONFHOME/.config/herdr/config.toml"
CONF_OUT=$(HOME="$CONFHOME" $CH setup --yes --name smoketester 2>&1)
echo "$CONF_OUT" | grep -q 'already in use' && ok "occupied tab key is reported, not stolen" || fail "occupied tab key not reported"
grep -q 'chatter.open-chat-tab' "$CONFHOME/.config/herdr/config.toml" && fail "tab binding written over an occupied key" || ok "tab binding skipped when its key is taken"
grep -q 'command = "chatter.open-chat"' "$CONFHOME/.config/herdr/config.toml" \
  && ok "popup binding still written despite the tab conflict" || fail "popup binding blocked by tab conflict"
grep -q 'type = "spawn_tab"' "$CONFHOME/.config/herdr/config.toml" && ok "the other owner's binding survived" || fail "existing binding clobbered"
printf '[ui.toast]\ndelivery = "off"\n' > "$SETHOME/.config/herdr/config.toml"
HOME="$SETHOME" $CH setup --yes --name smoketester >/dev/null 2>&1
grep -q 'delivery = "off"' "$SETHOME/.config/herdr/config.toml" && ok "existing [ui.toast] respected" || fail "existing [ui.toast] overwritten"
$CH doctor >/dev/null 2>&1; RC=$?
[ "$RC" = "0" ] || [ "$RC" = "1" ] && ok "doctor runs (exit $RC)" || fail "doctor crashed"
# Both bindings reported, each judged on its own config.
HOME="$SETHOME" $CH doctor 2>&1 | grep -q "chat tab keybinding bound" \
  && ok "doctor confirms a bound tab keybinding" || fail "doctor confirms a bound tab keybinding"
HOME="$CONFHOME" $CH doctor 2>&1 | grep -q "chat tab keybinding not bound" \
  && ok "doctor notes a missing tab keybinding" || fail "doctor notes a missing tab keybinding"
# A missing tab binding is a note, not a problem: it must not fail doctor on
# its own — CONFHOME has the popup binding written, so the tab line is the
# only keybinding-related difference.
HOME="$CONFHOME" $CH doctor 2>&1 | grep -q "✗.*chat tab keybinding" \
  && fail "missing tab binding rendered as a failure" || ok "missing tab binding is hint-level, not a failure"

echo "# help documents how to open the chat"
$CH help | grep -q "chatter.open-chat-tab" && ok "help names the tab action" || fail "help names the tab action"
$CH help | grep -q "placement split" && ok "help names --placement split" || fail "help names --placement split"
$CH help | grep -q "prefix+alt+t" && ok "help names the tab keybinding" || fail "help names the tab keybinding"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
