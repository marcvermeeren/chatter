'use strict';
// Durable state, scoped PER REPOSITORY: each repo gets its own SQLite DB under
// the plugin state dir. Worktrees of one repo share a DB (keyed by the git
// common dir); unrelated repos are isolated universes.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PLUGIN_ID, HERDR } = require('./herdr');
const { die } = require('./util');

// One git spawn: branch, worktree toplevel, and the shared common dir that
// identifies the repo across all of its linked worktrees.
let _git;
function gitInfo(cwd = process.cwd()) {
  if (_git && _git.cwd === cwd) return _git;
  const r = spawnSync('git', ['-C', cwd, 'rev-parse',
    '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { encoding: 'utf8' });
  if (r.status !== 0) return (_git = { cwd, branch: null, toplevel: null, repoRoot: null });
  const [toplevel, commonDir] = r.stdout.trim().split('\n');
  let repoRoot = commonDir;
  try { repoRoot = fs.realpathSync(commonDir); } catch { /* keep as reported */ }
  if (path.basename(repoRoot) === '.git') repoRoot = path.dirname(repoRoot);
  // Separate call: --abbrev-ref HEAD errors in a repo with no commits yet.
  const b = spawnSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' });
  const branch = b.status === 0 ? b.stdout.trim() : '';
  return (_git = { cwd, branch: branch || null, toplevel: toplevel || null, repoRoot });
}

function stateRoot() {
  if (process.env.HERDR_PLUGIN_STATE_DIR) return process.env.HERDR_PLUGIN_STATE_DIR;
  // Herdr's layout on Unix (verified 0.8.0): ~/.local/state/herdr/plugins/<id>
  const conventional = path.join(os.homedir(), '.local', 'state', 'herdr', 'plugins', PLUGIN_ID);
  if (fs.existsSync(conventional)) return conventional;
  // Fall back to the pointer the startup hook writes into the config dir.
  const cfg = spawnSync(HERDR, ['plugin', 'config-dir', PLUGIN_ID], { encoding: 'utf8' });
  const cfgDir = (cfg.stdout || '').trim();
  if (cfgDir) {
    const pointer = path.join(cfgDir, 'state-dir');
    if (fs.existsSync(pointer)) {
      const p = fs.readFileSync(pointer, 'utf8').trim();
      if (p && fs.existsSync(p)) return p;
    }
  }
  const fallback = path.join(os.homedir(), '.local', 'state', 'herdr-chatter');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

const sanitizeKey = (s) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40) || 'repo';
function repoKey(repoRoot) {
  const hash = crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
  return `${sanitizeKey(path.basename(repoRoot))}-${hash}`;
}

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 3000;
  CREATE TABLE IF NOT EXISTS agents (
    name TEXT PRIMARY KEY, pane_id TEXT, workspace_id TEXT, cwd TEXT,
    repo_root TEXT, branch TEXT, kind TEXT, role TEXT,
    registered_at TEXT, last_seen_at TEXT);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent TEXT, to_agent TEXT, body TEXT,
    kind TEXT DEFAULT 'chat', ref_id TEXT,
    created_at TEXT, delivered_at TEXT, read_at TEXT);
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author TEXT, type TEXT DEFAULT 'note', text TEXT,
    task_id TEXT, commit_sha TEXT,
    status TEXT DEFAULT 'active', superseded_by INTEGER, created_at TEXT);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT 'open',
    assignee TEXT, created_by TEXT, commit_sha TEXT,
    created_at TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT, from_agent TEXT, to_agent TEXT, summary TEXT,
    branch TEXT, commit_sha TEXT, files_json TEXT, tests TEXT, next_steps TEXT,
    status TEXT DEFAULT 'pending', created_at TEXT);
  CREATE TABLE IF NOT EXISTS chat_reads (agent TEXT PRIMARY KEY, last_read_id INTEGER);
  CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages (delivered_at) WHERE delivered_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages (to_agent, read_at);
`;

function openDbFile(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec(SCHEMA);
  return d;
}

function repoDbFile(repoRoot) {
  return path.join(stateRoot(), 'repos', repoKey(repoRoot), 'chatter.db');
}

// Every per-repo DB currently on disk (for hooks and the board).
function listRepoDbFiles() {
  const dir = path.join(stateRoot(), 'repos');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((k) => path.join(dir, k, 'chatter.db'))
    .filter((f) => fs.existsSync(f));
}

// The calling context's repo DB (the default for all commands).
let _db = null;
function db() {
  if (_db) return _db;
  const g = gitInfo();
  if (!g.repoRoot) die('chatter is per-repo — run it inside a git repository');
  _db = openDbFile(repoDbFile(g.repoRoot));
  return _db;
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

module.exports = { gitInfo, stateRoot, repoKey, repoDbFile, openDbFile, listRepoDbFiles, db, now };
