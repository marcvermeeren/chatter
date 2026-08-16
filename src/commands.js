'use strict';
// Agent-facing commands and plugin hooks.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PLUGIN_ID, herdr, liveAgents, matchLive } = require('./herdr');
const { db, now, gitInfo, stateRoot, repoDbFile, openDbFile, listRepoDbFiles } = require('./db');
const { whoami, sendMessage, flushPending, resolveRecipient, postToChat, chatUnreadCount } = require('./team');
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

function cmdAgents(me) {
  const live = liveAgents();
  const registered = db().prepare('SELECT * FROM agents ORDER BY name').all();
  const taskBy = inProgressTasksByAssignee();
  const rows = registered.map((a) => {
    const l = matchLive(live, a);
    return { ...a, status: l ? l.agent_status : 'offline', task: taskBy[a.name] || null };
  });
  const open = openQuestions();
  emit(rows, () => {
    const known = new Set(registered.map((a) => a.name));
    const row = (mark, name, status, role, branch, tail) =>
      `${mark} ${name.padEnd(20)} ${status.padEnd(9)} ${(role || '-').padEnd(18)} ${(branch || '-').padEnd(20)} ${tail}`.trimEnd();
    const lines = rows.map((a) =>
      row(a.name === me.name ? '*' : ' ', a.name, a.status, a.role, a.branch, a.task ? `${a.task.id} ${a.task.title}` : ''));
    for (const l of live) {
      if (l.name && !known.has(l.name)) lines.push(row(' ', l.name, l.agent_status, null, null, '(not yet on chatter)'));
      if (!l.name) lines.push(row(' ', 'pane:' + l.pane_id, l.agent_status, null, null, `(unnamed ${l.agent || 'agent'})`));
    }
    console.log(lines.length ? row(' ', 'NAME', 'STATUS', 'ROLE', 'BRANCH', 'TASK') + '\n' + lines.join('\n') : 'no agents');
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
function cmdIam(_me, args) {
  const fsx = require('node:fs');
  if (!args[0]) { console.log(`you are "${humanName()}" — change with: chatter iam <name>`); return; }
  const name = args[0].toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 32);
  if (!name) die('usage: chatter iam <name>');
  // A collision would silently redirect that agent's mail to the human —
  // check live agents AND every repo's registered roster.
  if (liveAgents().some((a) => a.name === name)) die(`"${name}" is a live agent's name — pick another`);
  for (const f of listRepoDbFiles()) {
    if (openDbFile(f).prepare('SELECT 1 FROM agents WHERE name = ?').get(name)) {
      die(`"${name}" is a registered agent in ${path.basename(path.dirname(f))} — pick another`);
    }
  }
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
    console.log(`${id} assigned to ${agent}`);
    notifyAssignment(me, { ...t, assignee: agent });
  } else if (sub === 'done') {
    const opts = parseFlags(args.slice(1), { commit: null });
    const id = opts._[0];
    if (!id) die('usage: chatter task done <TASK-n> [--commit SHA]');
    const r = db().prepare("UPDATE tasks SET status = 'done', commit_sha = COALESCE(?, commit_sha), updated_at = ? WHERE id = ?").run(opts.commit, now(), id);
    if (!r.changes) die(`${id} not found`);
    db().prepare("UPDATE handoffs SET status = 'done' WHERE task_id = ? AND status != 'done'").run(id);
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

// -------------------------------------------------------------------- help

function help() {
  const g = gitInfo();
  const dbPath = g.repoRoot ? repoDbFile(g.repoRoot) : `${stateRoot()}/repos/<repo>/chatter.db`;
  return `chatter — group chat, DMs, tasks and shared memory for this repo's coding agents

  chatter agents                        who's online: role, branch, task
  chatter send <agent> <message...>     DM an agent (lands in their session; --queue for absent agents)
  chatter inbox [--all]                 your unread messages (--all = history)
  chatter post <text...>                post to the repo group chat; @name pushes to that agent
  chatter chat [--limit N] [--all]      read the group chat (marks it read)
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
  cmdTask, cmdHandoff, cmdStats,
  taskLabel, openQuestions, help, ensurePointerAndSymlink, flushAllRepos,
  hookStartup, hookFlush, hookOpenBoard, hookOpenChat,
};
