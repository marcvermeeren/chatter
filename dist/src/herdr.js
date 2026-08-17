'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchLive = exports.invalidateSessionAgents = exports.HERDR = exports.PLUGIN_ID = void 0;
exports.herdr = herdr;
exports.isRecord = isRecord;
exports.sessionAgents = sessionAgents;
exports.paneLabel = paneLabel;
// Talk to Herdr through its CLI (argv arrays only — never a shell).
const node_child_process_1 = require("node:child_process");
exports.PLUGIN_ID = 'chatter';
exports.HERDR = process.env.HERDR_BIN_PATH || 'herdr';
function herdr(args) {
    const r = (0, node_child_process_1.spawnSync)(exports.HERDR, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const raw = (r.stdout || '').trim() || (r.stderr || '').trim();
    let json = null;
    try {
        json = JSON.parse(raw);
    }
    catch { /* non-JSON output */ }
    return { status: r.status, json, raw, ok: r.status === 0 };
}
// One `herdr agent list` per process is enough; invalidate after mutations
// that change the roster (agent rename).
let _live = null;
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function agentList(value) {
    if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.agents))
        return [];
    return value.result.agents.filter((agent) => isRecord(agent) && typeof agent.name === 'string' && typeof agent.pane_id === 'string');
}
function sessionAgents({ fresh = false } = {}) {
    if (_live && !fresh)
        return _live;
    const r = herdr(['agent', 'list']);
    _live = r.ok ? agentList(r.json) : [];
    return _live;
}
const invalidateSessionAgents = () => { _live = null; };
exports.invalidateSessionAgents = invalidateSessionAgents;
// Live entry for a registered agent row. Pane id first — pane ids are never
// reused, while a freed name can be re-taken by an agent in another repo.
const matchLive = (live, a) => live.find((x) => x.pane_id === a.pane_id) || live.find((x) => x.name === a.name);
exports.matchLive = matchLive;
// Manual pane name set via `herdr pane rename` (PaneInfo.label).
function paneLabel(paneId) {
    const r = herdr(['pane', 'get', paneId]);
    if (!r.ok || !isRecord(r.json) || !isRecord(r.json.result) || !isRecord(r.json.result.pane))
        return null;
    return typeof r.json.result.pane.label === 'string' ? r.json.result.pane.label : null;
}
