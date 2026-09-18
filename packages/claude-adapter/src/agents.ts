import { z } from 'zod';
import type { NormalizedSession, SessionState } from './types.js';

/**
 * `claude agents --json` is documented, TTY-free, and covers both background and
 * interactive sessions. Its rows are NOT uniform — background rows carry
 * `id`/`state`, interactive rows carry `pid`/`status` — so everything here exists
 * to collapse that into one shape.
 *
 * `.passthrough()` and a fully optional shape are deliberate: a Claude upgrade
 * that adds or drops a field must never take the app down.
 */
const AgentRow = z
  .object({
    id: z.string().nullish(),
    pid: z.number().nullish(),
    sessionId: z.string(),
    cwd: z.string(),
    kind: z.string(),
    name: z.string().nullish(),
    startedAt: z.number().nullish(),
    state: z.string().nullish(),
    status: z.string().nullish(),
  })
  .passthrough();

export const AgentList = z.array(AgentRow);
export type AgentRow = z.infer<typeof AgentRow>;

/**
 * Observed values as of CLI v2.1.272. Anything unrecognized maps to UNKNOWN
 * rather than throwing — an unknown state is a neutral dot, never an outage.
 */
const BACKGROUND_STATE: Record<string, SessionState> = {
  working: 'WORKING',
  running: 'WORKING',
  blocked: 'NEEDS_INPUT',
  done: 'IDLE',
  completed: 'IDLE',
  stopped: 'STOPPED',
  failed: 'FAILED',
  error: 'FAILED',
  starting: 'STARTING',
};

const INTERACTIVE_STATUS: Record<string, SessionState> = {
  busy: 'WORKING',
  idle: 'IDLE',
};

/** The short id is the first 8 hex chars of the session UUID. */
export function shortIdOf(sessionId: string): string {
  return sessionId.replace(/-/g, '').slice(0, 8);
}

/**
 * Whether a listed session is the one we stored as `sessionId`. The UUID alone
 * is not enough: a background session that moves into a worktree carries on
 * under a new transcript, so `claude agents` reports a different UUID for the
 * same job. The job's short id does not change — it is the prefix of the UUID
 * it was launched with — so it is the key that survives.
 */
export function isSameSession(s: NormalizedSession, sessionId: string): boolean {
  return (
    s.sessionId === sessionId || (s.kind === 'background' && s.shortId === shortIdOf(sessionId))
  );
}

export function normalizeRow(row: AgentRow): NormalizedSession {
  const kind = row.kind === 'background' ? 'background' : 'interactive';
  const raw = (kind === 'background' ? row.state : row.status) ?? null;
  const table = kind === 'background' ? BACKGROUND_STATE : INTERACTIVE_STATUS;
  // `raw &&` would let an empty string through `??`, so look it up explicitly.
  const state: SessionState = raw ? (table[raw.toLowerCase()] ?? 'UNKNOWN') : 'UNKNOWN';

  return {
    sessionId: row.sessionId,
    shortId: row.id ?? shortIdOf(row.sessionId),
    kind,
    cwd: row.cwd,
    name: row.name ?? null,
    startedAt: row.startedAt ?? 0,
    pid: row.pid ?? null,
    state,
    rawState: raw,
    // The CLI told us directly, so this is the strongest confidence we ever have.
    confidence: 'observed',
  };
}

/** Rows that fail to parse are dropped, never fatal. Returns what it could read. */
export function parseAgentList(stdout: string): {
  sessions: NormalizedSession[];
  skipped: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { sessions: [], skipped: 0 };
  }
  if (!Array.isArray(parsed)) return { sessions: [], skipped: 0 };

  const sessions: NormalizedSession[] = [];
  let skipped = 0;
  for (const raw of parsed) {
    const r = AgentRow.safeParse(raw);
    if (r.success) sessions.push(normalizeRow(r.data));
    else skipped++;
  }
  return { sessions, skipped };
}
