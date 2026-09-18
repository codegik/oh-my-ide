import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { Db, MIGRATION_0001, MIGRATIONS } from '../src/index.js';

const fresh = () => new Db(':memory:');

describe('Db', () => {
  it('applies migrations once and is idempotent', () => {
    const db = fresh();
    expect(() => db.recomputeAll()).not.toThrow();
    db.close();
  });

  it('a new track starts PARKED with the default rule', () => {
    // A brand-new track has no signal yet, and a court that everything starts
    // in cannot also be the one that means "act now".
    const db = fresh();
    const t = db.createTrack({ title: 'payment timeouts', question: 'why so slow?' });
    expect(t.court).toBe('PARKED');
    expect(t.courtRule).toBe('default');
    db.close();
  });

  it('recomputes court when a ref changes state', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.addRef({ trackId: t.id, kind: 'claude_session', externalId: 'claude:abc', state: 'WORKING' });
    expect(db.getTrack(t.id)?.court).toBe('ON_CLAUDE');

    db.setRefState('claude_session', 'claude:abc', 'NEEDS_PERMISSION');
    expect(db.getTrack(t.id)?.court).toBe('ON_ME');
    db.close();
  });

  it('setRefState reports which tracks were touched and skips no-ops', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.addRef({ trackId: t.id, kind: 'github_pr', externalId: 'a/b#1', state: 'AWAITING_REVIEW' });
    expect(db.setRefState('github_pr', 'a/b#1', 'CHANGES_REQUESTED')).toEqual([t.id]);
    // Setting the same state again must not churn or emit events.
    expect(db.setRefState('github_pr', 'a/b#1', 'CHANGES_REQUESTED')).toEqual([]);
    db.close();
  });

  it('linking the same ref twice updates rather than duplicating', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.addRef({ trackId: t.id, kind: 'github_pr', externalId: 'a/b#1', label: 'first' });
    db.addRef({ trackId: t.id, kind: 'github_pr', externalId: 'a/b#1', label: 'second' });
    const refs = db.getTrack(t.id)?.refs ?? [];
    expect(refs).toHaveLength(1);
    expect(refs[0]?.label).toBe('second');
    db.close();
  });

  it('a pin holds, and a high-weight signal releases it with an explanation', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.addRef({ trackId: t.id, kind: 'claude_session', externalId: 'claude:a', state: 'WORKING' });
    db.pin(t.id, 'ON_THEM', 'hard');
    expect(db.getTrack(t.id)?.court).toBe('ON_THEM');
    expect(db.getTrack(t.id)?.courtSource).toBe('pin');

    db.setRefState('claude_session', 'claude:a', 'NEEDS_PERMISSION');
    const after = db.getTrack(t.id);
    expect(after?.court).toBe('ON_ME');
    // The user must be able to see WHY it came back.
    const kinds = db.timeline(t.id).map((e) => e.kind);
    expect(kinds).toContain('track.pin_released');
    db.close();
  });

  it('closing a track makes it terminal and hides it from the open list', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.updateTrack(t.id, { lifecycle: 'done' });
    expect(db.getTrack(t.id)?.court).toBe('DONE');
    expect(db.listTracks().find((r) => r.id === t.id)).toBeUndefined();
    expect(db.listTracks(true).find((r) => r.id === t.id)).toBeDefined();
    db.close();
  });

  it('events bump last_activity_at via trigger', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    const before = db.getTrack(t.id)?.lastActivityAt ?? 0;
    db.addEvent({ trackId: t.id, source: 'claude', kind: 'x', title: 'y', occurredAt: before + 5000 });
    expect(db.getTrack(t.id)?.lastActivityAt).toBe(before + 5000);
    db.close();
  });

  it('notes returns only what the user wrote, even behind a flood of events', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.addEvent({ trackId: t.id, source: 'user', kind: 'note', title: 'first', occurredAt: 1 });
    // More system events than the limit, all newer than the note.
    for (let i = 0; i < 5; i++) {
      db.addEvent({ trackId: t.id, source: 'claude', kind: 'session.named', title: `e${i}`, occurredAt: 10 + i });
    }
    db.addEvent({ trackId: t.id, source: 'user', kind: 'note', title: 'second', occurredAt: 100 });
    expect(db.notes(t.id, 3).map((e) => e.title)).toEqual(['second', 'first']);
    db.close();
  });

  it('moves a stopped session\'s refs to a new session, leaving ones it already holds', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.addRef({ trackId: t.id, kind: 'claude_session', externalId: 'claude:old' });
    db.addRef({ trackId: t.id, kind: 'claude_session', externalId: 'claude:new' });
    db.addRef({ trackId: t.id, sessionId: 'claude:old', kind: 'github_pr', externalId: 'a/b#1' });
    db.addRef({ trackId: t.id, sessionId: 'claude:old', kind: 'jira_issue', externalId: 'PAY-1' });
    db.addRef({ trackId: t.id, sessionId: 'claude:new', kind: 'jira_issue', externalId: 'PAY-1' });
    db.moveSessionRefs(t.id, 'claude:old', 'claude:new');
    const held = (s: string) =>
      db.getTrack(t.id)?.refs.filter((r) => r.sessionId === s).map((r) => r.externalId).sort();
    expect(held('claude:new')).toEqual(['PAY-1', 'a/b#1']);
    // The duplicate stays behind rather than failing the whole move.
    expect(held('claude:old')).toEqual(['PAY-1']);
    db.close();
  });

  it('re-points a resumed session to its new id, keeping its label and refs', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.addRef({ trackId: t.id, kind: 'claude_session', externalId: 'claude:old', label: 'Security issues' });
    db.addRef({ trackId: t.id, sessionId: 'claude:old', kind: 'github_pr', externalId: 'a/b#1' });
    db.repointSession(t.id, 'claude:old', 'claude:new');
    const refs = db.getTrack(t.id)?.refs ?? [];
    const sess = refs.filter((r) => r.kind === 'claude_session');
    expect(sess.map((r) => [r.externalId, r.label])).toEqual([['claude:new', 'Security issues']]);
    expect(refs.find((r) => r.kind === 'github_pr')?.sessionId).toBe('claude:new');
    db.close();
  });

  it('scopes refs to a session, so two sessions can hold the same PR', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.addRef({ trackId: t.id, sessionId: 'claude:a', kind: 'github_pr', externalId: 'a/b#1', state: 'AWAITING_REVIEW' });
    db.addRef({ trackId: t.id, sessionId: 'claude:b', kind: 'github_pr', externalId: 'a/b#1', state: 'CHECKS_FAILED' });
    db.addRef({ trackId: t.id, kind: 'jira_issue', externalId: 'PAY-1' });

    const refs = db.getTrack(t.id)?.refs ?? [];
    expect(refs.filter((r) => r.kind === 'github_pr')).toHaveLength(2);
    expect(refs.find((r) => r.sessionId === 'claude:a')?.state).toBe('AWAITING_REVIEW');
    expect(refs.find((r) => r.sessionId === 'claude:b')?.state).toBe('CHECKS_FAILED');
    // A ref with no session belongs to the track as a whole.
    expect(refs.find((r) => r.kind === 'jira_issue')?.sessionId).toBe('');
    db.close();
  });

  it('re-adding the same ref in the same scope updates rather than duplicates', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.addRef({ trackId: t.id, sessionId: 'claude:a', kind: 'github_pr', externalId: 'a/b#1', label: 'first' });
    db.addRef({ trackId: t.id, sessionId: 'claude:a', kind: 'github_pr', externalId: 'a/b#1', label: 'second' });
    const refs = db.getTrack(t.id)?.refs ?? [];
    expect(refs).toHaveLength(1);
    expect(refs[0]?.label).toBe('second');
    db.close();
  });

  it('refuses to unlink a session that still holds refs', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.addRef({ trackId: t.id, kind: 'claude_session', externalId: 'claude:abc', state: 'WORKING' });
    db.addRef({ trackId: t.id, sessionId: 'claude:abc', kind: 'github_pr', externalId: 'a/b#1' });
    const session = (db.getTrack(t.id)?.refs ?? []).find((r) => r.kind === 'claude_session');

    expect(() => db.removeRef(t.id, session?.id as number)).toThrow(/still has 1 ref/);
    expect(db.getTrack(t.id)?.refs.some((r) => r.kind === 'claude_session')).toBe(true);
    db.close();
  });

  it('lets an empty session go, and keeps removing ordinary refs', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.addRef({ trackId: t.id, kind: 'claude_session', externalId: 'claude:empty', state: 'IDLE' });
    db.addRef({ trackId: t.id, kind: 'claude_session', externalId: 'claude:busy', state: 'WORKING' });
    db.addRef({ trackId: t.id, sessionId: 'claude:busy', kind: 'github_pr', externalId: 'a/b#1' });
    const refs = db.getTrack(t.id)?.refs ?? [];
    const empty = refs.find((r) => r.externalId === 'claude:empty');
    const pr = refs.find((r) => r.kind === 'github_pr');

    db.removeRef(t.id, empty?.id as number);
    expect(db.getTrack(t.id)?.refs.some((r) => r.externalId === 'claude:empty')).toBe(false);
    // Its neighbour and that session's own ref are untouched.
    expect(db.getTrack(t.id)?.refs.some((r) => r.externalId === 'claude:busy')).toBe(true);

    db.removeRef(t.id, pr?.id as number);
    expect(db.getTrack(t.id)?.refs.some((r) => r.kind === 'github_pr')).toBe(false);
    // Now that it holds nothing, that session can go too.
    const busy = (db.getTrack(t.id)?.refs ?? []).find((r) => r.externalId === 'claude:busy');
    db.removeRef(t.id, busy?.id as number);
    expect(db.getTrack(t.id)?.refs).toHaveLength(0);
    db.close();
  });

  it('renames a session ref when its session gets a title', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.addRef({ trackId: t.id, kind: 'claude_session', externalId: 'claude:abc', label: 'abc' });
    const ref = db.listSessionRefs().find((r) => r.externalId === 'claude:abc');
    expect(ref?.trackId).toBe(t.id);

    db.setRefLabel(ref?.id as number, 'why payments time out');
    expect(db.getTrack(t.id)?.refs.find((r) => r.kind === 'claude_session')?.label)
      .toBe('why payments time out');
    db.close();
  });

  it('migrates pre-existing refs to track scope without losing their events', () => {
    // A v1 database with real rows in it: the ref rebuild in 0002 has to keep
    // both the row ids and the events that point at them.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'omi-mig-')), 'omid.db');
    const raw = new Database(file);
    raw.exec(MIGRATION_0001);
    raw.pragma('user_version = 1');
    const now = Date.now();
    raw.prepare(
      `INSERT INTO track (id, public_id, title, last_activity_at, created_at, updated_at)
       VALUES (1, 'p1', 'payment timeouts', ?, ?, ?)`,
    ).run(now, now, now);
    raw.prepare(
      `INSERT INTO track_ref (id, track_id, kind, external_id, label, created_at, updated_at)
       VALUES (7, 1, 'github_pr', 'api#8821', 'api#8821', ?, ?)`,
    ).run(now, now);
    raw.prepare(
      `INSERT INTO event (dedupe_key, track_id, ref_id, source, kind, occurred_at, title)
       VALUES ('k1', 1, 7, 'user', 'ref.added.github_pr', ?, 'linked api#8821')`,
    ).run(now);
    raw.close();

    const db = new Db(file);
    const refs = db.getTrack(1)?.refs ?? [];
    expect(refs).toHaveLength(1);
    expect(refs[0]?.id).toBe(7);
    expect(refs[0]?.sessionId).toBe('');
    expect(db.timeline(1).map((e) => e.ref_id)).toContain(7);
    db.close();
  });

  it('hands unscoped refs to the first session the track gets', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    // Linked before there was any session to pin them to.
    db.addRef({ trackId: t.id, kind: 'github_pr', externalId: 'a/b#1' });
    db.addRef({ trackId: t.id, kind: 'jira_issue', externalId: 'PAY-1' });

    db.addRef({ trackId: t.id, kind: 'claude_session', externalId: 'claude:aaa', state: 'WORKING' });
    db.adoptOrphanRefs(t.id, 'claude:aaa');

    const refs = db.getTrack(t.id)?.refs ?? [];
    expect(refs.filter((r) => r.kind !== 'claude_session').every((r) => r.sessionId === 'claude:aaa')).toBe(true);
    // The session itself stays the track's, not its own child.
    expect(refs.find((r) => r.kind === 'claude_session')?.sessionId).toBe('');

    // A second session gets nothing: there is nothing unscoped left to adopt.
    db.addRef({ trackId: t.id, kind: 'claude_session', externalId: 'claude:bbb', state: 'IDLE' });
    db.adoptOrphanRefs(t.id, 'claude:bbb');
    expect((db.getTrack(t.id)?.refs ?? []).filter((r) => r.sessionId === 'claude:bbb')).toHaveLength(0);
    db.close();
  });

  it('adoption keeps the existing link when the session already has the same ref', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.addRef({ trackId: t.id, kind: 'github_pr', externalId: 'a/b#1', label: 'unscoped' });
    db.addRef({ trackId: t.id, sessionId: 'claude:aaa', kind: 'github_pr', externalId: 'a/b#1', label: 'scoped' });
    db.adoptOrphanRefs(t.id, 'claude:aaa');

    const prs = (db.getTrack(t.id)?.refs ?? []).filter((r) => r.kind === 'github_pr');
    // The collision is ignored rather than fatal, and nothing is lost.
    expect(prs).toHaveLength(2);
    expect(prs.find((r) => r.sessionId === 'claude:aaa')?.label).toBe('scoped');
    db.close();
  });

  it('pins a track to its folder once a session is bound to it', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    // Free to set, and free to change, while nothing is bound.
    db.updateTrack(t.id, { cwd: '/srv/one' });
    db.updateTrack(t.id, { cwd: '/srv/two' });
    expect(db.getTrack(t.id)?.cwd).toBe('/srv/two');

    db.addRef({ trackId: t.id, kind: 'claude_session', externalId: 'claude:abc', state: 'IDLE' });
    expect(() => db.updateTrack(t.id, { cwd: '/srv/three' })).toThrow(/folder cannot change/);
    expect(db.getTrack(t.id)?.cwd).toBe('/srv/two');

    // Setting it to what it already is changes nothing and is not refused.
    expect(() => db.updateTrack(t.id, { cwd: '/srv/two' })).not.toThrow();
    // And an unrelated patch still goes through.
    db.updateTrack(t.id, { title: 'y' });
    expect(db.getTrack(t.id)?.title).toBe('y');
    db.close();
  });

  it('reopening a finished track puts it back in the open list', () => {
    // closed_at is what the open-list query filters on, so finishing and then
    // reopening has to clear it — otherwise the track is in neither list.
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.updateTrack(t.id, { lifecycle: 'done' });
    expect(db.listTracks().map((r) => r.id)).not.toContain(t.id);
    expect(db.getTrack(t.id)?.lifecycle).toBe('done');

    db.updateTrack(t.id, { lifecycle: 'open' });
    expect(db.listTracks().map((r) => r.id)).toContain(t.id);
    expect(db.getTrack(t.id)?.lifecycle).toBe('open');
    db.close();
  });

  it('archiving a finished track hides it from the done list', () => {
    const db = fresh();
    const a = db.createTrack({ title: 'a' });
    const b = db.createTrack({ title: 'b' });
    db.updateTrack(a.id, { lifecycle: 'done' });
    db.updateTrack(b.id, { lifecycle: 'dropped' });
    expect(db.listClosed().map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

    const archived = db.archiveTrack(a.id);
    expect(archived.archivedAt).not.toBeNull();
    expect(db.listClosed().map((r) => r.id)).toEqual([b.id]);
    expect(db.listArchived().map((r) => r.id)).toEqual([a.id]);
    // Archiving is a visibility flag: the lifecycle underneath is untouched.
    expect(db.getTrack(a.id)?.lifecycle).toBe('done');
    db.close();
  });

  it('restoring puts an archived track back in the done list exactly as it was', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.updateTrack(t.id, { lifecycle: 'dropped' });
    const before = db.getTrack(t.id);

    db.archiveTrack(t.id);
    const restored = db.restoreTrack(t.id);
    expect(restored.archivedAt).toBeNull();
    expect(restored.lifecycle).toBe('dropped');
    expect(restored.court).toBe(before?.court);
    // No event on either side, so its place in the recency order is kept.
    expect(restored.lastActivityAt).toBe(before?.lastActivityAt);
    expect(db.listClosed().map((r) => r.id)).toContain(t.id);
    expect(db.listArchived()).toHaveLength(0);
    db.close();
  });

  it('lists archived tracks newest archived first', () => {
    const db = fresh();
    const a = db.createTrack({ title: 'a' });
    const b = db.createTrack({ title: 'b' });
    db.updateTrack(a.id, { lifecycle: 'done' });
    db.updateTrack(b.id, { lifecycle: 'done' });
    db.archiveTrack(a.id);
    db.archiveTrack(b.id);
    expect(db.listArchived().map((r) => r.id)).toEqual([b.id, a.id]);
    db.close();
  });

  it('refuses to archive a track that is still open', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    expect(() => db.archiveTrack(t.id)).toThrow(/only a finished track can be archived/);
    expect(db.getTrack(t.id)?.archivedAt).toBeNull();
    expect(db.listArchived()).toHaveLength(0);
    db.close();
  });

  it('reopening an archived track takes it out of the archive', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.updateTrack(t.id, { lifecycle: 'done' });
    db.archiveTrack(t.id);
    db.updateTrack(t.id, { lifecycle: 'open' });
    expect(db.getTrack(t.id)?.archivedAt).toBeNull();
    expect(db.listArchived()).toHaveLength(0);
    expect(db.listTracks().map((r) => r.id)).toContain(t.id);
    db.close();
  });

  it('adds archived_at to an existing v3 database without losing its tracks', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'omi-mig-')), 'omid.db');
    const raw = new Database(file);
    for (const m of MIGRATIONS.filter((x) => x.version <= 3)) raw.exec(m.sql);
    raw.pragma('user_version = 3');
    const now = Date.now();
    raw.prepare(
      `INSERT INTO track (id, public_id, title, lifecycle, court, closed_at, closed_reason,
                          last_activity_at, created_at, updated_at)
       VALUES (1, 'p1', 'finished work', 'done', 'DONE', ?, 'done', ?, ?, ?)`,
    ).run(now, now, now, now);
    raw.close();

    const db = new Db(file);
    const t = db.getTrack(1);
    expect(t?.title).toBe('finished work');
    expect(t?.archivedAt).toBeNull();
    expect(db.listClosed().map((r) => r.id)).toEqual([1]);
    db.archiveTrack(1);
    expect(db.listArchived().map((r) => r.id)).toEqual([1]);
    db.close();
  });

  it('still lets a track bind its first folder while holding an attached session', () => {
    // `attach…` can link a session to a track that has no folder of its own.
    const db = fresh();
    const t = db.createTrack({ title: 'x' });
    db.addRef({ trackId: t.id, kind: 'claude_session', externalId: 'claude:abc', state: 'IDLE' });
    db.updateTrack(t.id, { cwd: '/srv/one' });
    expect(db.getTrack(t.id)?.cwd).toBe('/srv/one');
    db.close();
  });
});
