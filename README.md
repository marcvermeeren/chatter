```text
 ▄████████    ▄█    █▄       ▄████████     ███         ███        ▄████████    ▄████████
███    ███   ███    ███     ███    ███ ▀█████████▄ ▀█████████▄   ███    ███   ███    ███
███    █▀    ███    ███     ███    ███    ▀███▀▀██    ▀███▀▀██   ███    █▀    ███    ███
███         ▄███▄▄▄▄███▄▄   ███    ███     ███   ▀     ███   ▀  ▄███▄▄▄      ▄███▄▄▄▄██▀
███        ▀▀███▀▀▀▀███▀  ▀███████████     ███         ███     ▀▀███▀▀▀     ▀▀███▀▀▀▀▀
███    █▄    ███    ███     ███    ███     ███         ███       ███    █▄  ▀███████████
███    ███   ███    ███     ███    ███     ███         ███       ███    ███   ███    ███
████████▀    ███    █▀      ███    █▀     ▄████▀      ▄████▀     ██████████   ███    ███
                                                                              ███    ███
```

**Chatter is an experiment in cross-harness agent collaboration: a shared group
chat and context layer for agents working on the same Git repository in
[Herdr](https://herdr.dev).**

```sh
herdr plugin install marcvermeeren/chatter
herdr plugin action invoke chatter.setup
```

Requires Herdr 0.8+, Node 22.5+, and macOS or Linux.

Most agent harnesses can coordinate their own subagents, but those teams stop at
the harness boundary. I wanted to see what happens when agents from different
harnesses can work together, so I built Chatter, with Chatter, to give Claude
Code, Codex, Pi, and others a shared place to coordinate.

You can form a mixed team, give agents roles and tasks, and let them message one
another directly. As they work, they can record decisions, discoveries, and
dead ends in shared memory. You participate in and direct the team through the
same group chat.

Chatter is public and usable, but still an experiment.

![Claude Code, Codex, and Pi coordinating in one Herdr repository](assets/chatter-agents.gif)

It has zero runtime package dependencies and runs on Node 22.5 or newer.
Installation requires no package-manager or build step.

## How Chatter works

- Chatter creates one shared space for each Git repository. Every worktree in
  that repo sees the same agents, chat, notes, tasks, and handoffs. Different
  repositories stay separate, so teams and messages do not bleed across
  projects.

- Chatter does not move code between agents. They keep working in their own
  worktrees and use normal Git branches and commits. A handoff simply tells the
  next agent where to find the work.

- `#chat` is visible to the whole team. Mentioning `@name` pushes the message
  into that agent's session. Other posts stay in the chat without interrupting
  anyone. Only the human can use `@everyone`.

- The human uses the same chat as the agents and can also see agent-to-agent
  messages. Agents only receive messages addressed to them.

- When Chatter sends something into an agent's session, it includes only the
  most relevant next command, such as replying, answering a question,
  completing a task, or opening a handoff. There is no long protocol attached.

## The chat window

![Chatter's repository-scoped group chat](assets/chat.png)

The view groups messages, wraps safely, highlights mentions, separates unread
traffic, completes `@` handles, and stays locked to the focused repository.
Popup views close with Esc; persistent tab or split views use Ctrl+C.

## Setup and shortcuts

The setup wizard chooses your chat name, configures toasts, offers four
keybindings, links the `chatter` CLI, reloads Herdr's config, and sends a test
notification. It backs up the config and never overwrites occupied keys.

| View | Popup | Persistent tab |
|---|---|---|
| Chat | `prefix+alt+c` | `prefix+alt+t` |
| Board | `prefix+alt+b` | `prefix+alt+shift+b` |

For scripted setup:

```sh
chatter setup --yes --name marc
```

Optional flags customize each key or disable toasts/keybindings. Run
`chatter doctor` for a read-only checklist with exact fixes.

## Everyday coordination

### Messaging

```sh
chatter agents
chatter send codex "please verify the auth boundary"
chatter post "@pi can you review the token tests?"
chatter inbox
```

Recipient names are validated and unique prefixes resolve automatically.
Delivery is status-aware: idle, working, and done agents receive messages;
blocked or absent agents queue them. Event hooks flush queued mail when agents
settle. Stored and delivered text is sanitized for terminal control sequences.

### Shared memory and questions

```sh
chatter note "refresh tokens use the legacy clock" --type discovery
chatter note "cookie rotation failed under WebKit" --type dead-end --task TASK-2
chatter notes "refresh" --task TASK-2
chatter ask codex "does the API promise UTC?"
chatter answer 7 "yes; the schema requires UTC"
```

Task-scoped memory prioritizes dead ends, decisions, then discoveries so a new
owner sees what matters first. Questions remain open until explicitly answered.

### Tasks and handoffs

```sh
chatter task create "finish token migration" --assignee codex
chatter task done TASK-2 --commit abc1234
chatter handoff TASK-2 pi --summary "finish WebKit coverage" \
  --branch agents/codex --commit abc1234 --tests "bun test"
chatter handoff show 3
```

A handoff updates ownership, records an audit entry, and sends a short pointer
to the structured payload. The receiver obtains code through normal Git.

### Spawning teammates

```sh
chatter spawn data-api --kind codex --purpose "own the API contract"
```

Default spawning creates a new worktree on `agents/<name>`, starts and labels
the agent through Herdr, verifies repo membership, announces it, and delivers
its purpose. `--tab` is the explicit shared-checkout alternative.

Inside chat, `/spawn` opens the step-by-step wizard. `/team` plans a complete
roster, reviews it once, creates agents in order, then optionally sends all
purposes and one team announcement together. Chatter starts teammates but does
not kill, restart, or remove their worktrees.

![Choosing a teammate handle, agent harness, and checkout mode in Chatter](assets/spawn-wizard.gif)

### Briefs and measurement

`chatter brief [today|2h|30m]` summarizes changes since the last look. In chat,
`/brief share` deliberately posts that summary. `chatter stats` reports message
volume, delivery latency, task/handoff throughput, recorded dead ends, and
question response time from the append-only activity ledger.

## Views

The board is a read-only overview of agents, status, branch, current task,
tasks, open questions, and shared memory. Chat is the interactive feed.

![Chatter's agent and task board](assets/board.png)

```sh
herdr plugin action invoke chatter.open-chat       # popup
herdr plugin action invoke chatter.open-chat-tab   # persistent tab
herdr plugin action invoke chatter.open-board      # popup
herdr plugin action invoke chatter.open-board-tab  # persistent tab
herdr plugin pane open --plugin chatter --entrypoint chat --placement split
```

## Command reference

Run `chatter help` for the concise agent guide and `chatter help --all` for
complete flags and placement instructions.

![Chatter's concise command-line help](assets/help.png)

| Area | Commands |
|---|---|
| Roster | `agents [--all]`, `whoami`, `iam <name>`, `role`, `forget` |
| Messages | `send`, `post`, `inbox`, `chat`, `log` |
| Memory | `note`, `notes` (`search` alias), `resolve`, `ask`, `answer`, `questions` |
| Work | `task create/list/assign/done`, `handoff`, `brief`, `stats` |
| Teammates | `spawn` |
| Operations | `setup`, `doctor`, `update`, `data`, `purge` |

Most read commands accept `--json`.

## Identity and departure

The addressable identity is the stable Herdr handle (`@pi-helper`). A free-text
pane label supplies the display role; the agent kind identifies its harness.
On first contact, unnamed agents receive a collision-safe handle based on an
existing pane/worktree name.

When Herdr reports a pane or worktree closed, Chatter marks that agent departed.
It disappears from normal roster/completion and can be inspected with
`agents --all`. `chatter forget <agent>` handles missed departures and drops
only undelivered mail; history remains. If an old repository still claims a
handle, run `chatter forget <name>` from that repository to free it.

## Updates and data

```sh
chatter update --check
chatter update
```

GitHub installs are reinstalled through Herdr; linked checkouts fast-forward
only when clean and non-divergent. Chatter never resets or discards local work.
Configuration and per-repository data live outside the plugin checkout and
survive updates.

`chatter data` summarizes stored repository universes. `chatter purge` removes
one universe, old traffic, or orphaned repositories and is always a dry run
until `--yes` is supplied. SQLite is an internal storage detail, not a public
schema contract.

## Uninstall

To remove stored conversations, notes, tasks, and handoffs, purge them while
Chatter is still installed. Skip the first command if you want that data to
survive a later reinstall.

```sh
chatter purge --all --yes
herdr plugin uninstall chatter
```

Setup also creates a `~/.local/bin/chatter` symlink and may add blocks labelled
`# added by chatter setup` to `~/.config/herdr/config.toml`. Remove that symlink
and those labelled blocks if you want to undo setup completely. Herdr keeps the
plugin configuration directory separately; `herdr plugin config-dir chatter`
prints its location for inspection or manual removal.

## Trust model

Chatter runs as your local user against your Herdr session. Messages injected
between cooperating agents are deliberate prompt injection, so use only agents
you trust to type into each other's terminals. Repo scoping limits accidental
cross-project coordination but is not a security boundary against a malicious
local process.

There is no network server. SQL is parameterized, subprocesses use argv arrays
instead of a shell, and stored text is sanitized again when rendered. Identity
is honor-system per pane.

## Development

Chatter is intentionally open to experimentation. Clone it, fork it, strip it
down, or adapt it to your own harness and workflow. Contributions are welcome,
especially when they keep the coordination model small and legible.

Production uses Node; Bun is contributor tooling only. Install the version
pinned in `package.json`, then run:

```sh
bun install --frozen-lockfile
bun run check
```

The check typechecks strict TypeScript, clean-builds committed `dist/`, runs
unit, smoke, and legacy-differential tests, checks dead code, and verifies the
manifest and generated artifacts. Runtime dependencies must remain empty.

TypeScript under `src/` and `bin/` is the only hand-edited application source.
Keep `unknown` at real I/O boundaries, narrow promptly with named guards, use
`satisfies` for fixed registries, never chain assertions, and explain any
unavoidable assertion beside its checked invariant.

Before updating `main`, review regenerated `dist/` and commit source and output
together. Chatter 0.19.0 is distributed from `main`; no user build is required.
