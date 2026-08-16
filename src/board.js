'use strict';
// Popup views. `chat` = grouped, colored, scrollable conversation with a fixed
// input bar. `board` = read-only overview. Both use the flicker-free painter.

const fs = require('node:fs');
const path = require('node:path');
const { liveAgents, matchLive } = require('./herdr');
const { gitInfo, repoDbFile, openDbFile, listRepoDbFiles, humanName } = require('./db');
const { postToChat, liveAgentInRepo } = require('./team');
const { taskLabel, buildBrief, spawnAgent } = require('./commands');
const { toMs } = require('./util');
const T = require('./tui');

// ------------------------------------------------------------ repo selection

function initialDbFile() {
  // The focused workspace's repo wins — and if its universe doesn't exist
  // yet, create it (empty) rather than silently showing another repo's chat.
  try {
    const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
    const cwd = (ctx.worktree && ctx.worktree.checkout_path) || ctx.workspace_cwd || ctx.focused_pane_cwd;
    if (cwd) {
      const g = gitInfo(cwd);
      if (g.repoRoot) {
        const file = repoDbFile(g.repoRoot);
        openDbFile(file).prepare(`INSERT INTO ui_marks (agent, mark, value) VALUES ('_repo', 'root', ?)
          ON CONFLICT(agent, mark) DO UPDATE SET value = excluded.value`).run(g.repoRoot);
        return file;
      }
    }
  } catch { /* fall through */ }
  const g = gitInfo(process.cwd());
  if (g.repoRoot && fs.existsSync(repoDbFile(g.repoRoot))) return repoDbFile(g.repoRoot);
  return listRepoDbFiles()[0] || null;
}

const repoLabel = (file) => path.basename(path.dirname(file)).replace(/-[0-9a-f]{8}$/, '');

// ------------------------------------------------------------------- helpers

