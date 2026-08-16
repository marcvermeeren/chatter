'use strict';
// Agent-facing commands and plugin hooks.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PLUGIN_ID, herdr, invalidateSessionAgents, matchLive } = require('./herdr');
const { db, dbFile, now, gitInfo, stateRoot, repoDbFile, openDbFile, listRepoDbFiles, logEvent } = require('./db');
const { whoami, sendMessage, flushPending, resolveRecipient, postToChat, chatUnreadCount, nameTaken, sanitizeName, teamAgents } = require('./team');
const { configRoot, humanName } = require('./db');
const { die, parseFlags, emit, age, toMs, median, fmtDur } = require('./util');
const { clean } = require('./tui');

const NOTE_TYPES = ['note', 'discovery', 'decision', 'dead-end', 'question'];

// ---------------------------------------------------------------- messaging

function cmdSend(me, args) {
  // Message bodies are raw text — only a trailing --queue is a flag, so
  // bodies containing "--anything" survive verbatim.
  const queue = args[args.length - 1] === '--queue';
  const rest = queue ? args.slice(0, -1) : args;
  const body = rest.slice(1).join(' ').trim();
  if (!rest[0] || !body) die('usage: chatter send <agent> <message...> [--queue]');
  const to = resolveRecipient(rest[0], { allowUnknown: queue });
  if (to === me.name) die('cannot message yourself');
  const res = sendMessage(me.name, to, body);
  console.log(res.delivered ? `delivered to ${to}` : `queued: ${res.reason}`);
}

// ---------------------------------------------------------------- group chat

function cmdPost(me, args) {
  const body = args.join(' ').trim();
  if (!body) die('usage: chatter post <text...>   (mention with @name; @everyone is human-only)');
  const { postId, pushed, warnings } = postToChat(me, body);
  for (const w of warnings) console.error(`warning: ${w}`);
  console.log(`posted to #chat (#${postId})${pushed.length ? `, pushed to ${pushed.join(', ')}` : ''}`);
}

function cmdChat(me, args) {
  const opts = parseFlags(args, { limit: null, all: false });
  const limit = opts.all ? '' : ` LIMIT ${parseInt(opts.limit, 10) || 30}`;
  const rows = db().prepare(`SELECT * FROM messages WHERE to_agent = '#chat' ORDER BY id DESC${limit}`).all().reverse();
  emit(rows, () => {
    if (!rows.length) { console.log('group chat is empty — post with: chatter post <text> (mention with @name)'); return; }
    for (const m of rows) console.log(`#${m.id} ${m.created_at} ${m.from_agent}: ${clean(m.body)}`);
  });
  const maxId = rows.length ? rows[rows.length - 1].id : 0;
  if (maxId) {
    db().prepare(`INSERT INTO chat_reads (agent, last_read_id) VALUES (?,?)
      ON CONFLICT(agent) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`).run(me.name, maxId);
  }
}

function cmdInbox(me, args) {
  const opts = parseFlags(args, { all: false });
  const rows = opts.all
    ? db().prepare('SELECT * FROM messages WHERE to_agent = ? OR from_agent = ? ORDER BY id DESC LIMIT 50').all(me.name, me.name).reverse()
    : db().prepare('SELECT * FROM messages WHERE to_agent = ? AND read_at IS NULL ORDER BY id').all(me.name);
  emit(rows, () => {
    if (!rows.length) { console.log(opts.all ? 'no messages' : 'no unread messages'); return; }
    for (const m of rows) {
      const tag = m.kind === 'chat' ? '' : ` [${m.kind}${m.ref_id ? ' ' + m.ref_id : ''}]`;
      console.log(`#${m.id} ${m.created_at} ${m.from_agent} -> ${m.to_agent}${tag}: ${clean(m.body)}`);
    }
  });
  if (!opts.all && rows.length) {
    db().prepare(`UPDATE messages SET read_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id IN (${rows.map((m) => m.id).join(',')})`)
      .run(now(), now());
  }
}

function cmdLog(_me, args) {
  const opts = parseFlags(args, { grep: null, task: null, limit: null, all: false });
  const cond = ['1=1'], params = [];
  if (opts.task) { cond.push('ref_id = ?'); params.push(opts.task); }
  const limit = opts.all ? '' : ` LIMIT ${parseInt(opts.limit, 10) || 40}`;
  let rows = db().prepare(`SELECT * FROM messages WHERE ${cond.join(' AND ')} ORDER BY id DESC${limit}`).all(...params);
  if (opts.grep) {
    let re; try { re = new RegExp(opts.grep, 'i'); } catch { re = null; }
    rows = rows.filter((m) => re
      ? re.test(m.body) || re.test(m.from_agent) || re.test(m.to_agent)
      : (m.body + m.from_agent + m.to_agent).toLowerCase().includes(opts.grep.toLowerCase()));
  }
  emit(rows, () => {
    for (const m of [...rows].reverse()) {
      const st = m.read_at ? '' : m.delivered_at ? ' (unread)' : ' (queued)';
      console.log(`#${m.id} ${m.created_at} ${m.from_agent} -> ${m.to_agent}: ${clean(m.body)}${st}`);
    }
    if (!rows.length) console.log('no messages match');
  });
}

// ------------------------------------------------------------------ roster

function inProgressTasksByAssignee() {
  const rows = db().prepare("SELECT assignee, id, title FROM tasks WHERE status = 'in_progress'").all();
  return Object.fromEntries(rows.map((t) => [t.assignee, t]));
}

// The one identity rendering: display label with the canonical handle always
// visible. Collapses when there is no label (or label ≈ handle) — never an
// empty "· @name". Labels are descriptive; only the @handle is addressable.
function identity(name, role) {
  const label = (role || '').trim();
  if (!label || sanitizeName(label) === name) return `@${name}`;
  return `${label} · @${name}`;
}

