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

/**
 * A view id is `<agent>:<short id>`. An id with no agent we know — or none at
 * all — keeps Claude's key, which is what every view used to send.
 */
export function newlineKeyFor(viewId: string): string {
  const i = viewId.indexOf(':');
  const agent = i < 0 ? '' : viewId.slice(0, i);
  return NEWLINE_KEY[agent] ?? DEFAULT_NEWLINE_KEY;
}
