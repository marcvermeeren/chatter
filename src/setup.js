'use strict';
// Premium onboarding: setup wizard (popup TUI + CLI fallback) and doctor.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PLUGIN_ID, HERDR, herdr, sessionAgents } = require('./herdr');
const { configRoot, humanName, stateRoot, listRepoDbFiles, openDbFile, gitInfo } = require('./db');
const { die, parseFlags } = require('./util');
const T = require('./tui');

// "Delta Corps Priest 1" (figlet), rendered once and baked in. 88 cols.
const LOGO = [
  ' ▄████████    ▄█    █▄       ▄████████     ███         ███        ▄████████    ▄████████',
  '███    ███   ███    ███     ███    ███ ▀█████████▄ ▀█████████▄   ███    ███   ███    ███',
  '███    █▀    ███    ███     ███    ███    ▀███▀▀██    ▀███▀▀██   ███    █▀    ███    ███',
  '███         ▄███▄▄▄▄███▄▄   ███    ███     ███   ▀     ███   ▀  ▄███▄▄▄      ▄███▄▄▄▄██▀',
  '███        ▀▀███▀▀▀▀███▀  ▀███████████     ███         ███     ▀▀███▀▀▀     ▀▀███▀▀▀▀▀',
  '███    █▄    ███    ███     ███    ███     ███         ███       ███    █▄  ▀███████████',
  '███    ███   ███    ███     ███    ███     ███         ███       ███    ███   ███    ███',
  '████████▀    ███    █▀      ███    █▀     ▄████▀      ▄████▀     ██████████   ███    ███',
  '                                                                              ███    ███',
];
const LOGO_SHADES = [240, 242, 244, 246, 248, 250, 252, 254, 231];

function logoLines(width) {
  if (width < 90) return [` ${T.BOLD}CHATTER${T.RESET}`, ''];
  return [...LOGO.map((l, i) => ` ${T.fg(LOGO_SHADES[i])}${l}${T.RESET}`),
    ` ${T.FAINT}group chat for coding agents in Herdr worktrees${T.RESET}`, ''];
}

// -------------------------------------------------------------- config edits

const configToml = () => path.join(os.homedir(), '.config', 'herdr', 'config.toml');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TOAST_BLOCK = `
# added by chatter setup
[ui.toast]
delivery = "herdr"
`;
const keyBlock = (key) => `
# added by chatter setup
[[keys.command]]
key = "${key}"
type = "plugin_action"
command = "${PLUGIN_ID}.open-chat"
description = "group chat"
`;

// Apply toast/keybinding config; returns human-readable report lines.
function editHerdrConfig({ toasts, key }) {
  const file = configToml();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const report = [];
  let out = text;
  if (toasts) {
    if (/^\s*\[ui\.toast\]/m.test(text)) report.push('toasts: existing [ui.toast] setting respected');
    else { out += TOAST_BLOCK; report.push('toasts: enabled (delivery = "herdr")'); }
  }
  if (key) {
    if (text.includes(`${PLUGIN_ID}.open-chat`)) report.push('keybinding: already bound — left as is');
    else if (new RegExp(`^\\s*key\\s*=\\s*"${escRe(key)}"`, 'm').test(text)) {
      report.push(`keybinding: "${key}" is already in use — skipped (bind manually)`);
    } else { out += keyBlock(key); report.push(`keybinding: ${key} → open chat`); }
  }
  if (out !== text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (text) fs.copyFileSync(file, `${file}.bak-${Math.floor(Date.now() / 1000)}`);
    fs.writeFileSync(file, out);
    const r = herdr(['server', 'reload-config']);
    report.push(r.ok ? 'herdr config reloaded — changes active now' : 'config written (reload when Herdr is running)');
  }
  return report;
}

// ------------------------------------------------------------------- doctor

const { nameTaken } = require('./team');

