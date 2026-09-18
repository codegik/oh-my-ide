import type { Court, RefKind, TrackRef, TrackSnapshot } from '@omi/core';
import { effective } from '@omi/core';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './schema.js';

export * from './schema.js';

export interface TrackRow {
  id: number;
  publicId: string;
  title: string;
  question: string | null;
  nextAction: string | null;
  originKind: string;
  originUrl: string | null;
  originActor: string | null;
  cwd: string | null;
  gitBranch: string | null;
  lifecycle: 'open' | 'done' | 'dropped';
  court: string;
  courtReason: string | null;
  courtRule: string | null;
  courtSource: string;
  waitingOn: string | null;
  snoozeUntil: number | null;
  lastActivityAt: number;
  createdAt: number;
  /** Set while a finished track is archived out of the `done` list. */
  archivedAt: number | null;
  refs: TrackRef[];
}

const ulid = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export class Db {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    // A migration that rebuilds a referenced table (the only way SQLite can
    // change a constraint) would otherwise trip the FKs pointing at it. The
    // pragma is a no-op inside a transaction, so it has to be set out here.
    this.db.pragma('foreign_keys = OFF');
    this.migrate();
    this.db.pragma('foreign_keys = ON');
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      // One transaction per migration, so a failure leaves no half-applied schema.
      this.db.transaction(() => {
        this.db.exec(m.sql);
        this.db.pragma(`user_version = ${m.version}`);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  // ── tracks ────────────────────────────────────────────────────────────────

  createTrack(o: {
    title: string;
    question?: string | null;
    originKind?: string;
    originUrl?: string | null;
    cwd?: string | null;
    gitBranch?: string | null;
  }): TrackRow {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO track (public_id, title, question, origin_kind, origin_url, cwd,
                            git_branch, last_activity_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
        o.title,
        o.question ?? null,
        o.originKind ?? 'self',
        o.originUrl ?? null,
        o.cwd ?? null,
        o.gitBranch ?? null,
        now,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    this.addEvent({
      trackId: id,
      source: 'user',
      kind: 'track.created',
      title: 'track created',
      occurredAt: now,
    });
    // Derive immediately rather than leaning on the column default: otherwise a
    // brand-new track has no rule or reason, and the "why?" popover is empty.
    this.recomputeCourt(id);
    return this.getTrack(id) as TrackRow;
  }

  getTrack(id: number): TrackRow | null {
    const row = this.db.prepare('SELECT * FROM track WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.hydrate(row) : null;
  }

  listTracks(includeClosed = false): TrackRow[] {
    const sql = includeClosed
      ? 'SELECT * FROM track ORDER BY last_activity_at DESC'
      : 'SELECT * FROM track WHERE closed_at IS NULL ORDER BY court_weight DESC, last_activity_at DESC';
    return (this.db.prepare(sql).all() as Record<string, unknown>[]).map((r) => this.hydrate(r));
  }

  /** The `done` section: finished tracks, most recently active first, minus archived ones. */
  listClosed(): TrackRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM track WHERE lifecycle <> 'open' AND archived_at IS NULL
            ORDER BY last_activity_at DESC`,
        )
        .all() as Record<string, unknown>[]
    ).map((r) => this.hydrate(r));
  }

  /** Archived tracks, most recently archived first. */
  listArchived(): TrackRow[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM track WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, id DESC',
        )
        .all() as Record<string, unknown>[]
    ).map((r) => this.hydrate(r));
  }

  /**
   * Hides a finished track from the `done` list. Only a finished one: an open
   * track archived out of sight would still be work nobody can see.
   *
   * No event is written on purpose — events bump last_activity_at, and that
   * would reorder the track when it is restored. It should come back exactly
   * where it was.
   */
  archiveTrack(id: number): TrackRow {
    const cur = this.db.prepare('SELECT lifecycle FROM track WHERE id = ?').get(id) as
      | { lifecycle: string }
      | undefined;
    if (!cur) throw new Error(`no such track: ${id}`);
    if (cur.lifecycle === 'open') {
      throw new Error('only a finished track can be archived; finish it first');
    }
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE track SET archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?',
      )
      .run(now, now, id);
    return this.getTrack(id) as TrackRow;
  }

  /** Puts an archived track back in the `done` list; its lifecycle was never touched. */
  restoreTrack(id: number): TrackRow {
    const info = this.db
      .prepare('UPDATE track SET archived_at = NULL, updated_at = ? WHERE id = ?')
      .run(Date.now(), id);
    if (info.changes === 0) throw new Error(`no such track: ${id}`);
    return this.getTrack(id) as TrackRow;
  }

  updateTrack(
    id: number,
    patch: Partial<{
      title: string;
      question: string | null;
      nextAction: string | null;
      waitingOn: string | null;
      cwd: string | null;
      gitBranch: string | null;
      lifecycle: 'open' | 'done' | 'dropped';
    }>,
  ): TrackRow | null {
    const now = Date.now();
    const sets: string[] = [];
    const vals: unknown[] = [];
    const col: Record<string, string> = {
      title: 'title',
      question: 'question',
      nextAction: 'next_action',
      waitingOn: 'waiting_on',
      cwd: 'cwd',
      gitBranch: 'git_branch',
      lifecycle: 'lifecycle',
    };
    for (const [k, v] of Object.entries(patch)) {
      const c = col[k];
      if (!c) continue;
      sets.push(`${c} = ?`);
      vals.push(v);
    }
    /**
     * A session runs in the folder it was started in — Claude owns that, and
     * nothing here can move it. So once a track has a session bound to it, the
     * track's folder is settled too: changing it would describe the sessions
     * wrongly. Setting one for the first time is not a change.
     */
    if (patch.cwd !== undefined) {
      const cur = this.db.prepare('SELECT cwd FROM track WHERE id = ?').get(id) as
        | { cwd: string | null }
        | undefined;
      if (cur?.cwd && cur.cwd !== patch.cwd) {
        const n = this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM track_ref WHERE track_id = ? AND kind = 'claude_session'",
          )
          .get(id) as { n: number };
        if (n.n > 0) {
          throw new Error(
            `this track has ${n.n} session${n.n === 1 ? '' : 's'} bound to ${cur.cwd}; its folder cannot change`,
          );
        }
      }
    }

    /**
     * `closed_at` is what every open-list query filters on, so it has to move
     * with the lifecycle in BOTH directions. Setting it and never clearing it
     * would leave a reopened track invisible in both lists — closed_at still
     * set, so not open; lifecycle 'open', so not done either.
     */
    if (patch.lifecycle) {
      if (patch.lifecycle === 'open') {
        // An open track is never archived: reopening one would otherwise leave
        // it in the open list and the archive at once.
        sets.push('closed_at = NULL', 'closed_reason = NULL', 'archived_at = NULL');
      } else {
        sets.push('closed_at = ?', 'closed_reason = ?');
        vals.push(now, patch.lifecycle);
      }
    }
    if (sets.length === 0) return this.getTrack(id);
    sets.push('updated_at = ?');
    vals.push(now, id);
    this.db.prepare(`UPDATE track SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    this.recomputeCourt(id);
    return this.getTrack(id);
  }

  // ── refs ──────────────────────────────────────────────────────────────────

  addRef(o: {
    trackId: number;
    kind: RefKind;
    externalId: string;
    /** '' (the default) scopes the ref to the whole track rather than one session. */
    sessionId?: string | null;
    url?: string | null;
    label?: string | null;
    role?: string;
    state?: string | null;
    body?: string | null;
    autoLinked?: boolean;
    linkRule?: string | null;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO track_ref (track_id, session_id, kind, external_id, url, label, role, state,
                                body, auto_linked, link_rule, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(track_id, session_id, kind, external_id) DO UPDATE SET
           url=excluded.url, label=excluded.label, state=excluded.state, updated_at=excluded.updated_at`,
      )
      .run(
        o.trackId,
        o.sessionId ?? '',
        o.kind,
        o.externalId,
        o.url ?? null,
        o.label ?? null,
        o.role ?? 'support',
        o.state ?? null,
        o.body ?? null,
        o.autoLinked ? 1 : 0,
        o.linkRule ?? null,
        now,
        now,
      );
    this.addEvent({
      trackId: o.trackId,
      source: 'user',
      kind: `ref.added.${o.kind}`,
      title: `linked ${o.label ?? o.externalId}`,
      occurredAt: now,
    });
    this.recomputeCourt(o.trackId);
  }

  /**
   * A session can only be unlinked once nothing is filed under it. Its refs live
   * in its scope, so removing a session that still holds some would take them
   * with it — that is the one case this refuses. An empty session (a terminal
   * opened and not used, say) is the user's to remove.
   */
  removeRef(trackId: number, refId: number): void {
    const row = this.db
      .prepare('SELECT kind, external_id FROM track_ref WHERE id = ? AND track_id = ?')
      .get(refId, trackId) as { kind: string; external_id: string } | undefined;
    if (!row) return;
    if (row.kind === 'claude_session') {
      const held = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM track_ref
            WHERE track_id = ? AND session_id = ? AND kind <> 'claude_session'`,
        )
        .get(trackId, row.external_id) as { n: number };
      if (held.n > 0) {
        throw new Error(
          `this session still has ${held.n} ref${held.n === 1 ? '' : 's'} linked to it; unlink those first`,
        );
      }
    }
    this.db.prepare('DELETE FROM track_ref WHERE id = ? AND track_id = ?').run(refId, trackId);
    this.recomputeCourt(trackId);
  }

  /** Every session ref across all tracks, for matching a pty view to a track. */
  listSessionRefs(): { id: number; trackId: number; externalId: string; label: string | null }[] {
    return (
      this.db
        .prepare(
          `SELECT id, track_id, external_id, label FROM track_ref
            WHERE kind = 'claude_session'`,
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      trackId: r.track_id as number,
      externalId: r.external_id as string,
      label: (r.label as string | null) ?? null,
    }));
  }

  setRefLabel(refId: number, label: string): void {
    this.db
      .prepare('UPDATE track_ref SET label = ?, updated_at = ? WHERE id = ?')
      .run(label, Date.now(), refId);
  }

  /**
   * Hands a track's unscoped refs to a session. A ref can only be unscoped if
   * it was written before the track had any session, so whichever session
   * arrives first is the one it was really about.
   */
  /**
   * Hands everything one session held to another: for a session that cannot be
   * resumed, so starting over does not mean re-linking every PR and ticket.
   * OR IGNORE leaves behind anything the new session already holds.
   */
  moveSessionRefs(trackId: number, fromSession: string, toSession: string): void {
    this.db
      .prepare(
        `UPDATE OR IGNORE track_ref SET session_id = ?, updated_at = ?
          WHERE track_id = ? AND session_id = ? AND kind <> 'claude_session'`,
      )
      .run(toSession, Date.now(), trackId, fromSession);
  }

  /**
   * The same conversation, now under another id — resuming can hand back a copy
   * instead of the original. The session ref keeps its row, label and tab, and
   * everything linked to it follows.
   */
  repointSession(trackId: number, fromSession: string, toSession: string): void {
    this.db
      .prepare(
        `UPDATE OR IGNORE track_ref SET external_id = ?, updated_at = ?
          WHERE track_id = ? AND kind = 'claude_session' AND external_id = ?`,
      )
      .run(toSession, Date.now(), trackId, fromSession);
    this.moveSessionRefs(trackId, fromSession, toSession);
  }

  adoptOrphanRefs(trackId: number, sessionExternalId: string): void {
    this.db
      .prepare(
        `UPDATE OR IGNORE track_ref SET session_id = ?, updated_at = ?
          WHERE track_id = ? AND session_id = '' AND kind <> 'claude_session'`,
      )
      .run(sessionExternalId, Date.now(), trackId);
  }

  /** Called by the poller when a session or PR changes state. */
  setRefState(kind: RefKind, externalId: string, state: string | null): number[] {
    const rows = this.db
      .prepare('SELECT id, track_id, state FROM track_ref WHERE kind = ? AND external_id = ?')
      .all(kind, externalId) as { id: number; track_id: number; state: string | null }[];
    const touched: number[] = [];
    for (const r of rows) {
      if (r.state === state) continue; // no event for a no-op
      this.db
        .prepare('UPDATE track_ref SET state = ?, updated_at = ? WHERE id = ?')
        .run(state, Date.now(), r.id);
      touched.push(r.track_id);
    }
    for (const id of new Set(touched)) this.recomputeCourt(id);
    return [...new Set(touched)];
  }

  // ── events ────────────────────────────────────────────────────────────────

  addEvent(o: {
    trackId: number | null;
    source: string;
    kind: string;
    title: string;
    body?: string | null;
    occurredAt?: number;
    importance?: number;
    dedupeKey?: string;
  }): void {
    const at = o.occurredAt ?? Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO event (dedupe_key, track_id, source, kind, occurred_at,
                                      title, body, importance)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        o.dedupeKey ?? `${o.source}:${o.kind}:${at}:${Math.random().toString(36).slice(2, 8)}`,
        o.trackId,
        o.source,
        o.kind,
        at,
        o.title,
        o.body ?? null,
        o.importance ?? 0,
      );
  }

  timeline(trackId: number, limit = 200): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM event WHERE track_id = ? ORDER BY occurred_at DESC LIMIT ?')
      .all(trackId, limit) as Record<string, unknown>[];
  }

  /**
   * Only what the user wrote. Filtered in SQL, not after the LIMIT, so a busy
   * track's system events can never push its notes out of the window.
   */
  notes(trackId: number, limit = 200): Record<string, unknown>[] {
    return this.db
      .prepare(
        "SELECT * FROM event WHERE track_id = ? AND source = 'user' AND kind = 'note' ORDER BY occurred_at DESC LIMIT ?",
      )
      .all(trackId, limit) as Record<string, unknown>[];
  }

  // ── court ─────────────────────────────────────────────────────────────────

  /** Recomputes and caches the derived court. The rules themselves are pure. */
  recomputeCourt(id: number): void {
    const row = this.db.prepare('SELECT * FROM track WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return;

    const pinRow = this.db
      .prepare('SELECT * FROM status_pin WHERE track_id = ? AND released_at IS NULL')
      .get(id) as Record<string, unknown> | undefined;

    const snap: TrackSnapshot = {
      id,
      lifecycle: row.lifecycle as TrackSnapshot['lifecycle'],
      refs: this.refsOf(id),
      snoozeUntil: (row.snooze_until as number | null) ?? null,
      waitingOn: (row.waiting_on as string | null) ?? null,
      lastActivityAt: row.last_activity_at as number,
      pin: pinRow
        ? {
            court: pinRow.court as Court,
            kind: pinRow.pin_kind as 'hard' | 'snooze' | 'park',
            expiresAt: (pinRow.expires_at as number | null) ?? null,
            overrideWeight: pinRow.override_weight as number,
            reason: (pinRow.reason as string | null) ?? null,
          }
        : null,
    };

    const e = effective(snap, Date.now());

    if (e.released && pinRow) {
      this.db
        .prepare('UPDATE status_pin SET released_at = ?, release_reason = ? WHERE id = ?')
        .run(Date.now(), e.released.reason, pinRow.id);
      // Nothing changes silently: the user must be able to see why it came back.
      this.addEvent({
        trackId: id,
        source: 'system',
        kind: 'track.pin_released',
        title: `pin released (${e.released.reason})`,
      });
    }

    this.db
      .prepare(
        `UPDATE track SET court = ?, court_weight = ?, court_rule = ?, court_reason = ?,
                          court_source = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        e.court,
        e.derivation.weight,
        e.derivation.rule,
        e.derivation.reason,
        e.source,
        Date.now(),
        id,
      );
  }

  recomputeAll(): void {
    for (const r of this.db.prepare('SELECT id FROM track WHERE closed_at IS NULL').all() as {
      id: number;
    }[]) {
      this.recomputeCourt(r.id);
    }
  }

  pin(trackId: number, court: Court, kind: 'hard' | 'snooze' | 'park', expiresAt?: number): void {
    this.db
      .prepare(
        'UPDATE status_pin SET released_at = ?, release_reason = ? WHERE track_id = ? AND released_at IS NULL',
      )
      .run(Date.now(), 'replaced', trackId);
    this.db
      .prepare(
        'INSERT INTO status_pin (track_id, court, pin_kind, created_at, expires_at) VALUES (?,?,?,?,?)',
      )
      .run(trackId, court, kind, Date.now(), expiresAt ?? null);
    if (kind === 'park' && expiresAt) {
      this.db.prepare('UPDATE track SET snooze_until = ? WHERE id = ?').run(expiresAt, trackId);
    }
    this.recomputeCourt(trackId);
  }

  unpin(trackId: number): void {
    this.db
      .prepare(
        'UPDATE status_pin SET released_at = ?, release_reason = ? WHERE track_id = ? AND released_at IS NULL',
      )
      .run(Date.now(), 'manual', trackId);
    this.recomputeCourt(trackId);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private refsOf(trackId: number): TrackRef[] {
    return (
      this.db
        .prepare('SELECT * FROM track_ref WHERE track_id = ? ORDER BY id')
        .all(trackId) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      kind: r.kind as RefKind,
      externalId: r.external_id as string,
      url: (r.url as string | null) ?? null,
      label: (r.label as string | null) ?? null,
      state: (r.state as string | null) ?? null,
      isBlocking: (r.is_blocking as number) === 1,
      sessionId: (r.session_id as string | null) ?? '',
    }));
  }

  private hydrate(r: Record<string, unknown>): TrackRow {
    return {
      id: r.id as number,
      publicId: r.public_id as string,
      title: r.title as string,
      question: (r.question as string | null) ?? null,
      nextAction: (r.next_action as string | null) ?? null,
      originKind: r.origin_kind as string,
      originUrl: (r.origin_url as string | null) ?? null,
      originActor: (r.origin_actor as string | null) ?? null,
      cwd: (r.cwd as string | null) ?? null,
      gitBranch: (r.git_branch as string | null) ?? null,
      lifecycle: r.lifecycle as TrackRow['lifecycle'],
      court: r.court as string,
      courtReason: (r.court_reason as string | null) ?? null,
      courtRule: (r.court_rule as string | null) ?? null,
      courtSource: r.court_source as string,
      waitingOn: (r.waiting_on as string | null) ?? null,
      snoozeUntil: (r.snooze_until as number | null) ?? null,
      lastActivityAt: r.last_activity_at as number,
      createdAt: r.created_at as number,
      archivedAt: (r.archived_at as number | null) ?? null,
      refs: this.refsOf(r.id as number),
    };
  }
}
