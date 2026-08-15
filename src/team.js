'use strict';
// Who agents are (identity) and how messages move between them (delivery).

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { herdr, liveAgents, invalidateLiveAgents } = require('./herdr');
const { db, now } = require('./db');

// ---------------------------------------------------------------- identity

function gitInfo(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD', '--show-toplevel'],
    { encoding: 'utf8' });
  if (r.status !== 0) return { branch: null, repo_root: null };
  const [branch, repo_root] = r.stdout.trim().split('\n');
  return { branch: branch || null, repo_root: repo_root || null };
}

function sanitizeName(s) {
  const n = (s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 32);
  return n || 'agent';
}

// Identify the calling pane's agent; auto-register on first contact.
function whoami() {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) return { name: 'user', paneId: null, human: true };
  const live = liveAgents();
  const me = live.find((a) => a.pane_id === paneId);
  let name = me && me.name;
  if (!name) {
    // Derive a stable name and tell Herdr so both sides agree.
    const cwd = (me && me.cwd) || process.cwd();
    const base = sanitizeName(path.basename(cwd));
    const taken = new Set(live.map((a) => a.name).filter(Boolean));
    let candidate = base, i = 2;
    while (taken.has(candidate)) candidate = `${base}-${i++}`.slice(0, 32);
    if (herdr(['agent', 'rename', paneId, candidate]).ok) {
      name = candidate;
      invalidateLiveAgents();
    }
  }
  if (!name) return { name: `pane:${paneId}`, paneId, human: false };
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
  return { name, paneId, human: false, status: me ? me.agent_status : null };
}

// ---------------------------------------------------------------- delivery

// Statuses safe to inject into: a working agent queues typed input; a blocked
// one is showing a dialog that our text would answer.
const DELIVERABLE = new Set(['idle', 'done', 'working', 'unknown']);

function resolveTarget(name, live) {
  const byName = live.find((x) => x.name === name);
  if (byName) return { paneId: byName.pane_id, status: byName.agent_status };
  // Last-known pane, but only if it isn't now occupied by a differently-named
  // agent — otherwise the message would land in the wrong session.
  const row = db().prepare('SELECT pane_id FROM agents WHERE name = ?').get(name);
  if (row) {
    const atPane = live.find((x) => x.pane_id === row.pane_id);
    if (atPane && !atPane.name) return { paneId: atPane.pane_id, status: atPane.agent_status };
  }
  return null;
}

// What gets injected into a session: sanitized (no control chars that could
// forge the [chatter] framing) and capped (full text stays in the DB).
const MAX_DELIVERY_CHARS = 700;
function deliveryText(body) {
  let t = String(body).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  if (t.length > MAX_DELIVERY_CHARS) t = `${t.slice(0, MAX_DELIVERY_CHARS)}… (full text: chatter inbox --all)`;
  return t;
}

function formatDelivery(msg) {
  const head = msg.kind === 'handoff'
    ? `[chatter] handoff from ${msg.from_agent}`
    : `[chatter] message from ${msg.from_agent}`;
  return `${head}: ${deliveryText(msg.body)}\n(you are "${msg.to_agent}" — reply: chatter send ${msg.from_agent} "..." | inbox: chatter inbox | all commands: chatter help)`;
}

// Inject one message into its target's live session. Claims the message
// atomically first so concurrent flushes (event hooks) can't double-deliver.
function tryDeliver(msg, live) {
  const t = resolveTarget(msg.to_agent, live);
  if (!t || !DELIVERABLE.has(t.status)) return false;
  const claim = db().prepare('UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL')
    .run(now(), msg.id);
  if (claim.changes !== 1) return false; // another process got it
  if (!herdr(['agent', 'prompt', t.paneId, formatDelivery(msg)]).ok) {
    db().prepare('UPDATE messages SET delivered_at = NULL WHERE id = ?').run(msg.id);
    return false;
  }
  db().prepare('UPDATE messages SET read_at = ? WHERE id = ?').run(now(), msg.id);
  return true;
}

// Best-effort flush of everything queued; zero subprocesses when queue is empty.
function flushPending() {
  const pending = db().prepare('SELECT * FROM messages WHERE delivered_at IS NULL ORDER BY id').all();
  if (!pending.length) return 0;
  const live = liveAgents();
  let n = 0;
  for (const m of pending) if (tryDeliver(m, live)) n++;
  return n;
}

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

module.exports = { gitInfo, sanitizeName, whoami, resolveTarget, formatDelivery, tryDeliver, flushPending, sendMessage };
