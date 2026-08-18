// Durable state, scoped PER REPOSITORY: each repo gets its own SQLite DB under
// the plugin state dir. Worktrees of one repo share a DB (keyed by the git
// common dir); unrelated repos are isolated universes.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { PLUGIN_ID, HERDR } from './herdr';
import { die } from './util';
import type { ChatterDb, FileRow, GitInfo, ValueRow } from './types';

// One git spawn: branch, worktree toplevel, and the shared common dir that
// identifies the repo across all of its linked worktrees.
let _git: GitInfo | undefined;
export function gitInfo(cwd = process.cwd()): GitInfo {
  if (_git && _git.cwd === cwd) return _git;
  const r = spawnSync('git', ['-C', cwd, 'rev-parse',
    '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { encoding: 'utf8' });
  if (r.status !== 0) return (_git = { cwd, branch: null, toplevel: null, repoRoot: null });
  const [toplevel, commonDir] = r.stdout.trim().split('\n');
  if (!commonDir) return (_git = { cwd, branch: null, toplevel: toplevel || null, repoRoot: null });
  let repoRoot = commonDir;
  try { repoRoot = fs.realpathSync(commonDir); } catch { /* keep as reported */ }
  if (path.basename(repoRoot) === '.git') repoRoot = path.dirname(repoRoot);
  // Separate call: --abbrev-ref HEAD errors in a repo with no commits yet.
  const b = spawnSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' });
  const branch = b.status === 0 ? b.stdout.trim() : '';
  return (_git = { cwd, branch: branch || null, toplevel: toplevel || null, repoRoot });
}

// User-editable plugin config (e.g. the human's chat name).
export function configRoot(): string {
  return process.env.HERDR_PLUGIN_CONFIG_DIR
    || path.join(os.homedir(), '.config', 'herdr', 'plugins', 'config', PLUGIN_ID);
}

// The human's name in chatter (set with `chatter iam <name>`).
export function humanName(): string {
  try {
    const n = fs.readFileSync(path.join(configRoot(), 'name'), 'utf8').trim();
    if (n) return n;
  } catch { /* not set */ }
  return 'user';
}

// Canonicalize so path comparisons (repo-boundary checks) never break on
// symlinks — SQLite reports resolved paths, e.g. /private/var vs /var on macOS.
const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };

export function stateRoot(): string {
  if (process.env.HERDR_PLUGIN_STATE_DIR) return real(process.env.HERDR_PLUGIN_STATE_DIR);
  // Herdr's layout on Unix (verified 0.8.0): ~/.local/state/herdr/plugins/<id>
  const conventional = path.join(os.homedir(), '.local', 'state', 'herdr', 'plugins', PLUGIN_ID);
  if (fs.existsSync(conventional)) return real(conventional);
  // Fall back to the pointer the startup hook writes into the config dir.
  const cfg = spawnSync(HERDR, ['plugin', 'config-dir', PLUGIN_ID], { encoding: 'utf8' });
  const cfgDir = (cfg.stdout || '').trim();
  if (cfgDir) {
    const pointer = path.join(cfgDir, 'state-dir');
    if (fs.existsSync(pointer)) {
      const p = fs.readFileSync(pointer, 'utf8').trim();
      if (p && fs.existsSync(p)) return real(p);
    }
  }
  const fallback = path.join(os.homedir(), '.local', 'state', 'herdr-chatter');
  fs.mkdirSync(fallback, { recursive: true });
  return real(fallback);
}

const sanitizeKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40) || 'repo';
function repoKey(repoRoot: string): string {
  const hash = crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
  return `${sanitizeKey(path.basename(repoRoot))}-${hash}`;
}

const SCHEMA = `
  PRAGMA busy_timeout = 3000;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS agents (
    name TEXT PRIMARY KEY, pane_id TEXT, workspace_id TEXT, cwd TEXT,
    repo_root TEXT, branch TEXT, kind TEXT, role TEXT,
    registered_at TEXT, last_seen_at TEXT, departed_at TEXT);
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
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT, actor TEXT, kind TEXT, ref TEXT, data TEXT);
  CREATE TABLE IF NOT EXISTS ui_marks (agent TEXT, mark TEXT, value TEXT, PRIMARY KEY (agent, mark));
  CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages (delivered_at) WHERE delivered_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages (to_agent, read_at);
`;