function cmdAgents(me, args = []) {
  const all = args.includes('--all');
  const live = teamAgents(); // this repo's team only — never the whole session
  const registered = db().prepare(
    all ? 'SELECT * FROM agents ORDER BY name' : 'SELECT * FROM agents WHERE departed_at IS NULL ORDER BY name'
  ).all();
  const taskBy = inProgressTasksByAssignee();
  const rows = registered.map((a) => {
    const l = matchLive(live, a);
    return { ...a, status: a.departed_at ? 'departed' : (l ? l.agent_status : 'offline'), task: taskBy[a.name] || null };
  });
  const open = openQuestions();
  emit(rows, () => {
    const known = new Set(registered.map((a) => a.name));
    const row = (mark, who, status, branch, tail) =>
      `${mark} ${who.padEnd(30)} ${status.padEnd(9)} ${(branch || '-').padEnd(20)} ${tail}`.trimEnd();
    const lines = rows.map((a) =>
      row(a.name === me.name ? '*' : ' ', identity(a.name, a.role), a.status, a.branch, a.task ? `${a.task.id} ${a.task.title}` : ''));
    for (const l of live) {
      if (l.name && !known.has(l.name)) lines.push(row(' ', `@${l.name}`, l.agent_status, null, '(not yet on chatter)'));
      if (!l.name) lines.push(row(' ', 'pane:' + l.pane_id, l.agent_status, null, `(unnamed ${l.agent || 'agent'})`));
    }
    console.log(lines.length ? row(' ', 'AGENT', 'STATUS', 'BRANCH', 'TASK') + '\n' + lines.join('\n') : 'no agents');
    if (open.length) console.log(`\n${open.length} open question${open.length > 1 ? 's' : ''} (${open.map((q) => '#' + q.id).join(' ')}) — chatter questions`);
    const unread = chatUnreadCount(me.name);
    if (unread) console.log(`#chat: ${unread} unread (chatter chat)`);
  });
}

function cmdWhoami(me) {
  const where = me.paneId ? `pane ${me.paneId}` : 'not inside a Herdr pane';
  console.log(`${me.name}${me.human ? ' (human' : ' ('}${me.human ? ', ' + where : where})`);
}

// Set the human's chat name (stored in the plugin config dir, global).
function cmdIam(me, args) {
  humanOnly(me, 'chatter iam');
  const fsx = require('node:fs');
  if (!args[0]) { console.log(`you are "${humanName()}" — change with: chatter iam <name>`); return; }
  const name = args[0].toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 32);
  if (!name) die('usage: chatter iam <name>');
  // A collision would silently redirect that agent's mail to the human.
  const taken = nameTaken(name);
  if (taken) die(`"${name}" is ${taken} — pick another`);
  fsx.mkdirSync(configRoot(), { recursive: true });
  fsx.writeFileSync(path.join(configRoot(), 'name'), name + '\n');
  console.log(`you are now "${name}" — agents can reach you with: chatter send ${name} "..." or @${name} in #chat`);
}

// ------------------------------------------------------------------- notes

function cmdNote(me, args) {
  const opts = parseFlags(args, { type: 'note', task: null, commit: null });
  const text = opts._.join(' ').trim();
  if (!text) die('usage: chatter note <text> [--type discovery|decision|dead-end] [--task TASK-n] [--commit SHA]');
  if (!NOTE_TYPES.includes(opts.type)) console.error(`warning: unusual note type "${opts.type}" (known: ${NOTE_TYPES.join(', ')})`);
  const r = db().prepare('INSERT INTO notes (author, type, text, task_id, commit_sha, created_at) VALUES (?,?,?,?,?,?)')
    .run(me.name, opts.type, text, opts.task, opts.commit, now());
  logEvent(me.name, 'note_created', `#${r.lastInsertRowid}`, { type: opts.type });
  console.log(`note #${r.lastInsertRowid} saved`);
}

function cmdNotes(_me, args) {
  const opts = parseFlags(args, { all: false });
  const q = opts._.join(' ').trim();
  const where = opts.all ? '1=1' : "status = 'active'";
  const rows = q
    ? db().prepare(`SELECT * FROM notes WHERE ${where} AND text LIKE ? ORDER BY id DESC LIMIT 100`).all(`%${q}%`)
    : db().prepare(`SELECT * FROM notes WHERE ${where} ORDER BY id DESC LIMIT 100`).all();
  emit(rows, () => {
    if (!rows.length) { console.log(q ? `no notes matching "${q}"` : 'no notes yet'); return; }
    for (const n of [...rows].reverse()) {
      const refs = [n.task_id, n.commit_sha && n.commit_sha.slice(0, 8)].filter(Boolean).join(' ');
      const st = n.status === 'active' ? '' : ` (${n.status}${n.superseded_by ? ` by #${n.superseded_by}` : ''})`;
      console.log(`#${n.id} [${n.type}] ${n.author}: ${clean(n.text)}${refs ? `  (${refs})` : ''}${st}`);
    }
  });
}

function cmdResolve(_me, args) {
  const id = parseInt(args[0], 10);
  if (!id) die('usage: chatter resolve <note-id>');
  const r = db().prepare("UPDATE notes SET status = 'superseded' WHERE id = ? AND status = 'active'").run(id);
  if (r.changes) logEvent(_me.name, 'note_resolved', `#${id}`);
  console.log(r.changes ? `note #${id} marked superseded` : `note #${id} not found or already resolved`);
}

// --------------------------------------------------------------- questions

function openQuestions() {
  return db().prepare("SELECT * FROM notes WHERE type = 'question' AND status = 'active' ORDER BY id").all();
}

function cmdAsk(me, args) {
  if (!args.length) die('usage: chatter ask [agent] <question...>');
  let target = null, words = args;
  if (args.length > 1) {
    const hit = resolveRecipient(args[0], { soft: true });
    if (hit) { target = hit; words = args.slice(1); }
  }
  const text = words.join(' ').trim();
  if (!text) die('usage: chatter ask [agent] <question...>');
  const id = db().prepare('INSERT INTO notes (author, type, text, created_at) VALUES (?,?,?,?)')
    .run(me.name, 'question', text, now()).lastInsertRowid;
  logEvent(me.name, 'question_opened', `#${id}`, target ? { to: target } : null);
  let out = `question #${id} opened`;
  if (target) {
    const res = sendMessage(me.name, target, `question #${id}: ${text} (answer with: chatter answer ${id} "...")`, 'system', `q${id}`);
    out += res.delivered ? `, delivered to ${target}` : `, queued for ${target} (${res.reason})`;
  } else {
    out += ' (open to anyone — visible in chatter questions)';
  }
  console.log(out);
}

