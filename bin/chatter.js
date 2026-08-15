#!/usr/bin/env node
'use strict';
// Chatter: Slack + shared memory for coding agents in Herdr worktrees.
// Zero-dependency: Node 22 built-in node:sqlite, talks to Herdr via its CLI.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PLUGIN_ID = 'n8n.chatter';
const HERDR = process.env.HERDR_BIN_PATH || 'herdr';

// ---------------------------------------------------------------- herdr CLI

function herdr(args) {
  const r = spawnSync(HERDR, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const raw = (r.stdout || '').trim() || (r.stderr || '').trim();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* non-JSON output */ }
  return { status: r.status, json, raw, ok: r.status === 0 };
}

function liveAgents() {
  const r = herdr(['agent', 'list']);
  return r.ok && r.json ? (r.json.result.agents || []) : [];
}

// ------------------------------------------------------------ state dir + db

function resolveStateDir() {
  if (process.env.HERDR_PLUGIN_STATE_DIR) return process.env.HERDR_PLUGIN_STATE_DIR;
  // Outside plugin context (agent shells): find the config dir via the CLI,
  // then follow the pointer the startup hook wrote there.
  // Herdr's layout on Unix (verified 0.8.0): ~/.local/state/herdr/plugins/<id>
  const conventional = path.join(os.homedir(), '.local', 'state', 'herdr', 'plugins', PLUGIN_ID);
  if (fs.existsSync(conventional)) return conventional;
  const cfg = spawnSync(HERDR, ['plugin', 'config-dir', PLUGIN_ID], { encoding: 'utf8' });
  const cfgDir = (cfg.stdout || '').trim();
  if (cfgDir) {
    const pointer = path.join(cfgDir, 'state-dir');
    if (fs.existsSync(pointer)) {
      const p = fs.readFileSync(pointer, 'utf8').trim();
      if (p && fs.existsSync(p)) return p;
    }
  }
  const fallback = path.join(os.homedir(), '.local', 'state', 'herdr-chatter');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

let _db = null;
function db() {
  if (_db) return _db;
  const { DatabaseSync } = require('node:sqlite');
  const dir = resolveStateDir();
  fs.mkdirSync(dir, { recursive: true });
  _db = new DatabaseSync(path.join(dir, 'chatter.db'));
  _db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY, pane_id TEXT, workspace_id TEXT, cwd TEXT,
      repo_root TEXT, branch TEXT, kind TEXT,
      registered_at TEXT, last_seen_at TEXT);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT, to_agent TEXT, body TEXT,
      kind TEXT DEFAULT 'chat', ref_id TEXT,
      created_at TEXT, delivered_at TEXT, read_at TEXT);
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT, type TEXT DEFAULT 'note', text TEXT,
      task_id TEXT, commit_sha TEXT,
      status TEXT DEFAULT 'active', superseded_by INTEGER, created_at TEXT);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT 'open',
      assignee TEXT, created_by TEXT, commit_sha TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT, from_agent TEXT, to_agent TEXT, summary TEXT,
      branch TEXT, commit_sha TEXT, files_json TEXT, tests TEXT, next_steps TEXT,
      status TEXT DEFAULT 'pending', created_at TEXT);
  `);
  return _db;
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ---------------------------------------------------------------- identity

function gitInfo(cwd) {
  const run = (args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  return { repo_root: run(['rev-parse', '--show-toplevel']), branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) };
}

function sanitizeName(s) {
  let n = (s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 32);
  return n || 'agent';
}

// Identify the calling pane's agent; auto-register on first contact.
function whoami({ register = true } = {}) {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) return { name: 'user', paneId: null, human: true };
  const live = liveAgents();
  const me = live.find((a) => a.pane_id === paneId);
  let name = me && me.name;
  if (!name && register) {
    // Derive a stable name and tell Herdr so both sides agree.
    const cwd = (me && me.cwd) || process.cwd();
    let base = sanitizeName(path.basename(cwd));
    const taken = new Set(live.map((a) => a.name).filter(Boolean));
    let candidate = base, i = 2;
    while (taken.has(candidate)) candidate = `${base}-${i++}`.slice(0, 32);
    const r = herdr(['agent', 'rename', paneId, candidate]);
    if (r.ok) name = candidate;
  }
  if (!name) return { name: `pane:${paneId}`, paneId, human: false };
  if (register) {
    const cwd = (me && me.cwd) || process.cwd();
    const git = gitInfo(cwd);
    db().prepare(`
      INSERT INTO agents (name, pane_id, workspace_id, cwd, repo_root, branch, kind, registered_at, last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET pane_id=excluded.pane_id, workspace_id=excluded.workspace_id,
        cwd=excluded.cwd, repo_root=excluded.repo_root, branch=excluded.branch,
        kind=excluded.kind, last_seen_at=excluded.last_seen_at
    `).run(name, paneId, me ? me.workspace_id : null, cwd, git.repo_root, git.branch,
           me ? me.agent : null, now(), now());
  }
  return { name, paneId, human: false, status: me ? me.agent_status : null };
}

// ---------------------------------------------------------------- delivery

const DELIVERABLE = new Set(['idle', 'done', 'working', 'unknown']);

function resolveTarget(name, live) {
  // Prefer the live Herdr agent with that name; fall back to registered pane.
  let a = live.find((x) => x.name === name);
  if (a) return { paneId: a.pane_id, status: a.agent_status };
  const row = db().prepare('SELECT pane_id FROM agents WHERE name = ?').get(name);
  if (row) {
    a = live.find((x) => x.pane_id === row.pane_id);
    if (a) return { paneId: a.pane_id, status: a.agent_status };
  }
  return null;
}

function formatDelivery(msg) {
  const head = msg.kind === 'handoff'
    ? `[chatter] handoff from ${msg.from_agent}`
    : `[chatter] message from ${msg.from_agent}`;
  return `${head}: ${msg.body}\n(you are "${msg.to_agent}" — reply: chatter send ${msg.from_agent} "..." | inbox: chatter inbox | all commands: chatter help)`;
}

// Try to inject one message into its target's live session. Returns true on success.
function tryDeliver(msg, live) {
  const t = resolveTarget(msg.to_agent, live);
  if (!t || !DELIVERABLE.has(t.status)) return false;
  const r = herdr(['agent', 'prompt', t.paneId, formatDelivery(msg)]);
  if (!r.ok) return false;
  db().prepare('UPDATE messages SET delivered_at = ?, read_at = ? WHERE id = ?').run(now(), now(), msg.id);
  return true;
}

// Best-effort flush of everything queued; cheap when queue is empty.
function flushPending() {
  const pending = db().prepare('SELECT * FROM messages WHERE delivered_at IS NULL ORDER BY id').all();
  if (!pending.length) return 0;
  const live = liveAgents();
  let n = 0;
  for (const m of pending) if (tryDeliver(m, live)) n++;
  return n;
}

// ---------------------------------------------------------------- commands

function sendMessage(from, to, body, kind = 'chat', refId = null) {
  const r = db().prepare(
    'INSERT INTO messages (from_agent, to_agent, body, kind, ref_id, created_at) VALUES (?,?,?,?,?,?)'
  ).run(from, to, body, kind, refId, now());
  const msg = { id: r.lastInsertRowid, from_agent: from, to_agent: to, body, kind, ref_id: refId };
  const live = liveAgents();
  const t = resolveTarget(to, live);
  if (!t) return { delivered: false, reason: `no live agent named "${to}" — queued (they'll get it via chatter inbox or when they appear)` };
  if (tryDeliver(msg, live)) return { delivered: true };
  return { delivered: false, reason: `${to} is ${t.status} — queued, will deliver when they settle` };
}

function cmdSend(me, args) {
  const to = args[0];
  const body = args.slice(1).join(' ').trim();
  if (!to || !body) die('usage: chatter send <agent> <message...>');
  if (to === me.name) die('cannot message yourself');
  const res = sendMessage(me.name, to, body);
  console.log(res.delivered ? `delivered to ${to}` : `queued: ${res.reason}`);
}

function cmdInbox(me, args) {
  const all = args.includes('--all');
  const rows = all
    ? db().prepare('SELECT * FROM messages WHERE to_agent = ? OR from_agent = ? ORDER BY id DESC LIMIT 50').all(me.name, me.name)
    : db().prepare('SELECT * FROM messages WHERE to_agent = ? AND read_at IS NULL ORDER BY id').all(me.name);
  if (!rows.length) { console.log(all ? 'no messages' : 'no unread messages'); return; }
  for (const m of (all ? rows.reverse() : rows)) {
    const tag = m.kind === 'chat' ? '' : ` [${m.kind}${m.ref_id ? ' ' + m.ref_id : ''}]`;
    console.log(`#${m.id} ${m.created_at} ${m.from_agent} -> ${m.to_agent}${tag}: ${m.body}`);
  }
  if (!all) {
    const ids = rows.map((m) => m.id);
    db().prepare(`UPDATE messages SET read_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id IN (${ids.join(',')})`).run(now(), now());
  }
}

function taskLabel(t) {
  const mark = t.status === 'done' ? 'x' : t.status === 'in_progress' ? '>' : ' ';
  return `[${mark}] ${t.id} ${t.title}${t.assignee ? `  (@${t.assignee})` : ''}${t.commit_sha ? `  ${t.commit_sha.slice(0, 8)}` : ''}`;
}

function cmdAgents(me) {
  const live = liveAgents();
  const registered = db().prepare('SELECT * FROM agents ORDER BY name').all();
  const tasks = db().prepare("SELECT assignee, id, title FROM tasks WHERE status = 'in_progress'").all();
  const taskBy = Object.fromEntries(tasks.map((t) => [t.assignee, t]));
  const seen = new Set();
  const lines = [];
  for (const a of registered) {
    const l = live.find((x) => x.name === a.name || x.pane_id === a.pane_id);
    seen.add(a.name);
    const status = l ? l.agent_status : 'offline';
    const t = taskBy[a.name];
    lines.push(`${a.name === me.name ? '*' : ' '} ${a.name.padEnd(20)} ${status.padEnd(9)} ${(a.branch || '-').padEnd(24)} ${t ? `${t.id} ${t.title}` : ''}`.trimEnd());
  }
  for (const l of live) {
    if (l.name && !seen.has(l.name)) lines.push(`  ${l.name.padEnd(20)} ${l.agent_status.padEnd(9)} ${'-'.padEnd(24)} (not yet on chatter)`);
    if (!l.name) lines.push(`  ${('pane:' + l.pane_id).padEnd(20)} ${l.agent_status.padEnd(9)} ${'-'.padEnd(24)} (unnamed ${l.agent || 'agent'})`);
  }
  console.log(lines.length ? `  ${'NAME'.padEnd(20)} ${'STATUS'.padEnd(9)} ${'BRANCH'.padEnd(24)} TASK\n` + lines.join('\n') : 'no agents');
}

function cmdNote(me, args) {
  const opts = parseFlags(args, { type: 'note', task: null, commit: null });
  const text = opts._.join(' ').trim();
  if (!text) die('usage: chatter note <text> [--type discovery|decision] [--task TASK-n] [--commit SHA]');
  const r = db().prepare('INSERT INTO notes (author, type, text, task_id, commit_sha, created_at) VALUES (?,?,?,?,?,?)')
    .run(me.name, opts.type, text, opts.task, opts.commit, now());
  console.log(`note #${r.lastInsertRowid} saved`);
}

function cmdNotes(_me, args) {
  const q = args.join(' ').trim();
  const rows = q
    ? db().prepare("SELECT * FROM notes WHERE status = 'active' AND text LIKE ? ORDER BY id DESC LIMIT 30").all(`%${q}%`)
    : db().prepare("SELECT * FROM notes WHERE status = 'active' ORDER BY id DESC LIMIT 30").all();
  if (!rows.length) { console.log(q ? `no active notes matching "${q}"` : 'no notes yet'); return; }
  for (const n of rows.reverse()) {
    const refs = [n.task_id, n.commit_sha && n.commit_sha.slice(0, 8)].filter(Boolean).join(' ');
    console.log(`#${n.id} [${n.type}] ${n.author}: ${n.text}${refs ? `  (${refs})` : ''}`);
  }
}

function cmdResolve(_me, args) {
  const id = parseInt(args[0], 10);
  if (!id) die('usage: chatter resolve <note-id>');
  const r = db().prepare("UPDATE notes SET status = 'superseded' WHERE id = ? AND status = 'active'").run(id);
  console.log(r.changes ? `note #${id} marked superseded` : `note #${id} not found or already resolved`);
}

function nextTaskId() {
  const row = db().prepare("SELECT id FROM tasks ORDER BY CAST(substr(id, 6) AS INTEGER) DESC LIMIT 1").get();
  const n = row ? parseInt(row.id.slice(5), 10) + 1 : 1;
  return `TASK-${n}`;
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
    const id = nextTaskId();
    db().prepare('INSERT INTO tasks (id, title, status, assignee, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, title, opts.assignee ? 'in_progress' : 'open', opts.assignee, me.name, now(), now());
    console.log(`${id} created${opts.assignee ? ` and assigned to ${opts.assignee}` : ''}`);
    notifyAssignment(me, { id, title, assignee: opts.assignee });
  } else if (sub === 'list') {
    const rows = db().prepare("SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, id").all();
    if (!rows.length) { console.log('no tasks'); return; }
    for (const t of rows) console.log(taskLabel(t));
  } else if (sub === 'assign') {
    const [id, agent] = [args[1], args[2]];
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

function cmdHandoff(me, args) {
  if (args[0] === 'show') {
    const id = parseInt(args[1], 10);
    const h = db().prepare('SELECT * FROM handoffs WHERE id = ?').get(id);
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
  const [taskId, to] = [opts._[0], opts._[1]];
  if (!taskId || !to || !opts.summary) {
    die('usage: chatter handoff <TASK-n> <agent> --summary S [--branch B] [--commit C] [--files a,b] [--tests CMD] [--next TEXT]\n       chatter handoff show <id>');
  }
  const task = db().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) die(`${taskId} not found — create it first: chatter task create <title>`);
  // Fill git context from the caller's worktree when not given explicitly.
  const git = gitInfo(process.cwd());
  const branch = opts.branch || git.branch;
  const files = opts.files ? opts.files.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const r = db().prepare(`INSERT INTO handoffs (task_id, from_agent, to_agent, summary, branch, commit_sha, files_json, tests, next_steps, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(taskId, me.name, to, opts.summary, branch, opts.commit, JSON.stringify(files), opts.tests, opts.next, now());
  const hid = `h${r.lastInsertRowid}`;
  db().prepare("UPDATE tasks SET assignee = ?, status = 'in_progress', updated_at = ? WHERE id = ?").run(to, now(), taskId);
  db().prepare('INSERT INTO notes (author, type, text, task_id, commit_sha, created_at) VALUES (?,?,?,?,?,?)')
    .run(me.name, 'note', `handed off ${taskId} to ${to}: ${opts.summary}`, taskId, opts.commit, now());
  const parts = [`${taskId} ${opts.summary}`];
  if (branch) parts.push(`branch ${branch}`);
  if (opts.commit) parts.push(`commit ${opts.commit.slice(0, 12)}`);
  if (opts.next) parts.push(`next: ${opts.next}`);
  parts.push(`full details: chatter handoff show ${r.lastInsertRowid}`);
  const res = sendMessage(me.name, to, parts.join(' | '), 'handoff', hid);
  console.log(`${hid} created; ${res.delivered ? `delivered to ${to}` : `queued: ${res.reason}`}`);
}

function cmdWhoami(me) {
  console.log(`${me.name}${me.paneId ? ` (pane ${me.paneId})` : ' (not inside a Herdr pane)'}`);
}

function cmdLog() {
  const rows = db().prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 40').all();
  for (const m of rows.reverse()) {
    const st = m.read_at ? '' : m.delivered_at ? ' (unread)' : ' (queued)';
    console.log(`#${m.id} ${m.created_at} ${m.from_agent} -> ${m.to_agent}: ${m.body}${st}`);
  }
  if (!rows.length) console.log('no messages');
}

const HELP = `chatter — Slack + shared memory for agents in this Herdr session

  chatter agents                        who's online, their branch and task
  chatter send <agent> <message...>     message an agent (lands in their session)
  chatter inbox [--all]                 your unread messages (--all = history)
  chatter note <text> [--type discovery|decision] [--task TASK-n] [--commit SHA]
  chatter notes [query]                 read/search the shared scratchpad
  chatter resolve <note-id>             mark a note stale/superseded
  chatter task create <title> [--assignee agent]
  chatter task list | assign <TASK-n> <agent> | done <TASK-n> [--commit SHA]
  chatter handoff <TASK-n> <agent> --summary S [--branch B] [--commit C]
                  [--files a,b] [--tests CMD] [--next TEXT]
  chatter handoff show <id>             structured handoff payload (JSON)
  chatter log                           recent team messages
  chatter whoami

Code moves through Git (commit/branch refs in handoffs) — never edit another
agent's worktree. Chatter carries context, Git carries code.`;

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
  const target = path.join(__dirname, 'chatter');
  const link = path.join(os.homedir(), '.local', 'bin', 'chatter');
  try {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    const existing = fs.existsSync(link) ? fs.realpathSync(link) : null;
    if (existing !== fs.realpathSync(target)) {
      try { fs.unlinkSync(link); } catch {}
      fs.symlinkSync(target, link);
    }
  } catch (e) {
    console.error(`symlink setup failed: ${e.message}`);
  }
}

function hookStartup() {
  ensurePointerAndSymlink();
  const n = flushPending();
  console.log(`chatter startup: ready${n ? `, flushed ${n} queued message(s)` : ''}`);
}

function hookFlush() {
  // Runs on pane.agent_status_changed — must be cheap when idle.
  const n = flushPending();
  if (n) console.log(`flushed ${n}`);
}

function hookOpenBoard() {
  const r = herdr(['plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', 'board']);
  if (!r.ok) { console.error(r.raw); process.exit(1); }
}

// ---------------------------------------------------------------- board TUI

function renderBoard() {
  const live = liveAgents();
  const agents = db().prepare('SELECT * FROM agents ORDER BY name').all();
  const tasks = db().prepare("SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, id LIMIT 12").all();
  const notes = db().prepare("SELECT * FROM notes WHERE status = 'active' ORDER BY id DESC LIMIT 8").all();
  const msgs = db().prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 8').all();
  const taskBy = Object.fromEntries(tasks.filter((t) => t.status === 'in_progress').map((t) => [t.assignee, t]));
  const dot = { idle: '\x1b[32m●\x1b[0m', done: '\x1b[32m●\x1b[0m', working: '\x1b[33m●\x1b[0m', blocked: '\x1b[31m●\x1b[0m', unknown: '\x1b[90m●\x1b[0m', offline: '\x1b[90m○\x1b[0m' };
  const out = [];
  out.push('\x1b[1m Chatter\x1b[0m  (q to close)\n');
  out.push('\x1b[1m Agents\x1b[0m');
  if (!agents.length) out.push('   (none registered yet)');
  for (const a of agents) {
    const l = live.find((x) => x.name === a.name || x.pane_id === a.pane_id);
    const st = l ? l.agent_status : 'offline';
    const t = taskBy[a.name];
    out.push(` ${dot[st] || dot.unknown} ${a.name.padEnd(18)} ${st.padEnd(9)} ${(a.branch || '').padEnd(22)} ${t ? t.id : ''}`.trimEnd());
  }
  out.push('\n\x1b[1m Tasks\x1b[0m');
  if (!tasks.length) out.push('   (none)');
  for (const t of tasks) out.push(' ' + taskLabel(t));
  out.push('\n\x1b[1m Shared memory\x1b[0m');
  if (!notes.length) out.push('   (empty)');
  for (const n of notes) out.push(` #${n.id} [${n.type}] ${n.author}: ${n.text}`.slice(0, 110));
  out.push('\n\x1b[1m Recent messages\x1b[0m');
  if (!msgs.length) out.push('   (none)');
  for (const m of msgs.reverse()) out.push(` ${m.from_agent} -> ${m.to_agent}  ${m.body}`.slice(0, 110));
  process.stdout.write('\x1b[2J\x1b[H' + out.join('\n') + '\n');
}

function cmdBoard() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (b) => {
      const s = b.toString();
      if (s === 'q' || s === '\x03' || s === '\x1b') process.exit(0);
    });
  }
  renderBoard();
  setInterval(renderBoard, 2000);
}

