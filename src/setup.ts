'use strict';
// Premium onboarding: setup wizard (popup TUI + CLI fallback) and doctor.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PLUGIN_ID, HERDR, herdr, isRecord, sessionAgents } from './herdr';
import { configRoot, humanName, stateRoot, gitInfo } from './db';
import { die, parseFlags } from './util';
import * as T from './tui';
import { ensurePointerAndSymlink } from './commands';
import { nameTaken } from './team';
import { registration, updateStatus } from './update';
import type { Identity } from './types';

// The wordmark lives with the other painting primitives; re-exported here
// because setup is where it was born and callers still ask for it.
export const { logoLines } = T;

// -------------------------------------------------------------- config edits

const configToml = () => path.join(os.homedir(), '.config', 'herdr', 'config.toml');
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TOAST_BLOCK = `
# added by chatter setup
[ui.toast]
delivery = "herdr"
`;
const keyBlock = (key: string, action: string, description: string): string => `
# added by chatter setup
[[keys.command]]
key = "${key}"
type = "plugin_action"
command = "${PLUGIN_ID}.${action}"
description = "${description}"
`;

// Is this exact plugin action already bound? The closing quote matters:
// "chatter.open-chat" is a prefix of "chatter.open-chat-tab", so a substring
// test would report the popup bound when only the tab binding exists.
const actionBound = (text: string, action: string): boolean =>
  new RegExp(`command\\s*=\\s*"${escRe(`${PLUGIN_ID}.${action}`)}"`).test(text);

