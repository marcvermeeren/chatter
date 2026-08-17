'use strict';
// Who agents are (identity) and how messages move between them (delivery).
// Everything here operates within ONE repo's DB; cross-repo delivery is
// deliberately refused.

import path from 'node:path';
import { herdr, sessionAgents, invalidateSessionAgents, paneLabel } from './herdr';
import { db, dbFile, now, gitInfo, humanName, repoDbFile, logEvent, listRepoDbFiles, openDbFile } from './db';
import { die } from './util';
import type {
  AgentStatus, ChatterDb, CountRow, HandoffRow, Identity, LastReadRow, LiveAgent,
  MessageRow, NameRow, PaneRow,
} from './types';

// Does this live agent belong to the repo a DB handle serves?
const _inRepoCache = new Map<string, boolean>(); // `${dbfile}|${cwd}` -> boolean
function liveAgentInRepo(agent: LiveAgent, d: ChatterDb): boolean {
  if (!agent.cwd) return false;
  const key = `${dbFile(d)}|${agent.cwd}`;
  if (!_inRepoCache.has(key)) {
    const g = gitInfo(agent.cwd);
    _inRepoCache.set(key, !!g.repoRoot && repoDbFile(g.repoRoot) === dbFile(d));
  }
  return _inRepoCache.get(key) ?? false;
}

// THE chokepoint for repo-scoped code: live agents whose CURRENT working
// directory verifiably belongs to this repo. Registration is identity, not
// membership — "registered here once" never means "belongs here now", so an
// agent that moved to another repo drops out (fail closed; its mail queues).
// Everything outside this module must see live agents only through here
// (enforced by the boundary lint + behavioral tests in test/).
export function teamAgents(d: ChatterDb = db(), { fresh = false }: { fresh?: boolean } = {}): LiveAgent[] {
  return sessionAgents({ fresh }).filter((a) => liveAgentInRepo(a, d));
}

// ---------------------------------------------------------------- identity

export function sanitizeName(s: string | null | undefined): string {
  const n = (s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 32);
  return n || 'agent';
}

// Identify the caller. A pane running a recognized coding agent speaks as
// that agent; anything else (the human's shell, scripts, outside Herdr) is
// the human, named via `chatter iam <name>`.
// Agent naming ladder: manual pane label > <worktree-dir>-<kind> > cwd basename.
export function whoami(): Identity {
  const paneId = process.env.HERDR_PANE_ID || null;
  const human = { name: humanName(), paneId, human: true };
  if (!paneId) return human;
  // session-wide by design: own-pane lookup + name uniqueness (Herdr agent
  // names are unique across the whole session).
  const live = sessionAgents();
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
      invalidateSessionAgents();
      if (candidate !== base) {
        console.error(`note: "@${base}" was taken — you are "@${candidate}"`);
      }
    }
  }
  if (!name) return { name: `pane:${paneId}`, paneId, human: false };
  const g = gitInfo();
  const isNew = !db().prepare<{ present: number }>('SELECT 1 AS present FROM agents WHERE name = ?').get(name);
  db().prepare(`
    INSERT INTO agents (name, pane_id, workspace_id, cwd, repo_root, branch, kind, role, registered_at, last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET pane_id=excluded.pane_id, workspace_id=excluded.workspace_id,
      cwd=excluded.cwd, repo_root=excluded.repo_root, branch=excluded.branch,
      kind=excluded.kind, role=excluded.role, last_seen_at=excluded.last_seen_at
  `).run(name, paneId, me.workspace_id ?? null, process.cwd(), g.repoRoot, g.branch,
         me.agent ?? null, label, now(), now());
  if (isNew) logEvent(name, 'agent_joined', name, { kind: me.agent || null, pane: paneId });
  return { name, paneId, human: false, status: me ? me.agent_status : null };
}

// -------------------------------------------------- recipient resolution