const pad2 = (n) => String(n).padStart(2, '0');
const localHM = (ts) => { const d = new Date(toMs(ts)); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const localDay = (ts) => new Date(toMs(ts)).toDateString().slice(0, 10);

function highlightMentions(line, human) {
  return line.replace(/@([a-z0-9_-]+)/g, (_, n) =>
    (n === human || n === 'everyone')
      ? `${T.INV}@${n}${T.RESET}`
      : `${T.fg(T.authorHue(n))}${T.BOLD}@${n}${T.RESET}`);
}

function headerBar(file, files, width) {
  const active = (f) => f === file;
  const tabs = files.length > 1
    ? files.map((f, i) => active(f) ? `${T.BOLD}[${i + 1} ${repoLabel(f)}]${T.RESET}${T.bg(236)}` : `[${i + 1} ${repoLabel(f)}]`).join(' ')
    : '';
  const left = ` ${T.BOLD}#${repoLabel(file)}${T.RESET}${T.bg(236)}`;
  const raw = `${left}   ${T.CHROME}${tabs}`;
  const fill = Math.max(0, width - T.visWidth(raw));
  return `${T.bg(236)}${raw}${' '.repeat(fill)}${T.RESET}`;
}

// --------------------------------------------------------------- chat window

// The human's window is omniscient: channel posts plus ALL direct traffic,
// including agent-to-agent DMs. Mention rows are per-recipient copies of a
// channel post, so they're skipped (the post itself shows).
function feedRows(d) {
  return d.prepare(`SELECT * FROM messages
    WHERE to_agent = '#chat' OR kind != 'mention'
    ORDER BY id DESC LIMIT 500`).all().reverse();
}

function buildFeedLines(rows, width, human, openPointer) {
  const lines = [];
  const bodyW = Math.max(20, width - 8);
  const center = (label, color) => {
    const t = `── ${label} ──`;
    lines.push(' '.repeat(Math.max(0, Math.floor((width - t.length) / 2))) + color + t + T.RESET);
  };
  let prev = null, prevDay = null, marker = false;
  for (const m of rows) {
    const day = localDay(m.created_at);
    if (day !== prevDay) { if (lines.length) lines.push(''); center(day, T.FAINT); prevDay = day; prev = null; }
    if (!marker && openPointer != null && m.to_agent === '#chat' && m.id > openPointer) {
      center('new', T.NEWMARK); marker = true; prev = null;
    }
    const isDM = m.to_agent !== '#chat';
    const grouped = prev && prev.from_agent === m.from_agent && prev.to_agent === m.to_agent
      && (toMs(m.created_at) - toMs(prev.created_at)) < 5 * 60 * 1000;
    const mine = m.from_agent === human || m.to_agent === human;
    if (!grouped) {
      if (lines.length) lines.push('');
      const you = m.from_agent === human ? ` ${T.FAINT}(you)${T.RESET}` : '';
      let head;
      if (!isDM) {
        head = `  ${T.author(m.from_agent)} ${T.CHROME}· ${localHM(m.created_at)}${T.RESET}${you}`;
      } else if (mine) {
        head = `  ${T.author(m.from_agent)} ${T.CHROME}· ${localHM(m.created_at)}${T.RESET}${you} ${T.CYAN}[DM → ${m.to_agent === human ? 'you' : m.to_agent}]${T.RESET}`;
      } else {
        // Agent-to-agent DM: both names colored, visibly quieter.
        head = `  ${T.author(m.from_agent)} ${T.CHROME}→${T.RESET} ${T.author(m.to_agent)} ${T.CHROME}· ${localHM(m.created_at)} [DM]${T.RESET}`;
      }
      lines.push(head);
    }
    const prefix = isDM ? `    ${T.fg(T.authorHue(m.from_agent))}│${T.RESET} ` : '    ';
    const style = (isDM && !mine) ? (l) => `${T.CHROME}${l}${T.RESET}` : (l) => highlightMentions(l, human);
    for (const l of T.wrap(T.clean(m.body), bodyW)) lines.push(prefix + style(l));
    prev = m;
  }
  return lines;
}

function renderChat(d, file, files, ui) {
  const width = process.stdout.columns || 100;
  const height = process.stdout.rows || 30;
  const human = humanName();
  const rows = feedRows(d);
  ui.lastMaxId = rows.length ? rows[rows.length - 1].id : 0;

  // Seeing the latest IS reading — but only while pinned to the bottom.
  if (ui.offset === 0) {
    const dmIds = rows.filter((m) => m.to_agent === human && !m.read_at).map((m) => m.id);
    if (dmIds.length) d.prepare(`UPDATE messages SET read_at = datetime('now') WHERE id IN (${dmIds.join(',')})`).run();
    const maxChat = rows.filter((m) => m.to_agent === '#chat').map((m) => m.id).pop();
    if (maxChat) {
      d.prepare(`INSERT INTO chat_reads (agent, last_read_id) VALUES (?,?)
        ON CONFLICT(agent) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`).run(human, maxChat);
    }
  }

  // Private block (slash-command results) sits above the input bar and
  // borrows rows from the feed. Never stored, never posted.
  const block = ui.block
    ? [`  ${T.FAINT}┌ ${ui.block.title} — only you (/clear dismisses)${T.RESET}`,
       ...ui.block.lines.map((l) => `  ${T.FAINT}│${T.RESET} ${l}`)]
    : [];
  const feedH = Math.max(3, height - 4 - block.length);
  const all = buildFeedLines(rows, width, human, ui.openPointer);
  ui.maxOffset = Math.max(0, all.length - feedH);
  ui.offset = Math.min(ui.offset, ui.maxOffset);
  const end = all.length - ui.offset;
  let visible = all.slice(Math.max(0, end - feedH), end);
  if (visible.length < feedH) visible = [...Array(feedH - visible.length).fill(''), ...visible];

  // Separator, with a scroll indicator while reading history.
  let sep = T.CHROME + '─'.repeat(width) + T.RESET;
  if (ui.offset > 0) {
    const fresh = rows.filter((m) => m.id > (ui.scrollBaseId || 0)).length;
    const label = ` ↓ ${fresh ? `${fresh} new · ` : ''}End = latest `;
    const cut = Math.max(0, width - label.length - 3);
    sep = T.CHROME + '─'.repeat(cut) + T.RESET + T.YELLOW + label + T.RESET + T.CHROME + '──' + T.RESET;
  }

  // Fixed input bar.
  const prompt = `${T.BOLD} › ${T.RESET}`;
  const cursor = `${T.INV} ${T.RESET}`;
  const inputRow = ui.buffer.length
    ? `${prompt}${ui.buffer}${cursor}`
    : `${prompt}${cursor}${T.FAINT} Message #${repoLabel(file)} — @name pushes${T.RESET}`;

  const mention = ui.buffer.match(/@([a-z0-9_-]*)$/);
  const hits = mention ? ui.names.filter((n) => n.startsWith(mention[1])) : [];
  const bottom = hits.length
    ? `   ${hits.map((n) => `${T.fg(T.authorHue(n))}@${n}${T.RESET}`).join('  ')}  ${T.FAINT}Tab completes${T.RESET}`
    : ui.status
      ? `   ${ui.status}`
      : `   ${T.FAINT}Enter posts as ${human} · Tab completes @ · ↑↓ scroll · Esc closes${T.RESET}`;

  return [headerBar(file, files, width), ...visible, ...block, sep, inputRow, bottom];
}

// Slash commands typed in the chat input. Results are private (ui.block).
// `paint` lets long-running commands show progress before blocking.
function runSlash(body, d, ui, paint) {
  const [cmd, ...rest] = body.slice(1).split(/\s+/);
  if (cmd === 'clear') { ui.block = null; return; }
  if (cmd === 'spawn') {
    // /spawn <name> [kind] [purpose...]
    const [name, kind, ...purpose] = rest;
    ui.block = { title: 'spawn', lines: [`starting ${name || '?'}${kind ? ` (${kind})` : ''}… (can take up to a minute)`] };
    if (paint) paint();
    const r = spawnAgent({ name: humanName(), human: true },
      { name, kind: kind || null, purpose: purpose.join(' ') || null }, d);
    ui.block = { title: r.ok ? 'spawned' : 'spawn failed', lines: r.lines };
    return;
  }
  if (cmd === 'brief' && rest[0] === 'share') {
    if (!ui.lastBrief) { ui.block = { title: 'brief', lines: ['nothing to share — run /brief first'] }; return; }
    postToChat({ name: humanName(), human: true }, `brief (since ${ui.lastBrief.since}):\n${ui.lastBrief.lines.join('\n')}`, d, viewMentionResolver(d));
    ui.block = null;
    ui.status = `${T.GREEN}✓ brief shared to #chat${T.RESET}`;
    return;
  }
  if (cmd === 'brief') {
    try {
      const b = buildBrief({ name: humanName(), human: true }, d, rest[0] || null);
      ui.lastBrief = b;
      ui.block = { title: `brief · since ${b.since}`, lines: [...b.lines, '', `${T.FAINT}/brief share posts this to #chat${T.RESET}`] };
    } catch (e) { ui.block = { title: 'brief', lines: [String(e.message)] }; }
    return;
  }
  ui.block = { title: 'commands', lines: ['/brief [today|2h|30m]', '/brief share', '/spawn <name> [kind] [purpose...]', '/clear'] };
}

// -------------------------------------------------------------------- board

function renderBoard(d, file, files) {
  const width = process.stdout.columns || 100;
  const height = process.stdout.rows || 30;
  const live = liveAgents({ fresh: true });
  const agents = d.prepare('SELECT * FROM agents ORDER BY name').all();
  const tasks = d.prepare("SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, id LIMIT 8").all();
  const notes = d.prepare("SELECT * FROM notes WHERE status = 'active' ORDER BY id DESC LIMIT 6").all();
  const msgs = d.prepare("SELECT * FROM messages WHERE to_agent = '#chat' ORDER BY id DESC LIMIT 10").all().reverse();
  const taskBy = Object.fromEntries(tasks.filter((t) => t.status === 'in_progress').map((t) => [t.assignee, t]));
  const openQ = d.prepare("SELECT COUNT(*) AS n FROM notes WHERE type = 'question' AND status = 'active'").get().n;
  const dot = { idle: T.GREEN, done: T.GREEN, working: T.YELLOW, blocked: T.NEWMARK, unknown: T.FAINT, offline: T.FAINT };
  const out = [headerBar(file, files, width)];
  if (openQ) out.push(` ${T.YELLOW}${openQ} open question${openQ > 1 ? 's' : ''}${T.RESET}`);
  out.push('', ` ${T.BOLD}Agents${T.RESET}`);
  if (!agents.length) out.push(`   ${T.FAINT}(none registered yet)${T.RESET}`);
  for (const a of agents) {
    const l = matchLive(live, a);
    const st = l ? l.agent_status : 'offline';
    const t = taskBy[a.name];
    out.push(` ${(dot[st] || T.FAINT)}●${T.RESET} ${T.author(a.name)}${' '.repeat(Math.max(1, 19 - a.name.length))}${T.CHROME}${st.padEnd(9)}${T.RESET} ${(a.role || a.branch || '').padEnd(20)} ${t ? t.id : ''}`.trimEnd());
  }
  out.push('', ` ${T.BOLD}Group chat${T.RESET}`);
  if (!msgs.length) out.push(`   ${T.FAINT}(no posts yet)${T.RESET}`);
  for (const m of msgs) out.push(`  ${T.CHROME}${localHM(m.created_at)}${T.RESET} ${T.author(m.from_agent)}: ${highlightMentions(T.clean(m.body), humanName())}`.slice(0, width + 60));
  out.push('', ` ${T.BOLD}Tasks${T.RESET}`);
  if (!tasks.length) out.push(`   ${T.FAINT}(none)${T.RESET}`);
  for (const t of tasks) out.push('  ' + taskLabel(t));
  out.push('', ` ${T.BOLD}Shared memory${T.RESET}`);
  if (!notes.length) out.push(`   ${T.FAINT}(empty)${T.RESET}`);
  for (const n of notes) out.push(`  ${T.CHROME}#${n.id} [${n.type}]${T.RESET} ${T.author(n.author)}: ${T.clean(n.text)}`.slice(0, width + 60));
  out.push('', ` ${T.FAINT}q closes · 1-9 switch repo${T.RESET}`);
  return out.slice(0, height);
}

// ----------------------------------------------------------------- run loop

function viewMentionResolver(d) {
  return (input) => {
    const names = new Set(d.prepare('SELECT name FROM agents').all().map((r) => r.name));
    // Live-but-unregistered candidates must verifiably live in this repo —
    // the popup must not pierce the per-repo boundary.
    for (const a of liveAgents()) if (a.name && !names.has(a.name) && liveAgentInRepo(a, d)) names.add(a.name);
    if (names.has(input)) return input;
    const hits = [...names].filter((n) => n.startsWith(input));
    return hits.length === 1 ? hits[0] : null;
  };
}

function openPointerFor(d) {
  const row = d.prepare('SELECT last_read_id FROM chat_reads WHERE agent = ?').get(humanName());
  return (row && row.last_read_id) || 0;
}

function runView(render, { input = false } = {}) {
  let files = listRepoDbFiles();
  let file = initialDbFile();
  if (!file) { console.log('no chatter data yet — run chatter inside a git repo first'); process.exit(0); }
  let d = openDbFile(file);
  const ui = { buffer: '', status: '', names: [], offset: 0, maxOffset: 0, openPointer: openPointerFor(d), lastMaxId: 0, scrollBaseId: 0 };
  const inRepoCache = new Map(); // "dbfile|cwd" -> belongs to the viewed repo
  const paint = () => {
    files = listRepoDbFiles();
    if (input) {
      const set = new Set(d.prepare('SELECT name FROM agents').all().map((r) => r.name));
      // Live-but-unregistered names only when they verifiably live in THIS
      // repo — suggesting names the resolver would refuse is worse than
      // omitting them.
      for (const a of liveAgents({ fresh: true })) {
        if (!a.name || set.has(a.name) || !a.cwd) continue;
        const key = `${file}|${a.cwd}`;
        if (!inRepoCache.has(key)) inRepoCache.set(key, liveAgentInRepo(a, d));
        if (inRepoCache.get(key)) set.add(a.name);
      }
      ui.names = [...set].sort();
    }
    painter(render(d, file, files, ui));
  };
  const painter = T.makePainter();
  const scroll = (delta) => {
    if (ui.offset === 0 && delta > 0) ui.scrollBaseId = ui.lastMaxId;
    ui.offset = Math.max(0, Math.min(ui.maxOffset, ui.offset + delta));
    paint();
  };
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (b) => {
      const key = T.decodeKey(b.toString());
      if (key.type === 'esc' || key.type === 'close') process.exit(0);
      const page = Math.max(3, (process.stdout.rows || 30) - 6);
      if (!input) {
        if (key.type === 'text') {
          if (key.text === 'q') process.exit(0);
          const n = parseInt(key.text, 10);
          if (n >= 1 && n <= files.length && files[n - 1] !== file) {
            file = files[n - 1]; d = openDbFile(file); ui.openPointer = openPointerFor(d); paint();
          }
        }
        return;
      }
      switch (key.type) {
        case 'up': return scroll(1);
        case 'down': return scroll(-1);
        case 'pgup': return scroll(page);
        case 'pgdn': return scroll(-page);
        case 'end': case 'home': ui.offset = key.type === 'home' ? ui.maxOffset : 0; return paint();
        case 'enter': {
          const body = ui.buffer.trim();
          ui.buffer = ''; ui.offset = 0;
          if (body.startsWith('/')) {
            runSlash(body, d, ui, paint);
          } else if (body) {
            ui.block = null;
            const { pushed, warnings } = postToChat({ name: humanName(), human: true }, body, d, viewMentionResolver(d));
            ui.status = warnings.length ? `${T.YELLOW}⚠ ${warnings.join(' · ')}${T.RESET}`
              : pushed.length ? `${T.GREEN}✓ pushed to ${pushed.join(', ')}${T.RESET}` : `${T.GREEN}✓ posted${T.RESET}`;
          }
          return paint();
        }
        case 'tab': {
          const m = ui.buffer.match(/@([a-z0-9_-]*)$/);
          if (m) {
            const hits = ui.names.filter((n) => n.startsWith(m[1]));
            if (hits.length) ui.buffer = ui.buffer.slice(0, ui.buffer.length - m[1].length) + hits[0] + ' ';
          }
          return paint();
        }
        case 'backspace': ui.buffer = ui.buffer.slice(0, -1); ui.status = ''; return paint();
        case 'text': ui.buffer += key.text; ui.status = ''; return paint();
        default: return;
      }
    });
  }
  paint();
  process.stdout.on('resize', paint);
  setInterval(paint, 2000);
}

const cmdBoard = () => runView(renderBoard);
const cmdChatView = () => runView(renderChat, { input: true });

module.exports = { cmdBoard, cmdChatView };
