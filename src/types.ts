import type { SQLInputValue, StatementResultingChanges } from 'node:sqlite';

export interface Identity {
  name: string;
  paneId?: string | null;
  human: boolean;
  status?: string | null;
}

export interface LiveAgent {
  name: string;
  pane_id: string;
  workspace_id?: string;
  cwd?: string;
  branch?: string | null;
  kind?: string;
  agent?: string;
  agent_status?: string;
  status?: string;
}

export interface AgentRow {
  name: string;
  pane_id: string | null;
  workspace_id: string | null;
  cwd: string | null;
  repo_root: string | null;
  branch: string | null;
  kind: string | null;
  role: string | null;
  registered_at: string | null;
  last_seen_at: string | null;
  departed_at: string | null;
}

export interface MessageRow {
  id: number;
  from_agent: string;
  to_agent: string;
  body: string;
  kind: string;
  ref_id: string | null;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
}

export interface NoteRow {
  id: number;
  author: string;
  type: string;
  text: string;
  task_id: string | null;
  commit_sha: string | null;
  status: string;
  superseded_by: number | null;
  created_at: string;
}

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  created_by: string;
  commit_sha: string | null;
  created_at: string;
  updated_at: string;
}

export interface HandoffRow {
  id: number;
  task_id: string | null;
  from_agent: string;
  to_agent: string;
  summary: string;
  branch: string | null;
  commit_sha: string | null;
  files_json: string | null;
  tests: string | null;
  next_steps: string | null;
  status: string;
  created_at: string;
}

export interface EventRow {
  id: number;
  at: string;
  actor: string;
  kind: string;
  ref: string | null;
  data: string | null;
}

export interface CountRow { n: number }
export interface FileRow { file: string }
export interface NameRow { name: string }
export interface PaneRow { pane_id: string | null }
export interface LastReadRow { last_read_id: number }
export interface ValueRow { value: string }
export interface TimeRow { t: string | null }

interface TypedStatement<Row extends object> {
  all(...params: SQLInputValue[]): Row[];
  get(...params: SQLInputValue[]): Row | undefined;
  run(...params: SQLInputValue[]): StatementResultingChanges;
}

export interface ChatterDb {
  exec(sql: string): void;
  prepare<Row extends object = Record<string, never>>(sql: string): TypedStatement<Row>;
}

export interface GitInfo {
  cwd: string;
  branch: string | null;
  toplevel: string | null;
  repoRoot: string | null;
}

export type ProgressCallback = (line: string) => void;

export interface HerdrResult {
  status: number | null;
  json: unknown;
  raw: string;
  ok: boolean;
}

export interface PluginSource {
  kind?: string;
  owner?: string;
  repo?: string;
  subdir?: string;
  requested_ref?: string;
  resolved_commit?: string;
}

export interface PluginRegistration {
  plugin_id: string;
  plugin_root: string;
  version?: string;
  source: PluginSource;
}

export type UpdateState =
  | { state: 'current' | 'behind'; reason?: never }
  | { state: 'unknown'; reason: string };

export interface UpdateResult { ok: boolean; lines: string[] }

export type TuiKey =
  | { type: 'esc' | 'close' | 'enter' | 'tab' | 'backspace' | 'up' | 'down' | 'left' | 'right' | 'pgup' | 'pgdn' | 'end' | 'home' | 'other' }
  | { type: 'text'; text: string };
