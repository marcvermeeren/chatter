'use strict';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.dbFile = exports.now = void 0;
exports.gitInfo = gitInfo;
exports.configRoot = configRoot;
exports.humanName = humanName;
exports.stateRoot = stateRoot;
exports.openDbFile = openDbFile;
exports.repoDbFile = repoDbFile;
exports.listRepoDbFiles = listRepoDbFiles;
exports.db = db;
exports.logEvent = logEvent;
// Durable state, scoped PER REPOSITORY: each repo gets its own SQLite DB under
// the plugin state dir. Worktrees of one repo share a DB (keyed by the git
// common dir); unrelated repos are isolated universes.
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_child_process_1 = require("node:child_process");
const node_sqlite_1 = require("node:sqlite");
const herdr_1 = require("./herdr");
const util_1 = require("./util");
// One git spawn: branch, worktree toplevel, and the shared common dir that
// identifies the repo across all of its linked worktrees.
let _git;
function gitInfo(cwd = process.cwd()) {
    if (_git && _git.cwd === cwd)
        return _git;
    const r = (0, node_child_process_1.spawnSync)('git', ['-C', cwd, 'rev-parse',
        '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { encoding: 'utf8' });
    if (r.status !== 0)
        return (_git = { cwd, branch: null, toplevel: null, repoRoot: null });
    const [toplevel, commonDir] = r.stdout.trim().split('\n');
    if (!commonDir)
        return (_git = { cwd, branch: null, toplevel: toplevel || null, repoRoot: null });
    let repoRoot = commonDir;
    try {
        repoRoot = node_fs_1.default.realpathSync(commonDir);
    }
    catch { /* keep as reported */ }
    if (node_path_1.default.basename(repoRoot) === '.git')
        repoRoot = node_path_1.default.dirname(repoRoot);
    // Separate call: --abbrev-ref HEAD errors in a repo with no commits yet.
    const b = (0, node_child_process_1.spawnSync)('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' });
    const branch = b.status === 0 ? b.stdout.trim() : '';
    return (_git = { cwd, branch: branch || null, toplevel: toplevel || null, repoRoot });
}
// User-editable plugin config (e.g. the human's chat name).
function configRoot() {
    return process.env.HERDR_PLUGIN_CONFIG_DIR
        || node_path_1.default.join(node_os_1.default.homedir(), '.config', 'herdr', 'plugins', 'config', herdr_1.PLUGIN_ID);
}
// The human's name in chatter (set with `chatter iam <name>`).
function humanName() {
    try {
        const n = node_fs_1.default.readFileSync(node_path_1.default.join(configRoot(), 'name'), 'utf8').trim();
        if (n)
            return n;
    }
    catch { /* not set */ }
    return 'user';
}
// Canonicalize so path comparisons (repo-boundary checks) never break on
// symlinks — SQLite reports resolved paths, e.g. /private/var vs /var on macOS.
const real = (p) => { try {
    return node_fs_1.default.realpathSync(p);
}
catch {
    return p;
} };
function stateRoot() {
    if (process.env.HERDR_PLUGIN_STATE_DIR)
        return real(process.env.HERDR_PLUGIN_STATE_DIR);
    // Herdr's layout on Unix (verified 0.8.0): ~/.local/state/herdr/plugins/<id>
    const conventional = node_path_1.default.join(node_os_1.default.homedir(), '.local', 'state', 'herdr', 'plugins', herdr_1.PLUGIN_ID);
    if (node_fs_1.default.existsSync(conventional))
        return real(conventional);
    // Fall back to the pointer the startup hook writes into the config dir.
    const cfg = (0, node_child_process_1.spawnSync)(herdr_1.HERDR, ['plugin', 'config-dir', herdr_1.PLUGIN_ID], { encoding: 'utf8' });
    const cfgDir = (cfg.stdout || '').trim();
    if (cfgDir) {
        const pointer = node_path_1.default.join(cfgDir, 'state-dir');
        if (node_fs_1.default.existsSync(pointer)) {
            const p = node_fs_1.default.readFileSync(pointer, 'utf8').trim();
            if (p && node_fs_1.default.existsSync(p))
                return real(p);
        }
    }
    const fallback = node_path_1.default.join(node_os_1.default.homedir(), '.local', 'state', 'herdr-chatter');
    node_fs_1.default.mkdirSync(fallback, { recursive: true });
    return real(fallback);
}
const sanitizeKey = (s) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40) || 'repo';
function repoKey(repoRoot) {
    const hash = node_crypto_1.default.createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
    return `${sanitizeKey(node_path_1.default.basename(repoRoot))}-${hash}`;
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
function openDbFile(file) {
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
    const d = new node_sqlite_1.DatabaseSync(file);
    d.exec(SCHEMA);
    // Migration for pre-v0.16 universes.
    try {
        d.exec('ALTER TABLE agents ADD COLUMN departed_at TEXT');
    }
    catch { /* exists */ }
    // All result-shape assertions stay behind this boundary. Callers must supply
    // an explicit row type whenever they read from a statement.
    return d;
}
function repoDbFile(repoRoot) {
    return node_path_1.default.join(stateRoot(), 'repos', repoKey(repoRoot), 'chatter.db');
}
// Every per-repo DB currently on disk (for hooks and the board).
function listRepoDbFiles() {
    const dir = node_path_1.default.join(stateRoot(), 'repos');
    if (!node_fs_1.default.existsSync(dir))
        return [];
    return node_fs_1.default.readdirSync(dir)
        .map((k) => node_path_1.default.join(dir, k, 'chatter.db'))
        .filter((f) => node_fs_1.default.existsSync(f));
}
// The calling context's repo DB (the default for all commands).
let _db = null;
function db() {
    if (_db)
        return _db;
    const g = gitInfo();
    if (!g.repoRoot)
        (0, util_1.die)('chatter is per-repo — run it inside a git repository');
    _db = openDbFile(repoDbFile(g.repoRoot));
    // Record which repo this universe belongs to (orphan detection in
    // `chatter data` — agent rows alone miss human-only universes).
    _db.prepare(`INSERT INTO ui_marks (agent, mark, value) VALUES ('_repo', 'root', ?)
    ON CONFLICT(agent, mark) DO UPDATE SET value = excluded.value`).run(g.repoRoot);
    return _db;
}
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
exports.now = now;
// Which on-disk file a handle is operating on (repo-boundary checks).
const dbFile = (d) => {
    const row = d.prepare("SELECT file FROM pragma_database_list WHERE name='main'").get();
    if (!row)
        throw new Error('SQLite main database is unavailable');
    return row.file;
};
exports.dbFile = dbFile;
// Append-only activity ledger. Silent for now; future briefs/reports read it.
function logEvent(actor, kind, ref, data = null, d = db()) {
    try {
        d.prepare('INSERT INTO events (at, actor, kind, ref, data) VALUES (?,?,?,?,?)')
            .run((0, exports.now)(), actor, kind, ref, data ? JSON.stringify(data).slice(0, 1024) : null);
    }
    catch { /* the ledger must never break a command */ }
}
