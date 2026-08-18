"use strict";
// Premium onboarding: setup wizard (popup TUI + CLI fallback) and doctor.
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
exports.cmdDoctor = cmdDoctor;
exports.cmdSetup = cmdSetup;
exports.nextSetupStep = nextSetupStep;
exports.wizard = wizard;
exports.hookOpenSetup = hookOpenSetup;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const herdr_1 = require("./herdr");
const db_1 = require("./db");
const util_1 = require("./util");
const T = __importStar(require("./tui"));
const commands_1 = require("./commands");
const team_1 = require("./team");
const update_1 = require("./update");
// -------------------------------------------------------------- config edits
const configToml = () => node_path_1.default.join(node_os_1.default.homedir(), '.config', 'herdr', 'config.toml');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TOAST_BLOCK = `
# added by chatter setup
[ui.toast]
delivery = "herdr"
`;
const keyBlock = (key, action, description) => `
# added by chatter setup
[[keys.command]]
key = "${key}"
type = "plugin_action"
command = "${herdr_1.PLUGIN_ID}.${action}"
description = "${description}"
`;
// Is this exact plugin action already bound? The closing quote matters:
// "chatter.open-chat" is a prefix of "chatter.open-chat-tab", so a substring
// test would report the popup bound when only the tab binding exists.
const actionBound = (text, action) => new RegExp(`command\\s*=\\s*"${escRe(`${herdr_1.PLUGIN_ID}.${action}`)}"`).test(text);
function editHerdrConfig({ toasts, key, tabKey = null, boardKey = null, boardTabKey = null, }) {
    const file = configToml();
    let text = '';
    try {
        text = node_fs_1.default.readFileSync(file, 'utf8');
    }
    catch { /* new file */ }
    const report = [];
    let out = text;
    if (toasts) {
        if (/^\s*\[ui\.toast\]/m.test(text))
            report.push('toasts: existing [ui.toast] setting respected');
        else {
            out += TOAST_BLOCK;
            report.push('toasts: enabled (delivery = "herdr")');
        }
    }
    const bindings = [
        { key, action: 'open-chat', description: 'group chat', label: 'keybinding', what: 'open chat' },
        { key: tabKey, action: 'open-chat-tab', description: 'group chat tab', label: 'tab keybinding', what: 'open chat in a tab' },
        { key: boardKey, action: 'open-board', description: 'Chatter board', label: 'board keybinding', what: 'open board' },
        { key: boardTabKey, action: 'open-board-tab', description: 'Chatter board tab', label: 'board tab keybinding', what: 'open board in a tab' },
    ];
    for (const b of bindings) {
        if (!b.key)
            continue;
        // Checked against `out`, not `text`: a key this same run just claimed is
        // as taken as one that was already in the file.
        if (actionBound(out, b.action))
            report.push(`${b.label}: already bound — left as is`);
        else if (new RegExp(`^\\s*key\\s*=\\s*"${escRe(b.key)}"`, 'm').test(out)) {
            report.push(`${b.label}: "${b.key}" is already in use — skipped (bind manually)`);
        }
        else {
            out += keyBlock(b.key, b.action, b.description);
            report.push(`${b.label}: ${b.key} → ${b.what}`);
        }
    }
    if (out !== text) {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
        if (text)
            node_fs_1.default.copyFileSync(file, `${file}.bak-${Math.floor(Date.now() / 1000)}`);
        node_fs_1.default.writeFileSync(file, out);
        const r = (0, herdr_1.herdr)(['server', 'reload-config']);
        report.push(r.ok ? 'herdr config reloaded — changes active now' : 'config written (reload when Herdr is running)');
    }
    return report;
}
function doctorChecks() {
    const checks = [];
    const add = (ok, label, hint) => { checks.push({ ok, label, hint }); };
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    add(major > 22 || (major === 22 && minor >= 5), `Node ${process.versions.node}`, 'install Node 22.5+');
    try {
        require('node:sqlite');
        add(true, 'node:sqlite available');
    }
    catch {
        add(false, 'node:sqlite available', 'Node build lacks built-in SQLite');
    }
    const st = (0, herdr_1.herdr)(['status']);
    add(st.ok, 'Herdr server reachable', 'start Herdr, or run inside a Herdr session');
    const entry = (0, update_1.registration)();
    add(!!entry, 'plugin registered with Herdr', `herdr plugin install/link this directory`);
    // Best effort, hard-capped, silent when it fails: being offline must never
    // slow doctor down or paint it red. Informational only, never a ✗.
    if (entry) {
        try {
            const st = (0, update_1.updateStatus)({ source: entry.source, root: entry.plugin_root }, { timeout: 3000 });
            if (st.state === 'behind')
                add(null, 'update available — run: chatter update');
            else if (st.state === 'current')
                add(null, `chatter is up to date (v${entry.version || '?'})`);
        }
        catch { /* the update probe must never break doctor */ }
    }
    const link = node_path_1.default.join(node_os_1.default.homedir(), '.local', 'bin', 'chatter');
    let linkOk = false;
    try {
        linkOk = node_fs_1.default.lstatSync(link).isSymbolicLink() && node_fs_1.default.existsSync(node_fs_1.default.realpathSync(link));
    }
    catch { /* absent */ }
    add(linkOk, '~/.local/bin/chatter symlink', 'run: chatter setup (or the _startup hook)');
    add((process.env.PATH || '').split(':').includes(node_path_1.default.join(node_os_1.default.homedir(), '.local', 'bin')), '~/.local/bin on PATH', 'add to your shell profile: export PATH="$HOME/.local/bin:$PATH"');
    try {
        node_fs_1.default.accessSync((0, db_1.stateRoot)(), node_fs_1.default.constants.W_OK);
        add(true, `state dir writable (${(0, db_1.stateRoot)()})`);
    }
    catch {
        add(false, 'state dir writable', 'check permissions on the plugin state dir');
    }
    add((0, db_1.humanName)() !== 'user', `human name set (${(0, db_1.humanName)()})`, 'run: chatter iam <name>');
    let cfg = '';
    try {
        cfg = node_fs_1.default.readFileSync(configToml(), 'utf8');
    }
    catch { /* none */ }
    add(/\[ui\.toast\]/.test(cfg) && !/delivery\s*=\s*"off"/.test(cfg), 'toast notifications enabled', 'run: chatter setup (adds [ui.toast] delivery = "herdr")');
    add(actionBound(cfg, 'open-chat'), 'chat window keybinding bound', 'run: chatter setup (adds a [[keys.command]] block)');
    // The tab binding is a convenience, not a requirement: ✓ when bound, a dim
    // note when not — never a reported problem.
    const tabBound = actionBound(cfg, 'open-chat-tab');
    add(tabBound || null, tabBound ? 'chat tab keybinding bound' : 'chat tab keybinding not bound (optional — run: chatter setup)');
    const boardBound = actionBound(cfg, 'open-board');
    add(boardBound || null, boardBound ? 'board keybinding bound' : 'board keybinding not bound (optional — run: chatter setup)');
    const boardTabBound = actionBound(cfg, 'open-board-tab');
    add(boardTabBound || null, boardTabBound ? 'board tab keybinding bound' : 'board tab keybinding not bound (optional — run: chatter setup)');
    const g = (0, db_1.gitInfo)();
    add(null, g.repoRoot ? `current repo: ${node_path_1.default.basename(g.repoRoot)}` : 'not inside a git repo (chatter is per-repo)');
    // session-wide by design: doctor is a machine-level diagnostic
    add(null, `live agents visible (session-wide): ${(0, herdr_1.sessionAgents)().length}`);
    return checks;
}
function renderChecks(checks) {
    return checks.map((c) => c.ok === null
        ? `   ${T.FAINT}ℹ${T.RESET}  ${T.FAINT}${c.label}${T.RESET}`
        : c.ok
            ? `   ${T.GREEN}✓${T.RESET}  ${c.label}`
            : `   ${T.NEWMARK}✗${T.RESET}  ${c.label}${c.hint ? `  ${T.FAINT}→ ${c.hint}${T.RESET}` : ''}`);
}
function cmdDoctor() {
    const width = process.stdout.columns || 100;
    console.log(T.logoLines(width).join('\n'));
    const checks = doctorChecks();
    console.log(renderChecks(checks).join('\n'));
    const bad = checks.filter((c) => c.ok === false).length;
    console.log(bad ? `\n${bad} problem${bad > 1 ? 's' : ''} found` : `\nall good — you're in`);
    if (bad)
        process.exit(1);
}
function applySetup({ name, toasts, key, tabKey = null, boardKey = null, boardTabKey = null, }) {
    const report = [];
    if (name) {
        node_fs_1.default.mkdirSync((0, db_1.configRoot)(), { recursive: true });
        node_fs_1.default.writeFileSync(node_path_1.default.join((0, db_1.configRoot)(), 'name'), name + '\n');
        report.push(`you are "${name}"`);
    }
    (0, commands_1.ensurePointerAndSymlink)();
    report.push('chatter linked into ~/.local/bin');
    report.push(...editHerdrConfig({ toasts, key, tabKey, boardKey, boardTabKey }));
    if (toasts) {
        const r = (0, herdr_1.herdr)(['notification', 'show', 'chatter', '--body', `hi ${name || (0, db_1.humanName)()} — notifications work`, '--sound', 'done']);
        const shown = r.ok && (0, herdr_1.isRecord)(r.json) && (0, herdr_1.isRecord)(r.json.result) && r.json.result.shown === true;
        report.push(shown ? 'test toast fired (did you see it?)' : 'test toast queued (visible once Herdr UI is active)');
    }
    return report;
}
// ------------------------------------------------------------- CLI: setup
const defaultName = () => {
    const n = node_os_1.default.userInfo().username.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 32);
    return n || 'user';
};
function cmdSetup(me, args) {
    if (!me.human)
        (0, util_1.die)('chatter setup is human-only');
    const opts = (0, util_1.parseFlags)(args, {
        yes: false, name: null, key: 'prefix+alt+c', 'tab-key': 'prefix+alt+t',
        'board-key': 'prefix+alt+b', 'board-tab-key': 'prefix+alt+shift+b',
        'no-toasts': false, 'no-keybind': false,
    });
    const width = process.stdout.columns || 100;
    console.log(T.logoLines(width).join('\n'));
    if (!opts.yes) {
        (0, util_1.die)('interactive setup runs as the Herdr wizard:  herdr plugin action invoke chatter.setup\n'
            + 'non-interactive here:  chatter setup --yes [--name X] [--key "prefix+alt+c"]\n'
            + '                       [--tab-key "prefix+alt+t"] [--board-key "prefix+alt+b"]\n'
            + '                       [--board-tab-key "prefix+alt+shift+b"]\n'
            + '                       [--no-toasts] [--no-keybind]');
    }
    const name = (opts.name || defaultName()).toLowerCase();
    const taken = (0, team_1.nameTaken)(name);
    if (taken && opts.name)
        (0, util_1.die)(`name "${name}" is ${taken} — rerun with --name <other>`);
    if (taken)
        console.error(`note: default name "${name}" is ${taken} — keeping current name "${(0, db_1.humanName)()}"`);
    const report = applySetup({
        name: taken ? null : name,
        toasts: !opts['no-toasts'],
        key: opts['no-keybind'] ? null : opts.key,
        tabKey: opts['no-keybind'] ? null : opts['tab-key'],
        boardKey: opts['no-keybind'] ? null : opts['board-key'],
        boardTabKey: opts['no-keybind'] ? null : opts['board-tab-key'],
    });
    console.log(report.map((l) => `   ${T.GREEN}✓${T.RESET}  ${l}`).join('\n'));
    console.log('');
    const checks = doctorChecks();
    console.log(renderChecks(checks).join('\n'));
    console.log(`\nopen the chat: ${T.BOLD}${opts.key}${T.RESET} as a popup · ${T.BOLD}${opts['tab-key']}${T.RESET} as a tab`
        + `\nopen the board: ${T.BOLD}${opts['board-key']}${T.RESET} as a popup · ${T.BOLD}${opts['board-tab-key']}${T.RESET} as a tab`
        + `\n(or: herdr plugin pane open --plugin ${herdr_1.PLUGIN_ID} --entrypoint chat [--placement tab|split])`);
}
// ----------------------------------------------------------- wizard (popup)
const STEPS = {
    NAME: 0, TOASTS: 1, KEY: 2, TABKEY: 3, BOARDKEY: 4, BOARDTABKEY: 5, DONE: 6,
};
function nextSetupStep(step) {
    if (step === STEPS.NAME)
        return STEPS.TOASTS;
    if (step === STEPS.TOASTS)
        return STEPS.KEY;
    if (step === STEPS.KEY)
        return STEPS.TABKEY;
    if (step === STEPS.TABKEY)
        return STEPS.BOARDKEY;
    if (step === STEPS.BOARDKEY)
        return STEPS.BOARDTABKEY;
    if (step === STEPS.BOARDTABKEY)
        return STEPS.DONE;
    return STEPS.DONE;
}
function wizard() {
    const painter = T.makePainter();
    const width = () => process.stdout.columns || 100;
    const state = {
        step: STEPS.NAME,
        name: defaultName(),
        toasts: true,
        key: 'prefix+alt+c',
        tabKey: 'prefix+alt+t',
        boardKey: 'prefix+alt+b',
        boardTabKey: 'prefix+alt+shift+b',
        error: '',
        report: null,
        checks: null,
        toastsExisting: /\[ui\.toast\]/.test((() => { try {
            return node_fs_1.default.readFileSync(configToml(), 'utf8');
        }
        catch {
            return '';
        } })()),
    };
    const field = T.field;
    const render = () => {
        const out = [...T.logoLines(width())];
        out.push(` ${T.BOLD}setup${T.RESET}`);
        out.push('');
        if (state.step === STEPS.NAME) {
            out.push(`   your chat name ${T.FAINT}(agents will reach you as @${state.name || '…'})${T.RESET}`);
            out.push('   ' + field(state.name));
            if (state.error)
                out.push(`   ${T.YELLOW}⚠ ${state.error}${T.RESET}`);
            out.push('', T.hint('Enter continues', 'Esc aborts'));
        }
        else if (state.step === STEPS.TOASTS) {
            out.push(`   notifications ${T.FAINT}(DMs and @${state.name} mentions arrive as a toast)${T.RESET}`);
            out.push(state.toastsExisting
                ? `   ${T.FAINT}existing [ui.toast] setting found — will be respected${T.RESET}`
                : `   ${state.toasts ? `${T.GREEN}● enabled${T.RESET}` : `${T.FAINT}○ disabled${T.RESET}`}  ${T.FAINT}(y/n toggles)${T.RESET}`);
            out.push('', T.hint('Enter continues', 'Esc aborts'));
        }
        else if (state.step === STEPS.KEY) {
            out.push(`   keybinding to open the chat as a popup ${T.FAINT}(clear the field to skip)${T.RESET}`);
            out.push('   ' + field(state.key));
            out.push('', T.hint('Enter continues', 'Esc aborts'));
        }
        else if (state.step === STEPS.TABKEY) {
            out.push(`   keybinding to open the chat in a tab ${T.FAINT}(a pane that stays open — clear to skip)${T.RESET}`);
            out.push('   ' + field(state.tabKey));
            out.push(`   ${T.FAINT}popup: ${state.key.trim() || '(skipped)'}${T.RESET}`);
            out.push('', T.hint('Enter continues', 'Esc aborts'));
        }
        else if (state.step === STEPS.BOARDKEY) {
            out.push(`   keybinding to open the board as a popup ${T.FAINT}(clear the field to skip)${T.RESET}`);
            out.push('   ' + field(state.boardKey));
            out.push(`   ${T.FAINT}chat: ${state.key.trim() || '(skipped)'} popup · ${state.tabKey.trim() || '(skipped)'} tab${T.RESET}`);
            out.push('', T.hint('Enter continues', 'Esc aborts'));
        }
        else if (state.step === STEPS.BOARDTABKEY) {
            out.push(`   keybinding to open the board in a tab ${T.FAINT}(a pane that stays open — clear to skip)${T.RESET}`);
            out.push('   ' + field(state.boardTabKey));
            out.push(`   ${T.FAINT}board popup: ${state.boardKey.trim() || '(skipped)'}${T.RESET}`);
            out.push('', T.hint('Enter applies everything', 'Esc aborts'));
        }
        else {
            out.push(...(state.report || []).map((l) => `   ${T.GREEN}✓${T.RESET}  ${l}`));
            out.push('');
            out.push(...renderChecks(state.checks || []));
            out.push('', T.hint('Enter opens the chat window', 'Esc closes'));
        }
        painter(out);
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (b) => {
        const key = T.decodeKey(b.toString());
        if (key.type === 'esc' || key.type === 'close')
            process.exit(0);
        if (state.step === STEPS.NAME) {
            if (key.type === 'backspace')
                state.name = state.name.slice(0, -1);
            else if (key.type === 'text')
                state.name += key.text.toLowerCase().replace(/[^a-z0-9_-]/g, '');
            else if (key.type === 'enter') {
                const taken = state.name ? (0, team_1.nameTaken)(state.name) : 'empty';
                if (!state.name)
                    state.error = 'name required';
                else if (taken)
                    state.error = `"${state.name}" is ${taken} — pick another`;
                else {
                    state.error = '';
                    state.step = nextSetupStep(state.step);
                }
            }
        }
        else if (state.step === STEPS.TOASTS) {
            if (key.type === 'text' && (key.text === 'y' || key.text === 'n'))
                state.toasts = key.text === 'y';
            else if (key.type === 'enter')
                state.step = nextSetupStep(state.step);
        }
        else if (state.step === STEPS.KEY) {
            if (key.type === 'backspace')
                state.key = state.key.slice(0, -1);
            else if (key.type === 'text')
                state.key += key.text;
            else if (key.type === 'enter')
                state.step = nextSetupStep(state.step);
        }
        else if (state.step === STEPS.TABKEY) {
            if (key.type === 'backspace')
                state.tabKey = state.tabKey.slice(0, -1);
            else if (key.type === 'text')
                state.tabKey += key.text;
            else if (key.type === 'enter')
                state.step = nextSetupStep(state.step);
        }
        else if (state.step === STEPS.BOARDKEY) {
            if (key.type === 'backspace')
                state.boardKey = state.boardKey.slice(0, -1);
            else if (key.type === 'text')
                state.boardKey += key.text;
            else if (key.type === 'enter')
                state.step = nextSetupStep(state.step);
        }
        else if (state.step === STEPS.BOARDTABKEY) {
            if (key.type === 'backspace')
                state.boardTabKey = state.boardTabKey.slice(0, -1);
            else if (key.type === 'text')
                state.boardTabKey += key.text;
            else if (key.type === 'enter') {
                state.report = applySetup({
                    name: state.name,
                    toasts: state.toasts && !state.toastsExisting,
                    key: state.key.trim() || null,
                    tabKey: state.tabKey.trim() || null,
                    boardKey: state.boardKey.trim() || null,
                    boardTabKey: state.boardTabKey.trim() || null,
                });
                state.checks = doctorChecks();
                state.step = nextSetupStep(state.step);
            }
        }
        else if (state.step === STEPS.DONE && key.type === 'enter') {
            // Popups are singletons: exit first, then a detached child opens chat.
            (0, node_child_process_1.spawn)(process.execPath, ['-e',
                `setTimeout(()=>require('node:child_process').spawnSync(${JSON.stringify(herdr_1.HERDR)},['plugin','pane','open','--plugin',${JSON.stringify(herdr_1.PLUGIN_ID)},'--entrypoint','chat']),400)`], { detached: true, stdio: 'ignore' }).unref();
            process.exit(0);
        }
        render();
    });
    render();
}
function hookOpenSetup() {
    const r = (0, herdr_1.herdr)(['plugin', 'pane', 'open', '--plugin', herdr_1.PLUGIN_ID, '--entrypoint', 'setup']);
    if (!r.ok) {
        console.error(r.raw);
        process.exit(1);
    }
}
