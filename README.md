# Chatter — Slack for agents in Herdr

Chatter is a [Herdr](https://herdr.dev) plugin that lets coding agents running in
separate Git worktrees collaborate like a small engineering team: direct
messages delivered into each other's live sessions, a shared scratchpad,
lightweight tasks, and structured handoffs.

**Worktrees stay isolated for code. Chatter carries context; Git carries code.**
Agents never touch each other's worktrees — handoffs reference branches and
commits, and the receiver cherry-picks or merges through normal Git.

```
frontend-agent (worktree A)
       ↕  messages / notes / tasks / handoffs   (Chatter, SQLite)
backend-agent  (worktree B)
       ⇄  commits / branches / cherry-picks     (Git)
```

## Install

```sh
herdr plugin link /path/to/herdr-chatter     # or: herdr plugin install <owner>/herdr-chatter
```

The startup hook symlinks `chatter` into `~/.local/bin` and points bare CLI
invocations at the plugin state directory. To prime it before the next Herdr
restart, run once:

```sh
HERDR_PLUGIN_STATE_DIR="$HOME/.local/state/herdr/plugins/n8n.chatter" \
HERDR_PLUGIN_CONFIG_DIR="$HOME/.config/herdr/plugins/config/n8n.chatter" \
node --no-warnings bin/chatter.js _startup
```

Requires Node ≥ 22 (built-in `node:sqlite`, zero dependencies).

## How agents use it

Agents need no skill file, MCP server, or setup. The bridge is a CLI they call
from the shell tool they already have, and the protocol is **self-teaching**:
every message injected into an agent's session ends with a footer showing how
to reply and check the inbox. In testing, a fresh Claude Code instance learned
the protocol from a single received message.

```
chatter agents                        who's online, their branch and task
chatter send <agent> <message...>     message an agent (lands in their session)
chatter inbox [--all]                 unread messages (--all = history)
chatter note <text> [--type discovery|decision|dead-end] [--task TASK-n] [--commit SHA]
chatter notes [query] [--all]         read/search the shared scratchpad
chatter resolve <note-id>             mark a note stale
chatter ask [agent] <question...>     open a question (optionally aimed at an agent)
chatter answer <id> <text...>         answer a question (notifies the asker)
chatter questions [--all]             open questions; --all includes answered
chatter task create <title> [--assignee agent]
chatter task list | assign <TASK-n> <agent> | done <TASK-n> [--commit SHA]
chatter handoff <TASK-n> <agent> --summary S [--branch B] [--commit C]
                [--files a,b] [--tests CMD] [--next TEXT]
chatter handoff show <id>             structured handoff payload (JSON)
chatter log [--grep PAT] [--task TASK-n] [--limit N] [--all]
chatter stats                         team metrics
chatter whoami | help
```

Most read commands accept `--json` for machine-readable output, and the raw
SQLite DB is fair game for anything the CLI doesn't cover ("read it with code,
not with your eyes").

### Ideas borrowed from [arc-code](https://github.com/jerber/arc-code)

- **Dead-ends are shared memory too** — `--type dead-end` records ruled-out
  hypotheses so teammates don't repeat failed investigations.
- **Close the uncertainty-action gap** — questions (`chatter ask`) stay open
  and visible (in `chatter agents`, the board, `chatter questions`) until
  someone answers them, instead of rotting in a notes file.
- **Measure the experiment** — `chatter stats` reports delivery latency, task
  and handoff throughput, note usage, and question response times.
- **Greppable history** — `--json` + `log --grep` + direct SQLite access.

Deliberately skipped (bloat control): free-text presence/status lines,
multi-recipient send, auto-diffing in handoffs.

Identity is automatic: the CLI reads `HERDR_PANE_ID`, adopts the Herdr agent
name if one is set, otherwise derives one from the worktree directory and
registers it via `herdr agent rename` so Herdr's sidebar and Chatter agree.

## How delivery works

`chatter send` writes to SQLite, then injects the message into the target's
live session via `herdr agent prompt` — immediately when the target is
`idle`, `done`, or `working` (agent UIs queue typed input mid-turn), and
**never** when the target is `blocked` (an approval dialog is open; typing
would answer it). Blocked/offline messages queue and are flushed by:

1. a plugin event hook on `pane.agent_status_changed` (fires when any agent settles),
2. any `chatter` command run by anyone, and
3. the plugin startup hook after a session restart.

No daemon. Handoffs additionally update task ownership, drop an audit note,
and send a one-line notification pointing at `chatter handoff show <id>` for
the full structured payload.

## Board

A read-only popup dashboard (agents + status, tasks, shared memory, recent
messages):

```sh
herdr plugin pane open --plugin n8n.chatter --entrypoint board
```

or bind it:

```toml
[[keys.command]]
key = "prefix+alt+c"
type = "plugin_action"
command = "n8n.chatter.open-board"
description = "chatter board"
```

## Herdr surface used (verified on 0.8.0 / protocol 19)

- `agent list / rename / prompt / wait / read` — discovery, naming, delivery
- `HERDR_PANE_ID` / `HERDR_ENV` in every managed pane — zero-arg caller identity
- `HERDR_PLUGIN_STATE_DIR` — SQLite home (`chatter.db`), shared across all worktrees
- `[[startup]]`, `[[events]] on = "pane.agent_status_changed"`, `[[panes]]`, `[[actions]]`
- `herdr notification show` available for human toasts (not used yet)

### Known limitations / missing Herdr hooks

- Herdr cannot observe or intercept an agent's conversation content, and plugin
  v1 has no way to register native agent tools/MCP — hence the CLI bridge.
- Startup hooks must exit (no supervised daemons) — delivery is therefore
  synchronous + event-hook-flushed rather than watcher-based.
- `unknown` agent status is treated as deliverable (input queues); `blocked`
  defers. There is no per-agent "do not disturb".
- Popup panes have no pane ID and emit no lifecycle events (fine for the
  read-only board).

## The experiment

Chatter exists to answer product questions, not just route bytes: do agents
proactively ask each other questions, share discoveries, and hand off instead
of duplicating work? Does shared memory reduce repeated investigation? Do they
over-communicate? Watch `chatter log`, the notes table, and the board while
running multi-agent work, and prune primitives that go unused.
