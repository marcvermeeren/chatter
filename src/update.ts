'use strict';
// Keeping this machine's copy of chatter current.
//
// Herdr installs plugins two ways and the registry remembers which: a GitHub
// install (reinstall IS the upgrade in Herdr's model) or a linked working tree
// (fast-forward, then re-register the manifest). One command covers both.
//
// Nothing here touches your data: config, names and the per-repo universes all
// live outside the checkout, so an upgrade never sees them.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ID, herdr, isRecord } from './herdr';
import { ensurePointerAndSymlink, humanOnly } from './commands';
import { die, parseFlags } from './util';
import type { Identity, PluginRegistration, PluginSource, UpdateResult, UpdateState } from './types';

// git as an argv array, never a shell. Network calls pass a timeout so a
// dead remote can't hang a terminal.
function git(args: readonly string[], { cwd = null, timeout = 0 }: { cwd?: string | null; timeout?: number } = {}) {
  const r = spawnSync('git', args, {
    cwd: cwd || undefined,
    encoding: 'utf8',
    timeout: timeout || undefined,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();
  return { ok: r.status === 0, out, err, raw: out || err || (r.error ? r.error.message : '') };
}

// The registry is the truth about how this machine got the plugin.
export function registration(): PluginRegistration | null {
  const r = herdr(['plugin', 'list', '--json']);
  if (!r.ok || !isRecord(r.json) || !isRecord(r.json.result) || !Array.isArray(r.json.result.plugins)) return null;
  const plugin = r.json.result.plugins.find((item) => isRecord(item) && item.plugin_id === PLUGIN_ID);
  if (!isRecord(plugin) || typeof plugin.plugin_id !== 'string' || typeof plugin.plugin_root !== 'string' || !isRecord(plugin.source)) return null;
  return {
    plugin_id: plugin.plugin_id,
    plugin_root: plugin.plugin_root,
    version: typeof plugin.version === 'string' ? plugin.version : undefined,
    source: Object.fromEntries(Object.entries(plugin.source).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  };
}

export function manifestVersion(root: string): string | null {
  try {
    const text = fs.readFileSync(path.join(root, 'herdr-plugin.toml'), 'utf8');
    const m = text.match(/^\s*version\s*=\s*"([^"]+)"/m);
    return m?.[1] ?? null;
  } catch { return null; }
}

const cloneUrl = (src: PluginSource): string => `https://github.com/${src.owner}/${src.repo}.git`;

// Compare a full sha against a possibly-abbreviated one.
const sameCommit = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n) === b.slice(0, n);
};

