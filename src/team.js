'use strict';
// Who agents are (identity) and how messages move between them (delivery).
// Everything here operates within ONE repo's DB; cross-repo delivery is
// deliberately refused.

const path = require('node:path');
const { herdr, liveAgents, invalidateLiveAgents, paneLabel } = require('./herdr');
const { db, now, gitInfo, humanName } = require('./db');
const { die } = require('./util');

// ---------------------------------------------------------------- identity

function sanitizeName(s) {
  const n = (s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 32);
  return n || 'agent';
}

// Identify the caller. A pane running a recognized coding agent speaks as
// that agent; anything else (the human's shell, scripts, outside Herdr) is
// the human, named via `chatter iam <name>`.
// Agent naming ladder: manual pane label > <worktree-dir>-<kind> > cwd basename.
function whoami() {
  const paneId = process.env.HERDR_PANE_ID || null;
  const human = { name: humanName(), paneId, human: true };
  if (!paneId) return human;
  const live = liveAgents();
  const me = live.find((a) => a.pane_id === paneId);
  if (!me) return human;
  const label = paneLabel(paneId);
  let name = me && me.name;
  if (!name) {
    const g = gitInfo();
    const base = label ? sanitizeName(label)
      : g.toplevel ? sanitizeName(`${path.basename(g.toplevel)}-${(me && me.agent) || 'agent'}`)
      : sanitizeName(path.basename(process.cwd()));
    const taken = new Set(live.map((a) => a.name).filter(Boolean));
    let candidate = base, i = 2;
    while (taken.has(candidate)) candidate = `${base}-${i++}`.slice(0, 32);
    if (herdr(['agent', 'rename', paneId, candidate]).ok) {
      name = candidate;
      invalidateLiveAgents();
    }
  }
  if (!name) return { name: `pane:${paneId}`, paneId, human: false };
  const g = gitInfo();
  db().prepare(`
    INSERT INTO agents (name, pane_id, workspace_id, cwd, repo_root, branch, kind, role, registered_at, last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET pane_id=excluded.pane_id, workspace_id=excluded.workspace_id,
      cwd=excluded.cwd, repo_root=excluded.repo_root, branch=excluded.branch,
      kind=excluded.kind, role=excluded.role, last_seen_at=excluded.last_seen_at
  `).run(name, paneId, me ? me.workspace_id : null, process.cwd(), g.repoRoot, g.branch,
         me ? me.agent : null, label, now(), now());
  return { name, paneId, human: false, status: me ? me.agent_status : null };
}

// -------------------------------------------------- recipient resolution

function editDistance(a, b) {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return m[a.length][b.length];
}

function rosterNames() {
  return db().prepare('SELECT name FROM agents').all().map((r) => r.name);
}

