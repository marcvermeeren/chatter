'use strict';
// Durable state: one SQLite DB in the Herdr plugin state dir, shared by all
// worktrees and panes of this user.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { PLUGIN_ID, HERDR } = require('./herdr');

function resolveStateDir() {
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

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 3000;
  CREATE TABLE IF NOT EXISTS agents (
    name TEXT PRIMARY KEY, pane_id TEXT, workspace_id TEXT, cwd TEXT,
    repo_root TEXT, branch TEXT, kind TEXT,
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
  CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages (delivered_at) WHERE delivered_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages (to_agent, read_at);
`;

let _db = null;
function db() {
  if (_db) return _db;
  const { DatabaseSync } = require('node:sqlite');
  const dir = resolveStateDir();
  fs.mkdirSync(dir, { recursive: true });
  _db = new DatabaseSync(path.join(dir, 'chatter.db'));
  _db.exec(SCHEMA);
  return _db;
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

module.exports = { resolveStateDir, db, now };
