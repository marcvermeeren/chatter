#!/usr/bin/env node
'use strict';

// Execute one stateful workflow against the synchronized JavaScript baseline
// and compiled TypeScript, then compare the contracts users can observe.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const tempRoot = required('DIFF_ROOT');
const repo = required('DIFF_REPO');
const fakeHerdr = path.join(root, 'test', 'fake-herdr');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizeString(value, implementationRoot) {
  return value
    .split(implementationRoot).join('<IMPLEMENTATION>')
    .split(tempRoot).join('<TMP>')
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{3}Z)?/g, '<timestamp>');
}

function normalize(value, implementationRoot) {
  if (typeof value === 'string') return normalizeString(value, implementationRoot);
  if (Array.isArray(value)) return value.map((item) => normalize(item, implementationRoot));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, implementationRoot)]));
  }
  return value;
}

function databaseFile(stateDir) {
  const repos = path.join(stateDir, 'repos');
  const universe = fs.readdirSync(repos).find((name) => fs.existsSync(path.join(repos, name, 'chatter.db')));
  if (!universe) throw new Error(`no differential database below ${repos}`);
  return path.join(repos, universe, 'chatter.db');
}

function dumpDatabase(file, implementationRoot) {
  const db = new DatabaseSync(file);
  const tables = {
    agents: 'name', messages: 'id', notes: 'id', tasks: 'id', handoffs: 'id',
    chat_reads: 'agent', events: 'id', ui_marks: 'agent, mark',
  };
  const dump = {};
  for (const [table, order] of Object.entries(tables)) {
    dump[table] = {
      columns: db.prepare(`PRAGMA table_info(${table})`).all(),
      rows: db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all(),
    };
  }
  db.close();
  return normalize(dump, implementationRoot);
}

function runImplementation(label, entry) {
  const implementationRoot = path.resolve(entry, '..', '..');
  const stateDir = path.join(tempRoot, `${label}-state`);
  const configDir = path.join(tempRoot, `${label}-config`);
  const callsFile = path.join(tempRoot, `${label}-herdr.calls`);
  const rosterFile = path.join(tempRoot, `${label}-roster.json`);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(callsFile, '');
  fs.writeFileSync(rosterFile, JSON.stringify({ result: { agents: [{
    name: 'alpha', pane_id: 'w1:p1', workspace_id: 'w1', cwd: repo,
    branch: 'main', agent: 'pi', agent_status: 'idle',
  }] } }));

  const env = {
    ...process.env,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
    HERDR_BIN_PATH: fakeHerdr,
    FAKE_CALLS: callsFile,
    FAKE_ROSTER: rosterFile,
    FAKE_REDACT_PROMPTS: '1',
  };
  const observations = [];
  const invoke = (args, json = args.includes('--json') || (args[0] === 'handoff' && args[1] === 'show')) => {
    const result = spawnSync(process.execPath,
      ['--no-warnings', '--experimental-sqlite', entry, ...args],
      { cwd: repo, env, encoding: 'utf8' });
    let stdout = result.stdout;
    if (json && result.status === 0) {
      try { stdout = JSON.parse(stdout); }
      catch (error) { throw new Error(`${label}: ${args.join(' ')} did not emit JSON: ${error.message}\n${stdout}`); }
    }
    observations.push(normalize({ args, status: result.status, stdout, stderr: result.stderr }, implementationRoot));
    return result;
  };

  invoke(['iam', 'tester']);
  invoke(['whoami']);
  invoke(['note', 'shared discovery', '--type', 'discovery']);
  invoke(['notes', 'shared', '--json']);
  invoke(['search', 'shared', '--json']);
  invoke(['ask', 'alpha', 'Can you verify this?']);
  invoke(['questions', '--json']);
  invoke(['answer', '2', 'Verified']);
  invoke(['send', 'alpha', 'direct hello']);
  invoke(['send', 'ghost', 'queued --flag-like body', '--queue']);
  invoke(['post', 'group hello @alpha']);
  invoke(['chat', '--all', '--json']);
  invoke(['task', 'create', 'migration task']);
  invoke(['task', 'assign', 'TASK-1', 'alpha']);
  invoke(['handoff', 'TASK-1', 'alpha', '--summary', 'continue migration', '--branch', 'main',
    '--commit', 'abcdef123456', '--files', 'src/a.js,src/b.js', '--tests', 'sh test/smoke.sh', '--next', 'finish']);
  invoke(['handoff', 'show', '1']);
  invoke(['log', '--task', 'TASK-1', '--json']);
  invoke(['log', '--limit', '1', '--json']);
  invoke(['log', '--all', '--json']);
  invoke(['task', 'done', 'TASK-1', '--commit', 'fedcba987654']);
  invoke(['task', 'list', '--json']);
  invoke(['resolve', '1']);
  invoke(['notes', '--all', '--json']);
  // The two implementations execute sequentially. Pin time-bearing rows
  // before comparing derived duration metrics so a wall-clock second boundary
  // cannot turn a parity check into a flaky test.
  const stableDb = new DatabaseSync(databaseFile(stateDir));
  stableDb.exec(`
    UPDATE messages SET created_at='2026-01-01 00:00:00',
      delivered_at=CASE WHEN delivered_at IS NULL THEN NULL ELSE '2026-01-01 00:00:00' END,
      read_at=CASE WHEN read_at IS NULL THEN NULL ELSE '2026-01-01 00:00:00' END;
    UPDATE notes SET created_at='2026-01-01 00:00:00';
    UPDATE tasks SET created_at='2026-01-01 00:00:00', updated_at='2026-01-01 00:00:00';
    UPDATE handoffs SET created_at='2026-01-01 00:00:00';
    UPDATE events SET at='2026-01-01 00:00:00';
  `);
  stableDb.close();
  invoke(['stats', '--json']);
  invoke(['brief', '2h', '--json']);
  invoke(['_flush']);

  const dbFile = databaseFile(stateDir);
  const db = new DatabaseSync(dbFile);
  db.prepare(`INSERT INTO messages (from_agent,to_agent,body,kind,created_at)
    VALUES ('sender','tester','incoming contract','chat','2026-01-01 00:00:00')`).run();
  db.close();
  invoke(['inbox', '--json']);
  invoke(['inbox', '--all', '--json']);

  return {
    observations,
    herdrCalls: normalizeString(fs.readFileSync(callsFile, 'utf8'), implementationRoot),
    database: dumpDatabase(dbFile, implementationRoot),
  };
}

