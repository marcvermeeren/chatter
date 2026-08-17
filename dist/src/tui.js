'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.visWidth = exports.clean = exports.stripAnsi = exports.author = exports.field = exports.hint = exports.NEWMARK = exports.CYAN = exports.YELLOW = exports.GREEN = exports.FAINT = exports.CHROME = exports.bg = exports.fg = exports.INV = exports.BOLD = exports.RESET = void 0;
exports.logoLines = logoLines;
exports.authorHue = authorHue;
exports.wrap = wrap;
exports.makePainter = makePainter;
exports.decodeKey = decodeKey;
// Shared TUI primitives: flicker-free painting, a stable color system,
// word-aware wrapping, and raw-mode key decoding.
const ESC = '\x1b';
exports.RESET = `${ESC}[0m`;
exports.BOLD = `${ESC}[1m`;
exports.INV = `${ESC}[7m`;
const fg = (n) => `${ESC}[38;5;${n}m`;
exports.fg = fg;
const bg = (n) => `${ESC}[48;5;${n}m`;
exports.bg = bg;
// Chrome = separators, timestamps, hints. Chosen to read on dark themes.
exports.CHROME = (0, exports.fg)(245);
exports.FAINT = (0, exports.fg)(240);
exports.GREEN = (0, exports.fg)(114);
exports.YELLOW = (0, exports.fg)(179);
exports.CYAN = (0, exports.fg)(81);
exports.NEWMARK = (0, exports.fg)(203);
// "Delta Corps Priest 1" (figlet), rendered once and baked in. 88 cols.
const LOGO = [
    ' ▄████████    ▄█    █▄       ▄████████     ███         ███        ▄████████    ▄████████',
    '███    ███   ███    ███     ███    ███ ▀█████████▄ ▀█████████▄   ███    ███   ███    ███',
    '███    █▀    ███    ███     ███    ███    ▀███▀▀██    ▀███▀▀██   ███    █▀    ███    ███',
    '███         ▄███▄▄▄▄███▄▄   ███    ███     ███   ▀     ███   ▀  ▄███▄▄▄      ▄███▄▄▄▄██▀',
    '███        ▀▀███▀▀▀▀███▀  ▀███████████     ███         ███     ▀▀███▀▀▀     ▀▀███▀▀▀▀▀',
    '███    █▄    ███    ███     ███    ███     ███         ███       ███    █▄  ▀███████████',
    '███    ███   ███    ███     ███    ███     ███         ███       ███    ███   ███    ███',
    '████████▀    ███    █▀      ███    █▀     ▄████▀      ▄████▀     ██████████   ███    ███',
    '                                                                              ███    ███',
];
const LOGO_SHADES = [240, 242, 244, 246, 248, 250, 252, 254, 231];
// Block art when there's room, a plain wordmark when there isn't.
function logoLines(width) {
    if (width < 90)
        return [` ${exports.BOLD}CHATTER${exports.RESET}`, ''];
    return [...LOGO.map((l, i) => ` ${(0, exports.fg)(LOGO_SHADES[i] ?? 231)}${l}${exports.RESET}`),
        ` ${exports.FAINT}group chat for coding agents in Herdr worktrees${exports.RESET}`, ''];
}
// The one hint-row format: dim, ` · ` separated, three-space indent.
// Convention: the primary action first, then modifiers, exit/cancel last.
const hint = (...parts) => `   ${exports.FAINT}${parts.filter(Boolean).join(' · ')}${exports.RESET}`;
exports.hint = hint;
// An editable text field: prompt, value, block cursor. Same in every wizard.
const field = (v) => `${exports.BOLD} › ${exports.RESET}${v}${exports.INV} ${exports.RESET}`;
exports.field = field;
// Stable author colors: same name -> same hue, everywhere, forever.
const AUTHOR_HUES = [204, 214, 114, 81, 147, 179, 210, 117];
function authorHue(name) {
    let h = 0;
    for (const ch of String(name))
        h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
    return AUTHOR_HUES[h % AUTHOR_HUES.length] ?? 204;
}
const author = (name) => `${(0, exports.fg)(authorHue(name))}${exports.BOLD}${name}${exports.RESET}`;
exports.author = author;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
exports.stripAnsi = stripAnsi;
// Stored text is untrusted terminal-wise: strip control chars (ANSI/OSC
// included) before rendering so a message can't spoof UI or touch the
// terminal/clipboard. Same rules as delivery sanitization.
const clean = (s) => String(s).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
exports.clean = clean;
const visWidth = (s) => [...(0, exports.stripAnsi)(s)].length;
exports.visWidth = visWidth;
// Word-aware wrap; ANSI-free input expected (style is applied per line after).
function wrap(text, width) {
    const out = [];
    for (const raw of String(text).split('\n')) {
        let line = '';
        for (const word of raw.split(/\s+/).filter(Boolean)) {
            if (!line.length)
                line = word;
            else if ([...line].length + 1 + [...word].length <= width)
                line += ' ' + word;
            else {
                out.push(line);
                line = word;
            }
            while ([...line].length > width) {
                out.push([...line].slice(0, width).join(''));
                line = [...line].slice(width).join('');
            }
        }
        out.push(line);
    }
    return out.length ? out : [''];
}
// Flicker-free painter: repaint in place, skip identical frames.
function makePainter() {
    let last = null;
    process.stdout.write(`${ESC}[?25l`); // we draw our own cursor
    const show = () => { try {
        process.stdout.write(`${ESC}[?25h${exports.RESET}`);
    }
    catch { /* gone */ } };
    process.on('exit', show);
    for (const sig of ['SIGINT', 'SIGTERM'])
        process.on(sig, () => process.exit(0));
    return (lines) => {
        const frame = lines.join('\n');
        if (frame === last)
            return;
        last = frame;
        process.stdout.write(`${ESC}[H` + lines.map((l) => l + `${ESC}[K`).join('\n') + `${ESC}[J`);
    };
}
// Decode one raw stdin chunk into a logical key.
const KEYS = {
    '\x1b': 'esc', '\x03': 'close', '\r': 'enter', '\n': 'enter', '\t': 'tab',
    '\x7f': 'backspace', '\b': 'backspace',
    '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
    '\x1b[5~': 'pgup', '\x1b[6~': 'pgdn',
    '\x1b[F': 'end', '\x1b[4~': 'end', '\x1bOF': 'end', '\x1b[H': 'home', '\x1b[1~': 'home', '\x1bOH': 'home',
};
const isKeySequence = (value) => Object.hasOwn(KEYS, value);
function decodeKey(s) {
    if (isKeySequence(s))
        return { type: KEYS[s] };
    if (s.startsWith('\x1b'))
        return { type: 'other' }; // unknown escape sequence
    const text = s.replace(/[\x00-\x1f\x7f]/g, '');
    return text ? { type: 'text', text } : { type: 'other' };
}
