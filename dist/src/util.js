'use strict';
// Small shared helpers: flag parsing, output mode, time math.
function die(msg) { console.error(msg); process.exit(1); }
// argv flags: defs with a boolean default are switches; others consume a value.
function parseFlags(args, defs) {
    const out = { _: [], ...defs };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            if (!(key in defs))
                die(`unknown flag ${a}`);
            if (typeof defs[key] === 'boolean') {
                out[key] = true;
                continue;
            }
            const val = args[++i];
            if (val === undefined || val.startsWith('--'))
                die(`flag --${key} requires a value`);
            out[key] = val;
        }
        else
            out._.push(a);
    }
    return out;
}
// Global output mode: --json prints raw rows instead of the human rendering.
let jsonOut = false;
const setJsonOut = (v) => { jsonOut = v; };
function emit(data, render) {
    if (jsonOut)
        console.log(JSON.stringify(data, null, 2));
    else
        render();
}
// Timestamps are stored as UTC 'YYYY-MM-DD HH:MM:SS' strings.
const toMs = (s) => new Date(s.replace(' ', 'T') + 'Z').getTime();
function median(nums) {
    if (!nums.length)
        return null;
    const a = [...nums].sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function fmtDur(ms) {
    if (ms == null)
        return '-';
    const s = Math.round(ms / 1000);
    if (s < 60)
        return `${s}s`;
    if (s < 3600)
        return `${Math.round(s / 60)}m`;
    return `${(s / 3600).toFixed(1)}h`;
}
const age = (ts) => fmtDur(Date.now() - toMs(ts));
module.exports = { die, parseFlags, setJsonOut, emit, toMs, median, fmtDur, age };
