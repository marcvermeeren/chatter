// Shared TUI primitives: flicker-free painting, a stable color system,
// word-aware wrapping, and raw-mode key decoding.

const ESC = '\x1b';
export const RESET = `${ESC}[0m`;
export const BOLD = `${ESC}[1m`;
export const INV = `${ESC}[7m`;
export const fg = (n: number): string => `${ESC}[38;5;${n}m`;
export const bg = (n: number): string => `${ESC}[48;5;${n}m`;

// Chrome = separators, timestamps, hints. Chosen to read on dark themes.
export const CHROME = fg(245);
export const FAINT = fg(240);
export const GREEN = fg(114);
export const YELLOW = fg(179);
export const CYAN = fg(81);
export const NEWMARK = fg(203);

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
export function logoLines(width: number): string[] {
  if (width < 90) return [` ${BOLD}CHATTER${RESET}`, ''];
  return [...LOGO.map((l, i) => ` ${fg(LOGO_SHADES[i] ?? 231)}${l}${RESET}`),
    ` ${FAINT}cross-harness group chat for agents sharing a Git repository in Herdr${RESET}`, ''];
}

// The one hint-row format: dim, ` · ` separated, three-space indent.
// Convention: the primary action first, then modifiers, exit/cancel last.
export const hint = (...parts: readonly (string | null | undefined | false)[]): string =>
  `   ${FAINT}${parts.filter(Boolean).join(' · ')}${RESET}`;

// An editable text field: prompt, value, block cursor. Same in every wizard.
export const field = (v: string): string => `${BOLD} › ${RESET}${v}${INV} ${RESET}`;

// Stable visual identity: same handle -> same hue and five-column face,
// everywhere, forever. Faces are deliberately curated rather than assembled
// so each one reads cleanly in ordinary terminal fonts.
const AUTHOR_HUES = [204, 214, 114, 81, 147, 179, 210, 117];
export const AGENT_FACES = [
  '[o_o]', '[O_O]', '[0_0]', '[._.]',
  '[^_^]', '[u_u]', '[n_n]', '[v_v]',
  '[o.O]', '[O.o]', '[q_p]', '[p_q]',
  '[@_@]', '[*_*]', '[+_+]', '[~_~]',
  '{o_o}', '{^_^}', '{._.}', '{0_0}',
  '(o_o)', '(^_^)', '(._.)', '(O_O)',
  '<o_o>', '<^_^>', '<._.>', '<0_0>',
  '/o_o\\', '/^_^\\', '/._.\\', '/0_0\\',
] as const;

function nameHash(name: string): number {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h;
}

export function authorHue(name: string): number {
  return AUTHOR_HUES[nameHash(name) % AUTHOR_HUES.length] ?? 204;
}
export function agentFace(name: string): string {
  return AGENT_FACES[nameHash(`${name}\0avatar`) % AGENT_FACES.length] ?? '[o_o]';
}
export const agentAvatar = (name: string): string =>
  `${fg(authorHue(name))}${BOLD}${agentFace(name)}${RESET}`;
export const author = (name: string): string => `${fg(authorHue(name))}${BOLD}${name}${RESET}`;
export const authorWithAvatar = (name: string): string => `${agentAvatar(name)} ${author(name)}`;

export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

// Stored text is untrusted terminal-wise: strip control chars (ANSI/OSC
// included) before rendering so a message can't spoof UI or touch the
// terminal/clipboard. Same rules as delivery sanitization.
export const clean = (s: unknown): string => String(s).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
export const visWidth = (s: string): number => [...stripAnsi(s)].length;

// Word-aware wrap; ANSI-free input expected (style is applied per line after).
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of String(text).split('\n')) {
    let line = '';
    for (const word of raw.split(/\s+/).filter(Boolean)) {
      if (!line.length) line = word;
      else if ([...line].length + 1 + [...word].length <= width) line += ' ' + word;
      else { out.push(line); line = word; }
      while ([...line].length > width) { out.push([...line].slice(0, width).join('')); line = [...line].slice(width).join(''); }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

// Flicker-free painter: repaint in place, skip identical frames.
export function makePainter(): (lines: readonly string[]) => void {
  let last: string | null = null;
  process.stdout.write(`${ESC}[?25l`); // we draw our own cursor
  const show = () => { try { process.stdout.write(`${ESC}[?25h${RESET}`); } catch { /* gone */ } };
  process.on('exit', show);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  return (lines: readonly string[]) => {
    const frame = lines.join('\n');
    if (frame === last) return;
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
} as const;
const isKeySequence = (value: string): value is keyof typeof KEYS => Object.hasOwn(KEYS, value);
export function decodeKey(s: string): import('./types').TuiKey {
  if (isKeySequence(s)) return { type: KEYS[s] };
  if (s.startsWith('\x1b')) return { type: 'other' }; // unknown escape sequence
  const text = s.replace(/[\x00-\x1f\x7f]/g, '');
  return text ? { type: 'text', text } : { type: 'other' };
}