export function openDbFile(file: string): ChatterDb {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec(SCHEMA);
  // Migration for pre-v0.16 universes.
  try { d.exec('ALTER TABLE agents ADD COLUMN departed_at TEXT'); } catch { /* exists */ }
  // Node 22.5's first node:sqlite release returns an object whose every value
  // is null for a missing `get()` row; newer Node releases return undefined.
  // Normalize that runtime difference at the typed boundary so application
  // code has one contract across every supported Node version.
  return {
    exec: (sql) => d.exec(sql),
    prepare: <Row extends object = Record<string, never>>(sql: string) => {
      const statement = d.prepare(sql);
      const all = (...params: SQLInputValue[]): Row[] => {
        // SAFETY: node:sqlite cannot infer a row from SQL text. The query owner
        // supplies Row, and SQLite returns one plain object for each result row.
        return statement.all(...params) as Row[];
      };
      return {
        all,
        // `all()[0]` avoids Node 22.5's null-filled phantom `get()` row while
        // preserving legitimate rows (including aggregate rows containing null).
        get: (...params: SQLInputValue[]) => all(...params)[0],
        run: (...params: SQLInputValue[]) => statement.run(...params),
      };
    },
  };
}

export function repoDbFile(repoRoot: string): string {
  return path.join(stateRoot(), 'repos', repoKey(repoRoot), 'chatter.db');
}

const recordRepoRoot = (d: ChatterDb, repoRoot: string): void => {
  d.prepare(`INSERT INTO ui_marks (agent, mark, value) VALUES ('_repo', 'root', ?)
    ON CONFLICT(agent, mark) DO UPDATE SET value = excluded.value`).run(repoRoot);
};

// Open a repository universe and retain its human-readable source path. Agent
// rows alone cannot identify repositories that have only human activity.
export function openRepoDb(repoRoot: string): ChatterDb {
  const d = openDbFile(repoDbFile(repoRoot));
  recordRepoRoot(d, repoRoot);
  return d;
}

// Databases created before the repo mark existed can still be identified from
// their most recently seen agent. Keep that compatibility fallback in one place.
export function storedRepoRoot(d: ChatterDb): string | null {
  const mark = d.prepare<ValueRow>(
    "SELECT value FROM ui_marks WHERE agent = '_repo' AND mark = 'root'",
  ).get();
  if (mark?.value) return mark.value;
  return d.prepare<{ repo_root: string }>(
    'SELECT repo_root FROM agents WHERE repo_root IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1',
  ).get()?.repo_root ?? null;
}

// Every per-repo DB currently on disk (for hooks and the board).
export function listRepoDbFiles(): string[] {
  const dir = path.join(stateRoot(), 'repos');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((k) => path.join(dir, k, 'chatter.db'))
    .filter((f) => fs.existsSync(f));
}

// The calling context's repo DB (the default for all commands).
let _db: ChatterDb | null = null;
export function db(): ChatterDb {
  if (_db) return _db;
  const g = gitInfo();
  if (!g.repoRoot) die('chatter is per-repo — run it inside a git repository');
  _db = openRepoDb(g.repoRoot);
  return _db;
}

export const now = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);

// Which on-disk file a handle is operating on (repo-boundary checks).
export const dbFile = (d: ChatterDb): string => {
  const row = d.prepare<FileRow>("SELECT file FROM pragma_database_list WHERE name='main'").get();
  if (!row) throw new Error('SQLite main database is unavailable');
  return row.file;
};

// Append-only activity ledger. Silent for now; future briefs/reports read it.
export function logEvent(
  actor: string,
  kind: string,
  ref: string | number | null,
  data: unknown = null,
  d: ChatterDb = db(),
): void {
  try {
    d.prepare('INSERT INTO events (at, actor, kind, ref, data) VALUES (?,?,?,?,?)')
      .run(now(), actor, kind, ref, data ? JSON.stringify(data).slice(0, 1024) : null);
  } catch { /* the ledger must never break a command */ }
}
