import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { STATE_DB, TERMINAL_SESSIONS } from './cli.js';

/**
 * Hermes' own session store, read-only.
 *
 * This is the hermes equivalent of reading `~/.claude/projects/*.jsonl`, and it
 * is a much better deal: one SQLite database with a row per session carrying
 * cwd, branch, title, last activity, token counts and cost. We open it
 * `readonly` and never write — hermes is the sole writer, and a second writer
 * on a WAL database is how you get a corrupt history that is not ours to lose.
 *
 * Every method degrades to null or an empty list. The store not being there at
 * all is the normal state on a machine where hermes has never run.
 */

export interface StoreSession {
  id: string;
  source: string;
  cwd: string | null;
  gitBranch: string | null;
  gitRepoRoot: string | null;
  title: string | null;
  model: string | null;
  /** ms epoch. */
  startedAt: number;
  lastActivityAt: number | null;
  /** e.g. `receiving stream response`, `tool running: process_manage`, ''. */
  lastActivityDescription: string | null;
  endedAt: number | null;
  endReason: string | null;
  messageCount: number;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** What hermes priced the conversation at; `actual` when the provider said so. */
  costUsd: number | null;
}

const SELECT = `
  SELECT id, source, cwd, git_branch, git_repo_root, title, model, started_at,
         last_activity_at, last_activity_description, ended_at, end_reason,
         message_count, api_call_count, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, reasoning_tokens,
         estimated_cost_usd, actual_cost_usd
    FROM sessions`;

const sec = (v: unknown): number | null =>
  typeof v === 'number' && v > 0 ? Math.round(v * 1000) : null;

function toSession(r: Record<string, unknown>): StoreSession {
  return {
    id: String(r.id),
    source: String(r.source ?? ''),
    cwd: (r.cwd as string | null) ?? null,
    gitBranch: (r.git_branch as string | null) ?? null,
    gitRepoRoot: (r.git_repo_root as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    startedAt: sec(r.started_at) ?? 0,
    lastActivityAt: sec(r.last_activity_at),
    lastActivityDescription: (r.last_activity_description as string | null) ?? null,
    endedAt: sec(r.ended_at),
    endReason: (r.end_reason as string | null) ?? null,
    messageCount: Number(r.message_count ?? 0),
    apiCalls: Number(r.api_call_count ?? 0),
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    cacheReadTokens: Number(r.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(r.cache_write_tokens ?? 0),
    reasoningTokens: Number(r.reasoning_tokens ?? 0),
    costUsd:
      typeof r.actual_cost_usd === 'number'
        ? r.actual_cost_usd
        : typeof r.estimated_cost_usd === 'number'
          ? r.estimated_cost_usd
          : null,
  };
}

/** What hermes wrote next to a tty when a session took it over. */
export interface TerminalMarker {
  sessionId: string;
  cwd: string;
  /** ms epoch. */
  at: number;
}

/** `/dev/pts/11` → `tty-dev-pts-11`, the name hermes files the marker under. */
export function markerFileFor(tty: string): string {
  return path.join(TERMINAL_SESSIONS, `tty${tty.replace(/\//g, '-')}`);
}

/**
 * The session bound to a tty, if one was written at or after `notBefore`.
 *
 * The time gate is the whole point: a pty number is recycled, so the marker
 * sitting next to `/dev/pts/11` is as likely to be from whatever held that tty
 * an hour ago. Only a marker younger than the tmux session asking about it can
 * be that session's.
 */
export function readMarker(tty: string, notBefore = 0): TerminalMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(markerFileFor(tty), 'utf8')) as Record<string, unknown>;
    const sessionId = typeof raw.session_id === 'string' ? raw.session_id : '';
    const at = typeof raw.ts === 'number' ? Math.round(raw.ts * 1000) : 0;
    if (!sessionId || at < notBefore) return null;
    return { sessionId, cwd: typeof raw.cwd === 'string' ? raw.cwd : '', at };
  } catch {
    return null;
  }
}

export class HermesStore {
  private db: Database.Database | null = null;
  private opened = false;

  /**
   * Opened lazily and kept: a readonly WAL connection sees the writer's commits
   * as they land, so reopening per query would buy nothing but syscalls.
   */
  private handle(): Database.Database | null {
    if (this.db) return this.db;
    if (this.opened) return null; // failed before; do not retry on every poll
    this.opened = true;
    try {
      this.db = new Database(STATE_DB, { readonly: true, fileMustExist: true });
      this.db.pragma('busy_timeout = 2000');
      return this.db;
    } catch {
      this.db = null;
      return null;
    }
  }

  /** Lets a later call try again — after hermes has been installed and run once. */
  reset(): void {
    try {
      this.db?.close();
    } catch {
      /* already gone */
    }
    this.db = null;
    this.opened = false;
  }

  available(): boolean {
    return this.handle() !== null;
  }

  private all(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    const db = this.handle();
    if (!db) return [];
    try {
      return db.prepare(sql).all(...params) as Record<string, unknown>[];
    } catch {
      // A schema that moved under us must never take the rail down. Hermes
      // upgrades its own store; we are a guest in it.
      return [];
    }
  }

  byId(id: string): StoreSession | null {
    const rows = this.all(`${SELECT} WHERE id = ?`, id);
    return rows[0] ? toSession(rows[0]) : null;
  }

  /** The first of these ids the store knows about. */
  byAnyId(ids: string[]): StoreSession | null {
    for (const id of ids) {
      if (!id) continue;
      const s = this.byId(id);
      if (s) return s;
    }
    return null;
  }

  /**
   * Sessions that ran in a folder, newest activity first. `git_repo_root` is
   * matched too, so a session started in a subdirectory of the track's folder
   * is still that folder's history.
   */
  inFolder(cwd: string, limit = 50): StoreSession[] {
    return this.all(
      `${SELECT} WHERE (cwd = ? OR git_repo_root = ?) AND archived = 0 AND hidden = 0
        ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT ?`,
      cwd,
      cwd,
      limit,
    ).map(toSession);
  }

  /**
   * The newest session started in a folder at or after `sinceMs` — the fallback
   * for pinning a tmux session to the row hermes wrote for it, when the tty
   * marker has not been written yet.
   */
  newestIn(cwd: string, sinceMs: number): StoreSession | null {
    const rows = this.all(
      `${SELECT} WHERE (cwd = ? OR git_repo_root = ?) AND started_at >= ?
        ORDER BY started_at DESC LIMIT 1`,
      cwd,
      cwd,
      sinceMs / 1000,
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  /**
   * Conversations with a turn in flight right now.
   *
   * `session_turn_leases` is hermes' own answer to "is this session busy": a
   * lease is taken for the duration of a turn and expires on its own, so a
   * crashed run cannot leave a session looking busy forever.
   */
  busyIds(now = Date.now()): Set<string> {
    const ids = new Set<string>();
    for (const r of this.all(
      'SELECT conversation_id, expires_at FROM session_turn_leases WHERE expires_at > ?',
      now / 1000,
    )) {
      ids.add(String(r.conversation_id));
    }
    return ids;
  }

  close(): void {
    this.reset();
  }
}
