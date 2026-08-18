"use strict";
// Small shared helpers: flag parsing, output mode, time math.
Object.defineProperty(exports, "__esModule", { value: true });
exports.age = exports.toMs = exports.setJsonOut = void 0;
exports.die = die;
exports.parseFlags = parseFlags;
exports.emit = emit;
exports.median = median;
exports.fmtDur = fmtDur;
function die(msg) { console.error(msg); process.exit(1); }
// argv flags: defs with a boolean default are switches; others consume a value.
function parseFlags(args, defs) {
    // SAFETY: every definition key starts with its declared default, `_` is
    // always a string array, and the parser only writes the matching flag kind.
    const out = { _: [], ...defs };
    // SAFETY: writes are limited to definition keys checked below; boolean
    // defaults receive booleans and every other default receives a string.
    const writable = out;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === undefined)
            continue;
        if (a.startsWith('--')) {
            const key = a.slice(2);
            if (!(key in defs))
                die(`unknown flag ${a}`);
            if (typeof defs[key] === 'boolean') {
                writable[key] = true;
                continue;
            }
            const val = args[++i];
            if (val === undefined || val.startsWith('--'))
                die(`flag --${key} requires a value`);
            writable[key] = val;
        }
        else
            out._.push(a);
    }
    return out;
}
// Global output mode: --json prints raw rows instead of the human rendering.
let jsonOut = false;
const setJsonOut = (v) => { jsonOut = v; };
exports.setJsonOut = setJsonOut;
function emit(data, render) {
    if (jsonOut)
        console.log(JSON.stringify(data, null, 2));
    else
        render();
}
// Timestamps are stored as UTC 'YYYY-MM-DD HH:MM:SS' strings.
const toMs = (s) => new Date(s.replace(' ', 'T') + 'Z').getTime();
exports.toMs = toMs;
function median(nums) {
    if (!nums.length)
        return null;
    const a = [...nums].sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    const right = a[mid];
    if (right === undefined)
        return null;
    if (a.length % 2)
        return right;
    const left = a[mid - 1];
    return left === undefined ? right : (left + right) / 2;
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
const age = (ts) => fmtDur(Date.now() - (0, exports.toMs)(ts));
exports.age = age;
