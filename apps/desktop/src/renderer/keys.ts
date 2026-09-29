/**
 * Keys the terminal pane has to translate itself, because xterm's own encoding
 * loses what the agent needs to know.
 *
 * Its own module so it can be tested: app.ts is one browser-only file that
 * cannot be imported outside a renderer, and getting the wrong bytes onto the
 * wire is exactly the kind of thing that only shows up in someone's hands.
 */

/**
 * What to send for Shift+Enter, per agent. Both mean "newline, do not submit",
 * and the difference is what stands between the key and the agent:
 *
 * - claude: ESC CR (Meta+Enter), what `claude /terminal-setup` binds in a native
 *   terminal. Its pty is `claude attach` and nothing else reads the bytes.
 * - hermes: the kitty-protocol CSI u form of Shift+Enter, which is what hermes'
 *   own terminal setup writes for editors whose terminal is xterm.js — ours. ESC
 *   CR cannot be used here: a hermes session lives in tmux, `M-Enter` is a key
 *   tmux itself may have bound (this user's config splits the pane with it), and
 *   a tmux binding consumes the key instead of forwarding it. CSI u passes
 *   through — hermes turns on extended keys when it sees tmux, and tmux forwards
 *   them to an application that asked.
 */
export const NEWLINE_KEY: Record<string, string> = {
  claude: '\x1b\r',
  hermes: '\x1b[13;2u',
};

const DEFAULT_NEWLINE_KEY = '\x1b\r';

/** A view id is `<agent>:<short id>`; an id with no colon has no agent. */
function agentOf(viewId: string): string {
  const i = viewId.indexOf(':');
  return i < 0 ? '' : viewId.slice(0, i);
}

/**
 * An id with no agent we know — or none at all — keeps Claude's key, which is
 * what every view used to send.
 */
export function newlineKeyFor(viewId: string): string {
  return NEWLINE_KEY[agentOf(viewId)] ?? DEFAULT_NEWLINE_KEY;
}

/**
 * Copy and paste, which xterm leaves to the page and the page never did.
 *
 * Omarchy gives two of each. Super+C / Super+V are its universal clipboard
 * keys: for a window it does not tag as a terminal — ours — Hyprland hands the
 * app a plain Ctrl+C / Ctrl+V (a tagged one would get Ctrl+Insert /
 * Shift+Insert). Ctrl+Shift+C / Ctrl+Shift+V are the terminal convention.
 * All of them are answered here:
 *
 * - Ctrl+Shift+V, Shift+Insert: paste, for every agent.
 * - Ctrl+V: paste for hermes only. Its ^V never arrives as ^V — tmux's
 *   extended keys rewrite it to `ESC[118;5u`, and hermes only pastes on the raw
 *   byte, so the key did nothing. Claude keeps its ^V, which is how it takes an
 *   image off the clipboard.
 * - Ctrl+Shift+C, Ctrl+Insert: copy the terminal's selection, for every agent.
 * - Ctrl+C: copy only when there is a selection in the terminal; otherwise it
 *   stays ^C, the interrupt. A drag inside hermes is not such a selection —
 *   hermes asks for the mouse, keeps its own highlight, and copies it itself
 *   when the ^C reaches it — so that path is left alone.
 */
export type ClipboardKey = 'copy' | 'paste';

/** Agents whose own ^V never pastes once tmux is in the way. */
const PASTES_ON_CTRL_V = new Set(['hermes']);

/**
 * Agents that take an empty bracketed paste as "the clipboard holds an image,
 * attach it" — what a terminal sends when there is no text to paste.
 */
const IMAGE_ON_EMPTY_PASTE = new Set(['hermes']);

export function pastesImageOnEmpty(viewId: string): boolean {
  return IMAGE_ON_EMPTY_PASTE.has(agentOf(viewId));
}

interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * The letter a chord was typed with. Layout first, so Ctrl+V is the V the
 * layout puts on the key; the physical position only when the layout types
 * something outside ASCII (Cyrillic, Greek) — same rule as the app shortcuts.
 */
function letterOf(e: KeyLike): string {
  if (/^[\x20-\x7e]$/.test(e.key)) return e.key.toLowerCase();
  return e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : '';
}

export function clipboardKeyFor(
  viewId: string,
  e: KeyLike,
  hasSelection: boolean,
): ClipboardKey | null {
  if (e.altKey || e.metaKey) return null;
  if (e.key === 'Insert') {
    if (e.ctrlKey && !e.shiftKey) return 'copy';
    if (e.shiftKey && !e.ctrlKey) return 'paste';
    return null;
  }
  if (!e.ctrlKey) return null;
  const letter = letterOf(e);
  if (letter === 'v') {
    return e.shiftKey || PASTES_ON_CTRL_V.has(agentOf(viewId)) ? 'paste' : null;
  }
  if (letter === 'c') {
    return e.shiftKey || hasSelection ? 'copy' : null;
  }
  return null;
}
