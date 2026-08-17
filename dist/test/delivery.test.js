"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const node_test_1 = __importDefault(require("node:test"));
const db_1 = require("../src/db");
const team_1 = require("../src/team");
function fixture(t) {
    const dir = (0, node_fs_1.mkdtempSync)(node_path_1.default.join((0, node_os_1.tmpdir)(), 'chatter-delivery-'));
    t.after(() => (0, node_fs_1.rmSync)(dir, { recursive: true, force: true }));
    return (0, db_1.openDbFile)(node_path_1.default.join(dir, 'chatter.db'));
}
const message = (overrides = {}) => ({
    id: 10,
    from_agent: 'marc',
    to_agent: 'alpha',
    body: 'please take a look',
    kind: 'chat',
    ref_id: null,
    ...overrides,
});
function recordPriorDelivery(d) {
    d.prepare(`INSERT INTO messages
    (id, from_agent, to_agent, body, kind, created_at, delivered_at)
    VALUES (1, 'marc', 'alpha', 'earlier', 'chat', '2026-01-01', '2026-01-01')`).run();
}
(0, node_test_1.default)('DM footer teaches one private reply and help only on first contact', (t) => {
    const d = fixture(t);
    strict_1.default.equal((0, team_1.formatDelivery)(message(), d), '[chatter] message from marc: please take a look\n'
        + '(reply: chatter send marc "..." · new here: chatter help)');
    recordPriorDelivery(d);
    strict_1.default.equal((0, team_1.formatDelivery)(message({ id: 11 }), d), '[chatter] message from marc: please take a look\n(reply: chatter send marc "...")');
    strict_1.default.equal((0, team_1.formatDelivery)(message({ id: 12, body: 'Use chatter send marc "ok"' }), d), '[chatter] message from marc: Use chatter send marc "ok"');
});
(0, node_test_1.default)('#chat mentions teach only a public reply', (t) => {
    const d = fixture(t);
    recordPriorDelivery(d);
    strict_1.default.equal((0, team_1.formatDelivery)(message({ kind: 'mention', ref_id: 'p4' }), d), '[chatter] #chat mention from marc: please take a look\n'
        + '(reply: chatter post "@marc ...")');
});
(0, node_test_1.default)('only active questions receive the answer command', (t) => {
    const d = fixture(t);
    recordPriorDelivery(d);
    d.prepare(`INSERT INTO notes (id, author, type, text, status, created_at)
    VALUES (7, 'marc', 'question', 'ship it?', 'active', '2026-01-01')`).run();
    const question = message({
        kind: 'system', ref_id: 'q7',
        body: 'question #7: ship it? (answer with: chatter answer 7 "...")',
    });
    strict_1.default.equal((0, team_1.formatDelivery)(question, d), '[chatter] message from marc: question #7: ship it?\n(answer: chatter answer 7 "...")');
    d.prepare("UPDATE notes SET status = 'resolved' WHERE id = 7").run();
    strict_1.default.equal((0, team_1.formatDelivery)(message({ kind: 'system', ref_id: 'q7', body: 'answer recorded' }), d), '[chatter] message from marc: answer recorded');
});
(0, node_test_1.default)('task assignments mention completion and only existing active memory', (t) => {
    const d = fixture(t);
    recordPriorDelivery(d);
    const assignment = message({
        kind: 'system', ref_id: 'TASK-3',
        body: 'you were assigned TASK-3: fix auth (details: chatter task list)',
    });
    d.prepare(`INSERT INTO notes (author, type, text, task_id, status, created_at)
    VALUES ('marc', 'decision', 'stale context', 'TASK-3', 'superseded', '2026-01-01')`).run();
    strict_1.default.equal((0, team_1.formatDelivery)(assignment, d), '[chatter] message from marc: you were assigned TASK-3: fix auth\n'
        + '(done: chatter task done TASK-3)');
    d.prepare(`INSERT INTO notes (author, type, text, task_id, status, created_at)
    VALUES ('marc', 'note', 'prior context', 'TASK-3', 'active', '2026-01-01')`).run();
    strict_1.default.equal((0, team_1.formatDelivery)(assignment, d), '[chatter] message from marc: you were assigned TASK-3: fix auth\n'
        + '(done: chatter task done TASK-3 · memory: chatter notes --task TASK-3)');
});
(0, node_test_1.default)('handoffs flag only task-linked active decisions and dead ends', (t) => {
    const d = fixture(t);
    recordPriorDelivery(d);
    d.prepare(`INSERT INTO handoffs (id, task_id, from_agent, to_agent, summary, status, created_at)
    VALUES (4, 'TASK-8', 'marc', 'alpha', 'continue', 'pending', '2026-01-01')`).run();
    const handoff = message({
        kind: 'handoff', ref_id: 'h4',
        body: 'TASK-8 continue | full details: chatter handoff show 4',
    });
    d.prepare(`INSERT INTO notes (author, type, text, task_id, status, created_at)
    VALUES ('marc', 'decision', 'obsolete', 'TASK-8', 'superseded', '2026-01-01')`).run();
    strict_1.default.equal((0, team_1.formatDelivery)(handoff, d), '[chatter] handoff from marc: TASK-8 continue\n(next: chatter handoff show 4)');
    d.prepare(`INSERT INTO notes (author, type, text, task_id, status, created_at)
    VALUES ('marc', 'discovery', 'found it', 'TASK-8', 'active', '2026-01-01')`).run();
    strict_1.default.equal((0, team_1.formatDelivery)(handoff, d), '[chatter] handoff from marc: TASK-8 continue\n(next: chatter handoff show 4)');
    d.prepare(`INSERT INTO notes (author, type, text, task_id, status, created_at)
    VALUES ('marc', 'dead-end', 'cannot use v1', 'TASK-8', 'active', '2026-01-01')`).run();
    strict_1.default.equal((0, team_1.formatDelivery)(handoff, d), '[chatter] handoff from marc: TASK-8 continue\n'
        + '(next: chatter handoff show 4 · prior decisions/dead ends: chatter notes --task TASK-8)');
});
(0, node_test_1.default)('purpose guidance is short, deduplicated, and generic system mail stays quiet', (t) => {
    const d = fixture(t);
    recordPriorDelivery(d);
    strict_1.default.equal((0, team_1.formatDelivery)(message({ kind: 'purpose', body: 'your purpose: fix auth' }), d), '[chatter] message from marc: your purpose: fix auth\n'
        + '(search first: chatter notes "<approach>" · record dead ends: chatter note "..." --type dead-end)');
    strict_1.default.equal((0, team_1.formatDelivery)(message({
        kind: 'purpose',
        body: 'Run chatter notes "auth" and chatter note "failed" --type dead-end',
    }), d), '[chatter] message from marc: Run chatter notes "auth" and chatter note "failed" --type dead-end');
    strict_1.default.equal((0, team_1.formatDelivery)(message({ kind: 'system', body: 'build completed' }), d), '[chatter] message from marc: build completed');
});
