#!/usr/bin/env node
"use strict";
// Chatter: repo-scoped coordination for agents in Herdr worktrees.
// Zero-dependency: Node 22 built-in node:sqlite, talks to Herdr via its CLI.
// Entry point only — see src/ for the implementation.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const util_1 = require("../src/util");
const team_1 = require("../src/team");
const c = __importStar(require("../src/commands"));
const board_1 = require("../src/board");
const s = __importStar(require("../src/setup"));
const update_1 = require("../src/update");
const tui_1 = require("../src/tui");
// Message content is sacred: commands whose args are free text never have
// flags plucked out of them. Everything else accepts --json anywhere.
const CONTENT_CMDS = new Set(['send', 'post', 'ask', 'answer']);
// Plugin entrypoints (run with plugin env, not by agents) and the board pane.
const HOOKS = {
    _startup: c.hookStartup, _flush: c.hookFlush, _reap: c.hookReap,
    _open_board: c.hookOpenBoard, _open_board_tab: c.hookOpenBoardTab,
    _open_chat: c.hookOpenChat, _open_chat_tab: c.hookOpenChatTab,
    _setup_action: s.hookOpenSetup, _setup_wizard: s.wizard,
    board: board_1.cmdBoard, _chat_view: board_1.cmdChatView, doctor: s.cmdDoctor,
};
const COMMANDS = {
    agents: c.cmdAgents, send: c.cmdSend, inbox: c.cmdInbox, post: c.cmdPost, chat: c.cmdChat,
    note: c.cmdNote, notes: c.cmdNotes, search: c.cmdNotes, resolve: c.cmdResolve,
    ask: c.cmdAsk, answer: c.cmdAnswer, questions: c.cmdQuestions,
    task: c.cmdTask, handoff: c.cmdHandoff,
    whoami: c.cmdWhoami, iam: c.cmdIam, log: c.cmdLog, stats: c.cmdStats,
    setup: s.cmdSetup, brief: c.cmdBrief, update: update_1.cmdUpdate,
    data: c.cmdData, purge: c.cmdPurge, spawn: c.cmdSpawn, role: c.cmdRole, forget: c.cmdForget,
};
function hasOwn(value, key) {
    return Object.hasOwn(value, key);
}
function main() {
    const raw = process.argv.slice(2);
    const first = raw[0];
    const argv = first && hasOwn(COMMANDS, first) && CONTENT_CMDS.has(first)
        ? raw
        : raw.filter((arg) => {
            if (arg === '--json') {
                (0, util_1.setJsonOut)(true);
                return false;
            }
            return true;
        });
    const [cmd, ...args] = argv;
    if (cmd && hasOwn(HOOKS, cmd)) {
        HOOKS[cmd]();
        return;
    }
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
        const helpArgs = cmd ? raw.slice(1) : [];
        if (helpArgs.some((arg) => arg !== '--all'))
            (0, util_1.die)('usage: chatter help [--all]');
        // Block art for a human at a terminal only: agents pipe `chatter help`
        // constantly, and a logo in their context window is pure token noise.
        if (process.stdout.isTTY)
            console.log((0, tui_1.logoLines)(process.stdout.columns || 100).join('\n'));
        console.log(c.help(helpArgs.includes('--all')));
        return;
    }
    if (!hasOwn(COMMANDS, cmd))
        (0, util_1.die)(`unknown command "${cmd}" — try: chatter help`);
    const run = COMMANDS[cmd];
    try {
        run((0, team_1.whoami)(), args);
    }
    catch (e) {
        if (process.env.CHATTER_DEBUG)
            throw e;
        (0, util_1.die)(`chatter: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Piggyback: any chatter activity flushes queued mail for everyone,
    // across all repos (works even when this command ran outside one).
    try {
        c.flushAllRepos();
    }
    catch { /* best effort */ }
}
main();