function remoteHead({ url = null, cwd = null, timeout }: { url?: string | null; cwd?: string | null; timeout: number }): string | null {
  const r = url ? git(['ls-remote', url, 'HEAD'], { timeout })
    : git(['ls-remote', 'origin', 'HEAD'], { cwd, timeout });
  if (!r.ok) return null;
  const sha = (r.out.split(/\s+/)[0] || '').trim();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

// Versions aren't tagged, so "is there an update?" is a commit comparison:
// the registry's resolved_commit for GitHub installs, HEAD for a checkout.
// Returns 'current' | 'behind' | 'unknown' — never throws.
export function updateStatus(
  { source, root }: { source: PluginSource; root: string },
  { timeout = 3000 }: { timeout?: number } = {},
): UpdateState {
  const src = source || {};
  if (src.kind === 'github') {
    if (!src.owner || !src.repo) return { state: 'unknown', reason: 'the registry has no owner/repo for this install' };
    const remote = remoteHead({ url: cloneUrl(src), timeout });
    if (!remote) return { state: 'unknown', reason: 'could not reach GitHub' };
    return { state: sameCommit(src.resolved_commit, remote) ? 'current' : 'behind' };
  }
  if (src.kind === 'local') {
    const local = git(['rev-parse', 'HEAD'], { cwd: root }).out;
    if (!local) return { state: 'unknown', reason: `${root} is not a git checkout` };
    const remote = remoteHead({ cwd: root, timeout });
    if (!remote) return { state: 'unknown', reason: 'could not reach the remote' };
    if (sameCommit(local, remote)) return { state: 'current' };
    // A linked checkout is often AHEAD of its remote (it may be where the
    // work happens). Only a remote commit this checkout does NOT already
    // contain counts as an update.
    return git(['merge-base', '--is-ancestor', remote, 'HEAD'], { cwd: root }).ok
      ? { state: 'current' }
      : { state: 'behind' };
  }
  return { state: 'unknown', reason: 'chatter is not registered with Herdr' };
}

// The core: an explicit source + root, so tests can drive it against a
// fixture instead of this machine's real installation.
export function runUpdate(
  { source, root }: { source: PluginSource; root: string },
  { check = false }: { check?: boolean } = {},
): UpdateResult {
  const src = source || {};
  const fail = (...lines: string[]): UpdateResult => ({ ok: false, lines });
  if (src.kind !== 'github' && src.kind !== 'local') {
    return fail('chatter is not registered with Herdr',
      'install it:  herdr plugin install <owner>/<repo>',
      'or link this checkout:  herdr plugin link <path>');
  }
  if (check) {
    const st = updateStatus({ source, root }, { timeout: 10000 });
    if (st.state === 'unknown') return fail(`could not check for updates — ${st.reason}`);
    return { ok: true, lines: [st.state === 'behind' ? 'update available (run: chatter update)' : 'up to date'] };
  }
  const before = manifestVersion(root);
  const lines: string[] = [];
  let rootAfter = root;
  if (src.kind === 'github') {
    if (!src.owner || !src.repo) {
      return fail('the registry has no owner/repo for this install',
        'reinstall by hand:  herdr plugin install <owner>/<repo> --yes');
    }
    const spec = [src.owner, src.repo, src.subdir].filter(Boolean).join('/');
    const args = ['plugin', 'install', spec, '--yes'];
    // A pinned ref stays pinned — an update must not silently unpin someone.
    if (src.requested_ref) args.push('--ref', src.requested_ref);
    const r = herdr(args);
    if (!r.ok) return fail(`reinstall failed: ${r.raw}`, 'if that was a network error, try again when you are online');
    lines.push(`reinstalled ${spec} from GitHub${src.requested_ref ? ` (ref ${src.requested_ref})` : ''}`);
    // The reinstall can land in a new managed path.
    const fresh = registration();
    if (fresh && fresh.plugin_root) rootAfter = fresh.plugin_root;
  } else {
    const status = git(['status', '--porcelain'], { cwd: root });
    if (!status.ok) {
      return fail(`${root} is not a git checkout — nothing to pull`,
        'if you moved it, re-link it:  herdr plugin link <path>');
    }
    if (status.out) {
      return fail(`${root} has uncommitted changes — commit or stash them first, then rerun`,
        'chatter will not discard your work');
    }
    const pull = git(['pull', '--ff-only'], { cwd: root, timeout: 120000 });
    if (!pull.ok) {
      return fail(`git pull --ff-only failed: ${(pull.raw || '').split('\n')[0]}`,
        'a refused fast-forward means this checkout has diverged from its remote — reconcile it by hand');
    }
    lines.push(/Already up to date|Already up-to-date/.test(pull.out) ? 'checkout already current' : 'fast-forwarded the checkout');
    const link = herdr(['plugin', 'link', root]);
    lines.push(link.ok ? 'manifest re-registered with Herdr' : `manifest re-register failed: ${link.raw}`);
  }
  const after = manifestVersion(rootAfter);
  if (before && after) lines.push(before === after ? `already up to date (v${before})` : `v${before} → v${after}`);
  // A new checkout means a new CLI target: refresh the symlink either way.
  ensurePointerAndSymlink();
  lines.push('verify with: chatter doctor');
  return { ok: true, lines };
}

export function cmdUpdate(me: Identity, args: readonly string[]): void {
  humanOnly(me, 'chatter update');
  const opts = parseFlags(args, { check: false });
  const reg = registration();
  if (!reg) {
    die('chatter is not registered with Herdr — install it (herdr plugin install <owner>/<repo>)\n'
      + 'or link this checkout (herdr plugin link <path>)');
  }
  const r = runUpdate({ source: reg.source, root: reg.plugin_root }, { check: opts.check });
  for (const l of r.lines) console.log(l);
  if (!r.ok) process.exit(1);
}
