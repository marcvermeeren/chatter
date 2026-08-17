'use strict';
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmdChatView = exports.cmdBoard = void 0;
exports.headerBar = headerBar;
// Popup views. `chat` = grouped, colored, scrollable conversation with a fixed
// input bar. `board` = read-only overview. Both use the flicker-free painter.
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const herdr_1 = require("./herdr");
const db_1 = require("./db");
const team_1 = require("./team");
const commands_1 = require("./commands");
const util_1 = require("./util");
const T = __importStar(require("./tui"));
// Colored identity for TUI rows: dim display label, colored @handle.
function identityColored(name, role) {
    const label = (role || '').trim();
    if (!label || (0, team_1.sanitizeName)(label) === name)
        return `${T.fg(T.authorHue(name))}@${name}${T.RESET}`;
    return `${T.FAINT}${label}${T.RESET} · ${T.fg(T.authorHue(name))}@${name}${T.RESET}`;
}
const padVis = (s, w) => s + ' '.repeat(Math.max(1, w - T.visWidth(s)));
// ------------------------------------------------------------ repo selection
function initialDbFile() {
    // The focused workspace's repo wins — and if its universe doesn't exist
    // yet, create it (empty) rather than silently showing another repo's chat.
    try {
        const parsed = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
        const ctx = (0, herdr_1.isRecord)(parsed) ? parsed : {};
        const worktree = (0, herdr_1.isRecord)(ctx.worktree) ? ctx.worktree : null;
        const cwd = typeof worktree?.checkout_path === 'string' ? worktree.checkout_path
            : typeof ctx.workspace_cwd === 'string' ? ctx.workspace_cwd
                : typeof ctx.focused_pane_cwd === 'string' ? ctx.focused_pane_cwd : null;
        if (cwd) {
            const g = (0, db_1.gitInfo)(cwd);
            if (g.repoRoot) {
                const file = (0, db_1.repoDbFile)(g.repoRoot);
                (0, db_1.openDbFile)(file).prepare(`INSERT INTO ui_marks (agent, mark, value) VALUES ('_repo', 'root', ?)
          ON CONFLICT(agent, mark) DO UPDATE SET value = excluded.value`).run(g.repoRoot);
                return file;
            }
        }
    }
    catch { /* fall through */ }
    // CLI path: the caller's own shell cwd is legitimate context.
    const g = (0, db_1.gitInfo)(process.cwd());
    if (g.repoRoot && node_fs_1.default.existsSync((0, db_1.repoDbFile)(g.repoRoot)))
        return (0, db_1.repoDbFile)(g.repoRoot);
    // Fail closed: never silently show some other repo's universe —
    // the human picks explicitly instead.
    return null;
}
const repoLabel = (file) => node_path_1.default.basename(node_path_1.default.dirname(file)).replace(/-[0-9a-f]{8}$/, '');
// ------------------------------------------------------------------- helpers
const pad2 = (n) => String(n).padStart(2, '0');
const localHM = (ts) => { const d = new Date((0, util_1.toMs)(ts)); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const localDay = (ts) => new Date((0, util_1.toMs)(ts)).toDateString().slice(0, 10);
function highlightMentions(line, human) {
    return line.replace(/@([a-z0-9_-]+)/g, (_match, n) => (n === human || n === 'everyone')
        ? `${T.INV}@${n}${T.RESET}`
        : `${T.fg(T.authorHue(n))}${T.BOLD}@${n}${T.RESET}`);
}
// The numbered universe tabs are only drawn where the number keys actually
// switch repos — the board. In the chat view digits are typing, so tabs there
// would look addressable without being addressable.
function headerBar(file, width, files = null) {
    const active = (f) => f === file;
    const tabs = files && files.length > 1
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
    let prev = null;
    let prevDay = null;
    let marker = false;
    for (const m of rows) {
        const day = localDay(m.created_at);
        if (day !== prevDay) {
            if (lines.length)
                lines.push('');
            center(day, T.FAINT);
            prevDay = day;
            prev = null;
        }
        if (!marker && openPointer != null && m.to_agent === '#chat' && m.id > openPointer) {
            center('new', T.NEWMARK);
            marker = true;
            prev = null;
        }
        const isDM = m.to_agent !== '#chat';
        const grouped = prev && prev.from_agent === m.from_agent && prev.to_agent === m.to_agent
            && ((0, util_1.toMs)(m.created_at) - (0, util_1.toMs)(prev.created_at)) < 5 * 60 * 1000;
        const mine = m.from_agent === human || m.to_agent === human;
        if (!grouped) {
            if (lines.length)
                lines.push('');
            const you = m.from_agent === human ? ` ${T.FAINT}(you)${T.RESET}` : '';
            let head;
            if (!isDM) {
                head = `  ${T.author(m.from_agent)} ${T.CHROME}· ${localHM(m.created_at)}${T.RESET}${you}`;
            }
            else if (mine) {
                head = `  ${T.author(m.from_agent)} ${T.CHROME}· ${localHM(m.created_at)}${T.RESET}${you} ${T.CYAN}[DM → ${m.to_agent === human ? 'you' : m.to_agent}]${T.RESET}`;
            }
            else {
                // Agent-to-agent DM: both names colored, visibly quieter.
                head = `  ${T.author(m.from_agent)} ${T.CHROME}→${T.RESET} ${T.author(m.to_agent)} ${T.CHROME}· ${localHM(m.created_at)} [DM]${T.RESET}`;
            }
            lines.push(head);
        }
        const prefix = isDM ? `    ${T.fg(T.authorHue(m.from_agent))}│${T.RESET} ` : '    ';
        const style = (isDM && !mine) ? (l) => `${T.CHROME}${l}${T.RESET}` : (l) => highlightMentions(l, human);
        for (const l of T.wrap(T.clean(m.body), bodyW))
            lines.push(prefix + style(l));
        prev = m;
    }
    return lines;
}
// ------------------------------------------------------------ team wizards
// Popups are singletons, so the wizard cannot be another pane: it is a
// full-screen takeover of the chat view, in setup.js's visual language.
const WZ = {
    HANDLE: 'handle', KIND: 'kind', SETUP: 'setup', BRANCH: 'branch', PURPOSE: 'purpose',
    MORE: 'more', CONFIRM: 'confirm', RUN: 'run', KICKOFF: 'kickoff', DONE: 'done',
};
const KIND_FALLBACK = ['claude', 'codex', 'pi', 'opencode', 'gemini', 'cursor'];
// Herdr owns the list of kinds it can start — ask it, and only fall back when
// the CLI is unreachable or its help format moves.
function supportedKinds() {
    const m = ((0, herdr_1.herdr)(['agent', 'start', '--help']).raw || '').match(/possible values:\s*([^\]]+)\]/);
    const kinds = m?.[1] ? m[1].split(',').map((s) => s.trim()).filter((s) => /^[a-z][a-z0-9-]*$/.test(s)) : [];
    return kinds.length ? kinds : KIND_FALLBACK;
}
// Preselect what this repo already runs — a team tends to be one kind.
function majorityKind(d, kinds) {
    const seen = (0, team_1.teamAgents)(d).map((a) => a.agent).filter((kind) => !!kind && kinds.includes(kind));
    const best = seen.sort((a, b) => seen.filter((k) => k === b).length - seen.filter((k) => k === a).length)[0];
    return best || (kinds.includes('claude') ? 'claude' : kinds[0] ?? 'claude');
}
const newDraft = (kind) => ({ handle: '', kind, tab: false, branch: '', purpose: '' });
function startWizard(d, ui, mode) {
    const kinds = supportedKinds();
    ui.block = null;
    ui.buffer = '';
    ui.status = '';
    ui.wizard = {
        mode, kinds, step: WZ.HANDLE, roster: [], progress: [], report: [],
        draft: newDraft(majorityKind(d, kinds)), typed: '',
    };
}
// The same four facts the /spawn-with-args plan card shows.
function planLines(p) {
    return [
        `handle:      @${p.handle}`,
        `kind:        ${p.kind}`,
        `code setup:  ${p.tab ? 'THIS checkout, new tab (shared files!)' : `new worktree · branch ${p.branch || `agents/${p.handle}`}`}`,
        `purpose:     ${p.purpose || '(none — DM it later)'}`,
    ];
}
// Live collision check: the same answer `chatter spawn` would give, plus the
// names this plan is about to claim.
function handleError(w) {
    const p = w.draft;
    if (!p.handle)
        return 'handle required';
    if (w.roster.some((r) => r.handle === p.handle))
        return `"${p.handle}" is already in this plan`;
    const taken = (0, team_1.nameTaken)(p.handle);
    return taken ? `"${p.handle}" is ${taken} — pick another` : '';
}
function renderWizard(_d, file, _files, ui) {
    const width = process.stdout.columns || 100;
    const height = process.stdout.rows || 30;
    const w = ui.wizard;
    if (!w)
        return [];
    const p = w.draft;
    const out = [headerBar(file, width), ''];
    const planned = w.mode === 'team' && w.roster.length ? `  ${T.FAINT}${w.roster.length} planned${T.RESET}` : '';
    out.push(` ${T.BOLD}${w.mode === 'team' ? 'build the team' : 'add a teammate'}${T.RESET}${planned}`, '');
    const cancels = w.mode === 'team' ? 'Esc cancels the roster' : 'Esc cancels';
    if (w.step === WZ.HANDLE) {
        const err = handleError(w);
        out.push(`   handle ${T.FAINT}(teammates and you reach it as @${p.handle || '…'})${T.RESET}`);
        out.push('   ' + T.field(p.handle));
        if (p.handle && err)
            out.push(`   ${T.YELLOW}⚠ ${err}${T.RESET}`);
        out.push('', T.hint('Enter continues', cancels));
    }
    else if (w.step === WZ.KIND) {
        // Herdr knows ~20 kinds; show a window around the selection rather than
        // wrapping the whole list across three lines.
        const i = Math.max(0, w.kinds.indexOf(p.kind));
        const span = Math.min(7, w.kinds.length);
        const from = Math.max(0, Math.min(i - Math.floor(span / 2), w.kinds.length - span));
        const strip = w.kinds.slice(from, from + span)
            .map((k) => (k === p.kind ? `${T.RESET}${T.BOLD}${k}${T.RESET}${T.FAINT}` : k)).join(' · ');
        out.push(`   agent kind ${T.FAINT}(${i + 1} of ${w.kinds.length})${T.RESET}`);
        out.push(`   ${T.FAINT}‹${T.RESET} ${T.BOLD}${p.kind}${T.RESET} ${T.FAINT}›${T.RESET}`);
        out.push(`   ${T.FAINT}${from > 0 ? '… ' : ''}${strip}${from + span < w.kinds.length ? ' …' : ''}${T.RESET}`);
        out.push('', T.hint('← → picks a kind', 'Enter continues', cancels));
    }
    else if (w.step === WZ.SETUP) {
        out.push('   code setup');
        const mark = (on, label) => (on ? `${T.GREEN}●${T.RESET} ${label}` : `${T.FAINT}○ ${label}${T.RESET}`);
        out.push(`   ${mark(!p.tab, 'new worktree')}    ${mark(p.tab, 'same checkout, new tab')}`);
        out.push(`   ${T.FAINT}worktree = isolated checkout · tab = shared files, coordinate carefully${T.RESET}`);
        out.push('', T.hint('← → toggles', 'Enter continues', cancels));
    }
    else if (w.step === WZ.BRANCH) {
        out.push(`   branch for @${p.handle}'s worktree`);
        out.push('   ' + T.field(p.branch));
        out.push('', T.hint('Enter continues', cancels));
    }
    else if (w.step === WZ.PURPOSE) {
        out.push(`   what is @${p.handle} for? ${T.FAINT}(sent as its first message — may be empty)${T.RESET}`);
        out.push('   ' + T.field(p.purpose));
        out.push('', T.hint('Enter continues', cancels));
    }
    else if (w.step === WZ.MORE) {
        out.push(`   ${T.GREEN}✓${T.RESET}  @${p.handle} planned ${T.FAINT}(${p.kind} · ${p.tab ? 'tab' : 'worktree'})${T.RESET}`);
        out.push('', '   add another teammate? (y/N)');
        out.push('', T.hint('y adds another', 'Enter reviews the roster', cancels));
    }
    else if (w.step === WZ.CONFIRM) {
        if (w.mode === 'team') {
            out.push(`   ${T.BOLD}the plan${T.RESET} ${T.FAINT}(${w.roster.length} teammate${w.roster.length > 1 ? 's' : ''}, created in order)${T.RESET}`, '');
            for (const r of w.roster) {
                out.push(`   ${T.fg(T.authorHue(r.handle))}@${r.handle}${T.RESET}  ${T.FAINT}${r.kind} · ${r.tab ? 'same checkout, new tab' : `worktree ${r.branch || `agents/${r.handle}`}`}${T.RESET}`);
                out.push(`     ${T.FAINT}${r.purpose || '(no purpose — DM it later)'}${T.RESET}`);
            }
        }
        else {
            out.push(...planLines(p).map((l) => `   ${l}`));
        }
        if (w.typed)
            out.push('', `   ${T.YELLOW}⚠ "${T.clean(w.typed)}" — Enter now aborts${T.RESET}`);
        out.push('', T.hint(`empty Enter creates${w.mode === 'team' ? ' all' : ''}`, 'typing anything cancels'));
    }
    else if (w.step === WZ.RUN) {
        out.push(...w.progress);
        out.push('', T.hint('working — this can take a minute per teammate'));
    }
    else if (w.step === WZ.KICKOFF) {
        out.push(...w.report.map(reportLine), '');
        out.push('   kick off now? (Y/n)');
        out.push(`   ${T.FAINT}sends each teammate its purpose and posts the roster to #chat${T.RESET}`);
        out.push('', T.hint('Enter kicks off', 'n skips'));
    }
    else {
        out.push(...w.report.map(reportLine));
        out.push('', T.hint('Enter returns to the chat'));
    }
    while (out.length < height)
        out.push('');
    return out.slice(0, height);
}
const reportLine = (r) => (r.ok
    ? `   ${T.GREEN}✓${T.RESET}  ${T.clean(r.text)}`
    : `   ${T.NEWMARK}✗${T.RESET}  ${T.clean(r.text)}`);
