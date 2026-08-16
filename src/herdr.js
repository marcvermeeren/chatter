'use strict';
// Talk to Herdr through its CLI (argv arrays only — never a shell).

const { spawnSync } = require('node:child_process');

const PLUGIN_ID = 'chatter';
const HERDR = process.env.HERDR_BIN_PATH || 'herdr';

function herdr(args) {
  const r = spawnSync(HERDR, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const raw = (r.stdout || '').trim() || (r.stderr || '').trim();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* non-JSON output */ }
  return { status: r.status, json, raw, ok: r.status === 0 };
}

// One `herdr agent list` per process is enough; invalidate after mutations
// that change the roster (agent rename).
let _live = null;
function sessionAgents({ fresh = false } = {}) {
  if (_live && !fresh) return _live;
  const r = herdr(['agent', 'list']);
  _live = r.ok && r.json ? (r.json.result.agents || []) : [];
  return _live;
}
const invalidateSessionAgents = () => { _live = null; };

// Live entry for a registered agent row. Pane id first — pane ids are never
// reused, while a freed name can be re-taken by an agent in another repo.
const matchLive = (live, a) =>
  live.find((x) => x.pane_id === a.pane_id) || live.find((x) => x.name === a.name);

// Manual pane name set via `herdr pane rename` (PaneInfo.label).
function paneLabel(paneId) {
  const r = herdr(['pane', 'get', paneId]);
  return (r.ok && r.json && r.json.result.pane && r.json.result.pane.label) || null;
}

module.exports = { PLUGIN_ID, HERDR, herdr, sessionAgents, invalidateSessionAgents, matchLive, paneLabel };