function cmdAnswer(me, args) {
  const id = parseInt(args[0], 10);
  const text = args.slice(1).join(' ').trim();
  if (!id || !text) die('usage: chatter answer <question-id> <text...>');
  const q = db().prepare("SELECT * FROM notes WHERE id = ? AND type = 'question'").get(id);
  if (!q) die(`question #${id} not found`);
  if (q.status !== 'active') die(`question #${id} is already ${q.status}`);
  const replyId = db().prepare('INSERT INTO notes (author, type, text, created_at) VALUES (?,?,?,?)')
    .run(me.name, 'note', `answer to #${id}: ${text}`, now()).lastInsertRowid;
  db().prepare("UPDATE notes SET status = 'resolved', superseded_by = ? WHERE id = ?").run(replyId, id);
  logEvent(me.name, 'question_answered', `#${id}`);
  let out = `question #${id} answered (note #${replyId})`;
  if (q.author !== me.name) {
    const res = sendMessage(me.name, q.author, `answer to your question #${id} ("${q.text}"): ${text}`, 'system', `q${id}`);
    out += res.delivered ? `, delivered to ${q.author}` : `, queued for ${q.author}`;
  }
  console.log(out);
}

function cmdQuestions(_me, args) {
  const opts = parseFlags(args, { all: false });
  if (!opts.all) {
    const rows = openQuestions();
    emit(rows, () => {
      if (!rows.length) { console.log('no open questions'); return; }
      for (const r of rows) console.log(`#${r.id} (${age(r.created_at)} old) ${r.author}: ${clean(r.text)}  (answer: chatter answer ${r.id} "...")`);
    });
    return;
  }
  const rows = db().prepare("SELECT * FROM notes WHERE type = 'question' ORDER BY id").all();
  const answerIds = rows.map((r) => r.superseded_by).filter(Boolean);
  const answers = answerIds.length
    ? Object.fromEntries(db().prepare(`SELECT * FROM notes WHERE id IN (${answerIds.join(',')})`).all().map((a) => [a.id, a]))
    : {};
  emit(rows.map((r) => ({ ...r, answer: answers[r.superseded_by] || null })), () => {
    if (!rows.length) { console.log('no questions'); return; }
    for (const r of rows) {
      console.log(`#${r.id} [${r.status}] ${r.author}: ${clean(r.text)}`);
      const a = answers[r.superseded_by];
      if (a) console.log(`    -> ${a.author}: ${clean(a.text).replace(/^answer to #\d+: /, '')}`);
    }
  });
}

// ------------------------------------------------------------------- tasks

function taskLabel(t) {
  const mark = t.status === 'done' ? 'x' : t.status === 'in_progress' ? '>' : ' ';
  return `[${mark}] ${t.id} ${t.title}${t.assignee ? `  (@${t.assignee})` : ''}${t.commit_sha ? `  ${t.commit_sha.slice(0, 8)}` : ''}`;
}

function nextTaskId() {
  const row = db().prepare("SELECT MAX(CAST(substr(id, 6) AS INTEGER)) AS n FROM tasks").get();
  return `TASK-${(row.n || 0) + 1}`;
}

function notifyAssignment(me, task) {
  if (task.assignee && task.assignee !== me.name) {
    sendMessage(me.name, task.assignee, `you were assigned ${task.id}: ${task.title} (details: chatter task list)`, 'system', task.id);
  }
}

function cmdTask(me, args) {
  const sub = args[0];
  if (sub === 'create') {
    const opts = parseFlags(args.slice(1), { assignee: null });
    const title = opts._.join(' ').trim();
    if (!title) die('usage: chatter task create <title> [--assignee agent]');
    const assignee = opts.assignee ? resolveRecipient(opts.assignee) : null;
    // ID allocation + insert must be atomic: concurrent creates otherwise
    // race MAX+1 into duplicate primary keys.
    let id = null;
    for (let attempt = 0; attempt < 5 && !id; attempt++) {
      try {
        db().exec('BEGIN IMMEDIATE');
        const candidate = nextTaskId();
        db().prepare('INSERT INTO tasks (id, title, status, assignee, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(candidate, title, assignee ? 'in_progress' : 'open', assignee, me.name, now(), now());
        db().exec('COMMIT');
        id = candidate;
      } catch (e) {
        try { db().exec('ROLLBACK'); } catch { /* not in tx */ }
        if (attempt === 4) throw e;
      }
    }
    logEvent(me.name, 'task_created', id, { title, assignee });
    if (assignee) logEvent(me.name, 'task_assigned', id, { to: assignee });
    console.log(`${id} created${assignee ? ` and assigned to ${assignee}` : ''}`);
    notifyAssignment(me, { id, title, assignee });
  } else if (sub === 'list') {
    const rows = db().prepare("SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, id").all();
    emit(rows, () => {
      if (!rows.length) { console.log('no tasks'); return; }
      for (const t of rows) console.log(taskLabel(t));
    });
  } else if (sub === 'assign') {
    const id = args[1];
    const agent = args[2] && resolveRecipient(args[2]);
    if (!id || !agent) die('usage: chatter task assign <TASK-n> <agent>');
    const t = db().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!t) die(`${id} not found`);
    db().prepare("UPDATE tasks SET assignee = ?, status = 'in_progress', updated_at = ? WHERE id = ?").run(agent, now(), id);
    logEvent(me.name, 'task_assigned', id, { to: agent });
    console.log(`${id} assigned to ${agent}`);
    notifyAssignment(me, { ...t, assignee: agent });
  } else if (sub === 'done') {
    const opts = parseFlags(args.slice(1), { commit: null });
    const id = opts._[0];
    if (!id) die('usage: chatter task done <TASK-n> [--commit SHA]');
    const r = db().prepare("UPDATE tasks SET status = 'done', commit_sha = COALESCE(?, commit_sha), updated_at = ? WHERE id = ?").run(opts.commit, now(), id);
    if (!r.changes) die(`${id} not found`);
    db().prepare("UPDATE handoffs SET status = 'done' WHERE task_id = ? AND status != 'done'").run(id);
    logEvent(me.name, 'task_done', id, opts.commit ? { commit: opts.commit } : null);
    console.log(`${id} done${opts.commit ? ` (${opts.commit.slice(0, 8)})` : ''}`);
  } else {
    die('usage: chatter task create|list|assign|done ...');
  }
}

