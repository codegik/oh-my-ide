/**
 * Whether the daemon on the socket is the one this window should be driving.
 *
 * Pure, and in its own file, so the rule can be tested without Electron.
 */

export interface DaemonStamp {
  /** The bundle the daemon loaded, as it reported it. */
  entry: unknown;
  /** mtime-size of that bundle when the daemon started. */
  buildId: unknown;
}

export type Skew =
  | { stale: false }
  /** `build`: same install, older bundle. `install`: a daemon from somewhere else. */
  | { stale: true; reason: 'build' | 'install' };

/**
 * The daemon outlives the app on purpose, so the window that opens next is not
 * always talking to a daemon built from the same source. Two ways that happens,
 * and both end the same way — calls the renderer makes are answered by code that
 * has never heard of them, which reads as a bug in whatever the user clicked:
 *
 * - **build**: our own bundle was rebuilt since the daemon started.
 * - **install**: the daemon came from a different checkout entirely. A dev build
 *   run from a worktree next to a daemon still listening from the main checkout
 *   is the common case, and the one that cost an afternoon: the window renders
 *   this year's UI over last week's daemon, and every new field is silently
 *   dropped on the floor.
 *
 * Both are a restart, not a warning. There is one daemon per user socket, and it
 * should be the one the running window would have spawned; a window that merely
 * complains leaves the user driving the wrong backend. Restarting costs nothing:
 * no agent's sessions live in the daemon — Claude's are in its own supervisor,
 * hermes' in tmux — which is the whole point of ADR 0001 and ADR 0003.
 *
 * The caller restarts at most once per window, so two apps from two checkouts
 * take one turn each and then settle rather than trading the socket forever.
 */
export function daemonSkew(
  reported: DaemonStamp,
  ours: { entry: string; buildId: string | null },
): Skew {
  const { entry, buildId } = reported;
  // A daemon too old to stamp itself at all cannot be compared, and is left
  // alone: it predates this check, and guessing would mean restarting a daemon
  // on every launch forever.
  if (typeof entry !== 'string' || typeof buildId !== 'string') return { stale: false };
  if (normalize(entry) !== normalize(ours.entry)) return { stale: true, reason: 'install' };
  // Our own bundle, unreadable: nothing to compare against.
  if (ours.buildId === null) return { stale: false };
  return buildId === ours.buildId ? { stale: false } : { stale: true, reason: 'build' };
}

/** Trailing slashes and `.` segments only; no symlink resolution, no I/O. */
function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `${p.startsWith('/') ? '/' : ''}${parts.join('/')}`;
}
