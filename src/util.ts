'use strict';
// Small shared helpers: flag parsing, output mode, time math.

export function die(msg: string): never { console.error(msg); process.exit(1); }

type FlagDefault = boolean | string | null;
type ParsedFlagValue<T extends FlagDefault> = T extends boolean ? boolean : string | T;
export type ParsedFlags<Defs extends Record<string, FlagDefault>> = {
  [Key in keyof Defs]: ParsedFlagValue<Defs[Key]>;
} & { _: string[] };

// argv flags: defs with a boolean default are switches; others consume a value.
export function parseFlags<const Defs extends Record<string, FlagDefault>>(
  args: readonly string[],
  defs: Defs,
): ParsedFlags<Defs> {
  const out = { _: [], ...defs } as ParsedFlags<Defs>;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (!(key in defs)) die(`unknown flag ${a}`);
      if (typeof defs[key] === 'boolean') {
        (out as Record<string, unknown>)[key] = true;
        continue;
      }
      const val = args[++i];
      if (val === undefined || val.startsWith('--')) die(`flag --${key} requires a value`);
      (out as Record<string, unknown>)[key] = val;
    } else out._.push(a);
  }
  return out;
}

// Global output mode: --json prints raw rows instead of the human rendering.
let jsonOut = false;
export const setJsonOut = (v: boolean): void => { jsonOut = v; };
export function emit(data: unknown, render: () => void): void {
  if (jsonOut) console.log(JSON.stringify(data, null, 2));
  else render();
}

// Timestamps are stored as UTC 'YYYY-MM-DD HH:MM:SS' strings.
export const toMs = (s: string): number => new Date(s.replace(' ', 'T') + 'Z').getTime();

export function median(nums: readonly number[]): number | null {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  const right = a[mid];
  if (right === undefined) return null;
  if (a.length % 2) return right;
  const left = a[mid - 1];
  return left === undefined ? right : (left + right) / 2;
}

export function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

export const age = (ts: string): string => fmtDur(Date.now() - toMs(ts));
