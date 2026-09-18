/**
 * Normalized types the rest of the app sees. Nothing outside this package may
 * know that `~/.claude` or the `claude` CLI exist.
 */

/** Our single normalized view of a session, regardless of how Claude reports it. */
export interface NormalizedSession {
  /** Claude's session UUID. The only durable join key we have. */
  sessionId: string;
  /** Short id used by `claude attach|logs|stop|rm`. Derived when absent. */
  shortId: string;
  kind: 'background' | 'interactive';
  cwd: string;
  name: string | null;
  startedAt: number;
  pid: number | null;
  /** Normalized from the CLI's asymmetric `state` (background) / `status` (interactive). */
  state: SessionState;
  /** What the CLI actually said, kept for debugging and for unknown values. */
  rawState: string | null;
  confidence: StateConfidence;
}

export type SessionState =
  | 'STARTING'
  | 'WORKING'
  | 'NEEDS_INPUT'
  | 'NEEDS_PERMISSION'
  | 'IDLE'
  | 'FAILED'
  | 'STOPPED'
  | 'RESUMABLE'
  | 'UNKNOWN';

/**
 * `observed`  — the CLI confirmed it within the freshness window.
 * `derived`   — inferred from the transcript alone.
 * `stale`     — no confirmation recently; the UI renders this as a hollow dot.
 *
 * Honest ambiguity beats a confident lie.
 */
export type StateConfidence = 'observed' | 'derived' | 'stale';

export interface StartedSession {
  sessionId: string;
  shortId: string;
  name: string | null;
  cwd: string;
}

export interface ClaudeCompat {
  cliVersion: string;
  tier: 'supported' | 'degraded' | 'unsupported';
  features: {
    background: boolean;
    attach: boolean;
    logs: boolean;
    stop: boolean;
    respawn: boolean;
    agentsJson: boolean;
    forkSession: boolean;
    sessionId: boolean;
    name: boolean;
  };
  notes: string[];
}

/**
 * Both substrates implement this. `ClaudeBgRunner` is the default — see
 * docs/decisions/0001-session-substrate.md. `TmuxRunner` is the hedge if the
 * documented flags ever change.
 */
export interface SessionRunner {
  /** An absent prompt starts the session idle, waiting for its first message. */
  start(o: { cwd: string; prompt?: string; name?: string; sessionId?: string }): Promise<StartedSession>;
  /** argv for a PTY the daemon owns, and for the "attach in your terminal" button. */
  attachCommand(s: { shortId: string }): { file: string; args: string[] };
  /** `cwd` matters: the CLI looks a transcript up under the folder it runs in. */
  resume(o: { sessionId: string; cwd?: string; fork?: boolean }): Promise<StartedSession>;
  stop(s: { shortId: string }): Promise<void>;
  remove(s: { shortId: string }): Promise<void>;
  list(): Promise<NormalizedSession[]>;
  /** Recent raw ANSI bytes. Works without a TTY. */
  logs(s: { shortId: string }): Promise<string>;
}
