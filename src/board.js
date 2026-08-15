'use strict';
// Read-only popup views, re-rendered every 2s. q / Esc / Ctrl-C closes.
// `board` = chat-first overview; `chat` = full-height group chat.
// Repo selection: plugin invocation context (focused workspace) picks the DB;
// number keys switch between repos when several exist.

const fs = require('node:fs');
const path = require('node:path');
const { liveAgents, matchLive } = require('./herdr');
const { gitInfo, repoDbFile, openDbFile, listRepoDbFiles, humanName } = require('./db');
const { postToChat } = require('./team');
const { taskLabel } = require('./commands');

const DOT = {
  idle: '\x1b[32m●\x1b[0m', done: '\x1b[32m●\x1b[0m', working: '\x1b[33m●\x1b[0m',
  blocked: '\x1b[31m●\x1b[0m', unknown: '\x1b[90m●\x1b[0m', offline: '\x1b[90m○\x1b[0m',
};
const B = (s) => `\x1b[1m${s}\x1b[0m`;

// Pick the initial repo DB: focused-workspace context first, then this
// process's cwd (the plugin root is itself a repo), then the first known DB.
function initialDbFile() {
  try {
    const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
    const cwd = (ctx.worktree && ctx.worktree.checkout_path) || ctx.workspace_cwd || ctx.focused_pane_cwd;
    if (cwd) {
      const g = gitInfo(cwd);
      if (g.repoRoot && fs.existsSync(repoDbFile(g.repoRoot))) return repoDbFile(g.repoRoot);
    }
  } catch { /* fall through */ }
  const g = gitInfo(process.cwd());
  if (g.repoRoot && fs.existsSync(repoDbFile(g.repoRoot))) return repoDbFile(g.repoRoot);
  return listRepoDbFiles()[0] || null;
}

const repoLabel = (file) => path.basename(path.dirname(file)).replace(/-[0-9a-f]{8}$/, '');

function header(mode, file, files, extra) {
  const tabs = files.length > 1
    ? '  ' + files.map((f, i) => (f === file ? B(`[${i + 1} ${repoLabel(f)}]`) : `[${i + 1} ${repoLabel(f)}]`)).join(' ')
    : `  ${B(repoLabel(file))}`;
  return `${B(` Chatter ${mode}`)}  (q closes)${tabs}${extra || ''}\n`;
}

function chatLines(d, limit) {
  const rows = d.prepare(`SELECT * FROM messages WHERE to_agent = '#chat' ORDER BY id DESC LIMIT ${limit}`).all().reverse();
  if (!rows.length) return ['   (no posts yet — chatter post <text>)'];
  return rows.map((m) => ` ${m.created_at.slice(11, 16)} ${B(m.from_agent)}: ${m.body}`.slice(0, 160));
}

function renderChat(d, file, files, inputBuffer) {
  const rowsWanted = Math.max(5, (process.stdout.rows || 30) - 7);
  const input = `\n${B(' > ')}${inputBuffer}\x1b[7m \x1b[0m\n   Enter posts as ${B(humanName())} (@name pushes) · Esc closes`;
  process.stdout.write('\x1b[2J\x1b[H' + header('#chat', file, files) + '\n' + chatLines(d, rowsWanted).join('\n') + input + '\n');
}

function renderBoard(d, file, files) {
  const live = liveAgents({ fresh: true });
  const agents = d.prepare('SELECT * FROM agents ORDER BY name').all();
  const tasks = d.prepare("SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, id LIMIT 8").all();
  const notes = d.prepare("SELECT * FROM notes WHERE status = 'active' ORDER BY id DESC LIMIT 6").all();
  const taskBy = Object.fromEntries(tasks.filter((t) => t.status === 'in_progress').map((t) => [t.assignee, t]));
  const openQ = d.prepare("SELECT COUNT(*) AS n FROM notes WHERE type = 'question' AND status = 'active'").get().n;
  const out = [header('board', file, files, openQ ? `   \x1b[33m${openQ} open question${openQ > 1 ? 's' : ''}\x1b[0m` : '')];
  out.push(B(' Agents'));
  if (!agents.length) out.push('   (none registered yet)');
  for (const a of agents) {
    const l = matchLive(live, a);
    const st = l ? l.agent_status : 'offline';
    const t = taskBy[a.name];
    out.push(` ${DOT[st] || DOT.unknown} ${a.name.padEnd(18)} ${st.padEnd(9)} ${(a.role || a.branch || '').padEnd(20)} ${t ? t.id : ''}`.trimEnd());
  }
  out.push('\n' + B(' Group chat'));
  out.push(...chatLines(d, 10));
  out.push('\n' + B(' Tasks'));
  if (!tasks.length) out.push('   (none)');
  for (const t of tasks) out.push(' ' + taskLabel(t));
  out.push('\n' + B(' Shared memory'));
  if (!notes.length) out.push('   (empty)');
  for (const n of notes) out.push(` #${n.id} [${n.type}] ${n.author}: ${n.text}`.slice(0, 110));
  process.stdout.write('\x1b[2J\x1b[H' + out.join('\n') + '\n');
}

// Mention matching for human posts from the view: exact or unique prefix
// against this repo's roster plus live agent names (a deliberate human act).
function viewMentionResolver(d) {
  return (input) => {
    const names = new Set(d.prepare('SELECT name FROM agents').all().map((r) => r.name));
    for (const a of liveAgents()) if (a.name) names.add(a.name);
    if (names.has(input)) return input;
    const hits = [...names].filter((n) => n.startsWith(input));
    return hits.length === 1 ? hits[0] : null;
  };
}

function runView(render, { input = false } = {}) {
  let files = listRepoDbFiles();
  let file = initialDbFile();
  if (!file) { console.log('no chatter data yet — run chatter inside a git repo first'); process.exit(0); }
  let d = openDbFile(file);
  let buffer = '';
  const paint = () => { files = listRepoDbFiles(); render(d, file, files, buffer); };
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (b) => {
      const s = b.toString();
      if (s === '\x03' || s === '\x1b') process.exit(0);
      const switchRepo = (key) => {
        const n = parseInt(key, 10);
        if (n >= 1 && n <= files.length && files[n - 1] !== file) {
          file = files[n - 1];
          d = openDbFile(file);
          paint();
          return true;
        }
        return false;
      };
      // Read-only views: q closes, number keys switch repos. The input view
      // treats every printable key as typing (Esc closes it instead).
      if (!input) {
        if (s === 'q') process.exit(0);
        if (/^[1-9]$/.test(s)) switchRepo(s);
        return;
      }
      if (s === '\r' || s === '\n') {
        const body = buffer.trim();
        buffer = '';
        if (body) postToChat({ name: humanName(), human: true }, body, d, viewMentionResolver(d));
        return paint();
      }
      if (s === '\x7f' || s === '\b') { buffer = buffer.slice(0, -1); return paint(); }
      const printable = s.replace(/[\x00-\x1f\x7f]/g, '');
      if (printable) { buffer += printable; paint(); }
    });
  }
  paint();
  setInterval(paint, 2000);
}

const cmdBoard = () => runView(renderBoard);
const cmdChatView = () => runView(renderChat, { input: true });

module.exports = { cmdBoard, cmdChatView };