function doctorChecks() {
  const checks = [];
  const add = (ok, label, hint) => checks.push({ ok, label, hint });
  const major = parseInt(process.versions.node, 10);
  add(major >= 22, `Node ${process.versions.node}`, 'install Node 22+');
  try { require('node:sqlite'); add(true, 'node:sqlite available'); }
  catch { add(false, 'node:sqlite available', 'Node build lacks built-in SQLite'); }
  const st = herdr(['status']);
  add(st.ok, 'Herdr server reachable', 'start Herdr, or run inside a Herdr session');
  const pl = herdr(['plugin', 'list', '--json']);
  const registered = pl.ok && pl.json && (pl.json.result.plugins || []).some((p) => p.plugin_id === PLUGIN_ID);
  add(!!registered, 'plugin registered with Herdr', `herdr plugin install/link this directory`);
  const link = path.join(os.homedir(), '.local', 'bin', 'chatter');
  let linkOk = false;
  try { linkOk = fs.lstatSync(link).isSymbolicLink() && fs.existsSync(fs.realpathSync(link)); } catch { /* absent */ }
  add(linkOk, '~/.local/bin/chatter symlink', 'run: chatter setup (or the _startup hook)');
  add((process.env.PATH || '').split(':').includes(path.join(os.homedir(), '.local', 'bin')),
    '~/.local/bin on PATH', 'add to your shell profile: export PATH="$HOME/.local/bin:$PATH"');
  try { fs.accessSync(stateRoot(), fs.constants.W_OK); add(true, `state dir writable (${stateRoot()})`); }
  catch { add(false, 'state dir writable', 'check permissions on the plugin state dir'); }
  add(humanName() !== 'user', `human name set (${humanName()})`, 'run: chatter iam <name>');
  let cfg = '';
  try { cfg = fs.readFileSync(configToml(), 'utf8'); } catch { /* none */ }
  add(/\[ui\.toast\]/.test(cfg) && !/delivery\s*=\s*"off"/.test(cfg),
    'toast notifications enabled', 'run: chatter setup (adds [ui.toast] delivery = "herdr")');
  add(cfg.includes(`${PLUGIN_ID}.open-chat`), 'chat window keybinding bound', 'run: chatter setup (adds a [[keys.command]] block)');
  const g = gitInfo();
  add(null, g.repoRoot ? `current repo: ${path.basename(g.repoRoot)}` : 'not inside a git repo (chatter is per-repo)');
  // session-wide by design: doctor is a machine-level diagnostic
  add(null, `live agents visible (session-wide): ${sessionAgents().length}`);
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
  console.log(logoLines(width).join('\n'));
  const checks = doctorChecks();
  console.log(renderChecks(checks).join('\n'));
  const bad = checks.filter((c) => c.ok === false).length;
  console.log(bad ? `\n${bad} problem${bad > 1 ? 's' : ''} found` : `\nall good — you're in`);
  if (bad) process.exit(1);
}

// -------------------------------------------------------------------- apply

function applySetup({ name, toasts, key }) {
  const report = [];
  if (name) {
    fs.mkdirSync(configRoot(), { recursive: true });
    fs.writeFileSync(path.join(configRoot(), 'name'), name + '\n');
    report.push(`you are "${name}"`);
  }
  const { ensurePointerAndSymlink } = require('./commands');
  ensurePointerAndSymlink();
  report.push('chatter linked into ~/.local/bin');
  report.push(...editHerdrConfig({ toasts, key }));
  if (toasts) {
    const r = herdr(['notification', 'show', 'chatter', '--body', `hi ${name || humanName()} — notifications work`, '--sound', 'done']);
    report.push(r.ok && r.json && r.json.result.shown ? 'test toast fired (did you see it?)' : 'test toast queued (visible once Herdr UI is active)');
  }
  return report;
}

// ------------------------------------------------------------- CLI: setup

const defaultName = () => {
  const n = os.userInfo().username.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 32);
  return n || 'user';
};

function cmdSetup(_me, args) {
  const opts = parseFlags(args, { yes: false, name: null, key: 'prefix+alt+c', 'no-toasts': false, 'no-keybind': false });
  const width = process.stdout.columns || 100;
  console.log(logoLines(width).join('\n'));
  if (!opts.yes) {
    die('interactive setup runs as the Herdr wizard:  herdr plugin action invoke chatter.setup\n'
      + 'non-interactive here:  chatter setup --yes [--name X] [--key "prefix+alt+c"] [--no-toasts] [--no-keybind]');
  }
  const name = (opts.name || defaultName()).toLowerCase();
  const taken = nameTaken(name);
  if (taken && opts.name) die(`name "${name}" is ${taken} — rerun with --name <other>`);
  if (taken) console.error(`note: default name "${name}" is ${taken} — keeping current name "${humanName()}"`);
  const report = applySetup({
    name: taken ? null : name,
    toasts: !opts['no-toasts'],
    key: opts['no-keybind'] ? null : opts.key,
  });
  console.log(report.map((l) => `   ${T.GREEN}✓${T.RESET}  ${l}`).join('\n'));
  console.log('');
  const checks = doctorChecks();
  console.log(renderChecks(checks).join('\n'));
  console.log(`\nopen the chat window: ${T.BOLD}${opts.key}${T.RESET} (or: herdr plugin pane open --plugin ${PLUGIN_ID} --entrypoint chat)`);
}

// ----------------------------------------------------------- wizard (popup)

