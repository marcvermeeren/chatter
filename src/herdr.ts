'use strict';
// Talk to Herdr through its CLI (argv arrays only — never a shell).

import { spawnSync } from 'node:child_process';
import type { AgentRow, HerdrResult, LiveAgent } from './types';

export const PLUGIN_ID = 'chatter';
export const HERDR = process.env.HERDR_BIN_PATH || 'herdr';

export function herdr(args: readonly string[]): HerdrResult {
  const r = spawnSync(HERDR, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const raw = (r.stdout || '').trim() || (r.stderr || '').trim();
  let json: unknown = null;
  try { json = JSON.parse(raw); } catch { /* non-JSON output */ }
  return { status: r.status, json, raw, ok: r.status === 0 };
}

// One `herdr agent list` per process is enough; invalidate after mutations
// that change the roster (agent rename).
let _live: LiveAgent[] | null = null;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function agentList(value: unknown): LiveAgent[] {
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.agents)) return [];
  return value.result.agents.filter((agent): agent is LiveAgent =>
    isRecord(agent) && typeof agent.name === 'string' && typeof agent.pane_id === 'string');
}

export function sessionAgents({ fresh = false }: { fresh?: boolean } = {}): LiveAgent[] {
  if (_live && !fresh) return _live;
  const r = herdr(['agent', 'list']);
  _live = r.ok ? agentList(r.json) : [];
  return _live;
}
export const invalidateSessionAgents = (): void => { _live = null; };

// Live entry for a registered agent row. Pane id first — pane ids are never
// reused, while a freed name can be re-taken by an agent in another repo.
export const matchLive = (live: readonly LiveAgent[], a: Pick<AgentRow, 'name' | 'pane_id'>): LiveAgent | undefined =>
  live.find((x) => x.pane_id === a.pane_id) || live.find((x) => x.name === a.name);

// Manual pane name set via `herdr pane rename` (PaneInfo.label).
export function paneLabel(paneId: string): string | null {
  const r = herdr(['pane', 'get', paneId]);
  if (!r.ok || !isRecord(r.json) || !isRecord(r.json.result) || !isRecord(r.json.result.pane)) return null;
  return typeof r.json.result.pane.label === 'string' ? r.json.result.pane.label : null;
}
