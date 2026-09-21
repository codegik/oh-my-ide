import type { NormalizedSession } from '@omi/claude-adapter';

/** How long a session may sit with nothing happening before it is put to sleep. */
export const IDLE_STOP_MS = 10 * 60 * 1000;

/**
 * Which sessions have been quiet long enough to stop.
 *
 * A background session nobody is using still holds a pty host and a whole CLI
 * process — a few hundred MB each — and Claude's supervisor never reaps them, so
 * a week of tracks leaves dozens running. Stopping one keeps its transcript, and
 * a stopped job wakes under the same id, so an idle one costs nothing to put
 * down and little to bring back.
 *
 * "Quiet" is measured two ways, because either alone lies. The CLI's own busy
 * flag misses a user who is halfway through typing a prompt; keystrokes miss a
 * session working on its own. Nothing is persisted: a daemon restart forgets
 * every clock, which only ever makes a session live longer.
 */
export class IdleWatch {
  /** shortId → when it was last seen doing something, or typed into. */
  private readonly lastActive = new Map<string, number>();

  constructor(private readonly idleMs = IDLE_STOP_MS) {}

  /**
   * Feeds one listing and returns the short ids now due to stop. Only sessions
   * in `ours` are considered — a job the user started elsewhere is theirs to
   * manage — and only live background ones: an interactive session belongs to
   * a terminal, and a row with no process has nothing left to free.
   */
  observe(
    sessions: NormalizedSession[],
    ours: (s: NormalizedSession) => boolean,
    now: number,
  ): string[] {
    const due: string[] = [];
    const seen = new Set<string>();
    for (const s of sessions) {
      if (s.kind !== 'background' || s.pid === null || !ours(s)) continue;
      seen.add(s.shortId);
      const busy = s.busy ?? s.state === 'WORKING';
      const since = this.lastActive.get(s.shortId);
      // First sight starts the clock rather than trusting that it has been idle
      // all along: we cannot know what it was doing before we looked.
      if (busy || since === undefined) {
        this.lastActive.set(s.shortId, now);
        continue;
      }
      if (now - since >= this.idleMs) due.push(s.shortId);
    }
    // A session that left the listing, or stopped being ours, starts over if it
    // comes back.
    for (const id of this.lastActive.keys()) if (!seen.has(id)) this.lastActive.delete(id);
    return due;
  }

  /** Someone typed into it: that is use, even before anything is sent. */
  touch(shortId: string, now: number): void {
    if (this.lastActive.has(shortId)) this.lastActive.set(shortId, now);
  }

  /** Stopped, or asked to stop: forget it until it is seen again. */
  forget(shortId: string): void {
    this.lastActive.delete(shortId);
  }
}