// ---------------------------------------------------------------- handoffs

function cmdHandoff(me, args) {
  if (args[0] === 'show') {
    const h = db().prepare('SELECT * FROM handoffs WHERE id = ?').get(parseInt(args[1], 10));
    if (!h) die(`handoff h${args[1]} not found`);
    const t = h.task_id ? db().prepare('SELECT * FROM tasks WHERE id = ?').get(h.task_id) : null;
    console.log(JSON.stringify({
      id: `h${h.id}`, task: h.task_id, task_title: t ? t.title : undefined,
      from: h.from_agent, to: h.to_agent, summary: h.summary,
      branch: h.branch, commit: h.commit_sha,
      files: h.files_json ? JSON.parse(h.files_json) : [],
      tests: h.tests, next: h.next_steps, status: h.status, created_at: h.created_at,
    }, null, 2));
    return;
  }
  const opts = parseFlags(args, { summary: null, branch: null, commit: null, files: null, tests: null, next: null });
  const taskId = opts._[0];
  const to = opts._[1] && resolveRecipient(opts._[1]);
  if (!taskId || !to || !opts.summary) {
    die('usage: chatter handoff <TASK-n> <agent> --summary S [--branch B] [--commit C] [--files a,b] [--tests CMD] [--next TEXT]\n       chatter handoff show <id>');
  }
  const task = db().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) die(`${taskId} not found — create it first: chatter task create <title>`);
  // Fill git context from the caller's worktree when not given explicitly.
  const branch = opts.branch || gitInfo(process.cwd()).branch;
  const files = opts.files ? opts.files.split(',').map((s) => s.trim()).filter(Boolean) : [];
  // One transaction: a crash mid-handoff must not leave ownership, the
  // handoff record, and the audit note disagreeing.
  let hid;
  db().exec('BEGIN IMMEDIATE');
  try {
    hid = db().prepare(`INSERT INTO handoffs (task_id, from_agent, to_agent, summary, branch, commit_sha, files_json, tests, next_steps, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(taskId, me.name, to, opts.summary, branch, opts.commit, JSON.stringify(files), opts.tests, opts.next, now()).lastInsertRowid;
    db().prepare("UPDATE tasks SET assignee = ?, status = 'in_progress', updated_at = ? WHERE id = ?").run(to, now(), taskId);
    db().prepare('INSERT INTO notes (author, type, text, task_id, commit_sha, created_at) VALUES (?,?,?,?,?,?)')
      .run(me.name, 'note', `handed off ${taskId} to ${to}: ${opts.summary}`, taskId, opts.commit, now());
    db().exec('COMMIT');
  } catch (e) {
    try { db().exec('ROLLBACK'); } catch { /* not in tx */ }
    throw e;
  }
  logEvent(me.name, 'handoff_created', `h${hid}`, { task: taskId, to });
  logEvent(me.name, 'task_assigned', taskId, { to, via: `h${hid}` });
  const parts = [`${taskId} ${opts.summary}`];
  if (branch) parts.push(`branch ${branch}`);
  if (opts.commit) parts.push(`commit ${opts.commit.slice(0, 12)}`);
  if (opts.next) parts.push(`next: ${opts.next}`);
  parts.push(`full details: chatter handoff show ${hid}`);
  const res = sendMessage(me.name, to, parts.join(' | '), 'handoff', `h${hid}`);
  console.log(`h${hid} created; ${res.delivered ? `delivered to ${to}` : `queued: ${res.reason}`}`);
}

// ------------------------------------------------------------------- stats

function cmdStats() {
  const allMsgs = db().prepare('SELECT * FROM messages').all();
  const posts = allMsgs.filter((m) => m.to_agent === '#chat');
  const msgs = allMsgs.filter((m) => m.to_agent !== '#chat');
  const tasks = db().prepare('SELECT * FROM tasks').all();
  const handoffs = db().prepare('SELECT * FROM handoffs').all();
  const notes = db().prepare('SELECT * FROM notes').all();
  const pairs = {};
  for (const m of msgs) pairs[`${m.from_agent} -> ${m.to_agent}`] = (pairs[`${m.from_agent} -> ${m.to_agent}`] || 0) + 1;
  const byType = {};
  for (const n of notes) byType[n.type] = (byType[n.type] || 0) + 1;
  const qs = notes.filter((n) => n.type === 'question');
  const qAnswered = qs.filter((q) => q.status === 'resolved' && q.superseded_by);
  const noteById = new Map(notes.map((n) => [n.id, n]));
  const openQs = qs.filter((q) => q.status === 'active');
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const stats = {
    messages: {
      total: msgs.length,
      queued: msgs.filter((m) => !m.delivered_at).length,
      median_delivery: median(msgs.filter((m) => m.delivered_at).map((m) => toMs(m.delivered_at) - toMs(m.created_at))),
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
      median_open_to_done: median(tasks.filter((t) => t.status === 'done').map((t) => toMs(t.updated_at) - toMs(t.created_at))),
    },
    handoffs: {
      total: handoffs.length,
      completed: handoffs.filter((h) => h.status === 'done').length,
      median_handoff_to_done: median(handoffs.filter((h) => h.status === 'done' && taskById.get(h.task_id))
        .map((h) => toMs(taskById.get(h.task_id).updated_at) - toMs(h.created_at))),
    },
    notes: {
      by_type: byType,
      superseded: notes.filter((n) => n.status !== 'active' && n.type !== 'question').length,
    },
    questions: {
      open: openQs.length,
      resolved: qAnswered.length,
      median_time_to_answer: median(qAnswered.filter((q) => noteById.get(q.superseded_by))
        .map((q) => toMs(noteById.get(q.superseded_by).created_at) - toMs(q.created_at))),
      oldest_open_age_ms: openQs.length ? Date.now() - toMs(openQs[0].created_at) : null,
    },
  };
  emit(stats, () => {
    const s = stats;
    console.log(`messages   ${s.messages.total} total, ${s.messages.queued} queued, median delivery ${fmtDur(s.messages.median_delivery)}`);
    for (const [pair, n] of Object.entries(s.messages.by_pair)) console.log(`             ${pair}: ${n}`);
    console.log(`#chat      ${s.chat.posts} posts (${Object.entries(s.chat.by_author).map(([a, n]) => `${a}: ${n}`).join(', ') || 'none'}), ${s.chat.mentions_pushed} mention pushes`);
    console.log(`tasks      ${s.tasks.open} open, ${s.tasks.in_progress} in progress, ${s.tasks.done} done, median open->done ${fmtDur(s.tasks.median_open_to_done)}`);
    console.log(`handoffs   ${s.handoffs.total} total, ${s.handoffs.completed} completed, median handoff->done ${fmtDur(s.handoffs.median_handoff_to_done)}`);
    console.log(`notes      ${Object.entries(s.notes.by_type).map(([t, n]) => `${n} ${t}`).join(', ') || 'none'}${s.notes.superseded ? `, ${s.notes.superseded} superseded` : ''}`);
    console.log(`questions  ${s.questions.open} open, ${s.questions.resolved} resolved, median time-to-answer ${fmtDur(s.questions.median_time_to_answer)}${s.questions.oldest_open_age_ms ? `, oldest open ${fmtDur(s.questions.oldest_open_age_ms)}` : ''}`);
  });
}

