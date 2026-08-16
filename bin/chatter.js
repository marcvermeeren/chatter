#!/usr/bin/env node
'use strict';
// Chatter: Slack + shared memory for coding agents in Herdr worktrees.
// Zero-dependency: Node 22 built-in node:sqlite, talks to Herdr via its CLI.
// Entry point only — see src/ for the implementation.

const { setJsonOut, die } = require('../src/util');
const { whoami } = require('../src/team');
const c = require('../src/commands');
const { cmdBoard, cmdChatView } = require('../src/board');
const s = require('../src/setup');

// Message content is sacred: commands whose args are free text never have
// flags plucked out of them. Everything else accepts --json anywhere.
const raw = process.argv.slice(2);
const CONTENT_CMDS = new Set(['send', 'post', 'ask', 'answer']);
const argv = CONTENT_CMDS.has(raw[0]) ? raw : raw.filter((a) => {
  if (a === '--json') { setJsonOut(true); return false; }
  return true;
});
const [cmd, ...args] = argv;

// Plugin entrypoints (run with plugin env, not by agents) and the board pane.
const HOOKS = {
  _startup: c.hookStartup, _flush: c.hookFlush,
  _open_board: c.hookOpenBoard, _open_chat: c.hookOpenChat,
  _setup_action: s.hookOpenSetup, _setup_wizard: s.wizard,
  board: cmdBoard, _chat_view: cmdChatView, doctor: s.cmdDoctor,
};
if (Object.hasOwn(HOOKS, cmd ?? '')) { HOOKS[cmd](); return; }

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(c.help()); return; }

const COMMANDS = {
  agents: c.cmdAgents, send: c.cmdSend, inbox: c.cmdInbox, post: c.cmdPost, chat: c.cmdChat,
  note: c.cmdNote, notes: c.cmdNotes, search: c.cmdNotes, resolve: c.cmdResolve,
  ask: c.cmdAsk, answer: c.cmdAnswer, questions: c.cmdQuestions,
  task: c.cmdTask, handoff: c.cmdHandoff,
  whoami: c.cmdWhoami, iam: c.cmdIam, log: c.cmdLog, stats: c.cmdStats,
  setup: s.cmdSetup, brief: c.cmdBrief,
  data: c.cmdData, purge: c.cmdPurge, spawn: c.cmdSpawn, role: c.cmdRole,
};
const run = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : null;
if (!run) die(`unknown command "${cmd}" — try: chatter help`);

try {
  run(whoami(), args);
} catch (e) {
  if (process.env.CHATTER_DEBUG) throw e;
  die(`chatter: ${e.message}`);
}
// Piggyback: any chatter activity flushes queued mail for everyone,
// across all repos (works even when this command ran outside one).
try { c.flushAllRepos(); } catch { /* best effort */ }
