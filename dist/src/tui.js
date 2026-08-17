'use strict';
// Shared TUI primitives: flicker-free painting, a stable color system,
// word-aware wrapping, and raw-mode key decoding.
const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const INV = `${ESC}[7m`;
const fg = (n) => `${ESC}[38;5;${n}m`;
const bg = (n) => `${ESC}[48;5;${n}m`;
// Chrome = separators, timestamps, hints. Chosen to read on dark themes.
const CHROME = fg(245);
const FAINT = fg(240);
const GREEN = fg(114);
const YELLOW = fg(179);
const CYAN = fg(81);
const NEWMARK = fg(203);
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
        return [` ${BOLD}CHATTER${RESET}`, ''];
    return [...LOGO.map((l, i) => ` ${fg(LOGO_SHADES[i])}${l}${RESET}`),
        ` ${FAINT}group chat for coding agents in Herdr worktrees${RESET}`, ''];
}
// The one hint-row format: dim, ` · ` separated, three-space indent.
// Convention: the primary action first, then modifiers, exit/cancel last.
const hint = (...parts) => `   ${FAINT}${parts.filter(Boolean).join(' · ')}${RESET}`;
// An editable text field: prompt, value, block cursor. Same in every wizard.
const field = (v) => `${BOLD} › ${RESET}${v}${INV} ${RESET}`;
// Stable author colors: same name -> same hue, everywhere, forever.
const AUTHOR_HUES = [204, 214, 114, 81, 147, 179, 210, 117];
function authorHue(name) {
    let h = 0;
    for (const ch of String(name))
        h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return AUTHOR_HUES[h % AUTHOR_HUES.length];
}
const author = (name) => `${fg(authorHue(name))}${BOLD}${name}${RESET}`;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
// Stored text is untrusted terminal-wise: strip control chars (ANSI/OSC
// included) before rendering so a message can't spoof UI or touch the
// terminal/clipboard. Same rules as delivery sanitization.
const clean = (s) => String(s).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const visWidth = (s) => [...stripAnsi(s)].length;
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
        process.stdout.write(`${ESC}[?25h${RESET}`);
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
function decodeKey(s) {
    if (KEYS[s])
        return { type: KEYS[s] };
    if (s.startsWith('\x1b'))
        return { type: 'other' }; // unknown escape sequence
    const text = s.replace(/[\x00-\x1f\x7f]/g, '');
    return text ? { type: 'text', text } : { type: 'other' };
}
module.exports = {
    RESET, BOLD, INV, fg, bg, CHROME, FAINT, GREEN, YELLOW, CYAN, NEWMARK,
    authorHue, author, stripAnsi, clean, visWidth, wrap, makePainter, decodeKey,
    logoLines, hint, field,
};