// ------------------------------------------------------------------- brief

const tsOf = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function briefWindow(me, d, arg) {
  if (arg === 'today') { const t = new Date(); t.setHours(0, 0, 0, 0); return { since: tsOf(t.getTime()), explicit: true }; }
  const m = arg && arg.match(/^(\d+)([hm])$/);
  if (m) return { since: tsOf(Date.now() - parseInt(m[1], 10) * (m[2] === 'h' ? 3600e3 : 60e3)), explicit: true };
  if (arg) die(`usage: chatter brief [today|2h|30m] — got "${arg}"`);
  const mark = d.prepare("SELECT value FROM ui_marks WHERE agent = ? AND mark = 'brief'").get(me.name);
  return { since: (mark && mark.value) || tsOf(Date.now() - 24 * 3600e3), explicit: false };
}

// Deterministic catch-up: what changed since the caller last looked.
function buildBrief(me, d = db(), arg = null) {
  const { since, explicit } = briefWindow(me, d, arg);
  const ev = (kind) => d.prepare('SELECT * FROM events WHERE kind = ? AND at > ? ORDER BY id').all(kind, since);
  const lines = [];
  const taskTitle = (id) => { const t = d.prepare('SELECT title FROM tasks WHERE id = ?').get(id); return t ? t.title : ''; };
  for (const e of ev('task_done')) lines.push(`✓ ${e.ref} ${taskTitle(e.ref)} — completed by ${e.actor}`);
  for (const e of ev('task_created')) {
    const t = d.prepare('SELECT * FROM tasks WHERE id = ?').get(e.ref);
    if (t && t.status === 'open') lines.push(`+ ${e.ref} ${t.title} — new, unassigned (by ${e.actor})`);
  }
  for (const t of d.prepare("SELECT * FROM tasks WHERE status = 'in_progress' ORDER BY id").all()) {
    lines.push(`→ ${t.assignee || '?'} is on ${t.id} ${t.title}`);
  }
  for (const q of d.prepare("SELECT * FROM notes WHERE type = 'question' AND status = 'active' ORDER BY id").all()) {
    lines.push(`? question #${q.id} open ${age(q.created_at)} (${q.author}): ${clean(q.text).slice(0, 70)}`);
  }
  for (const e of ev('handoff_created')) {
    const x = e.data ? JSON.parse(e.data) : {};
    lines.push(`⇄ ${e.actor} handed ${x.task || ''} to ${x.to || '?'} (${e.ref})`);
  }
  for (const n of d.prepare("SELECT * FROM notes WHERE type IN ('decision','dead-end') AND created_at > ? ORDER BY id").all(since)) {
    lines.push(`◆ [${n.type}] ${n.author}: ${clean(n.text).slice(0, 70)}`);
  }
  const dms = d.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_agent = ? AND read_at IS NULL AND kind != 'mention'").get(me.name).n;
  const unreadChat = chatUnreadCount(me.name, d);
  if (dms || unreadChat) lines.push(`✉ ${dms ? `${dms} unread DM${dms > 1 ? 's' : ''}` : ''}${dms && unreadChat ? ' · ' : ''}${unreadChat ? `#chat: ${unreadChat} unread` : ''}`);
  const counts = {};
  for (const a of teamAgents(d)) counts[a.agent_status] = (counts[a.agent_status] || 0) + 1;
  const stuck = d.prepare(`SELECT COUNT(*) AS n FROM messages m JOIN agents a ON a.name = m.to_agent
    WHERE m.delivered_at IS NULL AND a.departed_at IS NOT NULL`).get().n;
  if (stuck) lines.push(`⚠ ${stuck} message${stuck > 1 ? 's' : ''} queued for departed agents (chatter forget <name> cleans up)`);
  lines.push(`agents: ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ') || 'none live'}`);
  if (!explicit) {
    d.prepare(`INSERT INTO ui_marks (agent, mark, value) VALUES (?, 'brief', ?)
      ON CONFLICT(agent, mark) DO UPDATE SET value = excluded.value`).run(me.name, now());
  }
  return { since, lines: lines.length > 1 ? lines : [...lines, '(quiet — nothing new)'] };
}

function cmdBrief(me, args) {
  const b = buildBrief(me, db(), args[0] || null);
  emit(b, () => {
    console.log(`since ${b.since}:`);
    for (const l of b.lines) console.log(`  ${l}`);
  });
}

// ------------------------------------------------------------- data control

// Everything chatter stores is local SQLite under the plugin state dir.
// These commands make that visible and deletable.
function repoUniverses() {
  return listRepoDbFiles().map((f) => {
    const d = openDbFile(f);
    const count = (t) => d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    const mark = d.prepare("SELECT value FROM ui_marks WHERE agent = '_repo' AND mark = 'root'").get();
    const root = mark ? { repo_root: mark.value }
      : d.prepare('SELECT repo_root FROM agents WHERE repo_root IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1').get();
    const last = d.prepare('SELECT MAX(created_at) AS t FROM messages').get().t
      || d.prepare('SELECT MAX(at) AS t FROM events').get().t;
    let bytes = 0;
    for (const suffix of ['', '-wal', '-shm']) { try { bytes += fs.statSync(f + suffix).size; } catch { /* absent */ } }
    return {
      key: path.basename(path.dirname(f)),
      dir: path.dirname(f),
      repo_root: root ? root.repo_root : null,
      orphan: !!(root && root.repo_root && !fs.existsSync(root.repo_root)),
      messages: count('messages'), notes: count('notes'), tasks: count('tasks'), events: count('events'),
      last_activity: last || null,
      bytes,
    };
  });
}

// Global administration is human-only: a confused or prompt-injected agent
// must stay contained to its repo (honor-system tier, like the repo boundary).
function humanOnly(me, what) {
  if (!me.human) die(`${what} is human-only — agents administer nothing outside their repo`);
}

function cmdData(me) {
  humanOnly(me, 'chatter data');
  const rows = repoUniverses();
  emit(rows, () => {
    if (!rows.length) { console.log('no chatter data stored yet'); return; }
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
  const opts = parseFlags(args, { yes: false, orphans: false, all: false, 'older-than': null });
  const rows = repoUniverses();
  let targets = [];
  if (opts.all) targets = rows;
  else if (opts.orphans) targets = rows.filter((r) => r.orphan);
  else if (opts['older-than']) {
    const m = opts['older-than'].match(/^(\d+)([dh])$/);
    if (!m) die('usage: chatter purge --older-than <Nd|Nh> [--yes]  (trims old messages+events in the current repo)');
    const cutoff = new Date(Date.now() - parseInt(m[1], 10) * (m[2] === 'd' ? 86400e3 : 3600e3))
      .toISOString().replace('T', ' ').slice(0, 19);
    const d = db();
    const nm = d.prepare('SELECT COUNT(*) AS n FROM messages WHERE created_at < ?').get(cutoff).n;
    const ne = d.prepare('SELECT COUNT(*) AS n FROM events WHERE at < ?').get(cutoff).n;
    if (!opts.yes) { console.log(`would trim ${nm} messages and ${ne} events older than ${cutoff} — add --yes to execute`); return; }
    d.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
    d.prepare('DELETE FROM events WHERE at < ?').run(cutoff);
    console.log(`trimmed ${nm} messages and ${ne} events`);
    return;
  } else if (opts._[0]) {
    targets = rows.filter((r) => r.key === opts._[0] || r.key.startsWith(opts._[0] + '-') || r.key.replace(/-[0-9a-f]{8}$/, '') === opts._[0]);
    if (!targets.length) die(`no stored universe matches "${opts._[0]}" — see: chatter data`);
  } else {
    die('usage: chatter purge <repo-name> | --orphans | --all | --older-than 30d   (dry run; add --yes to execute)');
  }
  if (!targets.length) { console.log('nothing to purge'); return; }
  for (const t of targets) {
    const line = `${t.key}: ${t.messages} messages, ${t.notes} notes, ${t.tasks} tasks, ${t.events} events`;
    if (opts.yes) { fs.rmSync(t.dir, { recursive: true, force: true }); console.log(`deleted ${line}`); }
    else console.log(`would delete ${line}`);
  }
  if (!opts.yes) console.log('\ndry run — add --yes to execute');
}

// ------------------------------------------------------------------- spawn

// Thin wrapper over Herdr: new tab in this repo, start the agent, name it,
// announce in #chat. Spawn only — no lifecycle management here.
// Never exits the process (also runs inside the chat popup).
function spawnAgent(me, { name: rawName, kind, purpose, tab = false, branch = null, base = null }, d = db()) {
  const fail = (msg) => ({ ok: false, lines: [msg] });
  if (!rawName) return fail('usage: spawn <name> [--kind codex|claude|pi|...] [--purpose "why"] [--branch B] [--base REF] [--tab]');
  const name = sanitizeName(rawName);
  const taken = nameTaken(name);
  if (taken) return fail(`"${name}" is ${taken} — pick another name`);
  const lines = [];
  if (!kind) {
    const kinds = teamAgents(d).map((a) => a.agent).filter(Boolean);
    kind = kinds.sort((a, b) => kinds.filter((k) => k === b).length - kinds.filter((k) => k === a).length)[0];
    if (!kind) return fail('no --kind given and no agents in this repo to infer one from (run: herdr agent  for installed kinds)');
    lines.push(`no kind given — using ${kind} (majority of this repo's agents)`);
  }
  // The spawn target repo comes from the DB handle, never process.cwd():
  // inside the chat popup, cwd is the plugin's own checkout.
  const mark = d.prepare("SELECT value FROM ui_marks WHERE agent = '_repo' AND mark = 'root'").get();
  const repoRoot = (mark && mark.value) || gitInfo().repoRoot;
  if (!repoRoot || repoDbFile(repoRoot) !== dbFile(d)) {
    return fail('cannot determine this universe\'s repo — run one chatter command from a shell in it first');
  }
  // Code setup: a fresh worktree by default — Chatter's own model says
  // worktrees isolate code. --tab shares this checkout (explicit exception,
  // fine for reviewers/helpers that don't write files).
  let pane, cleanup, whereLine;
  if (tab) {
    const tabArgs = ['tab', 'create', '--label', name, '--cwd', repoRoot, '--no-focus'];
    if (process.env.HERDR_WORKSPACE_ID) tabArgs.push('--workspace', process.env.HERDR_WORKSPACE_ID);
    const t = herdr(tabArgs);
    if (!t.ok) return fail(`could not create a tab: ${t.raw}`);
    pane = t.json.result.root_pane.pane_id;
    cleanup = () => herdr(['tab', 'close', t.json.result.tab.tab_id]);
    whereLine = `same checkout, new tab (${pane}) — shared files, coordinate carefully`;
  } else {
    const wtBranch = branch || `agents/${name}`;
    const wtArgs = ['worktree', 'create', '--cwd', repoRoot, '--branch', wtBranch, '--label', name, '--no-focus'];
    if (base) wtArgs.push('--base', base);
    const wt = herdr(wtArgs);
    if (!wt.ok) return fail(`could not create a worktree: ${wt.raw}`);
    const r = wt.json.result;
    pane = (r.root_pane && r.root_pane.pane_id) || (r.workspace && r.workspace.root_pane && r.workspace.root_pane.pane_id);
    if (!pane) return fail('worktree created but no pane returned — start the agent manually');
    const wtPath = r.worktree && r.worktree.path;
    cleanup = null; // never auto-remove a worktree — that's user data
    whereLine = `new worktree on ${wtBranch}${wtPath ? ` (${wtPath})` : ''} — isolated checkout`;
    lines.push(`cleanup when done: herdr worktree remove --path ${wtPath || '<worktree-path>'}`);
  }
  const start = herdr(['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', '60000']);
  if (!start.ok) {
    if (cleanup) cleanup();
    return fail(`agent start failed: ${start.raw}${cleanup ? '' : ' (worktree left in place)'}`);
  }
  herdr(['pane', 'rename', pane, name]); // pane label = role, feeds the roster
  invalidateSessionAgents(); // roster changed — the cached list predates the spawn
  // Boundary proof: the newcomer must verifiably belong to this universe
  // (teamAgents only returns repo-verified agents, so presence = proof).
  const verified = !!teamAgents(d).find((a) => a.name === name);
  logEvent(me.name, 'agent_spawned', name, { kind, by: me.name, purpose: purpose || null, tab: !!tab }, d);
  postToChat(me, `spawned ${name} (${kind})${purpose ? `: ${purpose}` : ''}`, d, () => null);
  lines.unshift(`@${name} is up (${kind}) — ${whereLine}`);
  lines.push(verified ? 'verified: joined this repo\'s universe' : 'warning: could not verify repo membership yet — its mail queues until it checks in');
  if (purpose) {
    const res = sendMessage(me.name, name, `you are "${name}". your purpose: ${purpose}`, 'system', null, d);
    lines.push(res.delivered ? 'purpose delivered to its session' : `purpose queued (${res.reason})`);
  }
  const status = start.json && start.json.result.agent ? start.json.result.agent.agent_status : 'unknown';
  if (status === 'blocked') lines.push('it is showing a startup dialog (trust/permissions) — click through it once');
  return { ok: true, lines };
}


function cmdSpawn(me, args) {
  const opts = parseFlags(args, { kind: null, purpose: null, tab: false, branch: null, base: null });
  const r = spawnAgent(me, {
    name: opts._[0], kind: opts.kind, purpose: opts.purpose,
    tab: opts.tab, branch: opts.branch, base: opts.base,
  });
  for (const l of r.lines) console.log(l);
  if (!r.ok) process.exit(1);
}

// ------------------------------------------------------------------- role

// Roles are Chatter UX; the pane label is just where they live. Humans can
// retitle anyone; an agent may only describe itself.
function setRole(me, target, text, d = db()) {
  const who = resolveRecipient(target.replace(/^@/, ''), { soft: true }, d);
  if (!who) return { ok: false, lines: [`no agent "${target}" in this repo`] };
  if (!me.human && who !== me.name) return { ok: false, lines: ['agents may only set their own role'] };
  const row = d.prepare('SELECT pane_id FROM agents WHERE name = ?').get(who);
  const live = teamAgents(d).find((a) => a.name === who);
  const pane = (live && live.pane_id) || (row && row.pane_id);
  const lines = [];
  if (pane && live) {
    const r = herdr(['pane', 'rename', pane, text]);
    lines.push(r.ok ? `pane label updated` : `pane label not updated (${r.raw}) — roster updated anyway`);
  } else {
    lines.push(`${who} is offline — roster updated; pane label applies when it returns`);
  }
  const updated = d.prepare('UPDATE agents SET role = ? WHERE name = ?').run(text, who);
  if (!updated.changes) { // live but not yet registered — seed a minimal row
    d.prepare('INSERT INTO agents (name, pane_id, role, registered_at, last_seen_at) VALUES (?,?,?,?,?)')
      .run(who, pane || null, text, now(), now());
  }
  lines.unshift(`${text} · @${who}`);
  return { ok: true, lines };
}

function cmdRole(me, args) {
  const target = args[0];
  const text = args.slice(1).join(' ').trim();
  if (!target || !text) die('usage: chatter role <agent> <display role...>   e.g. chatter role data-api "Data / API"');
  const r = setRole(me, target, text);
  for (const l of r.lines) console.log(l);
  if (!r.ok) process.exit(1);
}

// -------------------------------------------------------------------- help

function help() {
  const g = gitInfo();
  const dbPath = g.repoRoot ? repoDbFile(g.repoRoot) : `${stateRoot()}/repos/<repo>/chatter.db`;
  return `chatter — group chat, DMs, tasks and shared memory for this repo's coding agents

  chatter agents [--all]                who's online: role, branch, task (--all incl. departed)
  chatter send <agent> <message...>     DM an agent (lands in their session; --queue for absent agents)
  chatter inbox [--all]                 your unread messages (--all = history)
  chatter post <text...>                post to the repo group chat; @name pushes to that agent
  chatter chat [--limit N] [--all]      read the group chat (marks it read)
  chatter brief [today|2h|30m]          what changed since you last checked
  chatter note <text> [--type discovery|decision|dead-end] [--task TASK-n] [--commit SHA]
  chatter notes [query] [--all]         read/search the shared scratchpad
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

The human is "${humanName()}": DMs and @${humanName()} mentions reach them as a
Herdr toast notification, and they read/post like anyone else.

Chatter is scoped per repository: agents, chat, notes, and tasks are only
shared within this repo (all its worktrees). Record dead-ends (--type
dead-end) so teammates don't repeat failed investigations. Answer open
questions before they go stale.

Most read commands accept --json. Raw history: query the SQLite DB directly at
${dbPath}
(tables: agents, messages, notes, tasks, handoffs, chat_reads).

Code moves through Git (commit/branch refs in handoffs) — never edit another
agent's worktree. Chatter carries context, Git carries code.`;
}

// ------------------------------------------------------------- plugin hooks

function ensurePointerAndSymlink() {
  // Startup hook runs with plugin env; persist what bare CLI calls can't see.
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const cfgDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (stateDir && cfgDir) {
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'state-dir'), stateDir + '\n');
  }
  // Make `chatter` callable from any agent shell.
  const target = path.join(__dirname, '..', 'bin', 'chatter');
  const link = path.join(os.homedir(), '.local', 'bin', 'chatter');
  try {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    // lstat: only ever replace a symlink or create fresh — never delete a
    // regular file someone else installed at this path.
    let st = null;
    try { st = fs.lstatSync(link); } catch { /* absent */ }
    if (st && !st.isSymbolicLink()) {
      console.error(`${link} exists and is not a symlink — leaving it alone`);
      return;
    }
    const current = st ? fs.readlinkSync(link) : null;
    if (path.resolve(path.dirname(link), current || '') !== path.resolve(target)) {
      fs.rmSync(link, { force: true });
      fs.symlinkSync(path.resolve(target), link);
    }
  } catch (e) {
    console.error(`symlink setup failed: ${e.message}`);
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
  const panes = [...new Set([...raw.matchAll(/"(w\d+:p[A-Za-z0-9]+)"/g)].map((m) => m[1]))];
  // Workspace-wide reaping ONLY for workspace-level teardown events — a
  // pane.closed payload may mention its workspace, and one closed pane must
  // never retire the whole workspace's team.
  const workspaces = event.startsWith('worktree.') || event.startsWith('workspace.')
    ? [...new Set([...raw.matchAll(/"(w\d+)"/g)].map((m) => m[1]))]
    : [];
  if (!panes.length && !workspaces.length) return;
  let n = 0;
  for (const f of listRepoDbFiles()) {
    const d = openDbFile(f);
    const doomed = new Set();
    for (const pane of panes) {
      for (const r of d.prepare('SELECT name FROM agents WHERE pane_id = ? AND departed_at IS NULL').all(pane)) doomed.add(r.name);
    }
    for (const ws of workspaces) {
      for (const r of d.prepare("SELECT name FROM agents WHERE pane_id LIKE ? AND departed_at IS NULL").all(`${ws}:%`)) doomed.add(r.name);
    }
    for (const name of doomed) {
      d.prepare('UPDATE agents SET departed_at = ? WHERE name = ?').run(now(), name);
      logEvent('system', 'agent_departed', name, { via: 'reap' }, d);
      n++;
    }
  }
  if (n) console.log(`marked ${n} agent(s) departed`);
}

// Human-only manual retirement (for departures the event hook missed):
// marks the row departed and drops its still-queued mail.
function cmdForget(me, args) {
  humanOnly(me, 'chatter forget');
  const name = (args[0] || '').replace(/^@/, '');
  if (!name) die('usage: chatter forget <agent>');
  const d = db();
  const row = d.prepare('SELECT name, departed_at FROM agents WHERE name = ?').get(name);
  if (!row) die(`no roster entry for "${name}" — see: chatter agents --all`);
  if (!row.departed_at) {
    d.prepare('UPDATE agents SET departed_at = ? WHERE name = ?').run(now(), name);
    logEvent(me.name, 'agent_departed', name, { by: 'forget' });
  }
  const dropped = d.prepare('DELETE FROM messages WHERE to_agent = ? AND delivered_at IS NULL').run(name).changes;
  console.log(`@${name} marked departed${dropped ? `, dropped ${dropped} queued message(s)` : ''} — history kept`);
}

// Hooks have no single repo context: flush every repo's queue.
function flushAllRepos() {
  let n = 0;
  for (const f of listRepoDbFiles()) n += flushPending(openDbFile(f));
  return n;
}

function hookStartup() {
  ensurePointerAndSymlink();
  // First run on this machine? Nudge toward setup (best effort — reaches
  // only users with toasts already on; harmless otherwise).
  if (!fs.existsSync(path.join(configRoot(), 'name'))) {
    herdr(['notification', 'show', 'chatter installed',
      '--body', 'finish setup: herdr plugin action invoke chatter.setup', '--sound', 'none']);
  }
  const n = flushAllRepos();
  console.log(`chatter startup: ready${n ? `, flushed ${n} queued message(s)` : ''}`);
}

function hookFlush() {
  // Runs on pane.agent_status_changed — must be cheap when idle.
  const n = flushAllRepos();
  if (n) console.log(`flushed ${n}`);
}

function openPane(entrypoint) {
  const r = herdr(['plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', entrypoint]);
  if (!r.ok) { console.error(r.raw); process.exit(1); }
}
const hookOpenBoard = () => openPane('board');
const hookOpenChat = () => openPane('chat');

module.exports = {
  cmdSend, cmdInbox, cmdLog, cmdAgents, cmdWhoami, cmdIam, cmdPost, cmdChat,
  cmdNote, cmdNotes, cmdResolve, cmdAsk, cmdAnswer, cmdQuestions,
  cmdTask, cmdHandoff, cmdStats, cmdBrief, buildBrief, cmdData, cmdPurge, cmdSpawn, spawnAgent, cmdRole, setRole, cmdForget, hookReap,
  taskLabel, openQuestions, help, identity, ensurePointerAndSymlink, flushAllRepos,
  hookStartup, hookFlush, hookOpenBoard, hookOpenChat,
};