// Create every planned teammate serially, narrating each stage into the
// progress list. Blocking by design — the screen keeps up because each
// stage repaints before the next subprocess call.
function runWizardSpawns(d, ui, paint) {
    const w = ui.wizard;
    if (!w)
        return;
    const me = { name: (0, db_1.humanName)(), human: true };
    const plans = w.mode === 'team' ? w.roster : [w.draft];
    w.step = WZ.RUN;
    w.progress = [];
    w.report = [];
    paint();
    for (const p of plans) {
        if (w.progress.length)
            w.progress.push('');
        w.progress.push(`   ${T.BOLD}@${p.handle}${T.RESET} ${T.FAINT}(${p.kind})${T.RESET}`);
        paint();
        const r = (0, commands_1.spawnAgent)(me, {
            name: p.handle,
            kind: p.kind,
            // Team planning delivers purposes at kickoff, not at spawn time.
            purpose: w.mode === 'team' ? null : (p.purpose || null),
            tab: p.tab,
            branch: p.tab ? null : (p.branch || null),
        }, d, (line) => { w.progress.push(`     ${T.FAINT}${line}${T.RESET}`); paint(); });
        p.created = r.ok;
        // A spawn can succeed and still carry a caveat — don't tick a warning.
        for (const l of r.lines)
            w.report.push({ ok: r.ok && !/^warning:/.test(l), text: l });
    }
    w.step = w.mode === 'team' ? WZ.KICKOFF : WZ.DONE;
    paint();
}
// Deliver the purposes the planning step deliberately withheld, then one
// roster brief so the whole team sees who is on it.
function kickoff(d, ui) {
    const w = ui.wizard;
    if (!w)
        return;
    const me = { name: (0, db_1.humanName)(), human: true };
    const made = w.roster.filter((p) => p.created);
    if (!made.length) {
        w.report.push({ ok: false, text: 'nothing was created — nothing to kick off' });
        return;
    }
    for (const p of made) {
        if (!p.purpose)
            continue;
        const res = (0, team_1.sendMessage)(me.name, p.handle, `you are "${p.handle}". your purpose: ${p.purpose}`, 'system', null, d);
        w.report.push({ ok: true, text: res.delivered ? `@${p.handle} briefed` : `@${p.handle} brief queued (${res.reason})` });
    }
    // Display label if a plan ever carries one; today the wizard collects only
    // handles, so this reads as the roster of @handles.
    const brief = ['the team:', ...made.map((p) => `${p.display || `@${p.handle}`} — ${p.purpose || p.kind}`)].join('\n');
    (0, team_1.postToChat)(me, brief, d, viewMentionResolver(d));
    w.report.push({ ok: true, text: 'roster posted to #chat' });
}
// One raw key, routed by step. Text fields edit their value directly; the
// confirm card keeps the "empty Enter = yes, typing = no" contract.
function wizardKey(key, d, ui, paint) {
    const w = ui.wizard;
    if (!w)
        return;
    const p = w.draft;
    const done = () => { ui.wizard = null; ui.buffer = ''; };
    if (key.type === 'esc') {
        done();
        ui.status = `${T.FAINT}${w.mode === 'team' ? 'team' : 'spawn'} wizard cancelled${T.RESET}`;
        return paint();
    }
    const edit = (val, filter) => key.type === 'backspace' ? val.slice(0, -1)
        : key.type === 'text' ? val + (filter ? key.text.replace(filter, '') : key.text) : val;
    const cycle = (delta) => {
        const next = w.kinds[(w.kinds.indexOf(p.kind) + delta + w.kinds.length) % w.kinds.length];
        if (next)
            p.kind = next;
    };
    switch (w.step) {
        case WZ.HANDLE:
            p.handle = edit(p.handle, /[^a-z0-9_-]/g);
            if (key.type === 'text')
                p.handle = p.handle.toLowerCase();
            if (key.type === 'enter' && !handleError(w)) {
                p.branch = `agents/${p.handle}`;
                w.step = WZ.KIND;
            }
            break;
        case WZ.KIND:
            if (key.type === 'right')
                cycle(1);
            else if (key.type === 'left')
                cycle(-1);
            else if (key.type === 'enter')
                w.step = WZ.SETUP;
            break;
        case WZ.SETUP:
            if (key.type === 'left' || key.type === 'right' || (key.type === 'text' && key.text === ' '))
                p.tab = !p.tab;
            else if (key.type === 'enter')
                w.step = p.tab ? WZ.PURPOSE : WZ.BRANCH;
            break;
        case WZ.BRANCH:
            p.branch = edit(p.branch, /[^A-Za-z0-9._/-]/g);
            if (key.type === 'enter') {
                if (!p.branch)
                    p.branch = `agents/${p.handle}`;
                w.step = WZ.PURPOSE;
            }
            break;
        case WZ.PURPOSE:
            p.purpose = edit(p.purpose);
            if (key.type === 'enter')
                w.step = w.mode === 'team' ? WZ.MORE : WZ.CONFIRM;
            break;
        case WZ.MORE:
            if (key.type === 'text' && (key.text === 'y' || key.text === 'Y')) {
                w.roster.push(p);
                w.draft = newDraft(p.kind);
                w.step = WZ.HANDLE;
            }
            else if (key.type === 'enter' || (key.type === 'text' && (key.text === 'n' || key.text === 'N'))) {
                w.roster.push(p);
                w.step = WZ.CONFIRM;
            }
            break;
        case WZ.CONFIRM:
            w.typed = edit(w.typed);
            if (key.type === 'enter') {
                if (w.typed.trim()) {
                    done();
                    ui.status = `${T.FAINT}cancelled — nothing was created${T.RESET}`;
                    break;
                }
                return runWizardSpawns(d, ui, paint);
            }
            break;
        case WZ.RUN:
            break; // a spawn in flight is never interruptible
        case WZ.KICKOFF:
            if (key.type === 'enter' || (key.type === 'text' && (key.text === 'y' || key.text === 'Y'))) {
                kickoff(d, ui);
                w.step = WZ.DONE;
            }
            else if (key.type === 'text' && (key.text === 'n' || key.text === 'N')) {
                w.report.push({ ok: false, text: 'not briefed — send purposes later: chatter send <name> "your purpose: …"' });
                w.step = WZ.DONE;
            }
            break;
        default:
            if (key.type === 'enter')
                done();
    }
    return paint();
}
function renderChat(d, file, files, ui) {
    if (ui.wizard)
        return renderWizard(d, file, files, ui);
    return renderFeed(d, file, files, ui);
}
// Nothing said yet: the wordmark plus the three things worth knowing.
function welcomeLines(width, feedH) {
    const logo = feedH >= T.logoLines(width).length + 3 ? T.logoLines(width) : [];
    const parts = ["this repo's team is empty", '/spawn adds a teammate', '@name pushes', '/help lists commands'];
    const one = T.hint(...parts);
    // Two rows rather than one wrapped mid-word in a narrow pane.
    const rows = T.visWidth(one) <= width ? [one] : [T.hint(...parts.slice(0, 2)), T.hint(...parts.slice(2))];
    return ['', ...logo, ...rows];
}
function renderFeed(d, file, _files, ui) {
    const width = process.stdout.columns || 100;
    const height = process.stdout.rows || 30;
    const human = (0, db_1.humanName)();
    const rows = feedRows(d);
    ui.lastMaxId = rows.at(-1)?.id ?? 0;
    // Seeing the latest IS reading — but only while pinned to the bottom.
    if (ui.offset === 0) {
        const dmIds = rows.filter((m) => m.to_agent === human && !m.read_at).map((m) => m.id);
        if (dmIds.length)
            d.prepare(`UPDATE messages SET read_at = datetime('now') WHERE id IN (${dmIds.join(',')})`).run();
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
    const all = rows.length ? buildFeedLines(rows, width, human, ui.openPointer) : welcomeLines(width, feedH);
    ui.maxOffset = Math.max(0, all.length - feedH);
    ui.offset = Math.min(ui.offset, ui.maxOffset);
    const end = all.length - ui.offset;
    let visible = all.slice(Math.max(0, end - feedH), end);
    if (visible.length < feedH)
        visible = [...Array(feedH - visible.length).fill(''), ...visible];
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
    const mentionPrefix = mention?.[1] ?? '';
    const hits = mention ? ui.names.filter((n) => n.startsWith(mentionPrefix)) : [];
    const bottom = hits.length
        ? `   ${hits.map((n) => {
            const role = (ui.roles && ui.roles.get(n)) || '';
            const label = role.trim() && (0, team_1.sanitizeName)(role) !== n ? `${T.FAINT}${role.trim()}${T.RESET} ` : '';
            return `${label}${T.fg(T.authorHue(n))}@${n}${T.RESET}`;
        }).join('   ')}  ${T.FAINT}Tab completes${T.RESET}`
        : ui.status
            ? `   ${ui.status}`
            // A tab/split pane outlives Esc; only the popup closes on it.
            : T.hint(`Enter posts as ${human}`, 'Tab completes @', '↑↓ scroll', process.env.HERDR_PANE_ID ? 'ctrl+c closes' : 'Esc closes');
    return [headerBar(file, width), ...visible, ...block, sep, inputRow, bottom];
}
// Slash commands typed in the chat input. Results are private (ui.block).
// `paint` lets long-running commands show progress before blocking.
function runSlash(body, d, ui, _paint) {
    const [cmd, ...rest] = body.slice(1).split(/\s+/);
    if (cmd === 'clear') {
        ui.block = null;
        return;
    }
    if (cmd === 'team') {
        startWizard(d, ui, 'team');
        return;
    }
    if (cmd === 'spawn') {
        // /spawn <name> [kind] [purpose...] [--tab] — plan first, Enter confirms.
        // Bare /spawn asks the questions instead of printing a usage line.
        const words = rest.filter((w) => w !== '--tab');
        const tab = rest.includes('--tab');
        const [name, kind, ...purpose] = words;
        if (!name) {
            startWizard(d, ui, 'spawn');
            return;
        }
        ui.pendingSpawn = { name, kind: kind || null, purpose: purpose.join(' ') || null, tab };
        ui.block = {
            title: 'add teammate — Enter creates, anything else cancels',
            lines: [
                `handle:      @${name}`,
                `kind:        ${kind || '(inferred from this repo\'s agents)'}`,
                `code setup:  ${tab ? 'THIS checkout, new tab (shared files!)' : `new worktree · branch agents/${name}`}`,
                `purpose:     ${purpose.join(' ') || '(none — DM it later)'}`,
            ],
        };
        return;
    }
    if (cmd === 'role') {
        // /role @agent <display role...>
        const [target, ...text] = rest;
        if (!target || !text.length) {
            ui.block = { title: 'role', lines: ['usage: /role @agent <display role...>'] };
            return;
        }
        const r = (0, commands_1.setRole)({ name: (0, db_1.humanName)(), human: true }, target, text.join(' '), d);
        ui.block = { title: r.ok ? 'role set' : 'role failed', lines: r.lines };
        return;
    }
    if (cmd === 'brief' && rest[0] === 'share') {
        if (!ui.lastBrief) {
            ui.block = { title: 'brief', lines: ['nothing to share — run /brief first'] };
            return;
        }
        (0, team_1.postToChat)({ name: (0, db_1.humanName)(), human: true }, `brief (since ${ui.lastBrief.since}):\n${ui.lastBrief.lines.join('\n')}`, d, viewMentionResolver(d));
        ui.block = null;
        ui.status = `${T.GREEN}✓ brief shared to #chat${T.RESET}`;
        return;
    }
    if (cmd === 'brief') {
        try {
            const b = (0, commands_1.buildBrief)({ name: (0, db_1.humanName)(), human: true }, d, rest[0] || null);
            ui.lastBrief = b;
            ui.block = { title: `brief · since ${b.since}`, lines: [...b.lines, '', `${T.FAINT}/brief share posts this to #chat${T.RESET}`] };
        }
        catch (e) {
            ui.block = { title: 'brief', lines: [e instanceof Error ? e.message : String(e)] };
        }
        return;
    }
    ui.block = { title: 'commands', lines: [
            '/brief [today|2h|30m]', '/brief share',
            '/spawn                              add a teammate, step by step',
            '/spawn <name> [kind] [purpose...] [--tab]',
            '/team                               plan a whole roster, then create it',
            '/role @agent <display role...>', '/clear',
        ] };
}
// -------------------------------------------------------------------- board
function renderBoard(d, file, files) {
    const width = process.stdout.columns || 100;
    const height = process.stdout.rows || 30;
    const live = (0, team_1.teamAgents)(d, { fresh: true });
    const agents = d.prepare('SELECT * FROM agents WHERE departed_at IS NULL ORDER BY name').all();
    const tasks = d.prepare("SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, id LIMIT 8").all();
    const notes = d.prepare("SELECT * FROM notes WHERE status = 'active' ORDER BY id DESC LIMIT 6").all();
    const msgs = d.prepare("SELECT * FROM messages WHERE to_agent = '#chat' ORDER BY id DESC LIMIT 10").all().reverse();
    const taskBy = Object.fromEntries(tasks.filter((t) => t.status === 'in_progress' && t.assignee).map((t) => [t.assignee, t]));
    const openQ = d.prepare("SELECT COUNT(*) AS n FROM notes WHERE type = 'question' AND status = 'active'").get()?.n ?? 0;
    const dot = { idle: T.GREEN, done: T.GREEN, working: T.YELLOW, blocked: T.NEWMARK, unknown: T.FAINT, offline: T.FAINT };
    const out = [headerBar(file, width, files)];
    if (openQ)
        out.push(` ${T.YELLOW}${openQ} open question${openQ > 1 ? 's' : ''}${T.RESET}`);
    out.push('', ` ${T.BOLD}Agents${T.RESET}`);
    if (!agents.length)
        out.push(`   ${T.FAINT}(none registered yet)${T.RESET}`);
    for (const a of agents) {
        const l = (0, herdr_1.matchLive)(live, a);
        const st = l?.agent_status ?? 'offline';
        const t = taskBy[a.name];
        out.push(` ${(dot[st] || T.FAINT)}●${T.RESET} ${padVis(identityColored(a.name, a.role), 32)}${T.CHROME}${st.padEnd(9)}${T.RESET} ${(a.branch || '').padEnd(18)} ${t ? t.id : ''}`.trimEnd());
    }
    out.push('', ` ${T.BOLD}Group chat${T.RESET}`);
    if (!msgs.length)
        out.push(`   ${T.FAINT}(no posts yet)${T.RESET}`);
    for (const m of msgs)
        out.push(`  ${T.CHROME}${localHM(m.created_at)}${T.RESET} ${T.author(m.from_agent)}: ${highlightMentions(T.clean(m.body), (0, db_1.humanName)())}`.slice(0, width + 60));
    out.push('', ` ${T.BOLD}Tasks${T.RESET}`);
    if (!tasks.length)
        out.push(`   ${T.FAINT}(none)${T.RESET}`);
    for (const t of tasks)
        out.push('  ' + (0, commands_1.taskLabel)(t));
    out.push('', ` ${T.BOLD}Shared memory${T.RESET}`);
    if (!notes.length)
        out.push(`   ${T.FAINT}(empty)${T.RESET}`);
    for (const n of notes)
        out.push(`  ${T.CHROME}#${n.id} [${n.type}]${T.RESET} ${T.author(n.author)}: ${T.clean(n.text)}`.slice(0, width + 60));
    out.push('', T.hint('1-9 switch repo', 'q closes'));
    return out.slice(0, height);
}
// ----------------------------------------------------------------- run loop
function viewMentionResolver(d) {
    return (input) => {
        const names = new Set(d.prepare('SELECT name FROM agents').all().map((r) => r.name));
        for (const a of (0, team_1.teamAgents)(d))
            if (a.name)
                names.add(a.name);
        if (names.has(input))
            return input;
        const hits = [...names].filter((n) => n.startsWith(input));
        return hits.length === 1 ? hits[0] ?? null : null;
    };
}
function openPointerFor(d) {
    const row = d.prepare('SELECT last_read_id FROM chat_reads WHERE agent = ?').get((0, db_1.humanName)());
    return (row && row.last_read_id) || 0;
}
function runView(render, { input = false } = {}) {
    let files = (0, db_1.listRepoDbFiles)();
    let file = initialDbFile();
    let d = file ? (0, db_1.openDbFile)(file) : null;
    const ui = { buffer: '', status: '', names: [], offset: 0, maxOffset: 0, openPointer: d ? openPointerFor(d) : 0, lastMaxId: 0, scrollBaseId: 0, wizard: null };
    // Pane entrypoints in tab/split mode get HERDR_PANE_ID; the popup does not.
    // A pane the human placed on purpose must not vanish on a stray Esc.
    const persistent = input && !!process.env.HERDR_PANE_ID;
    const pickerScreen = () => [
        ` ${T.BOLD}chatter${T.RESET}`,
        '',
        ` ${T.FAINT}no repository context — this workspace isn't a git repo (or has no focused repo).${T.RESET}`,
        files.length ? ` ${T.FAINT}pick a stored universe:${T.RESET}` : ` ${T.FAINT}no stored universes yet — run a chatter command inside a git repo first.${T.RESET}`,
        '',
        ...files.map((f, i) => `   ${T.BOLD}${i + 1}${T.RESET}  #${repoLabel(f)}`),
        '',
        T.hint('1-9 opens', 'Esc closes'),
    ];
    const paint = () => {
        files = (0, db_1.listRepoDbFiles)();
        if (!d || !file) {
            painter(pickerScreen());
            return;
        }
        if (input) {
            const rows = d.prepare('SELECT name, role FROM agents WHERE departed_at IS NULL').all();
            const set = new Set(rows.map((r) => r.name));
            ui.roles = new Map(rows.flatMap((r) => r.role ? [[r.name, r.role]] : []));
            for (const a of (0, team_1.teamAgents)(d, { fresh: true }))
                if (a.name)
                    set.add(a.name);
            ui.names = [...set].sort();
        }
        painter(render(d, file, files, ui));
    };
    const painter = T.makePainter();
    const scroll = (delta) => {
        if (ui.offset === 0 && delta > 0)
            ui.scrollBaseId = ui.lastMaxId;
        ui.offset = Math.max(0, Math.min(ui.maxOffset, ui.offset + delta));
        paint();
    };
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', (b) => {
            const key = T.decodeKey(b.toString());
            if (key.type === 'close')
                process.exit(0); // ctrl+c always closes
            if (key.type === 'esc') {
                if (ui.wizard && d)
                    return wizardKey(key, d, ui, paint);
                if (!persistent)
                    process.exit(0);
                // Persistent pane: Esc unwinds state instead of closing the pane.
                if (ui.pendingSpawn || ui.block || ui.buffer) {
                    ui.pendingSpawn = null;
                    ui.block = null;
                    ui.buffer = '';
                    ui.status = `${T.FAINT}cancelled${T.RESET}`;
                }
                else {
                    ui.status = `${T.FAINT}persistent pane — ctrl+c closes${T.RESET}`;
                }
                return paint();
            }
            // No repo selected yet: picker mode for every view (explicit choice only).
            if (!d) {
                if (key.type === 'text') {
                    if (key.text === 'q')
                        process.exit(0);
                    const n = parseInt(key.text, 10);
                    if (n >= 1 && n <= files.length) {
                        const selected = files[n - 1];
                        if (selected) {
                            file = selected;
                            d = (0, db_1.openDbFile)(selected);
                            ui.openPointer = openPointerFor(d);
                            paint();
                        }
                    }
                }
                return;
            }
            // The wizard owns the whole view (and the keyboard) while it is up.
            if (ui.wizard)
                return wizardKey(key, d, ui, paint);
            const page = Math.max(3, (process.stdout.rows || 30) - 6);
            if (!input) {
                if (key.type === 'text') {
                    if (key.text === 'q')
                        process.exit(0);
                    const n = parseInt(key.text, 10);
                    if (n >= 1 && n <= files.length && files[n - 1] !== file) {
                        const selected = files[n - 1];
                        if (selected) {
                            file = selected;
                            d = (0, db_1.openDbFile)(selected);
                            ui.openPointer = openPointerFor(d);
                            paint();
                        }
                    }
                }
                return;
            }
            switch (key.type) {
                case 'up': return scroll(1);
                case 'down': return scroll(-1);
                case 'pgup': return scroll(page);
                case 'pgdn': return scroll(-page);
                case 'end':
                case 'home':
                    ui.offset = key.type === 'home' ? ui.maxOffset : 0;
                    return paint();
                case 'enter': {
                    const body = ui.buffer.trim();
                    ui.buffer = '';
                    ui.offset = 0;
                    if (ui.pendingSpawn) {
                        const plan = ui.pendingSpawn;
                        ui.pendingSpawn = null;
                        if (!body) { // empty Enter = confirm; anything typed = cancel
                            ui.block = { title: `creating @${plan.name}`, lines: [] };
                            paint();
                            const r = (0, commands_1.spawnAgent)({ name: (0, db_1.humanName)(), human: true }, plan, d, (line) => {
                                ui.block?.lines.push(`${T.FAINT}${line}${T.RESET}`);
                                paint();
                            });
                            ui.block = { title: r.ok ? 'teammate added' : 'spawn failed', lines: r.lines };
                            return paint();
                        }
                        ui.status = `${T.FAINT}spawn cancelled${T.RESET}`;
                        ui.block = null;
                    }
                    if (body.startsWith('/')) {
                        runSlash(body, d, ui, paint);
                    }
                    else if (body) {
                        ui.block = null;
                        const { pushed, warnings } = (0, team_1.postToChat)({ name: (0, db_1.humanName)(), human: true }, body, d, viewMentionResolver(d));
                        ui.status = warnings.length ? `${T.YELLOW}⚠ ${warnings.join(' · ')}${T.RESET}`
                            : pushed.length ? `${T.GREEN}✓ pushed to ${pushed.join(', ')}${T.RESET}` : `${T.GREEN}✓ posted${T.RESET}`;
                    }
                    return paint();
                }
                case 'tab': {
                    const m = ui.buffer.match(/@([a-z0-9_-]*)$/);
                    if (m) {
                        const prefix = m[1] ?? '';
                        const hits = ui.names.filter((n) => n.startsWith(prefix));
                        if (hits[0])
                            ui.buffer = ui.buffer.slice(0, ui.buffer.length - prefix.length) + hits[0] + ' ';
                    }
                    return paint();
                }
                case 'backspace':
                    ui.buffer = ui.buffer.slice(0, -1);
                    ui.status = '';
                    return paint();
                case 'text':
                    ui.buffer += key.text;
                    ui.status = '';
                    return paint();
                default: return;
            }
        });
    }
    paint();
    process.stdout.on('resize', paint);
    setInterval(paint, 2000);
}
const cmdBoard = () => runView(renderBoard);
exports.cmdBoard = cmdBoard;
const cmdChatView = () => runView(renderChat, { input: true });
exports.cmdChatView = cmdChatView;
