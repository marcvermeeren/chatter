"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_test_1 = __importDefault(require("node:test"));
const board_1 = require("../src/board");
const db_1 = require("../src/db");
const herdr_1 = require("../src/herdr");
const setup_1 = require("../src/setup");
const update_1 = require("../src/update");
const tui_1 = require("../src/tui");
(0, node_test_1.default)('terminal sanitization removes controls but preserves newlines', () => {
    strict_1.default.equal((0, tui_1.clean)('hello\x1b[31m red\r\nnext\x07'), 'hello[31m red\nnext');
});
(0, node_test_1.default)('wrapping and visible width handle ANSI independently', () => {
    strict_1.default.deepEqual((0, tui_1.wrap)('one two three', 7), ['one two', 'three']);
    strict_1.default.equal((0, tui_1.visWidth)('\x1b[1mhello\x1b[0m'), 5);
    strict_1.default.equal((0, tui_1.stripAnsi)('\x1b[1mhello\x1b[0m'), 'hello');
});
(0, node_test_1.default)('agent avatars are curated, fixed-width, and deterministic', () => {
    strict_1.default.equal(tui_1.AGENT_FACES.length, 32);
    strict_1.default.equal(new Set(tui_1.AGENT_FACES).size, tui_1.AGENT_FACES.length);
    for (const face of tui_1.AGENT_FACES) {
        strict_1.default.match(face, /^[\x20-\x7e]{5}$/);
        strict_1.default.equal((0, tui_1.visWidth)(face), 5);
    }
    strict_1.default.equal((0, tui_1.agentFace)('codex'), (0, tui_1.agentFace)('codex'));
    strict_1.default.ok(new Set(['codex', 'claude', 'pi', 'opencode', 'gemini', 'cursor']
        .map(tui_1.agentFace)).size >= 4);
});
(0, node_test_1.default)('agent avatars reuse the existing author color and remain legible without ANSI', () => {
    const name = 'codex';
    strict_1.default.ok((0, tui_1.agentAvatar)(name).startsWith((0, tui_1.fg)((0, tui_1.authorHue)(name))));
    strict_1.default.equal((0, tui_1.stripAnsi)((0, tui_1.agentAvatar)(name)), (0, tui_1.agentFace)(name));
    strict_1.default.equal((0, tui_1.stripAnsi)((0, tui_1.authorWithAvatar)(name)), `${(0, tui_1.agentFace)(name)} ${name}`);
    strict_1.default.equal((0, tui_1.visWidth)((0, tui_1.authorWithAvatar)(name)), 5 + 1 + name.length);
});
(0, node_test_1.default)('board roster and chat headers render the assigned avatar', () => {
    strict_1.default.equal((0, tui_1.stripAnsi)((0, board_1.rosterIdentity)('codex', 'frontend')), `${(0, tui_1.agentFace)('codex')} frontend · @codex`);
    const message = {
        id: 1,
        from_agent: 'codex',
        to_agent: '#chat',
        body: 'deploy is green',
        kind: 'chat',
        ref_id: null,
        created_at: '2026-01-01 09:41:00',
        delivered_at: null,
        read_at: null,
    };
    const rendered = (0, board_1.buildFeedLines)([message], 80, 'marc', 0).map(tui_1.stripAnsi);
    strict_1.default.ok(rendered.some((line) => line.startsWith(`  ${(0, tui_1.agentFace)('codex')} codex · `)));
});
(0, node_test_1.default)('raw terminal keys decode into an explicit union', () => {
    strict_1.default.deepEqual((0, tui_1.decodeKey)('\x1b[A'), { type: 'up' });
    strict_1.default.deepEqual((0, tui_1.decodeKey)('x'), { type: 'text', text: 'x' });
    strict_1.default.deepEqual((0, tui_1.decodeKey)('toString'), { type: 'text', text: 'toString' });
    strict_1.default.deepEqual((0, tui_1.decodeKey)('\x1b[99~'), { type: 'other' });
});
(0, node_test_1.default)('setup and chat wizard state transitions stay explicit', () => {
    strict_1.default.equal((0, setup_1.nextSetupStep)(0), 1);
    strict_1.default.equal((0, setup_1.nextSetupStep)(1), 2);
    strict_1.default.equal((0, setup_1.nextSetupStep)(2), 3);
    strict_1.default.equal((0, setup_1.nextSetupStep)(3), 4);
    strict_1.default.equal((0, setup_1.nextSetupStep)(4), 5);
    strict_1.default.equal((0, setup_1.nextSetupStep)(5), 6);
    strict_1.default.equal((0, board_1.nextWizardStep)('handle'), 'kind');
    strict_1.default.equal((0, board_1.nextWizardStep)('kind'), 'setup');
    strict_1.default.equal((0, board_1.nextWizardStep)('setup', { tab: false }), 'branch');
    strict_1.default.equal((0, board_1.nextWizardStep)('setup', { tab: true }), 'purpose');
    strict_1.default.equal((0, board_1.nextWizardStep)('purpose', { mode: 'spawn' }), 'confirm');
    strict_1.default.equal((0, board_1.nextWizardStep)('purpose', { mode: 'team' }), 'more');
});
(0, node_test_1.default)('Escape closes popups but only unwinds or hints in persistent chat panes', () => {
    strict_1.default.equal((0, board_1.chatEscapeAction)(false), 'close');
    strict_1.default.equal((0, board_1.chatEscapeAction)(true, { transient: true }), 'clear-transient');
    strict_1.default.equal((0, board_1.chatEscapeAction)(true), 'persistent-hint');
    strict_1.default.equal((0, board_1.chatEscapeAction)(true, { wizard: true }), 'cancel-wizard');
});
(0, node_test_1.default)('view header names only its repository', () => {
    const header = (0, tui_1.stripAnsi)((0, board_1.headerBar)('/state/repos/alpha-11111111/chatter.db', 80));
    strict_1.default.match(header, /#alpha/);
    strict_1.default.doesNotMatch(header, /\[\d+ /);
});
(0, node_test_1.default)('board is a compact overview ordered by agents, tasks, questions, then memory', (t) => {
    const dir = node_fs_1.default.mkdtempSync(node_path_1.default.join(node_os_1.default.tmpdir(), 'chatter-board-'));
    t.after(() => node_fs_1.default.rmSync(dir, { recursive: true, force: true }));
    const file = node_path_1.default.join(dir, 'chatter.db');
    const d = (0, db_1.openDbFile)(file);
    d.prepare("INSERT INTO messages (from_agent, to_agent, body, kind, created_at) VALUES ('marc', '#chat', 'chat belongs elsewhere', 'chat', '2026-01-01 00:00:00')").run();
    d.prepare("INSERT INTO notes (author, type, text, status, created_at) VALUES ('marc', 'question', 'question details stay out of the board', 'active', '2026-01-01 00:00:00')").run();
    d.prepare("INSERT INTO notes (author, type, text, status, created_at) VALUES ('marc', 'decision', 'keep the board compact', 'active', '2026-01-01 00:00:01')").run();
    const lines = (0, board_1.renderBoard)(d, file).map(tui_1.stripAnsi);
    const agents = lines.findIndex((line) => line.trim() === 'Agents');
    const tasks = lines.findIndex((line) => line.trim() === 'Tasks');
    const questions = lines.findIndex((line) => line.trim() === 'Open questions  1');
    const memory = lines.findIndex((line) => line.trim() === 'Shared memory');
    strict_1.default.ok(agents < tasks && tasks < questions && questions < memory);
    strict_1.default.ok(lines.some((line) => line.includes('keep the board compact')));
    strict_1.default.ok(lines.every((line) => !line.includes('Group chat')));
    strict_1.default.ok(lines.every((line) => !line.includes('chat belongs elsewhere')));
    strict_1.default.ok(lines.every((line) => !line.includes('question details stay out of the board')));
});
(0, node_test_1.default)('plugin views require an explicit focused repository context', () => {
    strict_1.default.equal((0, board_1.pluginContextCwd)('{}'), null);
    strict_1.default.equal((0, board_1.pluginContextCwd)('not-json'), null);
    strict_1.default.equal((0, board_1.pluginContextCwd)('{"focused_pane_cwd":"/repo/one"}'), '/repo/one');
    strict_1.default.equal((0, board_1.pluginContextCwd)('{"workspace_cwd":"/repo/two","focused_pane_cwd":"/repo/one"}'), '/repo/one');
    strict_1.default.equal((0, board_1.pluginContextCwd)('{"worktree":{"checkout_path":"/repo/three"},"workspace_cwd":"/repo/two"}'), '/repo/two');
    strict_1.default.deepEqual((0, herdr_1.pluginInvocationContext)('{"workspace_id":"w4","focused_pane_id":"w4:p2","focused_pane_cwd":"/repo/one"}'), { workspaceId: 'w4', focusedPaneId: 'w4:p2', cwd: '/repo/one' });
});
(0, node_test_1.default)('explicit pane repository anchors win and invalid plugin context fails closed', () => {
    const context = '{"focused_pane_cwd":"/repo/context"}';
    strict_1.default.equal((0, board_1.viewRepoCwd)('/repo/anchor', context, '/plugin/root'), '/repo/anchor');
    strict_1.default.equal((0, board_1.viewRepoCwd)('', context, '/plugin/root'), null);
    strict_1.default.equal((0, board_1.viewRepoCwd)(undefined, context, '/plugin/root'), '/repo/context');
    strict_1.default.equal((0, board_1.viewRepoCwd)(undefined, '{}', '/plugin/root'), null);
    strict_1.default.equal((0, board_1.viewRepoCwd)(undefined, undefined, '/direct/repo'), '/direct/repo');
});
(0, node_test_1.default)('update helpers preserve the manifest and unsupported-source behavior', () => {
    strict_1.default.match((0, update_1.manifestVersion)(process.cwd()) ?? '', /^\d+\.\d+\.\d+$/);
    strict_1.default.deepEqual((0, update_1.runUpdate)({ source: {}, root: process.cwd() }), {
        ok: false,
        lines: [
            'chatter is not registered with Herdr',
            'install it:  herdr plugin install <owner>/<repo>',
            'or link this checkout:  herdr plugin link <path>',
        ],
    });
});