const STEPS = { NAME: 0, TOASTS: 1, KEY: 2, DONE: 3 };

function wizard() {
  const painter = T.makePainter();
  const width = () => process.stdout.columns || 100;
  const state = {
    step: STEPS.NAME,
    name: defaultName(),
    toasts: true,
    key: 'prefix+alt+c',
    error: '',
    report: null,
    checks: null,
    toastsExisting: /\[ui\.toast\]/.test((() => { try { return fs.readFileSync(configToml(), 'utf8'); } catch { return ''; } })()),
  };
  const field = (v) => `${T.BOLD} › ${T.RESET}${v}${T.INV} ${T.RESET}`;
  const render = () => {
    const out = [...logoLines(width())];
    out.push(` ${T.BOLD}setup${T.RESET}`);
    out.push('');
    if (state.step === STEPS.NAME) {
      out.push(`   your chat name ${T.FAINT}(agents will reach you as @${state.name || '…'})${T.RESET}`);
      out.push('   ' + field(state.name));
      if (state.error) out.push(`   ${T.YELLOW}⚠ ${state.error}${T.RESET}`);
      out.push('', `   ${T.FAINT}Enter continues · Esc aborts${T.RESET}`);
    } else if (state.step === STEPS.TOASTS) {
      out.push(`   notifications ${T.FAINT}(DMs and @${state.name} mentions arrive as a toast)${T.RESET}`);
      out.push(state.toastsExisting
        ? `   ${T.FAINT}existing [ui.toast] setting found — will be respected${T.RESET}`
        : `   ${state.toasts ? `${T.GREEN}● enabled${T.RESET}` : `${T.FAINT}○ disabled${T.RESET}`}  ${T.FAINT}(y/n toggles)${T.RESET}`);
      out.push('', `   ${T.FAINT}Enter continues · Esc aborts${T.RESET}`);
    } else if (state.step === STEPS.KEY) {
      out.push(`   keybinding to open the chat window ${T.FAINT}(clear the field to skip)${T.RESET}`);
      out.push('   ' + field(state.key));
      out.push('', `   ${T.FAINT}Enter applies everything · Esc aborts${T.RESET}`);
    } else {
      out.push(...(state.report || []).map((l) => `   ${T.GREEN}✓${T.RESET}  ${l}`));
      out.push('');
      out.push(...renderChecks(state.checks || []));
      out.push('', `   ${T.BOLD}Enter opens the chat window · Esc closes${T.RESET}`);
    }
    painter(out);
  };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (b) => {
    const key = T.decodeKey(b.toString());
    if (key.type === 'esc' || key.type === 'close') process.exit(0);
    if (state.step === STEPS.NAME) {
      if (key.type === 'backspace') state.name = state.name.slice(0, -1);
      else if (key.type === 'text') state.name += key.text.toLowerCase().replace(/[^a-z0-9_-]/g, '');
      else if (key.type === 'enter') {
        const taken = state.name ? nameTaken(state.name) : 'empty';
        if (!state.name) state.error = 'name required';
        else if (taken) state.error = `"${state.name}" is ${taken} — pick another`;
        else { state.error = ''; state.step = STEPS.TOASTS; }
      }
    } else if (state.step === STEPS.TOASTS) {
      if (key.type === 'text' && (key.text === 'y' || key.text === 'n')) state.toasts = key.text === 'y';
      else if (key.type === 'enter') state.step = STEPS.KEY;
    } else if (state.step === STEPS.KEY) {
      if (key.type === 'backspace') state.key = state.key.slice(0, -1);
      else if (key.type === 'text') state.key += key.text;
      else if (key.type === 'enter') {
        state.report = applySetup({
          name: state.name,
          toasts: state.toasts && !state.toastsExisting,
          key: state.key.trim() || null,
        });
        state.checks = doctorChecks();
        state.step = STEPS.DONE;
      }
    } else if (state.step === STEPS.DONE && key.type === 'enter') {
      // Popups are singletons: exit first, then a detached child opens chat.
      spawn(process.execPath, ['-e',
        `setTimeout(()=>require('node:child_process').spawnSync(${JSON.stringify(HERDR)},['plugin','pane','open','--plugin',${JSON.stringify(PLUGIN_ID)},'--entrypoint','chat']),400)`],
      { detached: true, stdio: 'ignore' }).unref();
      process.exit(0);
    }
    render();
  });
  render();
}

function hookOpenSetup() {
  const r = herdr(['plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', 'setup']);
  if (!r.ok) { console.error(r.raw); process.exit(1); }
}

module.exports = { cmdDoctor, cmdSetup, wizard, hookOpenSetup, logoLines };
