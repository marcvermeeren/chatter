import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { openDbFile } from '../src/db';
import { formatDelivery } from '../src/team';
import type { ChatterDb, MessageRow } from '../src/types';

type DeliveryMessage = Pick<MessageRow, 'id' | 'from_agent' | 'to_agent' | 'body' | 'kind' | 'ref_id'>;

function fixture(t: TestContext): ChatterDb {
  const dir = mkdtempSync(path.join(tmpdir(), 'chatter-delivery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return openDbFile(path.join(dir, 'chatter.db'));
}

const message = (overrides: Partial<DeliveryMessage> = {}): DeliveryMessage => ({
  id: 10,
  from_agent: 'marc',
  to_agent: 'alpha',
  body: 'please take a look',
  kind: 'chat',
  ref_id: null,
  ...overrides,
});

function recordPriorDelivery(d: ChatterDb): void {
  d.prepare(`INSERT INTO messages
    (id, from_agent, to_agent, body, kind, created_at, delivered_at)
    VALUES (1, 'marc', 'alpha', 'earlier', 'chat', '2026-01-01', '2026-01-01')`).run();
}

test('DM footer teaches one private reply and help only on first contact', (t) => {
  const d = fixture(t);
  assert.equal(formatDelivery(message(), d),
    '[chatter] message from marc: please take a look\n'
    + '(reply: chatter send marc "..." · new here: chatter help)');
  recordPriorDelivery(d);
  assert.equal(formatDelivery(message({ id: 11 }), d),
    '[chatter] message from marc: please take a look\n(reply: chatter send marc "...")');
  assert.equal(formatDelivery(message({ id: 12, body: 'Use chatter send marc "ok"' }), d),
    '[chatter] message from marc: Use chatter send marc "ok"');
});

test('#chat mentions teach only a public reply', (t) => {
  const d = fixture(t);
  recordPriorDelivery(d);
  assert.equal(formatDelivery(message({ kind: 'mention', ref_id: 'p4' }), d),
    '[chatter] #chat mention from marc: please take a look\n'
    + '(reply: chatter post "@marc ...")');
});

test('only active questions receive the answer command', (t) => {
  const d = fixture(t);
  recordPriorDelivery(d);
  d.prepare(`INSERT INTO notes (id, author, type, text, status, created_at)
    VALUES (7, 'marc', 'question', 'ship it?', 'active', '2026-01-01')`).run();
  const question = message({
    kind: 'system', ref_id: 'q7',
    body: 'question #7: ship it? (answer with: chatter answer 7 "...")',
  });
  assert.equal(formatDelivery(question, d),
    '[chatter] message from marc: question #7: ship it?\n(answer: chatter answer 7 "...")');
  d.prepare("UPDATE notes SET status = 'resolved' WHERE id = 7").run();
  assert.equal(formatDelivery(message({ kind: 'system', ref_id: 'q7', body: 'answer recorded' }), d),
    '[chatter] message from marc: answer recorded');
});

test('task assignments mention completion and only existing active memory', (t) => {
  const d = fixture(t);
  recordPriorDelivery(d);
  const assignment = message({
    kind: 'system', ref_id: 'TASK-3',
    body: 'you were assigned TASK-3: fix auth (details: chatter task list)',
  });
  d.prepare(`INSERT INTO notes (author, type, text, task_id, status, created_at)
    VALUES ('marc', 'decision', 'stale context', 'TASK-3', 'superseded', '2026-01-01')`).run();
  assert.equal(formatDelivery(assignment, d),
    '[chatter] message from marc: you were assigned TASK-3: fix auth\n'
    + '(done: chatter task done TASK-3)');
  d.prepare(`INSERT INTO notes (author, type, text, task_id, status, created_at)
    VALUES ('marc', 'note', 'prior context', 'TASK-3', 'active', '2026-01-01')`).run();
  assert.equal(formatDelivery(assignment, d),
    '[chatter] message from marc: you were assigned TASK-3: fix auth\n'
    + '(done: chatter task done TASK-3 · memory: chatter notes --task TASK-3)');
});

test('handoffs flag only task-linked active decisions and dead ends', (t) => {
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
  assert.equal(formatDelivery(handoff, d),
    '[chatter] handoff from marc: TASK-8 continue\n(next: chatter handoff show 4)');
  d.prepare(`INSERT INTO notes (author, type, text, task_id, status, created_at)
    VALUES ('marc', 'discovery', 'found it', 'TASK-8', 'active', '2026-01-01')`).run();
  assert.equal(formatDelivery(handoff, d),
    '[chatter] handoff from marc: TASK-8 continue\n(next: chatter handoff show 4)');
  d.prepare(`INSERT INTO notes (author, type, text, task_id, status, created_at)
    VALUES ('marc', 'dead-end', 'cannot use v1', 'TASK-8', 'active', '2026-01-01')`).run();
  assert.equal(formatDelivery(handoff, d),
    '[chatter] handoff from marc: TASK-8 continue\n'
    + '(next: chatter handoff show 4 · prior decisions/dead ends: chatter notes --task TASK-8)');
});

test('purpose guidance is short, deduplicated, and generic system mail stays quiet', (t) => {
  const d = fixture(t);
  recordPriorDelivery(d);
  assert.equal(formatDelivery(message({ kind: 'purpose', body: 'your purpose: fix auth' }), d),
    '[chatter] message from marc: your purpose: fix auth\n'
    + '(search first: chatter notes "<approach>" · record dead ends: chatter note "..." --type dead-end)');
  assert.equal(formatDelivery(message({
    kind: 'purpose',
    body: 'Run chatter notes "auth" and chatter note "failed" --type dead-end',
  }), d), '[chatter] message from marc: Run chatter notes "auth" and chatter note "failed" --type dead-end');
  assert.equal(formatDelivery(message({ kind: 'system', body: 'build completed' }), d),
    '[chatter] message from marc: build completed');
});