const legacy = runImplementation('legacy', required('LEGACY_ENTRY'));
const current = runImplementation('current', required('CURRENT_ENTRY'));
try {
  assert.deepEqual(current, legacy);
} catch (error) {
  fs.writeFileSync(path.join(tempRoot, 'legacy-observations.json'), JSON.stringify(legacy, null, 2));
  fs.writeFileSync(path.join(tempRoot, 'current-observations.json'), JSON.stringify(current, null, 2));
  throw error;
}

// Upgrade contract: the compiled implementation must read and mutate the very
// same database file created by the synchronized legacy implementation.
function verifyLegacyDatabaseUpgrade() {
  const stateDir = path.join(tempRoot, 'upgrade-state');
  const configDir = path.join(tempRoot, 'upgrade-config');
  const callsFile = path.join(tempRoot, 'upgrade-herdr.calls');
  const rosterFile = path.join(tempRoot, 'upgrade-roster.json');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(callsFile, '');
  fs.writeFileSync(rosterFile, '{"result":{"agents":[]}}');
  const env = { ...process.env, HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_PLUGIN_CONFIG_DIR: configDir,
    HERDR_BIN_PATH: fakeHerdr, FAKE_CALLS: callsFile, FAKE_ROSTER: rosterFile };
  const invoke = (entry, args) => spawnSync(process.execPath,
    ['--no-warnings', '--experimental-sqlite', entry, ...args], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(invoke(required('LEGACY_ENTRY'), ['iam', 'upgrade-user']).status, 0);
  assert.equal(invoke(required('LEGACY_ENTRY'), ['note', 'created by legacy']).status, 0);
  const read = invoke(required('CURRENT_ENTRY'), ['notes', '--all', '--json']);
  assert.equal(read.status, 0);
  assert.deepEqual(JSON.parse(read.stdout).map((row) => row.text), ['created by legacy']);
  assert.equal(invoke(required('CURRENT_ENTRY'), ['note', 'created by TypeScript']).status, 0);
  const reread = invoke(required('LEGACY_ENTRY'), ['notes', '--all', '--json']);
  assert.equal(reread.status, 0);
  assert.deepEqual(JSON.parse(reread.stdout).map((row) => row.text), ['created by TypeScript', 'created by legacy']);
}
verifyLegacyDatabaseUpgrade();

console.log(`legacy and compiled behavior match: ${current.observations.length} commands, exact JSON/human output, exit codes, Herdr targets, SQLite contents, and shared legacy DB upgrade`);