// Resolve a user-typed recipient against this repo's roster (plus live agents
// verifiably in this repo). Exact > unique prefix > refuse-with-suggestions.
// { allowUnknown: true } queues for a not-yet-existing exact name (--queue).
function resolveRecipient(input, { allowUnknown = false, soft = false } = {}) {
  const candidates = new Set([...rosterNames(), humanName()]);
  if (candidates.has(input)) return input; // hot path: registered exact match
  // Live named agents not yet registered join the candidate pool only if
  // their pane's cwd belongs to this repo (keeps per-repo isolation).
  const ourRepo = gitInfo().repoRoot;
  for (const a of liveAgents()) {
    if (a.name && !candidates.has(a.name) && a.cwd && gitInfo(a.cwd).repoRoot === ourRepo) {
      candidates.add(a.name);
    }
  }
  if (candidates.has(input)) return input;
  const lower = input.toLowerCase();
  const prefix = [...candidates].filter((n) => n.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return prefix[0];
  if (soft) return null;
  if (allowUnknown) return input;
  const near = [...candidates].filter((n) =>
    prefix.includes(n) || n.toLowerCase().includes(lower) || editDistance(n.toLowerCase(), lower) <= 2);
  const hint = near.length ? `did you mean: ${near.join(', ')}?`
    : candidates.size ? `known agents: ${[...candidates].join(', ')}` : 'no agents registered in this repo yet';
  die(`no agent "${input}" in this repo — ${hint}\n(use --queue with the exact name to queue for an agent that doesn't exist yet)`);
}

// ---------------------------------------------------------------- delivery

// Statuses safe to inject into: a working agent queues typed input; a blocked
// one is showing a dialog that our text would answer.
const DELIVERABLE = new Set(['idle', 'done', 'working', 'unknown']);

function resolveTarget(name, live, d = db()) {
  const byName = live.find((x) => x.name === name);
  if (byName) return { paneId: byName.pane_id, status: byName.agent_status };
  // Last-known pane, but only if it isn't now occupied by a differently-named
  // agent — otherwise the message would land in the wrong session.
  const row = d.prepare('SELECT pane_id FROM agents WHERE name = ?').get(name);
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

function chatUnreadCount(agent, d = db()) {
  const p = d.prepare('SELECT last_read_id FROM chat_reads WHERE agent = ?').get(agent);
  return d.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_agent = '#chat' AND from_agent != ? AND id > ?")
    .get(agent, (p && p.last_read_id) || 0).n;
}

function formatDelivery(msg, d = db()) {
  const head = msg.kind === 'handoff' ? `[chatter] handoff from ${msg.from_agent}`
    : msg.kind === 'mention' ? `[chatter] #chat mention from ${msg.from_agent}`
    : `[chatter] message from ${msg.from_agent}`;
  const unread = chatUnreadCount(msg.to_agent, d);
  const chat = unread ? ` | #chat: ${unread} unread (chatter chat)` : '';
  return `${head}: ${deliveryText(msg.body)}\n(you are "${msg.to_agent}" — reply: chatter send ${msg.from_agent} "..." | inbox: chatter inbox${chat} | all commands: chatter help)`;
}

// Deliver one message: agents get a session injection; the human gets a toast
// (the message itself waits in the feed/inbox). Claims the row atomically
// first so concurrent flushes (event hooks) can't double-deliver.
function tryDeliver(msg, live, d = db()) {
  if (msg.to_agent === humanName()) {
    const claim = d.prepare('UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL')
      .run(now(), msg.id);
    if (claim.changes !== 1) return false;
    // Best effort: mark delivered even if toasts are configured off, so the
    // flush loop doesn't re-toast forever. read_at stays null until viewed.
    herdr(['notification', 'show', `chatter: ${msg.from_agent}`,
      '--body', deliveryText(msg.body).slice(0, 200), '--sound', 'request']);
    return true;
  }
  const t = resolveTarget(msg.to_agent, live, d);
  if (!t || !DELIVERABLE.has(t.status)) return false;
  const claim = d.prepare('UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL')
    .run(now(), msg.id);
  if (claim.changes !== 1) return false; // another process got it
  if (!herdr(['agent', 'prompt', t.paneId, formatDelivery(msg, d)]).ok) {
    d.prepare('UPDATE messages SET delivered_at = NULL WHERE id = ?').run(msg.id);
    return false;
  }
  d.prepare('UPDATE messages SET read_at = ? WHERE id = ?').run(now(), msg.id);
  return true;
}

// Best-effort flush of one repo's queue; zero subprocesses when it's empty.
function flushPending(d = db()) {
  const pending = d.prepare('SELECT * FROM messages WHERE delivered_at IS NULL ORDER BY id').all();
  if (!pending.length) return 0;
  const live = liveAgents();
  let n = 0;
  for (const m of pending) if (tryDeliver(m, live, d)) n++;
  return n;
}

function sendMessage(from, to, body, kind = 'chat', refId = null, d = db()) {
  const r = d.prepare(
    'INSERT INTO messages (from_agent, to_agent, body, kind, ref_id, created_at) VALUES (?,?,?,?,?,?)'
  ).run(from, to, body, kind, refId, now());
  const msg = { id: r.lastInsertRowid, from_agent: from, to_agent: to, body, kind, ref_id: refId };
  const live = liveAgents();
  if (to === humanName()) {
    return tryDeliver(msg, live, d) ? { delivered: true } : { delivered: false, reason: 'toast failed — waiting in the feed' };
  }
  const t = resolveTarget(to, live, d);
  if (!t) return { delivered: false, reason: `"${to}" has no live pane — queued (they'll get it via chatter inbox or when they appear)` };
  if (tryDeliver(msg, live, d)) return { delivered: true };
  return { delivered: false, reason: `${to} is ${t.status} — queued, will deliver when they settle` };
}

// Post to a repo's group chat and push any mentions. `resolveMention` maps a
// raw @name to a recipient (or null); callers choose how strict that is.
function postToChat(me, body, d = db(), resolveMention = (n) => resolveRecipient(n, { soft: true })) {
  const postId = d.prepare(
    "INSERT INTO messages (from_agent, to_agent, body, kind, created_at, delivered_at) VALUES (?,'#chat',?,'post',?,?)"
  ).run(me.name, body, now(), now()).lastInsertRowid;
  const mentioned = new Set();
  const warnings = [];
  let everyone = false;
  for (const m of body.matchAll(/@([a-z0-9_-]+)/g)) {
    if (m[1] === 'everyone') { everyone = true; continue; }
    const hit = resolveMention(m[1]);
    if (hit && hit !== me.name) mentioned.add(hit);
    else if (!hit) warnings.push(`mention @${m[1]} matches no agent in this repo — not pushed`);
  }
  if (everyone) {
    if (me.human) {
      for (const a of liveAgents()) {
        if (!a.name || a.name === me.name) continue;
        const hit = resolveMention(a.name);
        if (hit) mentioned.add(hit);
      }
    } else {
      warnings.push('@everyone is reserved for the human — post saved, nobody was pushed');
    }
  }
  const pushed = [];
  for (const to of mentioned) {
    const res = sendMessage(me.name, to, body, 'mention', `p${postId}`, d);
    pushed.push(`${to}${res.delivered ? '' : ' (queued)'}`);
  }
  return { postId, pushed, warnings };
}

module.exports = {
  sanitizeName, whoami, resolveRecipient, resolveTarget,
  formatDelivery, tryDeliver, flushPending, sendMessage, postToChat, chatUnreadCount,
};
