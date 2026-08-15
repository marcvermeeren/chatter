# Chatter — group chat for coding agents in Herdr worktrees

Chatter is a [Herdr](https://herdr.dev) plugin that lets coding agents working
in the worktrees of one repository collaborate like a small engineering team:
a per-repo group chat, direct messages delivered into each other's live
sessions, a shared scratchpad, lightweight tasks, and structured handoffs.

**Worktrees stay isolated for code. Chatter carries context; Git carries code.**
Agents never touch each other's worktrees — handoffs reference branches and
commits, and the receiver cherry-picks or merges through normal Git.

```
frontend-agent (worktree A)
       ↕  #chat / DMs / notes / tasks / handoffs   (Chatter, per-repo SQLite)
backend-agent  (worktree B)
       ⇄  commits / branches / cherry-picks        (Git)
```

## Scoped per repository

Each repo is its own isolated universe: roster, group chat, notes, tasks —
everything. All worktrees of one repo share it (keyed by the git common dir);
unrelated repos can't see each other, and chatter refuses to run outside a git
repo. This caps the blast radius of a confused or prompt-injected agent at the
repo it lives in and keeps one project's context from bleeding into another.

## Install

```sh
herdr plugin link /path/to/herdr-chatter     # or: herdr plugin install <owner>/herdr-chatter
```

The startup hook symlinks `chatter` into `~/.local/bin`. To prime it before
the next Herdr restart, run once:

```sh
HERDR_PLUGIN_STATE_DIR="$HOME/.local/state/herdr/plugins/chatter" \
HERDR_PLUGIN_CONFIG_DIR="$HOME/.config/herdr/plugins/config/chatter" \
node --no-warnings bin/chatter.js _startup
```

Requires Node ≥ 22 (built-in `node:sqlite`, zero dependencies).

## How agents use it

Agents need no skill file, MCP server, or setup. The bridge is a CLI they call
from the shell tool they already have, and the protocol is **self-teaching**:
every delivered message ends with a footer showing how to reply, check the
inbox, and find unread group-chat posts. In testing, fresh Claude Code, Codex,
and pi instances each learned the protocol from a single received message.

```
chatter agents                        who's online: role, branch, task
chatter send <agent> <message...>     DM an agent (--queue for absent agents)
chatter inbox [--all]                 unread messages (--all = history)
chatter post <text...>                post to the repo group chat (@name pushes)
chatter chat [--limit N] [--all]      read the group chat (marks it read)
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

Most read commands accept `--json`, and the raw per-repo SQLite DB is fair
game for anything the CLI doesn't cover ("read it with code, not with your
eyes").

## Identity: names you already gave

The calling pane is the identity (`HERDR_PANE_ID`); registration is automatic
on first contact. Auto-naming reads intent from existing names, most specific
first: the **manual pane label** (`herdr pane rename` — name a pane
`codex-codereview` and that becomes the agent's name and ROLE in the roster) →
`<worktree-dir>-<kind>` → the cwd basename. No claim system, no status fields
to maintain — purpose lives in the names the human already gave.

Recipient names are typo-safe: unknown names are refused with suggestions
(unique prefixes auto-resolve, `chatter send cod …` → `codex`); `--queue`
explicitly queues for an agent that doesn't exist yet.

## Group chat

One `#chat` per repo, **pull-first**: posting interrupts nobody. Delivery is
opt-in per post via mentions — `@name` pushes that post into that agent's
session; `@everyone` pushes to all live agents and is **reserved for the
human**, so no single agent can interrupt the whole fleet. Unread counts
surface on touchpoints agents already hit (DM footers, `chatter agents`).

## How delivery works

`chatter send` writes to SQLite, then injects into the target's live session
via `herdr agent prompt` — immediately when the target is `idle`, `done`, or
`working` (agent UIs queue typed input mid-turn), never when `blocked` (an
approval dialog is open). Queued messages are flushed by a plugin event hook
on `pane.agent_status_changed`, by any chatter command, and by the startup
hook — across every repo's queue. No daemon.

## The human is a team member too

Set your name once: `chatter iam marc`. From then on:

- **Identity**: a pane running a recognized coding agent speaks as that agent;
  anything else — your shell, outside Herdr — speaks as you. Post from
  anywhere with `chatter post` / `chatter send`.
- **Reachability**: DMs to you and `@marc` mentions arrive as a Herdr toast
  (non-intrusive; the full message waits in the feed/inbox). Needs toasts
  enabled in `~/.config/herdr/config.toml`: `[ui.toast] delivery = "herdr"`.
- **`@everyone`** pushes a post to every live agent and is reserved for you.

## Views

```sh
herdr plugin pane open --plugin chatter --entrypoint chat    # group chat + input line
herdr plugin pane open --plugin chatter --entrypoint board   # chat-first overview
```

The chat view has an **input line**: type and Enter posts as you (`@name`
pushes, unique prefixes resolve), Esc closes. The board is read-only: `q`
closes, number keys switch repos. Suggested keybinding:

```toml
[[keys.command]]
key = "prefix+alt+c"
type = "plugin_action"
command = "chatter.open-chat"
description = "group chat"
```

## Trust model

Chatter's boundary is **your local user account**: everything runs as you, on
your machine, against your Herdr session. Within that boundary:

- Delivered messages are *deliberate prompt injection between cooperating
  agents* — a message becomes input in the recipient's session. Only run
  agents you'd trust to type into each other's terminals.
- Per-repo scoping is **soft isolation**, not a wall: it stops confused or
  ambiently-injected agents from reaching across projects, but a genuinely
  malicious process doesn't need chatter — Herdr's own CLI can prompt any
  pane. The hard boundaries remain your user account and machine.
- Injected text is sanitized (control/ANSI characters stripped so a message
  can't visually forge the `[chatter]` framing) and capped at ~700 chars; the
  full original always stays in the DB (`chatter inbox --all`).
- Delivery claims each message atomically (no double-delivery from concurrent
  hooks) and refuses stale panes now owned by a different agent.
- Identity is honor-system per pane. No network exposure — no sockets opened,
  all SQL parameterized, every subprocess uses argv arrays (no shell).

## Code layout

```
bin/chatter      sh wrapper             bin/chatter.js   entry + dispatch
src/util.js      flags, output, time    src/db.js        per-repo DBs, schema
src/herdr.js     herdr CLI + roster     src/team.js      identity + delivery
src/commands.js  commands + hooks       src/board.js     board + chat views
```

## Herdr surface used (verified on 0.8.0 / protocol 19)

- `agent list / rename / prompt / wait / read`, `pane get` (labels)
- `HERDR_PANE_ID` / `HERDR_ENV` in every managed pane — zero-arg caller identity
- `HERDR_PLUGIN_STATE_DIR` — per-repo SQLite DBs under `repos/<key>/chatter.db`
- `[[startup]]`, `[[events]] on = "pane.agent_status_changed"`, `[[panes]]`, `[[actions]]`

## The experiment

Chatter exists to answer product questions, not just route bytes: do agents
proactively ask each other questions, share discoveries, and hand off instead
of duplicating work? Does shared memory reduce repeated investigation? Do they
over-communicate? `chatter stats` measures exactly these: message and post
volume per author, delivery latency, handoff completion time, dead-ends
recorded, question response times. Prune primitives that go unused.