function editDistance(a: string, b: string): number {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  const first = m[0];
  if (!first) return b.length;
  for (let j = 0; j <= b.length; j++) first[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = m[i];
      const prev = m[i - 1];
      if (!row || !prev) continue;
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return m[a.length]?.[b.length] ?? Math.max(a.length, b.length);
}

// Departed members (pane/worktree gone) are not addressable candidates.
function rosterNames(d: ChatterDb = db()): string[] {
  return d.prepare<NameRow>('SELECT name FROM agents WHERE departed_at IS NULL').all().map((r) => r.name);
}

// Is a name already claimed anywhere — live agents or any repo's roster?
// Departed rows free their name (a re-spawn is a comeback: queued mail from
// before departure delivers when the name verifiably returns).
// session-wide by design: names must be globally unique.
export function nameTaken(name: string): string | null {
  if (sessionAgents().some((a) => a.name === name)) return 'a live agent';
  for (const f of listRepoDbFiles()) {
    if (openDbFile(f).prepare<{ present: number }>('SELECT 1 AS present FROM agents WHERE name = ? AND departed_at IS NULL').get(name)) {
      return `a registered agent in ${path.basename(path.dirname(f))}`;
    }
  }
  return null;
}

// Resolve a user-typed recipient against this repo's roster (plus live agents
// verifiably in this repo). Exact > unique prefix > refuse-with-suggestions.
// { allowUnknown: true } queues for a not-yet-existing exact name (--queue).
export function resolveRecipient(
  input: string,
  { allowUnknown = false, soft = false }: { allowUnknown?: boolean; soft?: boolean } = {},
  d: ChatterDb = db(),
): string | null {
  const candidates = new Set([...rosterNames(d), humanName()]);
  if (candidates.has(input)) return input; // hot path: registered exact match
  // Live named agents not yet registered join the pool only when they
  // verifiably belong to this repo (per-repo isolation).
  for (const a of teamAgents(d)) if (a.name) candidates.add(a.name);
  if (candidates.has(input)) return input;
  const lower = input.toLowerCase();
  const prefix = [...candidates].filter((n) => n.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return prefix[0] ?? null;
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

interface DeliveryTarget { paneId: string; status: AgentStatus | undefined }
function resolveTarget(name: string, live: readonly LiveAgent[], d: ChatterDb = db()): DeliveryTarget | null {
  // Fail closed: injection requires the target's CURRENT repo to verify —
  // historical registration alone is never enough (an agent that moved to
  // another repo must not receive this repo's messages there).
  const byName = live.find((x) => x.name === name);
  if (byName && liveAgentInRepo(byName, d)) {
    return { paneId: byName.pane_id, status: byName.agent_status };
  }
  // Last-known pane, but only if it isn't now occupied by a differently-named
  // agent AND still works in this repo (a pane can be cd'd elsewhere).
  const registered = d.prepare<PaneRow>('SELECT pane_id FROM agents WHERE name = ?').get(name);
  if (registered) {
    const atPane = live.find((x) => x.pane_id === registered.pane_id);
    if (atPane && !atPane.name && liveAgentInRepo(atPane, d)) {
      return { paneId: atPane.pane_id, status: atPane.agent_status };
    }
  }
  return null;
}

// What gets injected into a session: sanitized (no control chars that could
// forge the [chatter] framing) and capped (full text stays in the DB).
const MAX_DELIVERY_CHARS = 700;
function deliveryText(body: string): string {
  let t = String(body).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  if (t.length > MAX_DELIVERY_CHARS) t = `${t.slice(0, MAX_DELIVERY_CHARS)}… (full text: chatter inbox --all)`;
  return t;
}

export function chatUnreadCount(agent: string, d: ChatterDb = db()): number {
  const p = d.prepare<LastReadRow>('SELECT last_read_id FROM chat_reads WHERE agent = ?').get(agent);
  return d.prepare<CountRow>("SELECT COUNT(*) AS n FROM messages WHERE to_agent = '#chat' AND from_agent != ? AND id > ?")
    .get(agent, (p && p.last_read_id) || 0)?.n ?? 0;
}

type DeliveryMessage = Pick<MessageRow, 'id' | 'from_agent' | 'to_agent' | 'body' | 'kind' | 'ref_id'>;

function generatedScaffoldFreeBody(msg: DeliveryMessage): string {
  let body = msg.body;
  const question = msg.kind === 'system' ? msg.ref_id?.match(/^q(\d+)$/) : null;
  if (question?.[1]) {
    const suffix = ` (answer with: chatter answer ${question[1]} "...")`;
    if (body.endsWith(suffix)) body = body.slice(0, -suffix.length);
  }
  if (msg.kind === 'system' && /^TASK-\d+$/.test(msg.ref_id || '')) {
    const suffix = ' (details: chatter task list)';
    if (body.endsWith(suffix)) body = body.slice(0, -suffix.length);
  }
  const handoff = msg.kind === 'handoff' ? msg.ref_id?.match(/^h(\d+)$/) : null;
  if (handoff?.[1]) {
    const suffix = ` | full details: chatter handoff show ${handoff[1]}`;
    if (body.endsWith(suffix)) body = body.slice(0, -suffix.length);
  }
  return body;
}

function contextualFooter(msg: DeliveryMessage, visibleBody: string, d: ChatterDb): string[] {
  const clauses: string[] = [];
  const add = (command: string, clause: string): void => {
    if (!visibleBody.includes(command)) clauses.push(clause);
  };
  const question = msg.kind === 'system' ? msg.ref_id?.match(/^q(\d+)$/) : null;
  const taskId = msg.kind === 'system' && /^TASK-\d+$/.test(msg.ref_id || '') ? msg.ref_id : null;
  const handoff = msg.kind === 'handoff' ? msg.ref_id?.match(/^h(\d+)$/) : null;

  if (msg.kind === 'chat') {
    add(`chatter send ${msg.from_agent}`, `reply: chatter send ${msg.from_agent} "..."`);
  } else if (msg.kind === 'mention') {
    add('chatter post', `reply: chatter post "@${msg.from_agent} ..."`);
  } else if (question?.[1]) {
    const active = d.prepare<CountRow>(
      "SELECT COUNT(*) AS n FROM notes WHERE id = ? AND type = 'question' AND status = 'active'"
    ).get(Number(question[1]))?.n ?? 0;
    if (active) add(`chatter answer ${question[1]}`, `answer: chatter answer ${question[1]} "..."`);
  } else if (taskId) {
    add(`chatter task done ${taskId}`, `done: chatter task done ${taskId}`);
    const memory = d.prepare<CountRow>(
      "SELECT COUNT(*) AS n FROM notes WHERE task_id = ? AND status = 'active'"
    ).get(taskId)?.n ?? 0;
    if (memory) add(`chatter notes --task ${taskId}`, `memory: chatter notes --task ${taskId}`);
  } else if (handoff?.[1]) {
    add(`chatter handoff show ${handoff[1]}`, `next: chatter handoff show ${handoff[1]}`);
    const row = d.prepare<Pick<HandoffRow, 'task_id'>>('SELECT task_id FROM handoffs WHERE id = ?')
      .get(Number(handoff[1]));
    if (row?.task_id) {
      const memory = d.prepare<CountRow>(`SELECT COUNT(*) AS n FROM notes
        WHERE task_id = ? AND status = 'active' AND type IN ('decision','dead-end')`).get(row.task_id)?.n ?? 0;
      if (memory) add(`chatter notes --task ${row.task_id}`,
        `prior decisions/dead ends: chatter notes --task ${row.task_id}`);
    }
  } else if (msg.kind === 'purpose') {
    add('chatter notes', 'search first: chatter notes "<approach>"');
    add('chatter note ', 'record dead ends: chatter note "..." --type dead-end');
  }

  const prior = d.prepare<CountRow>(`SELECT COUNT(*) AS n FROM messages
    WHERE to_agent = ? AND id != ? AND delivered_at IS NOT NULL`).get(msg.to_agent, msg.id)?.n ?? 0;
  if (!prior) add('chatter help', 'new here: chatter help');
  return clauses;
}

export function formatDelivery(msg: DeliveryMessage, d: ChatterDb = db()): string {
  const head = msg.kind === 'handoff' ? `[chatter] handoff from ${msg.from_agent}`
    : msg.kind === 'mention' ? `[chatter] #chat mention from ${msg.from_agent}`
    : `[chatter] message from ${msg.from_agent}`;
  const body = deliveryText(generatedScaffoldFreeBody(msg));
  const clauses = contextualFooter(msg, body, d);
  return `${head}: ${body}${clauses.length ? `\n(${clauses.join(' · ')})` : ''}`;
}

// Deliver one message: agents get a session injection; the human gets a toast
// (the message itself waits in the feed/inbox). Claims the row atomically
// first so concurrent flushes (event hooks) can't double-deliver.
function tryDeliver(msg: DeliveryMessage, live: readonly LiveAgent[], d: ChatterDb = db()): boolean {
  if (msg.to_agent === humanName()) {
    const claim = d.prepare('UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL')
      .run(now(), msg.id);
    if (claim.changes !== 1) return false;
    // The toast is a pointer, not the message — content is read in the chat
    // window. Best effort: mark delivered even if toasts are configured off,
    // so the flush loop doesn't re-toast forever. read_at stays null until viewed.
    const what = msg.kind === 'mention' ? 'mentioned you in #chat' : 'sent you a direct message';
    herdr(['notification', 'show', `chatter: ${msg.from_agent}`,
      '--body', `${what} — open the chatter window to read`, '--sound', 'request']);
    return true;
  }
  const t = resolveTarget(msg.to_agent, live, d);
  if (!t || !t.status || !DELIVERABLE.has(t.status)) return false;
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
export function flushPending(d: ChatterDb = db()): number {
  const pending = d.prepare<MessageRow>('SELECT * FROM messages WHERE delivered_at IS NULL ORDER BY id').all();
  if (!pending.length) return 0;
  const live = sessionAgents();
  let n = 0;
  for (const m of pending) if (tryDeliver(m, live, d)) n++;
  return n;
}

export interface SendResult { delivered: boolean; reason?: string }
export function sendMessage(
  from: string,
  to: string,
  body: string,
  kind = 'chat',
  refId: string | null = null,
  d: ChatterDb = db(),
): SendResult {
  const r = d.prepare(
    'INSERT INTO messages (from_agent, to_agent, body, kind, ref_id, created_at) VALUES (?,?,?,?,?,?)'
  ).run(from, to, body, kind, refId, now());
  const msg = { id: Number(r.lastInsertRowid), from_agent: from, to_agent: to, body, kind, ref_id: refId };
  const live = sessionAgents();
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
// Safe by construction: the default mention resolver binds to the SAME
// handle `d`, never to the process-cwd universe.
export interface PostResult { postId: number; pushed: string[]; warnings: string[] }
export function postToChat(
  me: Identity,
  body: string,
  d: ChatterDb = db(),
  resolveMention: ((name: string) => string | null) | null = null,
): PostResult {
  const resolve = resolveMention || ((n: string) => resolveRecipient(n, { soft: true }, d));
  const postId = d.prepare(
    "INSERT INTO messages (from_agent, to_agent, body, kind, created_at, delivered_at) VALUES (?,'#chat',?,'post',?,?)"
  ).run(me.name, body, now(), now()).lastInsertRowid;
  const numericPostId = Number(postId);
  const mentioned = new Set<string>();
  const warnings: string[] = [];
  let everyone = false;
  for (const m of body.matchAll(/@([a-z0-9_-]+)/g)) {
    const mention = m[1];
    if (!mention) continue;
    if (mention === 'everyone') { everyone = true; continue; }
    const hit = resolve(mention);
    if (hit && hit !== me.name) mentioned.add(hit);
    else if (!hit) warnings.push(`mention @${mention} matches no agent in this repo — not pushed`);
  }
  if (everyone) {
    if (me.human) {
      for (const a of teamAgents(d)) {
        if (!a.name || a.name === me.name) continue;
        const hit = resolve(a.name);
        if (hit) mentioned.add(hit);
      }
    } else {
      warnings.push('@everyone is reserved for the human — post saved, nobody was pushed');
    }
  }
  const pushed: string[] = [];
  for (const to of mentioned) {
    const res = sendMessage(me.name, to, body, 'mention', `p${numericPostId}`, d);
    pushed.push(`${to}${res.delivered ? '' : ' (queued)'}`);
  }
  return { postId: numericPostId, pushed, warnings };
}