// Apply toast/keybinding config; returns human-readable report lines.
// Each binding is decided independently: already bound, key taken, or added.
interface SetupConfig { toasts: boolean; key: string | null; tabKey?: string | null }
function editHerdrConfig({ toasts, key, tabKey = null }: SetupConfig): string[] {
  const file = configToml();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const report: string[] = [];
  let out = text;
  if (toasts) {
    if (/^\s*\[ui\.toast\]/m.test(text)) report.push('toasts: existing [ui.toast] setting respected');
    else { out += TOAST_BLOCK; report.push('toasts: enabled (delivery = "herdr")'); }
  }
  const bindings = [
    { key, action: 'open-chat', description: 'group chat', label: 'keybinding', what: 'open chat' },
    { key: tabKey, action: 'open-chat-tab', description: 'group chat tab', label: 'tab keybinding', what: 'open chat in a tab' },
  ];
  for (const b of bindings) {
    if (!b.key) continue;
    // Checked against `out`, not `text`: a key this same run just claimed is
    // as taken as one that was already in the file.
    if (actionBound(out, b.action)) report.push(`${b.label}: already bound — left as is`);
    else if (new RegExp(`^\\s*key\\s*=\\s*"${escRe(b.key)}"`, 'm').test(out)) {
      report.push(`${b.label}: "${b.key}" is already in use — skipped (bind manually)`);
    } else {
      out += keyBlock(b.key, b.action, b.description);
      report.push(`${b.label}: ${b.key} → ${b.what}`);
    }
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

interface DoctorCheck { ok: boolean | null; label: string; hint?: string }

function doctorChecks(): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const add = (ok: boolean | null, label: string, hint?: string): void => { checks.push({ ok, label, hint }); };
  const major = parseInt(process.versions.node, 10);
  add(major >= 22, `Node ${process.versions.node}`, 'install Node 22+');
  try { require('node:sqlite'); add(true, 'node:sqlite available'); }
  catch { add(false, 'node:sqlite available', 'Node build lacks built-in SQLite'); }
  const st = herdr(['status']);
  add(st.ok, 'Herdr server reachable', 'start Herdr, or run inside a Herdr session');
  const entry = registration();
  add(!!entry, 'plugin registered with Herdr', `herdr plugin install/link this directory`);
  // Best effort, hard-capped, silent when it fails: being offline must never
  // slow doctor down or paint it red. Informational only, never a ✗.
  if (entry) {
    try {
      const st = updateStatus({ source: entry.source, root: entry.plugin_root }, { timeout: 3000 });
      if (st.state === 'behind') add(null, 'update available — run: chatter update');
      else if (st.state === 'current') add(null, `chatter is up to date (v${entry.version || '?'})`);
    } catch { /* the update probe must never break doctor */ }
  }
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
  add(actionBound(cfg, 'open-chat'), 'chat window keybinding bound', 'run: chatter setup (adds a [[keys.command]] block)');
  // The tab binding is a convenience, not a requirement: ✓ when bound, a dim
  // note when not — never a reported problem.
  const tabBound = actionBound(cfg, 'open-chat-tab');
  add(tabBound || null, tabBound ? 'chat tab keybinding bound' : 'chat tab keybinding not bound (optional — run: chatter setup)');
  const g = gitInfo();
  add(null, g.repoRoot ? `current repo: ${path.basename(g.repoRoot)}` : 'not inside a git repo (chatter is per-repo)');
  // session-wide by design: doctor is a machine-level diagnostic
  add(null, `live agents visible (session-wide): ${sessionAgents().length}`);
  return checks;
}

function renderChecks(checks: readonly DoctorCheck[]): string[] {
  return checks.map((c) => c.ok === null
    ? `   ${T.FAINT}ℹ${T.RESET}  ${T.FAINT}${c.label}${T.RESET}`
    : c.ok
      ? `   ${T.GREEN}✓${T.RESET}  ${c.label}`
      : `   ${T.NEWMARK}✗${T.RESET}  ${c.label}${c.hint ? `  ${T.FAINT}→ ${c.hint}${T.RESET}` : ''}`);
}

export function cmdDoctor(): void {
  const width = process.stdout.columns || 100;
  console.log(logoLines(width).join('\n'));
  const checks = doctorChecks();
  console.log(renderChecks(checks).join('\n'));
  const bad = checks.filter((c) => c.ok === false).length;
  console.log(bad ? `\n${bad} problem${bad > 1 ? 's' : ''} found` : `\nall good — you're in`);
  if (bad) process.exit(1);
}

// -------------------------------------------------------------------- apply

interface ApplySetupOptions extends SetupConfig { name: string | null }
function applySetup({ name, toasts, key, tabKey = null }: ApplySetupOptions): string[] {
  const report: string[] = [];
  if (name) {
    fs.mkdirSync(configRoot(), { recursive: true });
    fs.writeFileSync(path.join(configRoot(), 'name'), name + '\n');
    report.push(`you are "${name}"`);
  }
  ensurePointerAndSymlink();
  report.push('chatter linked into ~/.local/bin');
  report.push(...editHerdrConfig({ toasts, key, tabKey }));
  if (toasts) {
    const r = herdr(['notification', 'show', 'chatter', '--body', `hi ${name || humanName()} — notifications work`, '--sound', 'done']);
    const shown = r.ok && isRecord(r.json) && isRecord(r.json.result) && r.json.result.shown === true;
    report.push(shown ? 'test toast fired (did you see it?)' : 'test toast queued (visible once Herdr UI is active)');
  }
  return report;
}

// ------------------------------------------------------------- CLI: setup

const defaultName = () => {
  const n = os.userInfo().username.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 32);
  return n || 'user';
};

export function cmdSetup(me: Identity, args: readonly string[]): void {
  if (!me.human) die('chatter setup is human-only');
  const opts = parseFlags(args, {
    yes: false, name: null, key: 'prefix+alt+c', 'tab-key': 'prefix+alt+t',
    'no-toasts': false, 'no-keybind': false,
  });
  const width = process.stdout.columns || 100;
  console.log(logoLines(width).join('\n'));
  if (!opts.yes) {
    die('interactive setup runs as the Herdr wizard:  herdr plugin action invoke chatter.setup\n'
      + 'non-interactive here:  chatter setup --yes [--name X] [--key "prefix+alt+c"]\n'
      + '                       [--tab-key "prefix+alt+t"] [--no-toasts] [--no-keybind]');
  }
  const name = (opts.name || defaultName()).toLowerCase();
  const taken = nameTaken(name);
  if (taken && opts.name) die(`name "${name}" is ${taken} — rerun with --name <other>`);
  if (taken) console.error(`note: default name "${name}" is ${taken} — keeping current name "${humanName()}"`);
  const report = applySetup({
    name: taken ? null : name,
    toasts: !opts['no-toasts'],
    key: opts['no-keybind'] ? null : opts.key,
    tabKey: opts['no-keybind'] ? null : opts['tab-key'],
  });
  console.log(report.map((l) => `   ${T.GREEN}✓${T.RESET}  ${l}`).join('\n'));
  console.log('');
  const checks = doctorChecks();
  console.log(renderChecks(checks).join('\n'));
  console.log(`\nopen the chat: ${T.BOLD}${opts.key}${T.RESET} as a popup · ${T.BOLD}${opts['tab-key']}${T.RESET} as a tab`
    + `\n(or: herdr plugin pane open --plugin ${PLUGIN_ID} --entrypoint chat [--placement tab|split])`);
}

