'use strict';
// Agent-facing commands and plugin hooks.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { SQLInputValue } from 'node:sqlite';
import { PLUGIN_ID, herdr, invalidateSessionAgents, isRecord, matchLive } from './herdr';
import { db, dbFile, now, gitInfo, stateRoot, repoDbFile, openDbFile, listRepoDbFiles, logEvent, configRoot, humanName } from './db';
import { sendMessage, flushPending, resolveRecipient, postToChat, chatUnreadCount, nameTaken, sanitizeName, teamAgents } from './team';
import { die, parseFlags, emit, age, toMs, median, fmtDur } from './util';
import { clean } from './tui';
import type {
  AgentRow, ChatterDb, CountRow, EventRow, HandoffRow, Identity, MessageRow,
  HerdrResult, NameRow, NoteRow, PaneRow, ProgressCallback, TaskRow, TimeRow, ValueRow,
} from './types';

const NOTE_TYPES = ['note', 'discovery', 'decision', 'dead-end', 'question'];
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const childRecord = (value: unknown, key: string): Record<string, unknown> | null =>
  isRecord(value) && isRecord(value[key]) ? value[key] : null;

// ---------------------------------------------------------------- messaging

export function cmdSend(me: Identity, args: readonly string[]): void {
  // Message bodies are raw text — only a trailing --queue is a flag, so
  // bodies containing "--anything" survive verbatim.
  const queue = args[args.length - 1] === '--queue';
  const rest = queue ? args.slice(0, -1) : args;
  const body = rest.slice(1).join(' ').trim();
  if (!rest[0] || !body) die('usage: chatter send <agent> <message...> [--queue]');
  const to = resolveRecipient(rest[0], { allowUnknown: queue });
  if (!to) die(`no agent "${rest[0]}" in this repo`);
  if (to === me.name) die('cannot message yourself');
  const res = sendMessage(me.name, to, body);
  console.log(res.delivered ? `delivered to ${to}` : `queued: ${res.reason}`);
}

// ---------------------------------------------------------------- group chat

export function cmdPost(me: Identity, args: readonly string[]): void {
  const body = args.join(' ').trim();
  if (!body) die('usage: chatter post <text...>   (mention with @name; @everyone is human-only)');
  const { postId, pushed, warnings } = postToChat(me, body);
  for (const w of warnings) console.error(`warning: ${w}`);
  console.log(`posted to #chat (#${postId})${pushed.length ? `, pushed to ${pushed.join(', ')}` : ''}`);
}

export function cmdChat(me: Identity, args: readonly string[]): void {
  const opts = parseFlags(args, { limit: null, all: false });
  const limit = opts.all ? '' : ` LIMIT ${parseInt(opts.limit ?? '', 10) || 30}`;
  const rows = db().prepare<MessageRow>(`SELECT * FROM messages WHERE to_agent = '#chat' ORDER BY id DESC${limit}`).all().reverse();
  emit(rows, () => {
    if (!rows.length) { console.log('group chat is empty — post with: chatter post <text> (mention with @name)'); return; }
    for (const m of rows) console.log(`#${m.id} ${m.created_at} ${m.from_agent}: ${clean(m.body)}`);
  });
  const maxId = rows.at(-1)?.id ?? 0;
  if (maxId) {
    db().prepare(`INSERT INTO chat_reads (agent, last_read_id) VALUES (?,?)
      ON CONFLICT(agent) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`).run(me.name, maxId);
  }
}