// ------------------------------------------------------------------ helpers

function parseFlags(args, defs) {
  const out = { _: [] , ...defs };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (!(key in defs)) die(`unknown flag ${a}`);
      out[key] = args[++i];
    } else out._.push(a);
  }
  return out;
}

function die(msg) { console.error(msg); process.exit(1); }

// --------------------------------------------------------------------- main

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  // Internal plugin entrypoints (run with plugin env, not by agents).
  if (cmd === '_startup') return hookStartup();
  if (cmd === '_flush') return hookFlush();
  if (cmd === '_open_board') return hookOpenBoard();
  if (cmd === 'board') return cmdBoard();

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); return; }

  const me = whoami();
  switch (cmd) {
    case 'agents': cmdAgents(me); break;
    case 'send': cmdSend(me, args); break;
    case 'inbox': cmdInbox(me, args); break;
    case 'note': cmdNote(me, args); break;
    case 'notes': case 'search': cmdNotes(me, args); break;
    case 'resolve': cmdResolve(me, args); break;
    case 'task': cmdTask(me, args); break;
    case 'handoff': cmdHandoff(me, args); break;
    case 'whoami': cmdWhoami(me); break;
    case 'log': cmdLog(); break;
    default: die(`unknown command "${cmd}" — try: chatter help`);
  }
  // Piggyback: any chatter activity flushes queued mail for everyone.
  try { flushPending(); } catch {}
}

main();
