'use strict';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hookOpenChatTab = exports.hookOpenChat = exports.hookOpenBoardTab = exports.hookOpenBoard = void 0;
exports.cmdSend = cmdSend;
exports.cmdPost = cmdPost;
exports.cmdChat = cmdChat;
exports.cmdInbox = cmdInbox;
exports.cmdLog = cmdLog;
exports.cmdAgents = cmdAgents;
exports.cmdWhoami = cmdWhoami;
exports.cmdIam = cmdIam;
exports.cmdNote = cmdNote;
exports.cmdNotes = cmdNotes;
exports.cmdResolve = cmdResolve;
exports.cmdAsk = cmdAsk;
exports.cmdAnswer = cmdAnswer;
exports.cmdQuestions = cmdQuestions;
exports.taskLabel = taskLabel;
exports.cmdTask = cmdTask;
exports.cmdHandoff = cmdHandoff;
exports.cmdStats = cmdStats;
exports.buildBrief = buildBrief;
exports.cmdBrief = cmdBrief;
exports.humanOnly = humanOnly;
exports.cmdData = cmdData;
exports.cmdPurge = cmdPurge;
exports.spawnAgent = spawnAgent;
exports.cmdSpawn = cmdSpawn;
exports.setRole = setRole;
exports.cmdRole = cmdRole;
exports.help = help;
exports.ensurePointerAndSymlink = ensurePointerAndSymlink;
exports.hookReap = hookReap;
exports.cmdForget = cmdForget;
exports.flushAllRepos = flushAllRepos;
exports.hookStartup = hookStartup;
exports.hookFlush = hookFlush;
// Agent-facing commands and plugin hooks.
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const node_child_process_1 = require("node:child_process");
const herdr_1 = require("./herdr");
const db_1 = require("./db");
const team_1 = require("./team");
const util_1 = require("./util");
const tui_1 = require("./tui");
const NOTE_TYPES = ['note', 'discovery', 'decision', 'dead-end', 'question'];
const errorMessage = (error) => error instanceof Error ? error.message : String(error);
const childRecord = (value, key) => (0, herdr_1.isRecord)(value) && (0, herdr_1.isRecord)(value[key]) ? value[key] : null;
// ---------------------------------------------------------------- messaging
function cmdSend(me, args) {
    // Message bodies are raw text — only a trailing --queue is a flag, so
    // bodies containing "--anything" survive verbatim.
    const queue = args[args.length - 1] === '--queue';
    const rest = queue ? args.slice(0, -1) : args;
    const body = rest.slice(1).join(' ').trim();
    if (!rest[0] || !body)
        (0, util_1.die)('usage: chatter send <agent> <message...> [--queue]');
    const to = (0, team_1.resolveRecipient)(rest[0], { allowUnknown: queue });
    if (!to)
        (0, util_1.die)(`no agent "${rest[0]}" in this repo`);
    if (to === me.name)
        (0, util_1.die)('cannot message yourself');
    const res = (0, team_1.sendMessage)(me.name, to, body);
    console.log(res.delivered ? `delivered to ${to}` : `queued: ${res.reason}`);
}
// ---------------------------------------------------------------- group chat
function cmdPost(me, args) {
    const body = args.join(' ').trim();
    if (!body)
        (0, util_1.die)('usage: chatter post <text...>   (mention with @name; @everyone is human-only)');
    const { postId, pushed, warnings } = (0, team_1.postToChat)(me, body);
    for (const w of warnings)
        console.error(`warning: ${w}`);
    console.log(`posted to #chat (#${postId})${pushed.length ? `, pushed to ${pushed.join(', ')}` : ''}`);
}
function cmdChat(me, args) {
    const opts = (0, util_1.parseFlags)(args, { limit: null, all: false });
    const limit = opts.all ? '' : ` LIMIT ${parseInt(opts.limit ?? '', 10) || 30}`;
    const rows = (0, db_1.db)().prepare(`SELECT * FROM messages WHERE to_agent = '#chat' ORDER BY id DESC${limit}`).all().reverse();
    (0, util_1.emit)(rows, () => {
        if (!rows.length) {
            console.log('group chat is empty — post with: chatter post <text> (mention with @name)');
            return;
        }
        for (const m of rows)
            console.log(`#${m.id} ${m.created_at} ${m.from_agent}: ${(0, tui_1.clean)(m.body)}`);
    });
    const maxId = rows.at(-1)?.id ?? 0;
    if (maxId) {
        (0, db_1.db)().prepare(`INSERT INTO chat_reads (agent, last_read_id) VALUES (?,?)
      ON CONFLICT(agent) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`).run(me.name, maxId);
    }
}
function cmdInbox(me, args) {
    const opts = (0, util_1.parseFlags)(args, { all: false });
    const rows = opts.all
        ? (0, db_1.db)().prepare('SELECT * FROM messages WHERE to_agent = ? OR from_agent = ? ORDER BY id DESC LIMIT 50').all(me.name, me.name).reverse()
        : (0, db_1.db)().prepare('SELECT * FROM messages WHERE to_agent = ? AND read_at IS NULL ORDER BY id').all(me.name);
    (0, util_1.emit)(rows, () => {
        if (!rows.length) {
            console.log(opts.all ? 'no messages' : 'no unread messages');
            return;
        }
        for (const m of rows) {
            const tag = m.kind === 'chat' ? '' : ` [${m.kind}${m.ref_id ? ' ' + m.ref_id : ''}]`;
            console.log(`#${m.id} ${m.created_at} ${m.from_agent} -> ${m.to_agent}${tag}: ${(0, tui_1.clean)(m.body)}`);
        }
    });
    if (!opts.all && rows.length) {
        (0, db_1.db)().prepare(`UPDATE messages SET read_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id IN (${rows.map((m) => m.id).join(',')})`)
            .run((0, db_1.now)(), (0, db_1.now)());
    }
}
function cmdLog(_me, args) {
    const opts = (0, util_1.parseFlags)(args, { grep: null, task: null, limit: null, all: false });
    const cond = ['1=1'];
    const params = [];
    if (opts.task) {
        cond.push('ref_id = ?');
        params.push(opts.task);
    }
    const limit = opts.all ? '' : ` LIMIT ${parseInt(opts.limit ?? '', 10) || 40}`;
    let rows = (0, db_1.db)().prepare(`SELECT * FROM messages WHERE ${cond.join(' AND ')} ORDER BY id DESC${limit}`).all(...params);
    if (opts.grep) {
        let re;
        try {
            re = new RegExp(opts.grep, 'i');
        }
        catch {
            re = null;
        }
        const grep = opts.grep;
        rows = rows.filter((m) => re
            ? re.test(m.body) || re.test(m.from_agent) || re.test(m.to_agent)
            : grep ? (m.body + m.from_agent + m.to_agent).toLowerCase().includes(grep.toLowerCase()) : true);
    }
    (0, util_1.emit)(rows, () => {
        for (const m of [...rows].reverse()) {
            const st = m.read_at ? '' : m.delivered_at ? ' (unread)' : ' (queued)';
            console.log(`#${m.id} ${m.created_at} ${m.from_agent} -> ${m.to_agent}: ${(0, tui_1.clean)(m.body)}${st}`);
        }
        if (!rows.length)
            console.log('no messages match');
    });
}
// ------------------------------------------------------------------ roster
function inProgressTasksByAssignee() {
    const rows = (0, db_1.db)().prepare("SELECT assignee, id, title FROM tasks WHERE status = 'in_progress'").all();
    return Object.fromEntries(rows.filter((t) => !!t.assignee)
        .map((t) => [t.assignee, t]));
}
// The one identity rendering: display label with the canonical handle always
// visible. Collapses when there is no label (or label ≈ handle) — never an
// empty "· @name". Labels are descriptive; only the @handle is addressable.
function identity(name, role) {
    const label = (role || '').trim();
    if (!label || (0, team_1.sanitizeName)(label) === name)
        return `@${name}`;
    return `${label} · @${name}`;
}
function cmdAgents(me, args = []) {
    const all = args.includes('--all');
    const live = (0, team_1.teamAgents)(); // this repo's team only — never the whole session
    const registered = (0, db_1.db)().prepare(all ? 'SELECT * FROM agents ORDER BY name' : 'SELECT * FROM agents WHERE departed_at IS NULL ORDER BY name').all();
    const taskBy = inProgressTasksByAssignee();
    const rows = registered.map((a) => {
        const l = (0, herdr_1.matchLive)(live, a);
        return { ...a, status: a.departed_at ? 'departed' : (l ? l.agent_status : 'offline'), task: taskBy[a.name] || null };
    });
    const open = openQuestions();
    (0, util_1.emit)(rows, () => {
        const known = new Set(registered.map((a) => a.name));
        const row = (mark, who, status, branch, tail) => `${mark} ${who.padEnd(30)} ${status.padEnd(9)} ${(branch || '-').padEnd(20)} ${tail}`.trimEnd();
        const lines = rows.map((a) => row(a.name === me.name ? '*' : ' ', identity(a.name, a.role), a.status ?? 'unknown', a.branch, a.task ? `${a.task.id} ${a.task.title}` : ''));
        for (const l of live) {
            if (l.name && !known.has(l.name))
                lines.push(row(' ', `@${l.name}`, l.agent_status ?? 'unknown', null, '(not yet on chatter)'));
            if (!l.name)
                lines.push(row(' ', 'pane:' + l.pane_id, l.agent_status ?? 'unknown', null, `(unnamed ${l.agent || 'agent'})`));
        }
        console.log(lines.length ? row(' ', 'AGENT', 'STATUS', 'BRANCH', 'TASK') + '\n' + lines.join('\n') : 'no agents');
        if (open.length)
            console.log(`\n${open.length} open question${open.length > 1 ? 's' : ''} (${open.map((q) => '#' + q.id).join(' ')}) — chatter questions`);
        const unread = (0, team_1.chatUnreadCount)(me.name);
        if (unread)
            console.log(`#chat: ${unread} unread (chatter chat)`);
    });
}
function cmdWhoami(me) {
    const where = me.paneId ? `pane ${me.paneId}` : 'not inside a Herdr pane';
    console.log(`${me.name}${me.human ? ' (human' : ' ('}${me.human ? ', ' + where : where})`);
}
// Set the human's chat name (stored in the plugin config dir, global).
function cmdIam(me, args) {
    humanOnly(me, 'chatter iam');
    if (!args[0]) {
        console.log(`you are "${(0, db_1.humanName)()}" — change with: chatter iam <name>`);
        return;
    }
    const name = args[0].toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 32);
    if (!name)
        (0, util_1.die)('usage: chatter iam <name>');
    // A collision would silently redirect that agent's mail to the human.
    const taken = (0, team_1.nameTaken)(name);
    if (taken)
        (0, util_1.die)(`"${name}" is ${taken} — pick another`);
    node_fs_1.default.mkdirSync((0, db_1.configRoot)(), { recursive: true });
    node_fs_1.default.writeFileSync(node_path_1.default.join((0, db_1.configRoot)(), 'name'), name + '\n');
    console.log(`you are now "${name}" — agents can reach you with: chatter send ${name} "..." or @${name} in #chat`);
}
// ------------------------------------------------------------------- notes
function cmdNote(me, args) {
    const opts = (0, util_1.parseFlags)(args, { type: 'note', task: null, commit: null });
    const text = opts._.join(' ').trim();
    if (!text)
        (0, util_1.die)('usage: chatter note <text> [--type discovery|decision|dead-end] [--task TASK-n] [--commit SHA]');
    if (!NOTE_TYPES.includes(opts.type))
        console.error(`warning: unusual note type "${opts.type}" (known: ${NOTE_TYPES.join(', ')})`);
    const r = (0, db_1.db)().prepare('INSERT INTO notes (author, type, text, task_id, commit_sha, created_at) VALUES (?,?,?,?,?,?)')
        .run(me.name, opts.type, text, opts.task, opts.commit, (0, db_1.now)());
    (0, db_1.logEvent)(me.name, 'note_created', `#${r.lastInsertRowid}`, { type: opts.type });
    console.log(`note #${r.lastInsertRowid} saved`);
}
function cmdNotes(_me, args) {
    const opts = (0, util_1.parseFlags)(args, { all: false, task: null });
    const q = opts._.join(' ').trim();
    const conditions = opts.all ? ['1=1'] : ["status = 'active'"];
    const params = [];
    if (opts.task) {
        conditions.push('task_id = ?');
        params.push(opts.task);
    }
    if (q) {
        conditions.push('text LIKE ?');
        params.push(`%${q}%`);
    }
    const order = opts.task
        ? "CASE type WHEN 'dead-end' THEN 0 WHEN 'decision' THEN 1 WHEN 'discovery' THEN 2 ELSE 3 END, id DESC"
        : 'id DESC';
    const rows = (0, db_1.db)().prepare(`SELECT * FROM notes WHERE ${conditions.join(' AND ')} ORDER BY ${order} LIMIT ${opts.task ? 10 : 100}`).all(...params);
    (0, util_1.emit)(rows, () => {
        if (!rows.length) {
            const scope = opts.task ? ` for ${opts.task}` : '';
            console.log(q ? `no notes${scope} matching "${q}"` : opts.task ? `no notes for ${opts.task}` : 'no notes yet');
            return;
        }
        for (const n of opts.task ? rows : [...rows].reverse()) {
            const refs = [n.task_id, n.commit_sha && n.commit_sha.slice(0, 8)].filter(Boolean).join(' ');
            const st = n.status === 'active' ? '' : ` (${n.status}${n.superseded_by ? ` by #${n.superseded_by}` : ''})`;
            console.log(`#${n.id} [${n.type}] ${n.author}: ${(0, tui_1.clean)(n.text)}${refs ? `  (${refs})` : ''}${st}`);
        }
    });
}
function cmdResolve(_me, args) {
    const id = parseInt(args[0] ?? '', 10);
    if (!id)
        (0, util_1.die)('usage: chatter resolve <note-id>');
    const r = (0, db_1.db)().prepare("UPDATE notes SET status = 'superseded' WHERE id = ? AND status = 'active'").run(id);
    if (r.changes)
        (0, db_1.logEvent)(_me.name, 'note_resolved', `#${id}`);
    console.log(r.changes ? `note #${id} marked superseded` : `note #${id} not found or already resolved`);
}
// --------------------------------------------------------------- questions
function openQuestions() {
    return (0, db_1.db)().prepare("SELECT * FROM notes WHERE type = 'question' AND status = 'active' ORDER BY id").all();
}
function cmdAsk(me, args) {
    if (!args.length)
        (0, util_1.die)('usage: chatter ask [agent] <question...>');
    let target = null, words = args;
    if (args.length > 1) {
        const hit = (0, team_1.resolveRecipient)(args[0] ?? '', { soft: true });
        if (hit) {
            target = hit;
            words = args.slice(1);
        }
    }
    const text = words.join(' ').trim();
    if (!text)
        (0, util_1.die)('usage: chatter ask [agent] <question...>');
    const id = (0, db_1.db)().prepare('INSERT INTO notes (author, type, text, created_at) VALUES (?,?,?,?)')
        .run(me.name, 'question', text, (0, db_1.now)()).lastInsertRowid;
    (0, db_1.logEvent)(me.name, 'question_opened', `#${id}`, target ? { to: target } : null);
    let out = `question #${id} opened`;
    if (target) {
        const res = (0, team_1.sendMessage)(me.name, target, `question #${id}: ${text} (answer with: chatter answer ${id} "...")`, 'system', `q${id}`);
        out += res.delivered ? `, delivered to ${target}` : `, queued for ${target} (${res.reason})`;
    }
    else {
        out += ' (open to anyone — visible in chatter questions)';
    }
    console.log(out);
}
function cmdAnswer(me, args) {
    const id = parseInt(args[0] ?? '', 10);
    const text = args.slice(1).join(' ').trim();
    if (!id || !text)
        (0, util_1.die)('usage: chatter answer <question-id> <text...>');
    const q = (0, db_1.db)().prepare("SELECT * FROM notes WHERE id = ? AND type = 'question'").get(id);
    if (!q)
        (0, util_1.die)(`question #${id} not found`);
    if (q.status !== 'active')
        (0, util_1.die)(`question #${id} is already ${q.status}`);
    const replyId = (0, db_1.db)().prepare('INSERT INTO notes (author, type, text, created_at) VALUES (?,?,?,?)')
        .run(me.name, 'note', `answer to #${id}: ${text}`, (0, db_1.now)()).lastInsertRowid;
    (0, db_1.db)().prepare("UPDATE notes SET status = 'resolved', superseded_by = ? WHERE id = ?").run(replyId, id);
    (0, db_1.logEvent)(me.name, 'question_answered', `#${id}`);
    let out = `question #${id} answered (note #${replyId})`;
    if (q.author !== me.name) {
        const res = (0, team_1.sendMessage)(me.name, q.author, `answer to your question #${id} ("${q.text}"): ${text}`, 'system', `q${id}`);
        out += res.delivered ? `, delivered to ${q.author}` : `, queued for ${q.author}`;
    }
    console.log(out);
}
function cmdQuestions(_me, args) {
    const opts = (0, util_1.parseFlags)(args, { all: false });
    if (!opts.all) {
        const rows = openQuestions();
        (0, util_1.emit)(rows, () => {
            if (!rows.length) {
                console.log('no open questions');
                return;
            }
            for (const r of rows)
                console.log(`#${r.id} (${(0, util_1.age)(r.created_at)} old) ${r.author}: ${(0, tui_1.clean)(r.text)}  (answer: chatter answer ${r.id} "...")`);
        });
        return;
    }
    const rows = (0, db_1.db)().prepare("SELECT * FROM notes WHERE type = 'question' ORDER BY id").all();
    const answerIds = rows.map((r) => r.superseded_by).filter((id) => id !== null);
    const answers = answerIds.length
        ? Object.fromEntries((0, db_1.db)().prepare(`SELECT * FROM notes WHERE id IN (${answerIds.join(',')})`).all().map((a) => [a.id, a]))
        : {};
    (0, util_1.emit)(rows.map((r) => ({ ...r, answer: r.superseded_by ? answers[r.superseded_by] || null : null })), () => {
        if (!rows.length) {
            console.log('no questions');
            return;
        }
        for (const r of rows) {
            console.log(`#${r.id} [${r.status}] ${r.author}: ${(0, tui_1.clean)(r.text)}`);
            const a = r.superseded_by ? answers[r.superseded_by] : undefined;
            if (a)
                console.log(`    -> ${a.author}: ${(0, tui_1.clean)(a.text).replace(/^answer to #\d+: /, '')}`);
        }
    });
}
// ------------------------------------------------------------------- tasks
function taskLabel(t) {
    const mark = t.status === 'done' ? 'x' : t.status === 'in_progress' ? '>' : ' ';
    return `[${mark}] ${t.id} ${t.title}${t.assignee ? `  (@${t.assignee})` : ''}${t.commit_sha ? `  ${t.commit_sha.slice(0, 8)}` : ''}`;
}
function nextTaskId() {
    const row = (0, db_1.db)().prepare("SELECT MAX(CAST(substr(id, 6) AS INTEGER)) AS n FROM tasks").get();
    return `TASK-${(row?.n || 0) + 1}`;
}
function notifyAssignment(me, task) {
    if (task.assignee && task.assignee !== me.name) {
        (0, team_1.sendMessage)(me.name, task.assignee, `you were assigned ${task.id}: ${task.title} (details: chatter task list)`, 'system', task.id);
    }
}
function cmdTask(me, args) {
    const sub = args[0];
    if (sub === 'create') {
        const opts = (0, util_1.parseFlags)(args.slice(1), { assignee: null });
        const title = opts._.join(' ').trim();
        if (!title)
            (0, util_1.die)('usage: chatter task create <title> [--assignee agent]');
        const assignee = opts.assignee ? (0, team_1.resolveRecipient)(opts.assignee) : null;
        // ID allocation + insert must be atomic: concurrent creates otherwise
        // race MAX+1 into duplicate primary keys.
        let id = null;
        for (let attempt = 0; attempt < 5 && !id; attempt++) {
            try {
                (0, db_1.db)().exec('BEGIN IMMEDIATE');
                const candidate = nextTaskId();
                (0, db_1.db)().prepare('INSERT INTO tasks (id, title, status, assignee, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
                    .run(candidate, title, assignee ? 'in_progress' : 'open', assignee, me.name, (0, db_1.now)(), (0, db_1.now)());
                (0, db_1.db)().exec('COMMIT');
                id = candidate;
            }
            catch (e) {
                try {
                    (0, db_1.db)().exec('ROLLBACK');
                }
                catch { /* not in tx */ }
                if (attempt === 4)
                    throw e;
            }
        }
        (0, db_1.logEvent)(me.name, 'task_created', id, { title, assignee });
        if (assignee)
            (0, db_1.logEvent)(me.name, 'task_assigned', id, { to: assignee });
        console.log(`${id} created${assignee ? ` and assigned to ${assignee}` : ''}`);
        if (!id)
            throw new Error('task id allocation failed');
        notifyAssignment(me, { id, title, assignee });
    }
    else if (sub === 'list') {
        const rows = (0, db_1.db)().prepare("SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, id").all();
        (0, util_1.emit)(rows, () => {
            if (!rows.length) {
                console.log('no tasks');
                return;
            }
            for (const t of rows)
                console.log(taskLabel(t));
        });
    }
    else if (sub === 'assign') {
        const id = args[1];
        const agent = args[2] && (0, team_1.resolveRecipient)(args[2]);
        if (!id || !agent)
            (0, util_1.die)('usage: chatter task assign <TASK-n> <agent>');
        const t = (0, db_1.db)().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        if (!t)
            (0, util_1.die)(`${id} not found`);
        (0, db_1.db)().prepare("UPDATE tasks SET assignee = ?, status = 'in_progress', updated_at = ? WHERE id = ?").run(agent, (0, db_1.now)(), id);
        (0, db_1.logEvent)(me.name, 'task_assigned', id, { to: agent });
        console.log(`${id} assigned to ${agent}`);
        notifyAssignment(me, { ...t, assignee: agent });
    }
    else if (sub === 'done') {
        const opts = (0, util_1.parseFlags)(args.slice(1), { commit: null });
        const id = opts._[0];
        if (!id)
            (0, util_1.die)('usage: chatter task done <TASK-n> [--commit SHA]');
        const r = (0, db_1.db)().prepare("UPDATE tasks SET status = 'done', commit_sha = COALESCE(?, commit_sha), updated_at = ? WHERE id = ?").run(opts.commit, (0, db_1.now)(), id);
        if (!r.changes)
            (0, util_1.die)(`${id} not found`);
        (0, db_1.db)().prepare("UPDATE handoffs SET status = 'done' WHERE task_id = ? AND status != 'done'").run(id);
        (0, db_1.logEvent)(me.name, 'task_done', id, opts.commit ? { commit: opts.commit } : null);
        console.log(`${id} done${opts.commit ? ` (${opts.commit.slice(0, 8)})` : ''}`);
    }
    else {
        (0, util_1.die)('usage: chatter task create|list|assign|done ...');
    }
}
// ---------------------------------------------------------------- handoffs
function cmdHandoff(me, args) {
    if (args[0] === 'show') {
        const h = (0, db_1.db)().prepare('SELECT * FROM handoffs WHERE id = ?').get(parseInt(args[1] ?? '', 10));
        if (!h)
            (0, util_1.die)(`handoff h${args[1]} not found`);
        const t = h.task_id ? (0, db_1.db)().prepare('SELECT * FROM tasks WHERE id = ?').get(h.task_id) : null;
        console.log(JSON.stringify({
            id: `h${h.id}`, task: h.task_id, task_title: t ? t.title : undefined,
            from: h.from_agent, to: h.to_agent, summary: h.summary,
            branch: h.branch, commit: h.commit_sha,
            files: h.files_json ? JSON.parse(h.files_json) : [],
            tests: h.tests, next: h.next_steps, status: h.status, created_at: h.created_at,
        }, null, 2));
        return;
    }
    const opts = (0, util_1.parseFlags)(args, { summary: null, branch: null, commit: null, files: null, tests: null, next: null });
    const taskId = opts._[0];
    const to = opts._[1] && (0, team_1.resolveRecipient)(opts._[1]);
    if (!taskId || !to || !opts.summary) {
        (0, util_1.die)('usage: chatter handoff <TASK-n> <agent> --summary S [--branch B] [--commit C] [--files a,b] [--tests CMD] [--next TEXT]\n       chatter handoff show <id>');
    }
    const task = (0, db_1.db)().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task)
        (0, util_1.die)(`${taskId} not found — create it first: chatter task create <title>`);
    // Fill git context from the caller's worktree when not given explicitly.
    const branch = opts.branch || (0, db_1.gitInfo)(process.cwd()).branch;
    const files = opts.files ? opts.files.split(',').map((s) => s.trim()).filter(Boolean) : [];
    // One transaction: a crash mid-handoff must not leave ownership, the
    // handoff record, and the audit note disagreeing.
    let hid;
    (0, db_1.db)().exec('BEGIN IMMEDIATE');
    try {
        hid = (0, db_1.db)().prepare(`INSERT INTO handoffs (task_id, from_agent, to_agent, summary, branch, commit_sha, files_json, tests, next_steps, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run(taskId, me.name, to, opts.summary, branch, opts.commit, JSON.stringify(files), opts.tests, opts.next, (0, db_1.now)()).lastInsertRowid;
        (0, db_1.db)().prepare("UPDATE tasks SET assignee = ?, status = 'in_progress', updated_at = ? WHERE id = ?").run(to, (0, db_1.now)(), taskId);
        (0, db_1.db)().prepare('INSERT INTO notes (author, type, text, task_id, commit_sha, created_at) VALUES (?,?,?,?,?,?)')
            .run(me.name, 'note', `handed off ${taskId} to ${to}: ${opts.summary}`, taskId, opts.commit, (0, db_1.now)());
        (0, db_1.db)().exec('COMMIT');
    }
    catch (e) {
        try {
            (0, db_1.db)().exec('ROLLBACK');
        }
        catch { /* not in tx */ }
        throw e;
    }
    (0, db_1.logEvent)(me.name, 'handoff_created', `h${hid}`, { task: taskId, to });
    (0, db_1.logEvent)(me.name, 'task_assigned', taskId, { to, via: `h${hid}` });
    const parts = [`${taskId} ${opts.summary}`];
    if (branch)
        parts.push(`branch ${branch}`);
    if (opts.commit)
        parts.push(`commit ${opts.commit.slice(0, 12)}`);
    if (opts.next)
        parts.push(`next: ${opts.next}`);
    parts.push(`full details: chatter handoff show ${hid}`);
    const res = (0, team_1.sendMessage)(me.name, to, parts.join(' | '), 'handoff', `h${hid}`);
    console.log(`h${hid} created; ${res.delivered ? `delivered to ${to}` : `queued: ${res.reason}`}`);
}
// ------------------------------------------------------------------- stats
function cmdStats() {
    const allMsgs = (0, db_1.db)().prepare('SELECT * FROM messages').all();
    const posts = allMsgs.filter((m) => m.to_agent === '#chat');
    const msgs = allMsgs.filter((m) => m.to_agent !== '#chat');
    const tasks = (0, db_1.db)().prepare('SELECT * FROM tasks').all();
    const handoffs = (0, db_1.db)().prepare('SELECT * FROM handoffs').all();
    const notes = (0, db_1.db)().prepare('SELECT * FROM notes').all();
    const pairs = {};
    for (const m of msgs)
        pairs[`${m.from_agent} -> ${m.to_agent}`] = (pairs[`${m.from_agent} -> ${m.to_agent}`] || 0) + 1;
    const byType = {};
    for (const n of notes)
        byType[n.type] = (byType[n.type] || 0) + 1;
    const qs = notes.filter((n) => n.type === 'question');
    const qAnswered = qs.filter((q) => q.status === 'resolved' && q.superseded_by);
    const noteById = new Map(notes.map((n) => [n.id, n]));
    const openQs = qs.filter((q) => q.status === 'active');
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const stats = {
        messages: {
            total: msgs.length,
            queued: msgs.filter((m) => !m.delivered_at).length,
            median_delivery: (0, util_1.median)(msgs.flatMap((m) => m.delivered_at ? [(0, util_1.toMs)(m.delivered_at) - (0, util_1.toMs)(m.created_at)] : [])),
            by_pair: pairs,
        },
        chat: {
            posts: posts.length,
            by_author: posts.reduce((acc, p) => ((acc[p.from_agent] = (acc[p.from_agent] || 0) + 1), acc), {}),
            mentions_pushed: msgs.filter((m) => m.kind === 'mention').length,
        },
        tasks: {
            open: tasks.filter((t) => t.status === 'open').length,
            in_progress: tasks.filter((t) => t.status === 'in_progress').length,
            done: tasks.filter((t) => t.status === 'done').length,
            median_open_to_done: (0, util_1.median)(tasks.filter((t) => t.status === 'done').map((t) => (0, util_1.toMs)(t.updated_at) - (0, util_1.toMs)(t.created_at))),
        },
        handoffs: {
            total: handoffs.length,
            completed: handoffs.filter((h) => h.status === 'done').length,
            median_handoff_to_done: (0, util_1.median)(handoffs.filter((h) => h.status === 'done' && h.task_id && taskById.has(h.task_id))
                .map((h) => h.task_id ? (0, util_1.toMs)(taskById.get(h.task_id)?.updated_at ?? h.created_at) - (0, util_1.toMs)(h.created_at) : 0)),
        },
        notes: {
            by_type: byType,
            superseded: notes.filter((n) => n.status !== 'active' && n.type !== 'question').length,
        },
        questions: {
            open: openQs.length,
            resolved: qAnswered.length,
            median_time_to_answer: (0, util_1.median)(qAnswered.filter((q) => q.superseded_by && noteById.has(q.superseded_by))
                .map((q) => (0, util_1.toMs)(q.superseded_by ? noteById.get(q.superseded_by)?.created_at ?? q.created_at : q.created_at) - (0, util_1.toMs)(q.created_at))),
            oldest_open_age_ms: openQs[0] ? Date.now() - (0, util_1.toMs)(openQs[0].created_at) : null,
        },
    };
    (0, util_1.emit)(stats, () => {
        const s = stats;
        console.log(`messages   ${s.messages.total} total, ${s.messages.queued} queued, median delivery ${(0, util_1.fmtDur)(s.messages.median_delivery)}`);
        for (const [pair, n] of Object.entries(s.messages.by_pair))
            console.log(`             ${pair}: ${n}`);
        console.log(`#chat      ${s.chat.posts} posts (${Object.entries(s.chat.by_author).map(([a, n]) => `${a}: ${n}`).join(', ') || 'none'}), ${s.chat.mentions_pushed} mention pushes`);
        console.log(`tasks      ${s.tasks.open} open, ${s.tasks.in_progress} in progress, ${s.tasks.done} done, median open->done ${(0, util_1.fmtDur)(s.tasks.median_open_to_done)}`);
        console.log(`handoffs   ${s.handoffs.total} total, ${s.handoffs.completed} completed, median handoff->done ${(0, util_1.fmtDur)(s.handoffs.median_handoff_to_done)}`);
        console.log(`notes      ${Object.entries(s.notes.by_type).map(([t, n]) => `${n} ${t}`).join(', ') || 'none'}${s.notes.superseded ? `, ${s.notes.superseded} superseded` : ''}`);
        console.log(`questions  ${s.questions.open} open, ${s.questions.resolved} resolved, median time-to-answer ${(0, util_1.fmtDur)(s.questions.median_time_to_answer)}${s.questions.oldest_open_age_ms ? `, oldest open ${(0, util_1.fmtDur)(s.questions.oldest_open_age_ms)}` : ''}`);
    });
}
// ------------------------------------------------------------------- brief
const tsOf = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
function briefWindow(me, d, arg) {
    if (arg === 'today') {
        const t = new Date();
        t.setHours(0, 0, 0, 0);
        return { since: tsOf(t.getTime()), explicit: true };
    }
    const m = arg && arg.match(/^(\d+)([hm])$/);
    if (m)
        return { since: tsOf(Date.now() - parseInt(m[1] ?? '', 10) * (m[2] === 'h' ? 3600e3 : 60e3)), explicit: true };
    if (arg)
        (0, util_1.die)(`usage: chatter brief [today|2h|30m] — got "${arg}"`);
    const mark = d.prepare("SELECT value FROM ui_marks WHERE agent = ? AND mark = 'brief'").get(me.name);
    return { since: (mark && mark.value) || tsOf(Date.now() - 24 * 3600e3), explicit: false };
}
// Deterministic catch-up: what changed since the caller last looked.
function buildBrief(me, d = (0, db_1.db)(), arg = null) {
    const { since, explicit } = briefWindow(me, d, arg);
    const ev = (kind) => d.prepare('SELECT * FROM events WHERE kind = ? AND at > ? ORDER BY id').all(kind, since);
    const lines = [];
    const taskTitle = (id) => {
        if (!id)
            return '';
        const t = d.prepare('SELECT title FROM tasks WHERE id = ?').get(id);
        return t ? t.title : '';
    };
    for (const e of ev('task_done'))
        lines.push(`✓ ${e.ref} ${taskTitle(e.ref)} — completed by ${e.actor}`);
    for (const e of ev('task_created')) {
        const t = e.ref ? d.prepare('SELECT * FROM tasks WHERE id = ?').get(e.ref) : undefined;
        if (t && t.status === 'open')
            lines.push(`+ ${e.ref} ${t.title} — new, unassigned (by ${e.actor})`);
    }
    for (const t of d.prepare("SELECT * FROM tasks WHERE status = 'in_progress' ORDER BY id").all()) {
        lines.push(`→ ${t.assignee || '?'} is on ${t.id} ${t.title}`);
    }
    for (const q of d.prepare("SELECT * FROM notes WHERE type = 'question' AND status = 'active' ORDER BY id").all()) {
        lines.push(`? question #${q.id} open ${(0, util_1.age)(q.created_at)} (${q.author}): ${(0, tui_1.clean)(q.text).slice(0, 70)}`);
    }
    for (const e of ev('handoff_created')) {
        const parsed = e.data ? JSON.parse(e.data) : {};
        const x = (0, herdr_1.isRecord)(parsed) ? parsed : {};
        lines.push(`⇄ ${e.actor} handed ${typeof x.task === 'string' ? x.task : ''} to ${typeof x.to === 'string' ? x.to : '?'} (${e.ref})`);
    }
    for (const n of d.prepare("SELECT * FROM notes WHERE type IN ('decision','dead-end') AND created_at > ? ORDER BY id").all(since)) {
        lines.push(`◆ [${n.type}] ${n.author}: ${(0, tui_1.clean)(n.text).slice(0, 70)}`);
    }
    const dms = d.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_agent = ? AND read_at IS NULL AND kind != 'mention'").get(me.name)?.n ?? 0;
    const unreadChat = (0, team_1.chatUnreadCount)(me.name, d);
    if (dms || unreadChat)
        lines.push(`✉ ${dms ? `${dms} unread DM${dms > 1 ? 's' : ''}` : ''}${dms && unreadChat ? ' · ' : ''}${unreadChat ? `#chat: ${unreadChat} unread` : ''}`);
    const counts = {};
    for (const a of (0, team_1.teamAgents)(d)) {
        const status = a.agent_status ?? 'unknown';
        counts[status] = (counts[status] || 0) + 1;
    }
    const stuck = d.prepare(`SELECT COUNT(*) AS n FROM messages m JOIN agents a ON a.name = m.to_agent
    WHERE m.delivered_at IS NULL AND a.departed_at IS NOT NULL`).get()?.n ?? 0;
    if (stuck)
        lines.push(`⚠ ${stuck} message${stuck > 1 ? 's' : ''} queued for departed agents (chatter forget <name> cleans up)`);
    lines.push(`agents: ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ') || 'none live'}`);
    if (!explicit) {
        d.prepare(`INSERT INTO ui_marks (agent, mark, value) VALUES (?, 'brief', ?)
      ON CONFLICT(agent, mark) DO UPDATE SET value = excluded.value`).run(me.name, (0, db_1.now)());
    }
    return { since, lines: lines.length > 1 ? lines : [...lines, '(quiet — nothing new)'] };
}
function cmdBrief(me, args) {
    const b = buildBrief(me, (0, db_1.db)(), args[0] || null);
    (0, util_1.emit)(b, () => {
        console.log(`since ${b.since}:`);
        for (const l of b.lines)
            console.log(`  ${l}`);
    });
}
function repoUniverses() {
    return (0, db_1.listRepoDbFiles)().map((f) => {
        const d = (0, db_1.openDbFile)(f);
        const count = (t) => d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? 0;
        const mark = d.prepare("SELECT value FROM ui_marks WHERE agent = '_repo' AND mark = 'root'").get();
        const root = mark ? { repo_root: mark.value }
            : d.prepare('SELECT repo_root FROM agents WHERE repo_root IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1').get();
        const last = d.prepare('SELECT MAX(created_at) AS t FROM messages').get()?.t
            || d.prepare('SELECT MAX(at) AS t FROM events').get()?.t;
        let bytes = 0;
        for (const suffix of ['', '-wal', '-shm']) {
            try {
                bytes += node_fs_1.default.statSync(f + suffix).size;
            }
            catch { /* absent */ }
        }
        return {
            key: node_path_1.default.basename(node_path_1.default.dirname(f)),
            dir: node_path_1.default.dirname(f),
            repo_root: root ? root.repo_root : null,
            orphan: !!(root && root.repo_root && !node_fs_1.default.existsSync(root.repo_root)),
            messages: count('messages'), notes: count('notes'), tasks: count('tasks'), events: count('events'),
            last_activity: last || null,
            bytes,
        };
    });
}
// Global administration is human-only: a confused or prompt-injected agent
// must stay contained to its repo (honor-system tier, like the repo boundary).
function humanOnly(me, what) {
    if (!me.human)
        (0, util_1.die)(`${what} is human-only — agents administer nothing outside their repo`);
}
function cmdData(me) {
    humanOnly(me, 'chatter data');
    const rows = repoUniverses();
    (0, util_1.emit)(rows, () => {
        if (!rows.length) {
            console.log('no chatter data stored yet');
            return;
        }
        console.log('chatter stores everything locally in per-repo SQLite files:\n');
        for (const r of rows) {
            const tag = r.orphan ? '  (ORPHAN — repo no longer exists)' : '';
            console.log(`${r.key}${tag}`);
            console.log(`   repo: ${r.repo_root || 'unknown'}`);
            console.log(`   ${r.messages} messages, ${r.notes} notes, ${r.tasks} tasks, ${r.events} events · ${(r.bytes / 1024).toFixed(0)} KB · last activity ${r.last_activity || '-'}`);
            console.log(`   file: ${r.dir}/chatter.db`);
        }
        console.log(`\ndelete: chatter purge <name> | --orphans | --all  (dry run without --yes)`);
    });
}
function cmdPurge(me, args) {
    humanOnly(me, 'chatter purge');
    const opts = (0, util_1.parseFlags)(args, { yes: false, orphans: false, all: false, 'older-than': null });
    const rows = repoUniverses();
    let targets = [];
    if (opts.all)
        targets = rows;
    else if (opts.orphans)
        targets = rows.filter((r) => r.orphan);
    else if (opts['older-than']) {
        const m = opts['older-than'].match(/^(\d+)([dh])$/);
        if (!m)
            (0, util_1.die)('usage: chatter purge --older-than <Nd|Nh> [--yes]  (trims old messages+events in the current repo)');
        const cutoff = new Date(Date.now() - parseInt(m[1] ?? '', 10) * (m[2] === 'd' ? 86400e3 : 3600e3))
            .toISOString().replace('T', ' ').slice(0, 19);
        const d = (0, db_1.db)();
        const nm = d.prepare('SELECT COUNT(*) AS n FROM messages WHERE created_at < ?').get(cutoff)?.n ?? 0;
        const ne = d.prepare('SELECT COUNT(*) AS n FROM events WHERE at < ?').get(cutoff)?.n ?? 0;
        if (!opts.yes) {
            console.log(`would trim ${nm} messages and ${ne} events older than ${cutoff} — add --yes to execute`);
            return;
        }
        d.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
        d.prepare('DELETE FROM events WHERE at < ?').run(cutoff);
        console.log(`trimmed ${nm} messages and ${ne} events`);
        return;
    }
    else if (opts._[0]) {
        targets = rows.filter((r) => r.key === opts._[0] || r.key.startsWith(opts._[0] + '-') || r.key.replace(/-[0-9a-f]{8}$/, '') === opts._[0]);
        if (!targets.length)
            (0, util_1.die)(`no stored universe matches "${opts._[0]}" — see: chatter data`);
    }
    else {
        (0, util_1.die)('usage: chatter purge <repo-name> | --orphans | --all | --older-than 30d   (dry run; add --yes to execute)');
    }
    if (!targets.length) {
        console.log('nothing to purge');
        return;
    }
    for (const t of targets) {
        const line = `${t.key}: ${t.messages} messages, ${t.notes} notes, ${t.tasks} tasks, ${t.events} events`;
        if (opts.yes) {
            node_fs_1.default.rmSync(t.dir, { recursive: true, force: true });
            console.log(`deleted ${line}`);
        }
        else
            console.log(`would delete ${line}`);
    }
    if (!opts.yes)
        console.log('\ndry run — add --yes to execute');
}
function spawnAgent(me, { name: rawName, kind, purpose, tab = false, branch = null, base = null }, d = (0, db_1.db)(), onProgress = () => { }) {
    const fail = (msg) => ({ ok: false, lines: [msg] });
    if (!rawName)
        return fail('usage: spawn <name> [--kind codex|claude|pi|...] [--purpose "why"] [--branch B] [--base REF] [--tab]');
    const name = (0, team_1.sanitizeName)(rawName);
    const taken = (0, team_1.nameTaken)(name);
    if (taken)
        return fail(`"${name}" is ${taken} — pick another name`);
    const lines = [];
    if (!kind) {
        const kinds = (0, team_1.teamAgents)(d).map((a) => a.agent).filter(Boolean);
        kind = kinds.sort((a, b) => kinds.filter((k) => k === b).length - kinds.filter((k) => k === a).length)[0];
        if (!kind)
            return fail('no --kind given and no agents in this repo to infer one from (run: herdr agent  for installed kinds)');
        lines.push(`no kind given — using ${kind} (majority of this repo's agents)`);
    }
    // The spawn target repo comes from the DB handle, never process.cwd():
    // inside the chat popup, cwd is the plugin's own checkout.
    const mark = d.prepare("SELECT value FROM ui_marks WHERE agent = '_repo' AND mark = 'root'").get();
    const repoRoot = (mark && mark.value) || (0, db_1.gitInfo)().repoRoot;
    if (!repoRoot || (0, db_1.repoDbFile)(repoRoot) !== (0, db_1.dbFile)(d)) {
        return fail('cannot determine this universe\'s repo — run one chatter command from a shell in it first');
    }
    // Code setup: a fresh worktree by default — Chatter's own model says
    // worktrees isolate code. --tab shares this checkout (explicit exception,
    // fine for reviewers/helpers that don't write files).
    let pane;
    let cleanup;
    let whereLine;
    if (tab) {
        const tabArgs = ['tab', 'create', '--label', name, '--cwd', repoRoot, '--no-focus'];
        if (process.env.HERDR_WORKSPACE_ID)
            tabArgs.push('--workspace', process.env.HERDR_WORKSPACE_ID);
        const t = (0, herdr_1.herdr)(tabArgs);
        if (!t.ok)
            return fail(`could not create a tab: ${t.raw}`);
        const tabResult = childRecord(t.json, 'result');
        const rootPane = childRecord(tabResult, 'root_pane');
        const tabInfo = childRecord(tabResult, 'tab');
        const paneId = rootPane?.pane_id;
        const tabId = tabInfo?.tab_id;
        if (typeof paneId !== 'string' || typeof tabId !== 'string')
            return fail('tab created but no pane returned — start the agent manually');
        pane = paneId;
        cleanup = () => (0, herdr_1.herdr)(['tab', 'close', tabId]);
        whereLine = `same checkout, new tab (${pane}) — shared files, coordinate carefully`;
        onProgress(`tab created in this checkout (${pane})`);
    }
    else {
        // A worktree branch needs a commit to point at — a freshly-init'ed repo
        // (unborn HEAD) can't host worktree teammates yet. Say so clearly.
        const head = (0, node_child_process_1.spawnSync)('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
        if (head.status !== 0) {
            return fail('this repo has no commits yet, so a worktree branch has nothing to start from —\n'
                + 'make a first commit (git commit --allow-empty -m "init") or spawn into this checkout with --tab');
        }
        const wtBranch = branch || `agents/${name}`;
        const wtArgs = ['worktree', 'create', '--cwd', repoRoot, '--branch', wtBranch, '--label', name, '--no-focus'];
        if (base)
            wtArgs.push('--base', base);
        const wt = (0, herdr_1.herdr)(wtArgs);
        if (!wt.ok)
            return fail(`could not create a worktree: ${wt.raw}`);
        const wtResult = childRecord(wt.json, 'result');
        const directPane = childRecord(wtResult, 'root_pane');
        const workspace = childRecord(wtResult, 'workspace');
        const workspacePane = childRecord(workspace, 'root_pane');
        const paneId = directPane?.pane_id ?? workspacePane?.pane_id;
        if (typeof paneId !== 'string')
            return fail('worktree created but no pane returned — start the agent manually');
        pane = paneId;
        const worktree = childRecord(wtResult, 'worktree');
        const wtPath = typeof worktree?.path === 'string' ? worktree.path : null;
        cleanup = null; // never auto-remove a worktree — that's user data
        whereLine = `new worktree on ${wtBranch}${wtPath ? ` (${wtPath})` : ''} — isolated checkout`;
        lines.push(`cleanup when done: herdr worktree remove --path ${wtPath || '<worktree-path>'}`);
        onProgress(`worktree created on ${wtBranch}`);
    }
    // A fresh worktree/tab's shell may not be at its prompt yet — Herdr then
    // refuses with agent_pane_busy. Retry briefly instead of giving up.
    let start = null;
    onProgress(`starting ${kind}…`);
    for (let attempt = 0; attempt < 15; attempt++) {
        start = (0, herdr_1.herdr)(['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', '60000']);
        if (start.ok || !(start.raw || '').includes('agent_pane_busy'))
            break;
        onProgress(`shell warming up, attempt ${attempt + 2}`);
        (0, node_child_process_1.spawnSync)('sleep', ['1']);
    }
    if (!start || !start.ok) {
        if (cleanup)
            cleanup();
        return fail(`agent start failed: ${start?.raw ?? 'no response'}${cleanup ? '' : ' (worktree left in place)'}`);
    }
    onProgress(`${kind} agent up`);
    (0, herdr_1.herdr)(['pane', 'rename', pane, name]); // pane label = role, feeds the roster
    (0, herdr_1.invalidateSessionAgents)(); // roster changed — the cached list predates the spawn
    // Boundary proof: the newcomer must verifiably belong to this universe
    // (teamAgents only returns repo-verified agents, so presence = proof).
    const verified = !!(0, team_1.teamAgents)(d).find((a) => a.name === name);
    (0, db_1.logEvent)(me.name, 'agent_spawned', name, { kind, by: me.name, purpose: purpose || null, tab: !!tab }, d);
    (0, team_1.postToChat)(me, `spawned ${name} (${kind})${purpose ? `: ${purpose}` : ''}`, d, () => null);
    onProgress('announced in #chat');
    lines.unshift(`@${name} is up (${kind}) — ${whereLine}`);
    lines.push(verified ? 'verified: joined this repo\'s universe' : 'warning: could not verify repo membership yet — its mail queues until it checks in');
    if (purpose) {
        const res = (0, team_1.sendMessage)(me.name, name, `you are "${name}". your purpose: ${purpose}`, 'purpose', null, d);
        lines.push(res.delivered ? 'purpose delivered to its session' : `purpose queued (${res.reason})`);
        onProgress(res.delivered ? 'purpose delivered' : 'purpose queued');
    }
    const startResult = childRecord(start.json, 'result');
    const startedAgent = childRecord(startResult, 'agent');
    const status = typeof startedAgent?.agent_status === 'string' ? startedAgent.agent_status : 'unknown';
    if (status === 'blocked')
        lines.push('it is showing a startup dialog (trust/permissions) — click through it once');
    return { ok: true, lines };
}
function cmdSpawn(me, args) {
    const opts = (0, util_1.parseFlags)(args, { kind: null, purpose: null, tab: false, branch: null, base: null });
    // The CLI streams the stages as they happen — a spawn can take a minute.
    const r = spawnAgent(me, {
        name: opts._[0], kind: opts.kind, purpose: opts.purpose,
        tab: opts.tab, branch: opts.branch, base: opts.base,
    }, (0, db_1.db)(), (line) => console.log(`… ${line}`));
    for (const l of r.lines)
        console.log(l);
    if (!r.ok)
        process.exit(1);
}
// ------------------------------------------------------------------- role
// Roles are Chatter UX; the pane label is just where they live. Humans can
// retitle anyone; an agent may only describe itself.
function setRole(me, target, text, d = (0, db_1.db)()) {
    const who = (0, team_1.resolveRecipient)(target.replace(/^@/, ''), { soft: true }, d);
    if (!who)
        return { ok: false, lines: [`no agent "${target}" in this repo`] };
    if (!me.human && who !== me.name)
        return { ok: false, lines: ['agents may only set their own role'] };
    const row = d.prepare('SELECT pane_id FROM agents WHERE name = ?').get(who);
    const live = (0, team_1.teamAgents)(d).find((a) => a.name === who);
    const pane = (live && live.pane_id) || (row && row.pane_id);
    const lines = [];
    if (pane && live) {
        const r = (0, herdr_1.herdr)(['pane', 'rename', pane, text]);
        lines.push(r.ok ? `pane label updated` : `pane label not updated (${r.raw}) — roster updated anyway`);
    }
    else {
        lines.push(`${who} is offline — roster updated; pane label applies when it returns`);
    }
    const updated = d.prepare('UPDATE agents SET role = ? WHERE name = ?').run(text, who);
    if (!updated.changes) { // live but not yet registered — seed a minimal row
        d.prepare('INSERT INTO agents (name, pane_id, role, registered_at, last_seen_at) VALUES (?,?,?,?,?)')
            .run(who, pane || null, text, (0, db_1.now)(), (0, db_1.now)());
    }
    lines.unshift(`${text} · @${who}`);
    return { ok: true, lines };
}
function cmdRole(me, args) {
    const target = args[0];
    const text = args.slice(1).join(' ').trim();
    if (!target || !text)
        (0, util_1.die)('usage: chatter role <agent> <display role...>   e.g. chatter role data-api "Data / API"');
    const r = setRole(me, target, text);
    for (const l of r.lines)
        console.log(l);
    if (!r.ok)
        process.exit(1);
}
// -------------------------------------------------------------------- help
function help(all = false) {
    if (!all)
        return `chatter — repo-scoped coordination for coding agents

Common coordination:
  chatter agents                         roster, status and current task
  chatter send <agent> <message...>      private message
  chatter post <text...>                 group chat; @name pushes
  chatter inbox [--all]                  unread private messages / history
  chatter note <text> [--type TYPE]      record a discovery, decision or dead end
  chatter notes [query] [--task TASK-n]  search shared memory
  chatter ask [agent] <question...>      open a question
  chatter answer <id> <text...>          answer one
  chatter task create|list|assign|done   lightweight ownership
  chatter handoff <TASK-n> <agent> --summary "..."
  chatter handoff show <id>              read a structured handoff
  chatter brief [today|2h|30m]           catch up on changes

Human workflows:
  chatter spawn <name> [--kind k] [--purpose "..."]
  chatter setup --yes · chatter doctor · chatter update [--check]

Open chat:  prefix+alt+c popup · prefix+alt+t tab
Open board: prefix+alt+b popup · prefix+alt+shift+b tab

Chatter carries context inside this repo; Git carries code between worktrees.
Full command and placement reference: chatter help --all`;
    return `chatter — repo-scoped chat, shared memory, tasks and handoffs for coding agents

  chatter agents [--all]                who's online: role, branch, task (--all incl. departed)
  chatter send <agent> <message...>     DM an agent (lands in their session; --queue for absent agents)
  chatter inbox [--all]                 your unread messages (--all = history)
  chatter post <text...>                post to the repo group chat; @name pushes to that agent
  chatter chat [--limit N] [--all]      read the group chat (marks it read)
  chatter brief [today|2h|30m]          what changed since you last checked
  chatter note <text> [--type discovery|decision|dead-end] [--task TASK-n] [--commit SHA]
  chatter notes [query] [--task TASK-n] [--all]   read/search shared memory
  chatter resolve <note-id>             mark a note stale/superseded
  chatter ask [agent] <question...>     open a question (optionally aimed at an agent)
  chatter answer <id> <text...>         answer a question (notifies the asker)
  chatter questions [--all]             open questions; --all includes answered
  chatter task create <title> [--assignee agent]
  chatter task list | assign <TASK-n> <agent> | done <TASK-n> [--commit SHA]
  chatter handoff <TASK-n> <agent> --summary S [--branch B] [--commit C]
                  [--files a,b] [--tests CMD] [--next TEXT]
  chatter handoff show <id>             structured handoff payload (JSON)
  chatter log [--grep PAT] [--task TASK-n] [--limit N] [--all]
  chatter stats                         team metrics (delivery latency, tasks, questions)
  chatter spawn <name> [--kind k] [--purpose "..."] [--branch B] [--base REF] [--tab]
                                        add a teammate in a NEW WORKTREE (--tab shares this checkout)
  chatter role <agent> <display role...>   set a display role, e.g. "Data / API" · @data-api
  chatter forget <agent>                retire a departed teammate, drop its queued mail (human only)
  chatter data                          what chatter stores (per repo, sizes)
  chatter purge <repo>|--orphans|--all|--older-than 30d [--yes]   delete stored data
  chatter whoami
  chatter iam <name>                    set the human's chat name (human only)
  chatter update [--check]              bring this machine's chatter up to date (human only)
  chatter help [--all]                  concise guide / complete reference

Open the chat: prefix+alt+c (popup) or prefix+alt+t (tab) once chatter setup binds
them — same as: herdr plugin action invoke chatter.open-chat-tab, or herdr plugin
pane open --plugin chatter --entrypoint chat --placement split
Open the board: prefix+alt+b (popup) or prefix+alt+shift+b (tab) once setup binds
them — same as: herdr plugin action invoke chatter.open-board-tab

The human is "${(0, db_1.humanName)()}": DMs and @${(0, db_1.humanName)()} mentions reach them as a
Herdr toast notification, and they read/post like anyone else.

Chatter is scoped per repository: agents, chat, notes, and tasks are only
shared within this repo (all its worktrees). Record dead-ends (--type
dead-end) so teammates don't repeat failed investigations. Answer open
questions before they go stale.

Most read commands accept --json. chatter data reports local stored data.

Code moves through Git (commit/branch refs in handoffs) — never edit another
agent's worktree. Chatter carries context, Git carries code.`;
}
// ------------------------------------------------------------- plugin hooks
function ensurePointerAndSymlink() {
    // Startup hook runs with plugin env; persist what bare CLI calls can't see.
    const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
    const cfgDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
    if (stateDir && cfgDir) {
        node_fs_1.default.mkdirSync(cfgDir, { recursive: true });
        node_fs_1.default.writeFileSync(node_path_1.default.join(cfgDir, 'state-dir'), stateDir + '\n');
    }
    // Make `chatter` callable from any agent shell.
    // Runtime lives in dist/src; the stable user-facing launcher remains at
    // the repository root so it survives clean rebuilds of generated output.
    const target = node_path_1.default.join(__dirname, '..', '..', 'bin', 'chatter');
    const link = node_path_1.default.join(node_os_1.default.homedir(), '.local', 'bin', 'chatter');
    try {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(link), { recursive: true });
        // lstat: only ever replace a symlink or create fresh — never delete a
        // regular file someone else installed at this path.
        let st = null;
        try {
            st = node_fs_1.default.lstatSync(link);
        }
        catch { /* absent */ }
        if (st && !st.isSymbolicLink()) {
            console.error(`${link} exists and is not a symlink — leaving it alone`);
            return;
        }
        const current = st ? node_fs_1.default.readlinkSync(link) : null;
        if (node_path_1.default.resolve(node_path_1.default.dirname(link), current || '') !== node_path_1.default.resolve(target)) {
            node_fs_1.default.rmSync(link, { force: true });
            node_fs_1.default.symlinkSync(node_path_1.default.resolve(target), link);
        }
    }
    catch (e) {
        console.error(`symlink setup failed: ${errorMessage(e)}`);
    }
}
// Herdr told us a pane or worktree died: roster rows bound to those panes
// become departed (bookkeeping only — chatter never kills anything itself).
// Pane ids are never reused, so this signal is exact.
function hookReap() {
    const raw = process.env.HERDR_PLUGIN_EVENT_JSON || '';
    // pane.closed events name the exact pane; worktree.removed / workspace
    // teardown events name only the WORKSPACE — and pane ids are
    // workspace-qualified (w5:p1), so a dead workspace retires every roster
    // row whose pane lives under it.
    const event = process.env.HERDR_PLUGIN_EVENT || '';
    const panes = [...new Set([...raw.matchAll(/"(w\d+:p[A-Za-z0-9]+)"/g)].flatMap((m) => m[1] ? [m[1]] : []))];
    // Workspace-wide reaping ONLY for workspace-level teardown events — a
    // pane.closed payload may mention its workspace, and one closed pane must
    // never retire the whole workspace's team.
    const workspaces = event.startsWith('worktree.') || event.startsWith('workspace.')
        ? [...new Set([...raw.matchAll(/"(w\d+)"/g)].flatMap((m) => m[1] ? [m[1]] : []))]
        : [];
    if (!panes.length && !workspaces.length)
        return;
    let n = 0;
    for (const f of (0, db_1.listRepoDbFiles)()) {
        const d = (0, db_1.openDbFile)(f);
        const doomed = new Set();
        for (const pane of panes) {
            for (const r of d.prepare('SELECT name FROM agents WHERE pane_id = ? AND departed_at IS NULL').all(pane))
                doomed.add(r.name);
        }
        for (const ws of workspaces) {
            for (const r of d.prepare("SELECT name FROM agents WHERE pane_id LIKE ? AND departed_at IS NULL").all(`${ws}:%`))
                doomed.add(r.name);
        }
        for (const name of doomed) {
            d.prepare('UPDATE agents SET departed_at = ? WHERE name = ?').run((0, db_1.now)(), name);
            (0, db_1.logEvent)('system', 'agent_departed', name, { via: 'reap' }, d);
            n++;
        }
    }
    if (n)
        console.log(`marked ${n} agent(s) departed`);
}
// Human-only manual retirement (for departures the event hook missed):
// marks the row departed and drops its still-queued mail.
function cmdForget(me, args) {
    humanOnly(me, 'chatter forget');
    const name = (args[0] || '').replace(/^@/, '');
    if (!name)
        (0, util_1.die)('usage: chatter forget <agent>');
    const d = (0, db_1.db)();
    const row = d.prepare('SELECT name, departed_at FROM agents WHERE name = ?').get(name);
    if (!row)
        (0, util_1.die)(`no roster entry for "${name}" — see: chatter agents --all`);
    if (!row.departed_at) {
        d.prepare('UPDATE agents SET departed_at = ? WHERE name = ?').run((0, db_1.now)(), name);
        (0, db_1.logEvent)(me.name, 'agent_departed', name, { by: 'forget' });
    }
    const dropped = d.prepare('DELETE FROM messages WHERE to_agent = ? AND delivered_at IS NULL').run(name).changes;
    console.log(`@${name} marked departed${dropped ? `, dropped ${dropped} queued message(s)` : ''} — history kept`);
}
// Hooks have no single repo context: flush every repo's queue.
function flushAllRepos() {
    let n = 0;
    for (const f of (0, db_1.listRepoDbFiles)())
        n += (0, team_1.flushPending)((0, db_1.openDbFile)(f));
    return n;
}
function hookStartup() {
    ensurePointerAndSymlink();
    // First run on this machine? Nudge toward setup (best effort — reaches
    // only users with toasts already on; harmless otherwise).
    if (!node_fs_1.default.existsSync(node_path_1.default.join((0, db_1.configRoot)(), 'name'))) {
        (0, herdr_1.herdr)(['notification', 'show', 'chatter installed',
            '--body', 'finish setup: herdr plugin action invoke chatter.setup', '--sound', 'none']);
    }
    const n = flushAllRepos();
    console.log(`chatter startup: ready${n ? `, flushed ${n} queued message(s)` : ''}`);
}
function hookFlush() {
    // Runs on pane.agent_status_changed — must be cheap when idle.
    const n = flushAllRepos();
    if (n)
        console.log(`flushed ${n}`);
}
// Placement decides the pane's lifetime: the manifest default is a popup
// (session-modal, Esc closes it); tab/split make it a persistent pane the
// human keeps open beside their work.
function openPane(entrypoint, placement = null) {
    const context = (0, herdr_1.pluginInvocationContext)(process.env.HERDR_PLUGIN_CONTEXT_JSON);
    if (!context.cwd) {
        (0, util_1.die)('Chatter needs an originating repository; focus a Herdr pane inside a Git repository and try again');
    }
    const repoRoot = (0, db_1.gitInfo)(context.cwd).repoRoot;
    if (!repoRoot) {
        (0, util_1.die)('Chatter needs an originating repository; focus a Herdr pane inside a Git repository and try again');
    }
    const args = ['plugin', 'pane', 'open', '--plugin', herdr_1.PLUGIN_ID, '--entrypoint', entrypoint];
    if (placement)
        args.push('--placement', placement);
    // Herdr popups are attached to the active pane and reject explicit targets;
    // tabs accept a workspace but reject target-pane. The repository env anchor
    // is authoritative for both placements even if UI focus changes meanwhile.
    if (placement === 'tab' && context.workspaceId)
        args.push('--workspace', context.workspaceId);
    args.push('--env', `CHATTER_REPO_ROOT=${repoRoot}`);
    const r = (0, herdr_1.herdr)(args);
    if (!r.ok) {
        console.error(r.raw);
        process.exit(1);
    }
}
const hookOpenBoard = () => openPane('board');
exports.hookOpenBoard = hookOpenBoard;
const hookOpenBoardTab = () => openPane('board', 'tab');
exports.hookOpenBoardTab = hookOpenBoardTab;
const hookOpenChat = () => openPane('chat');
exports.hookOpenChat = hookOpenChat;
const hookOpenChatTab = () => openPane('chat', 'tab');
exports.hookOpenChatTab = hookOpenChatTab;