export function cmdInbox(me: Identity, args: readonly string[]): void {
  const opts = parseFlags(args, { all: false });
  const rows = opts.all
    ? db().prepare<MessageRow>('SELECT * FROM messages WHERE to_agent = ? OR from_agent = ? ORDER BY id DESC LIMIT 50').all(me.name, me.name).reverse()
    : db().prepare<MessageRow>('SELECT * FROM messages WHERE to_agent = ? AND read_at IS NULL ORDER BY id').all(me.name);
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

export function cmdLog(_me: Identity, args: readonly string[]): void {
  const opts = parseFlags(args, { grep: null, task: null, limit: null, all: false });
  const cond = ['1=1'];
  const params: SQLInputValue[] = [];
  if (opts.task) { cond.push('ref_id = ?'); params.push(opts.task); }
  const limit = opts.all ? '' : ` LIMIT ${parseInt(opts.limit ?? '', 10) || 40}`;
  let rows = db().prepare<MessageRow>(`SELECT * FROM messages WHERE ${cond.join(' AND ')} ORDER BY id DESC${limit}`).all(...params);
  if (opts.grep) {
    let re; try { re = new RegExp(opts.grep, 'i'); } catch { re = null; }
    const grep = opts.grep;
    rows = rows.filter((m) => re
      ? re.test(m.body) || re.test(m.from_agent) || re.test(m.to_agent)
      : grep ? (m.body + m.from_agent + m.to_agent).toLowerCase().includes(grep.toLowerCase()) : true);
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

function inProgressTasksByAssignee(): Record<string, Pick<TaskRow, 'assignee' | 'id' | 'title'>> {
  const rows = db().prepare<Pick<TaskRow, 'assignee' | 'id' | 'title'>>("SELECT assignee, id, title FROM tasks WHERE status = 'in_progress'").all();
  return Object.fromEntries(rows.filter((t): t is Pick<TaskRow, 'assignee' | 'id' | 'title'> & { assignee: string } => !!t.assignee)
    .map((t) => [t.assignee, t]));
}

// The one identity rendering: display label with the canonical handle always
// visible. Collapses when there is no label (or label ≈ handle) — never an
// empty "· @name". Labels are descriptive; only the @handle is addressable.
function identity(name: string, role: string | null | undefined): string {
  const label = (role || '').trim();
  if (!label || sanitizeName(label) === name) return `@${name}`;
  return `${label} · @${name}`;
}

export function cmdAgents(me: Identity, args: readonly string[] = []): void {
  const all = args.includes('--all');
  const live = teamAgents(); // this repo's team only — never the whole session
  const registered = db().prepare<AgentRow>(
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
    const row = (mark: string, who: string, status: string, branch: string | null | undefined, tail: string): string =>
      `${mark} ${who.padEnd(30)} ${status.padEnd(9)} ${(branch || '-').padEnd(20)} ${tail}`.trimEnd();
    const lines = rows.map((a) =>
      row(a.name === me.name ? '*' : ' ', identity(a.name, a.role), a.status ?? 'unknown', a.branch, a.task ? `${a.task.id} ${a.task.title}` : ''));
    for (const l of live) {
      if (l.name && !known.has(l.name)) lines.push(row(' ', `@${l.name}`, l.agent_status ?? 'unknown', null, '(not yet on chatter)'));
      if (!l.name) lines.push(row(' ', 'pane:' + l.pane_id, l.agent_status ?? 'unknown', null, `(unnamed ${l.agent || 'agent'})`));
    }
    console.log(lines.length ? row(' ', 'AGENT', 'STATUS', 'BRANCH', 'TASK') + '\n' + lines.join('\n') : 'no agents');
    if (open.length) console.log(`\n${open.length} open question${open.length > 1 ? 's' : ''} (${open.map((q) => '#' + q.id).join(' ')}) — chatter questions`);
    const unread = chatUnreadCount(me.name);
    if (unread) console.log(`#chat: ${unread} unread (chatter chat)`);
  });
}

export function cmdWhoami(me: Identity): void {
  const where = me.paneId ? `pane ${me.paneId}` : 'not inside a Herdr pane';
  console.log(`${me.name}${me.human ? ' (human' : ' ('}${me.human ? ', ' + where : where})`);
}

// Set the human's chat name (stored in the plugin config dir, global).
export function cmdIam(me: Identity, args: readonly string[]): void {
  humanOnly(me, 'chatter iam');
  if (!args[0]) { console.log(`you are "${humanName()}" — change with: chatter iam <name>`); return; }
  const name = args[0].toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 32);
  if (!name) die('usage: chatter iam <name>');
  // A collision would silently redirect that agent's mail to the human.
  const taken = nameTaken(name);
  if (taken) die(`"${name}" is ${taken} — pick another`);
  fs.mkdirSync(configRoot(), { recursive: true });
  fs.writeFileSync(path.join(configRoot(), 'name'), name + '\n');
  console.log(`you are now "${name}" — agents can reach you with: chatter send ${name} "..." or @${name} in #chat`);
}

// ------------------------------------------------------------------- notes

export function cmdNote(me: Identity, args: readonly string[]): void {
  const opts = parseFlags(args, { type: 'note', task: null, commit: null });
  const text = opts._.join(' ').trim();
  if (!text) die('usage: chatter note <text> [--type discovery|decision|dead-end] [--task TASK-n] [--commit SHA]');
  if (!NOTE_TYPES.includes(opts.type)) console.error(`warning: unusual note type "${opts.type}" (known: ${NOTE_TYPES.join(', ')})`);
  const r = db().prepare('INSERT INTO notes (author, type, text, task_id, commit_sha, created_at) VALUES (?,?,?,?,?,?)')
    .run(me.name, opts.type, text, opts.task, opts.commit, now());
  logEvent(me.name, 'note_created', `#${r.lastInsertRowid}`, { type: opts.type });
  console.log(`note #${r.lastInsertRowid} saved`);
}

export function cmdNotes(_me: Identity, args: readonly string[]): void {
  const opts = parseFlags(args, { all: false, task: null });
  const q = opts._.join(' ').trim();
  const conditions = opts.all ? ['1=1'] : ["status = 'active'"];
  const params: SQLInputValue[] = [];
  if (opts.task) { conditions.push('task_id = ?'); params.push(opts.task); }
  if (q) { conditions.push('text LIKE ?'); params.push(`%${q}%`); }
  const order = opts.task
    ? "CASE type WHEN 'dead-end' THEN 0 WHEN 'decision' THEN 1 WHEN 'discovery' THEN 2 ELSE 3 END, id DESC"
    : 'id DESC';
  const rows = db().prepare<NoteRow>(
    `SELECT * FROM notes WHERE ${conditions.join(' AND ')} ORDER BY ${order} LIMIT ${opts.task ? 10 : 100}`
  ).all(...params);
  emit(rows, () => {
    if (!rows.length) {
      const scope = opts.task ? ` for ${opts.task}` : '';
      console.log(q ? `no notes${scope} matching "${q}"` : opts.task ? `no notes for ${opts.task}` : 'no notes yet');
      return;
    }
    for (const n of opts.task ? rows : [...rows].reverse()) {
      const refs = [n.task_id, n.commit_sha && n.commit_sha.slice(0, 8)].filter(Boolean).join(' ');
      const st = n.status === 'active' ? '' : ` (${n.status}${n.superseded_by ? ` by #${n.superseded_by}` : ''})`;
      console.log(`#${n.id} [${n.type}] ${n.author}: ${clean(n.text)}${refs ? `  (${refs})` : ''}${st}`);
    }
  });
}

export function cmdResolve(_me: Identity, args: readonly string[]): void {
  const id = parseInt(args[0] ?? '', 10);
  if (!id) die('usage: chatter resolve <note-id>');
  const r = db().prepare("UPDATE notes SET status = 'superseded' WHERE id = ? AND status = 'active'").run(id);
  if (r.changes) logEvent(_me.name, 'note_resolved', `#${id}`);
  console.log(r.changes ? `note #${id} marked superseded` : `note #${id} not found or already resolved`);
}

// --------------------------------------------------------------- questions

function openQuestions(): NoteRow[] {
  return db().prepare<NoteRow>("SELECT * FROM notes WHERE type = 'question' AND status = 'active' ORDER BY id").all();
}

export function cmdAsk(me: Identity, args: readonly string[]): void {
  if (!args.length) die('usage: chatter ask [agent] <question...>');
  let target = null, words = args;
  if (args.length > 1) {
    const hit = resolveRecipient(args[0] ?? '', { soft: true });
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

export function cmdAnswer(me: Identity, args: readonly string[]): void {
  const id = parseInt(args[0] ?? '', 10);
  const text = args.slice(1).join(' ').trim();
  if (!id || !text) die('usage: chatter answer <question-id> <text...>');
  const q = db().prepare<NoteRow>("SELECT * FROM notes WHERE id = ? AND type = 'question'").get(id);
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

export function cmdQuestions(_me: Identity, args: readonly string[]): void {
  const opts = parseFlags(args, { all: false });
  if (!opts.all) {
    const rows = openQuestions();
    emit(rows, () => {
      if (!rows.length) { console.log('no open questions'); return; }
      for (const r of rows) console.log(`#${r.id} (${age(r.created_at)} old) ${r.author}: ${clean(r.text)}  (answer: chatter answer ${r.id} "...")`);
    });
    return;
  }
  const rows = db().prepare<NoteRow>("SELECT * FROM notes WHERE type = 'question' ORDER BY id").all();
  const answerIds = rows.map((r) => r.superseded_by).filter((id): id is number => id !== null);
  const answers: Record<number, NoteRow> = answerIds.length
    ? Object.fromEntries(db().prepare<NoteRow>(`SELECT * FROM notes WHERE id IN (${answerIds.join(',')})`).all().map((a) => [a.id, a]))
    : {};
  emit(rows.map((r) => ({ ...r, answer: r.superseded_by ? answers[r.superseded_by] || null : null })), () => {
    if (!rows.length) { console.log('no questions'); return; }
    for (const r of rows) {
      console.log(`#${r.id} [${r.status}] ${r.author}: ${clean(r.text)}`);
      const a = r.superseded_by ? answers[r.superseded_by] : undefined;
      if (a) console.log(`    -> ${a.author}: ${clean(a.text).replace(/^answer to #\d+: /, '')}`);
    }
  });
}

// ------------------------------------------------------------------- tasks

export function taskLabel(t: TaskRow): string {
  const mark = t.status === 'done' ? 'x' : t.status === 'in_progress' ? '>' : ' ';
  return `[${mark}] ${t.id} ${t.title}${t.assignee ? `  (@${t.assignee})` : ''}${t.commit_sha ? `  ${t.commit_sha.slice(0, 8)}` : ''}`;
}

function nextTaskId(): string {
  const row = db().prepare<CountRow>("SELECT MAX(CAST(substr(id, 6) AS INTEGER)) AS n FROM tasks").get();
  return `TASK-${(row?.n || 0) + 1}`;
}

function notifyAssignment(me: Identity, task: Pick<TaskRow, 'id' | 'title' | 'assignee'>): void {
  if (task.assignee && task.assignee !== me.name) {
    sendMessage(me.name, task.assignee, `you were assigned ${task.id}: ${task.title} (details: chatter task list)`, 'system', task.id);
  }
}

export function cmdTask(me: Identity, args: readonly string[]): void {
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
    if (!id) throw new Error('task id allocation failed');
    notifyAssignment(me, { id, title, assignee });
  } else if (sub === 'list') {
    const rows = db().prepare<TaskRow>("SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, id").all();
    emit(rows, () => {
      if (!rows.length) { console.log('no tasks'); return; }
      for (const t of rows) console.log(taskLabel(t));
    });
  } else if (sub === 'assign') {
    const id = args[1];
    const agent = args[2] && resolveRecipient(args[2]);
    if (!id || !agent) die('usage: chatter task assign <TASK-n> <agent>');
    const t = db().prepare<TaskRow>('SELECT * FROM tasks WHERE id = ?').get(id);
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

export function cmdHandoff(me: Identity, args: readonly string[]): void {
  if (args[0] === 'show') {
    const h = db().prepare<HandoffRow>('SELECT * FROM handoffs WHERE id = ?').get(parseInt(args[1] ?? '', 10));
    if (!h) die(`handoff h${args[1]} not found`);
    const t = h.task_id ? db().prepare<TaskRow>('SELECT * FROM tasks WHERE id = ?').get(h.task_id) : null;
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
  const task = db().prepare<TaskRow>('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) die(`${taskId} not found — create it first: chatter task create <title>`);
  // Fill git context from the caller's worktree when not given explicitly.
  const branch = opts.branch || gitInfo(process.cwd()).branch;
  const files = opts.files ? opts.files.split(',').map((s) => s.trim()).filter(Boolean) : [];
  // One transaction: a crash mid-handoff must not leave ownership, the
  // handoff record, and the audit note disagreeing.
  let hid: number | bigint;
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

export function cmdStats(): void {
  const allMsgs = db().prepare<MessageRow>('SELECT * FROM messages').all();
  const posts = allMsgs.filter((m) => m.to_agent === '#chat');
  const msgs = allMsgs.filter((m) => m.to_agent !== '#chat');
  const tasks = db().prepare<TaskRow>('SELECT * FROM tasks').all();
  const handoffs = db().prepare<HandoffRow>('SELECT * FROM handoffs').all();
  const notes = db().prepare<NoteRow>('SELECT * FROM notes').all();
  const pairs: Record<string, number> = {};
  for (const m of msgs) pairs[`${m.from_agent} -> ${m.to_agent}`] = (pairs[`${m.from_agent} -> ${m.to_agent}`] || 0) + 1;
  const byType: Record<string, number> = {};
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
      median_delivery: median(msgs.flatMap((m) => m.delivered_at ? [toMs(m.delivered_at) - toMs(m.created_at)] : [])),
      by_pair: pairs,
    },
    chat: {
      posts: posts.length,
      by_author: posts.reduce<Record<string, number>>((acc, p) => ((acc[p.from_agent] = (acc[p.from_agent] || 0) + 1), acc), {}),
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
      median_handoff_to_done: median(handoffs.filter((h) => h.status === 'done' && h.task_id && taskById.has(h.task_id))
        .map((h) => h.task_id ? toMs(taskById.get(h.task_id)?.updated_at ?? h.created_at) - toMs(h.created_at) : 0)),
    },
    notes: {
      by_type: byType,
      superseded: notes.filter((n) => n.status !== 'active' && n.type !== 'question').length,
    },
    questions: {
      open: openQs.length,
      resolved: qAnswered.length,
      median_time_to_answer: median(qAnswered.filter((q) => q.superseded_by && noteById.has(q.superseded_by))
        .map((q) => toMs(q.superseded_by ? noteById.get(q.superseded_by)?.created_at ?? q.created_at : q.created_at) - toMs(q.created_at))),
      oldest_open_age_ms: openQs[0] ? Date.now() - toMs(openQs[0].created_at) : null,
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

const tsOf = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function briefWindow(me: Identity, d: ChatterDb, arg: string | null): { since: string; explicit: boolean } {
  if (arg === 'today') { const t = new Date(); t.setHours(0, 0, 0, 0); return { since: tsOf(t.getTime()), explicit: true }; }
  const m = arg && arg.match(/^(\d+)([hm])$/);
  if (m) return { since: tsOf(Date.now() - parseInt(m[1] ?? '', 10) * (m[2] === 'h' ? 3600e3 : 60e3)), explicit: true };
  if (arg) die(`usage: chatter brief [today|2h|30m] — got "${arg}"`);
  const mark = d.prepare<ValueRow>("SELECT value FROM ui_marks WHERE agent = ? AND mark = 'brief'").get(me.name);
  return { since: (mark && mark.value) || tsOf(Date.now() - 24 * 3600e3), explicit: false };
}

// Deterministic catch-up: what changed since the caller last looked.
export function buildBrief(me: Identity, d: ChatterDb = db(), arg: string | null = null): { since: string; lines: string[] } {
  const { since, explicit } = briefWindow(me, d, arg);
  const ev = (kind: string): EventRow[] => d.prepare<EventRow>('SELECT * FROM events WHERE kind = ? AND at > ? ORDER BY id').all(kind, since);
  const lines: string[] = [];
  const taskTitle = (id: string | null): string => {
    if (!id) return '';
    const t = d.prepare<Pick<TaskRow, 'title'>>('SELECT title FROM tasks WHERE id = ?').get(id);
    return t ? t.title : '';
  };
  for (const e of ev('task_done')) lines.push(`✓ ${e.ref} ${taskTitle(e.ref)} — completed by ${e.actor}`);
  for (const e of ev('task_created')) {
    const t = e.ref ? d.prepare<TaskRow>('SELECT * FROM tasks WHERE id = ?').get(e.ref) : undefined;
    if (t && t.status === 'open') lines.push(`+ ${e.ref} ${t.title} — new, unassigned (by ${e.actor})`);
  }
  for (const t of d.prepare<TaskRow>("SELECT * FROM tasks WHERE status = 'in_progress' ORDER BY id").all()) {
    lines.push(`→ ${t.assignee || '?'} is on ${t.id} ${t.title}`);
  }
  for (const q of d.prepare<NoteRow>("SELECT * FROM notes WHERE type = 'question' AND status = 'active' ORDER BY id").all()) {
    lines.push(`? question #${q.id} open ${age(q.created_at)} (${q.author}): ${clean(q.text).slice(0, 70)}`);
  }
  for (const e of ev('handoff_created')) {
    const parsed: unknown = e.data ? JSON.parse(e.data) : {};
    const x = isRecord(parsed) ? parsed : {};
    lines.push(`⇄ ${e.actor} handed ${typeof x.task === 'string' ? x.task : ''} to ${typeof x.to === 'string' ? x.to : '?'} (${e.ref})`);
  }
  for (const n of d.prepare<NoteRow>("SELECT * FROM notes WHERE type IN ('decision','dead-end') AND created_at > ? ORDER BY id").all(since)) {
    lines.push(`◆ [${n.type}] ${n.author}: ${clean(n.text).slice(0, 70)}`);
  }
  const dms = d.prepare<CountRow>("SELECT COUNT(*) AS n FROM messages WHERE to_agent = ? AND read_at IS NULL AND kind != 'mention'").get(me.name)?.n ?? 0;
  const unreadChat = chatUnreadCount(me.name, d);
  if (dms || unreadChat) lines.push(`✉ ${dms ? `${dms} unread DM${dms > 1 ? 's' : ''}` : ''}${dms && unreadChat ? ' · ' : ''}${unreadChat ? `#chat: ${unreadChat} unread` : ''}`);
  const counts: Record<string, number> = {};
  for (const a of teamAgents(d)) {
    const status = a.agent_status ?? 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }
  const stuck = d.prepare<CountRow>(`SELECT COUNT(*) AS n FROM messages m JOIN agents a ON a.name = m.to_agent
    WHERE m.delivered_at IS NULL AND a.departed_at IS NOT NULL`).get()?.n ?? 0;
  if (stuck) lines.push(`⚠ ${stuck} message${stuck > 1 ? 's' : ''} queued for departed agents (chatter forget <name> cleans up)`);
  lines.push(`agents: ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ') || 'none live'}`);
  if (!explicit) {
    d.prepare(`INSERT INTO ui_marks (agent, mark, value) VALUES (?, 'brief', ?)
      ON CONFLICT(agent, mark) DO UPDATE SET value = excluded.value`).run(me.name, now());
  }
  return { since, lines: lines.length > 1 ? lines : [...lines, '(quiet — nothing new)'] };
}

export function cmdBrief(me: Identity, args: readonly string[]): void {
  const b = buildBrief(me, db(), args[0] || null);
  emit(b, () => {
    console.log(`since ${b.since}:`);
    for (const l of b.lines) console.log(`  ${l}`);
  });
}

// ------------------------------------------------------------- data control

// Everything chatter stores is local SQLite under the plugin state dir.
// These commands make that visible and deletable.
interface RepoUniverse {
  key: string; dir: string; repo_root: string | null; orphan: boolean;
  messages: number; notes: number; tasks: number; events: number;
  last_activity: string | null; bytes: number;
}
function repoUniverses(): RepoUniverse[] {
  return listRepoDbFiles().map((f) => {
    const d = openDbFile(f);
    const count = (t: string): number => d.prepare<CountRow>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? 0;
    const mark = d.prepare<ValueRow>("SELECT value FROM ui_marks WHERE agent = '_repo' AND mark = 'root'").get();
    const root = mark ? { repo_root: mark.value }
      : d.prepare<Pick<AgentRow, 'repo_root'>>('SELECT repo_root FROM agents WHERE repo_root IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1').get();
    const last = d.prepare<TimeRow>('SELECT MAX(created_at) AS t FROM messages').get()?.t
      || d.prepare<TimeRow>('SELECT MAX(at) AS t FROM events').get()?.t;
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
export function humanOnly(me: Identity, what: string): void {
  if (!me.human) die(`${what} is human-only — agents administer nothing outside their repo`);
}

export function cmdData(me: Identity): void {
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

export function cmdPurge(me: Identity, args: readonly string[]): void {
  humanOnly(me, 'chatter purge');
  const opts = parseFlags(args, { yes: false, orphans: false, all: false, 'older-than': null });
  const rows = repoUniverses();
  let targets: RepoUniverse[] = [];
  if (opts.all) targets = rows;
  else if (opts.orphans) targets = rows.filter((r) => r.orphan);
  else if (opts['older-than']) {
    const m = opts['older-than'].match(/^(\d+)([dh])$/);
    if (!m) die('usage: chatter purge --older-than <Nd|Nh> [--yes]  (trims old messages+events in the current repo)');
    const cutoff = new Date(Date.now() - parseInt(m[1] ?? '', 10) * (m[2] === 'd' ? 86400e3 : 3600e3))
      .toISOString().replace('T', ' ').slice(0, 19);
    const d = db();
    const nm = d.prepare<CountRow>('SELECT COUNT(*) AS n FROM messages WHERE created_at < ?').get(cutoff)?.n ?? 0;
    const ne = d.prepare<CountRow>('SELECT COUNT(*) AS n FROM events WHERE at < ?').get(cutoff)?.n ?? 0;
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
// `onProgress(line)` reports each stage as it happens — spawning takes tens of
// seconds, and a silent screen for that long reads as a hang.
interface SpawnOptions { name?: string; kind?: string | null; purpose?: string | null; tab?: boolean; branch?: string | null; base?: string | null }
interface CommandResult { ok: boolean; lines: string[] }
export function spawnAgent(
  me: Identity,
  { name: rawName, kind, purpose, tab = false, branch = null, base = null }: SpawnOptions,
  d: ChatterDb = db(),
  onProgress: ProgressCallback = () => {},
): CommandResult {
  const fail = (msg: string): CommandResult => ({ ok: false, lines: [msg] });
  if (!rawName) return fail('usage: spawn <name> [--kind codex|claude|pi|...] [--purpose "why"] [--branch B] [--base REF] [--tab]');
  const name = sanitizeName(rawName);
  const taken = nameTaken(name);
  if (taken) return fail(`"${name}" is ${taken} — pick another name`);
  const lines: string[] = [];
  if (!kind) {
    const kinds = teamAgents(d).map((a) => a.agent).filter(Boolean);
    kind = kinds.sort((a, b) => kinds.filter((k) => k === b).length - kinds.filter((k) => k === a).length)[0];
    if (!kind) return fail('no --kind given and no agents in this repo to infer one from (run: herdr agent  for installed kinds)');
    lines.push(`no kind given — using ${kind} (majority of this repo's agents)`);
  }
  // The spawn target repo comes from the DB handle, never process.cwd():
  // inside the chat popup, cwd is the plugin's own checkout.
  const mark = d.prepare<ValueRow>("SELECT value FROM ui_marks WHERE agent = '_repo' AND mark = 'root'").get();
  const repoRoot = (mark && mark.value) || gitInfo().repoRoot;
  if (!repoRoot || repoDbFile(repoRoot) !== dbFile(d)) {
    return fail('cannot determine this universe\'s repo — run one chatter command from a shell in it first');
  }
  // Code setup: a fresh worktree by default — Chatter's own model says
  // worktrees isolate code. --tab shares this checkout (explicit exception,
  // fine for reviewers/helpers that don't write files).
  let pane: string;
  let cleanup: (() => HerdrResult) | null;
  let whereLine: string;
  if (tab) {
    const tabArgs = ['tab', 'create', '--label', name, '--cwd', repoRoot, '--no-focus'];
    if (process.env.HERDR_WORKSPACE_ID) tabArgs.push('--workspace', process.env.HERDR_WORKSPACE_ID);
    const t = herdr(tabArgs);
    if (!t.ok) return fail(`could not create a tab: ${t.raw}`);
    const tabResult = childRecord(t.json, 'result');
    const rootPane = childRecord(tabResult, 'root_pane');
    const tabInfo = childRecord(tabResult, 'tab');
    const paneId = rootPane?.pane_id;
    const tabId = tabInfo?.tab_id;
    if (typeof paneId !== 'string' || typeof tabId !== 'string') return fail('tab created but no pane returned — start the agent manually');
    pane = paneId;
    cleanup = () => herdr(['tab', 'close', tabId]);
    whereLine = `same checkout, new tab (${pane}) — shared files, coordinate carefully`;
    onProgress(`tab created in this checkout (${pane})`);
  } else {
    // A worktree branch needs a commit to point at — a freshly-init'ed repo
    // (unborn HEAD) can't host worktree teammates yet. Say so clearly.
    const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
    if (head.status !== 0) {
      return fail('this repo has no commits yet, so a worktree branch has nothing to start from —\n'
        + 'make a first commit (git commit --allow-empty -m "init") or spawn into this checkout with --tab');
    }
    const wtBranch = branch || `agents/${name}`;
    const wtArgs = ['worktree', 'create', '--cwd', repoRoot, '--branch', wtBranch, '--label', name, '--no-focus'];
    if (base) wtArgs.push('--base', base);
    const wt = herdr(wtArgs);
    if (!wt.ok) return fail(`could not create a worktree: ${wt.raw}`);
    const wtResult = childRecord(wt.json, 'result');
    const directPane = childRecord(wtResult, 'root_pane');
    const workspace = childRecord(wtResult, 'workspace');
    const workspacePane = childRecord(workspace, 'root_pane');
    const paneId = directPane?.pane_id ?? workspacePane?.pane_id;
    if (typeof paneId !== 'string') return fail('worktree created but no pane returned — start the agent manually');
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
  let start: HerdrResult | null = null;
  onProgress(`starting ${kind}…`);
  for (let attempt = 0; attempt < 15; attempt++) {
    start = herdr(['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', '60000']);
    if (start.ok || !(start.raw || '').includes('agent_pane_busy')) break;
    onProgress(`shell warming up, attempt ${attempt + 2}`);
    spawnSync('sleep', ['1']);
  }
  if (!start || !start.ok) {
    if (cleanup) cleanup();
    return fail(`agent start failed: ${start?.raw ?? 'no response'}${cleanup ? '' : ' (worktree left in place)'}`);
  }
  onProgress(`${kind} agent up`);
  herdr(['pane', 'rename', pane, name]); // pane label = role, feeds the roster
  invalidateSessionAgents(); // roster changed — the cached list predates the spawn
  // Boundary proof: the newcomer must verifiably belong to this universe
  // (teamAgents only returns repo-verified agents, so presence = proof).
  const verified = !!teamAgents(d).find((a) => a.name === name);
  logEvent(me.name, 'agent_spawned', name, { kind, by: me.name, purpose: purpose || null, tab: !!tab }, d);
  postToChat(me, `spawned ${name} (${kind})${purpose ? `: ${purpose}` : ''}`, d, () => null);
  onProgress('announced in #chat');
  lines.unshift(`@${name} is up (${kind}) — ${whereLine}`);
  lines.push(verified ? 'verified: joined this repo\'s universe' : 'warning: could not verify repo membership yet — its mail queues until it checks in');
  if (purpose) {
    const res = sendMessage(me.name, name, `you are "${name}". your purpose: ${purpose}`, 'purpose', null, d);
    lines.push(res.delivered ? 'purpose delivered to its session' : `purpose queued (${res.reason})`);
    onProgress(res.delivered ? 'purpose delivered' : 'purpose queued');
  }
  const startResult = childRecord(start.json, 'result');
  const startedAgent = childRecord(startResult, 'agent');
  const status = typeof startedAgent?.agent_status === 'string' ? startedAgent.agent_status : 'unknown';
  if (status === 'blocked') lines.push('it is showing a startup dialog (trust/permissions) — click through it once');
  return { ok: true, lines };
}


export function cmdSpawn(me: Identity, args: readonly string[]): void {
  const opts = parseFlags(args, { kind: null, purpose: null, tab: false, branch: null, base: null });
  // The CLI streams the stages as they happen — a spawn can take a minute.
  const r = spawnAgent(me, {
    name: opts._[0], kind: opts.kind, purpose: opts.purpose,
    tab: opts.tab, branch: opts.branch, base: opts.base,
  }, db(), (line) => console.log(`… ${line}`));
  for (const l of r.lines) console.log(l);
  if (!r.ok) process.exit(1);
}

// ------------------------------------------------------------------- role

// Roles are Chatter UX; the pane label is just where they live. Humans can
// retitle anyone; an agent may only describe itself.
export function setRole(me: Identity, target: string, text: string, d: ChatterDb = db()): CommandResult {
  const who = resolveRecipient(target.replace(/^@/, ''), { soft: true }, d);
  if (!who) return { ok: false, lines: [`no agent "${target}" in this repo`] };
  if (!me.human && who !== me.name) return { ok: false, lines: ['agents may only set their own role'] };
  const row = d.prepare<PaneRow>('SELECT pane_id FROM agents WHERE name = ?').get(who);
  const live = teamAgents(d).find((a) => a.name === who);
  const pane = (live && live.pane_id) || (row && row.pane_id);
  const lines: string[] = [];
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

export function cmdRole(me: Identity, args: readonly string[]): void {
  const target = args[0];
  const text = args.slice(1).join(' ').trim();
  if (!target || !text) die('usage: chatter role <agent> <display role...>   e.g. chatter role data-api "Data / API"');
  const r = setRole(me, target, text);
  for (const l of r.lines) console.log(l);
  if (!r.ok) process.exit(1);
}

// -------------------------------------------------------------------- help

export function help(): string {
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

Open the chat: prefix+alt+c (popup) or prefix+alt+t (tab) once chatter setup binds
them — same as: herdr plugin action invoke chatter.open-chat-tab, or herdr plugin
pane open --plugin chatter --entrypoint chat --placement split
Open the board: prefix+alt+b (popup) or prefix+alt+shift+b (tab) once setup binds
them — same as: herdr plugin action invoke chatter.open-board-tab

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

export function ensurePointerAndSymlink(): void {
  // Startup hook runs with plugin env; persist what bare CLI calls can't see.
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const cfgDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (stateDir && cfgDir) {
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'state-dir'), stateDir + '\n');
  }
  // Make `chatter` callable from any agent shell.
  // Runtime lives in dist/src; the stable user-facing launcher remains at
  // the repository root so it survives clean rebuilds of generated output.
  const target = path.join(__dirname, '..', '..', 'bin', 'chatter');
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
    console.error(`symlink setup failed: ${errorMessage(e)}`);
  }
}

// Herdr told us a pane or worktree died: roster rows bound to those panes
// become departed (bookkeeping only — chatter never kills anything itself).
// Pane ids are never reused, so this signal is exact.
export function hookReap(): void {
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
  if (!panes.length && !workspaces.length) return;
  let n = 0;
  for (const f of listRepoDbFiles()) {
    const d = openDbFile(f);
    const doomed = new Set<string>();
    for (const pane of panes) {
      for (const r of d.prepare<NameRow>('SELECT name FROM agents WHERE pane_id = ? AND departed_at IS NULL').all(pane)) doomed.add(r.name);
    }
    for (const ws of workspaces) {
      for (const r of d.prepare<NameRow>("SELECT name FROM agents WHERE pane_id LIKE ? AND departed_at IS NULL").all(`${ws}:%`)) doomed.add(r.name);
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
export function cmdForget(me: Identity, args: readonly string[]): void {
  humanOnly(me, 'chatter forget');
  const name = (args[0] || '').replace(/^@/, '');
  if (!name) die('usage: chatter forget <agent>');
  const d = db();
  const row = d.prepare<Pick<AgentRow, 'name' | 'departed_at'>>('SELECT name, departed_at FROM agents WHERE name = ?').get(name);
  if (!row) die(`no roster entry for "${name}" — see: chatter agents --all`);
  if (!row.departed_at) {
    d.prepare('UPDATE agents SET departed_at = ? WHERE name = ?').run(now(), name);
    logEvent(me.name, 'agent_departed', name, { by: 'forget' });
  }
  const dropped = d.prepare('DELETE FROM messages WHERE to_agent = ? AND delivered_at IS NULL').run(name).changes;
  console.log(`@${name} marked departed${dropped ? `, dropped ${dropped} queued message(s)` : ''} — history kept`);
}

// Hooks have no single repo context: flush every repo's queue.
export function flushAllRepos(): number {
  let n = 0;
  for (const f of listRepoDbFiles()) n += flushPending(openDbFile(f));
  return n;
}

export function hookStartup(): void {
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

export function hookFlush(): void {
  // Runs on pane.agent_status_changed — must be cheap when idle.
  const n = flushAllRepos();
  if (n) console.log(`flushed ${n}`);
}

// Placement decides the pane's lifetime: the manifest default is a popup
// (session-modal, Esc closes it); tab/split make it a persistent pane the
// human keeps open beside their work.
function openPane(entrypoint: string, placement: string | null = null): void {
  const args = ['plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', entrypoint];
  if (placement) args.push('--placement', placement);
  const r = herdr(args);
  if (!r.ok) { console.error(r.raw); process.exit(1); }
}
export const hookOpenBoard = (): void => openPane('board');
export const hookOpenBoardTab = (): void => openPane('board', 'tab');
export const hookOpenChat = (): void => openPane('chat');
export const hookOpenChatTab = (): void => openPane('chat', 'tab');