// ----------------------------------------------------------- wizard (popup)

const STEPS = { NAME: 0, TOASTS: 1, KEY: 2, TABKEY: 3, DONE: 4 } as const;
type SetupStep = typeof STEPS[keyof typeof STEPS];

interface SetupState {
  step: SetupStep;
  name: string;
  toasts: boolean;
  key: string;
  tabKey: string;
  error: string;
  report: string[] | null;
  checks: DoctorCheck[] | null;
  toastsExisting: boolean;
}

export function wizard(): void {
  const painter = T.makePainter();
  const width = () => process.stdout.columns || 100;
  const state: SetupState = {
    step: STEPS.NAME,
    name: defaultName(),
    toasts: true,
    key: 'prefix+alt+c',
    tabKey: 'prefix+alt+t',
    error: '',
    report: null,
    checks: null,
    toastsExisting: /\[ui\.toast\]/.test((() => { try { return fs.readFileSync(configToml(), 'utf8'); } catch { return ''; } })()),
  };
  const field = T.field;
  const render = () => {
    const out = [...logoLines(width())];
    out.push(` ${T.BOLD}setup${T.RESET}`);
    out.push('');
    if (state.step === STEPS.NAME) {
      out.push(`   your chat name ${T.FAINT}(agents will reach you as @${state.name || '…'})${T.RESET}`);
      out.push('   ' + field(state.name));
      if (state.error) out.push(`   ${T.YELLOW}⚠ ${state.error}${T.RESET}`);
      out.push('', T.hint('Enter continues', 'Esc aborts'));
    } else if (state.step === STEPS.TOASTS) {
      out.push(`   notifications ${T.FAINT}(DMs and @${state.name} mentions arrive as a toast)${T.RESET}`);
      out.push(state.toastsExisting
        ? `   ${T.FAINT}existing [ui.toast] setting found — will be respected${T.RESET}`
        : `   ${state.toasts ? `${T.GREEN}● enabled${T.RESET}` : `${T.FAINT}○ disabled${T.RESET}`}  ${T.FAINT}(y/n toggles)${T.RESET}`);
      out.push('', T.hint('Enter continues', 'Esc aborts'));
    } else if (state.step === STEPS.KEY) {
      out.push(`   keybinding to open the chat as a popup ${T.FAINT}(clear the field to skip)${T.RESET}`);
      out.push('   ' + field(state.key));
      out.push('', T.hint('Enter continues', 'Esc aborts'));
    } else if (state.step === STEPS.TABKEY) {
      out.push(`   keybinding to open the chat in a tab ${T.FAINT}(a pane that stays open — clear to skip)${T.RESET}`);
      out.push('   ' + field(state.tabKey));
      out.push(`   ${T.FAINT}popup: ${state.key.trim() || '(skipped)'}${T.RESET}`);
      out.push('', T.hint('Enter applies everything', 'Esc aborts'));
    } else {
      out.push(...(state.report || []).map((l) => `   ${T.GREEN}✓${T.RESET}  ${l}`));
      out.push('');
      out.push(...renderChecks(state.checks || []));
      out.push('', T.hint('Enter opens the chat window', 'Esc closes'));
    }
    painter(out);
  };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (b: Buffer) => {
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
      else if (key.type === 'enter') state.step = STEPS.TABKEY;
    } else if (state.step === STEPS.TABKEY) {
      if (key.type === 'backspace') state.tabKey = state.tabKey.slice(0, -1);
      else if (key.type === 'text') state.tabKey += key.text;
      else if (key.type === 'enter') {
        state.report = applySetup({
          name: state.name,
          toasts: state.toasts && !state.toastsExisting,
          key: state.key.trim() || null,
          tabKey: state.tabKey.trim() || null,
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

export function hookOpenSetup(): void {
  const r = herdr(['plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', 'setup']);
  if (!r.ok) { console.error(r.raw); process.exit(1); }
}
