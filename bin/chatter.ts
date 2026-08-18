#!/usr/bin/env node
// Chatter: repo-scoped coordination for agents in Herdr worktrees.
// Zero-dependency: Node 22 built-in node:sqlite, talks to Herdr via its CLI.
// Entry point only — see src/ for the implementation.

import { setJsonOut, die } from '../src/util';
import { whoami } from '../src/team';
import * as c from '../src/commands';
import { cmdBoard, cmdChatView } from '../src/board';
import * as s from '../src/setup';
import { cmdUpdate } from '../src/update';
import { logoLines } from '../src/tui';
import type { Identity } from '../src/types';

type Command = (identity: Identity, args: readonly string[]) => void;
type Hook = () => void;

// Message content is sacred: commands whose args are free text never have
// flags plucked out of them. Everything else accepts --json anywhere.
const CONTENT_CMDS = new Set<CommandName>(['send', 'post', 'ask', 'answer']);

// Plugin entrypoints (run with plugin env, not by agents) and the board pane.
const HOOKS = {
  _startup: c.hookStartup, _flush: c.hookFlush, _reap: c.hookReap,
  _open_board: c.hookOpenBoard, _open_board_tab: c.hookOpenBoardTab,
  _open_chat: c.hookOpenChat, _open_chat_tab: c.hookOpenChatTab,
  _setup_action: s.hookOpenSetup, _setup_wizard: s.wizard,
  board: cmdBoard, _chat_view: cmdChatView, doctor: s.cmdDoctor,
} as const satisfies Record<string, Hook>;

const COMMANDS = {
  agents: c.cmdAgents, send: c.cmdSend, inbox: c.cmdInbox, post: c.cmdPost, chat: c.cmdChat,
  note: c.cmdNote, notes: c.cmdNotes, search: c.cmdNotes, resolve: c.cmdResolve,
  ask: c.cmdAsk, answer: c.cmdAnswer, questions: c.cmdQuestions,
  task: c.cmdTask, handoff: c.cmdHandoff,
  whoami: c.cmdWhoami, iam: c.cmdIam, log: c.cmdLog, stats: c.cmdStats,
  setup: s.cmdSetup, brief: c.cmdBrief, update: cmdUpdate,
  data: c.cmdData, purge: c.cmdPurge, spawn: c.cmdSpawn, role: c.cmdRole, forget: c.cmdForget,
} as const satisfies Record<string, Command>;
type CommandName = keyof typeof COMMANDS;

function hasOwn<Key extends PropertyKey, Value>(value: Record<Key, Value>, key: PropertyKey): key is Key {
  return Object.hasOwn(value, key);
}

function main(): void {
  const raw = process.argv.slice(2);
  const first = raw[0];
  const argv = first && hasOwn(COMMANDS, first) && CONTENT_CMDS.has(first)
    ? raw
    : raw.filter((arg) => {
      if (arg === '--json') { setJsonOut(true); return false; }
      return true;
    });
  const [cmd, ...args] = argv;

  if (cmd && hasOwn(HOOKS, cmd)) {
    HOOKS[cmd]();
    return;
  }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const helpArgs = cmd ? raw.slice(1) : [];
    if (helpArgs.some((arg) => arg !== '--all')) die('usage: chatter help [--all]');
    // Block art for a human at a terminal only: agents pipe `chatter help`
    // constantly, and a logo in their context window is pure token noise.
    if (process.stdout.isTTY) console.log(logoLines(process.stdout.columns || 100).join('\n'));
    console.log(c.help(helpArgs.includes('--all')));
    return;
  }

  if (!hasOwn(COMMANDS, cmd)) die(`unknown command "${cmd}" — try: chatter help`);
  const run = COMMANDS[cmd];

  try {
    run(whoami(), args);
  } catch (e) {
    if (process.env.CHATTER_DEBUG) throw e;
    die(`chatter: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Piggyback: any chatter activity flushes queued mail for everyone,
  // across all repos (works even when this command ran outside one).
  try { c.flushAllRepos(); } catch { /* best effort */ }
}

main();
