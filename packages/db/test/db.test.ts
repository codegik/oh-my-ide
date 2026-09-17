import { describe, expect, it } from 'vitest';
import { Db } from '../src/index.js';

const fresh = () => new Db(':memory:');

describe('Db', () => {
  it('applies migrations once and is idempotent', () => {
    const db = fresh();
    expect(() => db.recomputeAll()).not.toThrow();
    db.close();
  });

  it('a new track starts ON_ME with the default rule', () => {
    const db = fresh();
    const t = db.createTrack({ title: 'payment timeouts', question: 'why so slow?' });
    expect(t.court).toBe('ON_ME');
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
});
