'use strict';
// Read-only popup dashboard, re-rendered every 2s. q / Esc / Ctrl-C closes.

const { liveAgents, matchLive } = require('./herdr');
const { db } = require('./db');
const { taskLabel, openQuestions } = require('./commands');

const DOT = {
  idle: '\x1b[32m●\x1b[0m', done: '\x1b[32m●\x1b[0m', working: '\x1b[33m●\x1b[0m',
  blocked: '\x1b[31m●\x1b[0m', unknown: '\x1b[90m●\x1b[0m', offline: '\x1b[90m○\x1b[0m',
};

function renderBoard() {
  const live = liveAgents({ fresh: true });
  const agents = db().prepare('SELECT * FROM agents ORDER BY name').all();
  const tasks = db().prepare("SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, id LIMIT 12").all();
  const notes = db().prepare("SELECT * FROM notes WHERE status = 'active' ORDER BY id DESC LIMIT 8").all();
  const msgs = db().prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 8').all();
  const taskBy = Object.fromEntries(tasks.filter((t) => t.status === 'in_progress').map((t) => [t.assignee, t]));
  const openQ = openQuestions();
  const out = [];
  out.push(`\x1b[1m Chatter\x1b[0m  (q to close)${openQ.length ? `   \x1b[33m${openQ.length} open question${openQ.length > 1 ? 's' : ''}\x1b[0m` : ''}\n`);
  out.push('\x1b[1m Agents\x1b[0m');
  if (!agents.length) out.push('   (none registered yet)');
  for (const a of agents) {
    const l = matchLive(live, a);
    const st = l ? l.agent_status : 'offline';
    const t = taskBy[a.name];
    out.push(` ${DOT[st] || DOT.unknown} ${a.name.padEnd(18)} ${st.padEnd(9)} ${(a.branch || '').padEnd(22)} ${t ? t.id : ''}`.trimEnd());
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

module.exports = { cmdBoard };
