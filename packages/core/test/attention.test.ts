import { describe, expect, it } from 'vitest';
import { type AttentionTrack, asks, notifiable, toNotify } from '../src/attention.js';
import { ruleWeight } from '../src/court.js';
import type { TrackRef } from '../src/types.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const session = (over: Partial<TrackRef> = {}): TrackRef => ({
  id: 1,
  kind: 'claude_session',
  externalId: 'claude:aaa',
  url: null,
  label: 'the session',
  state: null,
  isBlocking: true,
  sessionId: '',
  ...over,
});

const track = (over: Partial<AttentionTrack> = {}): AttentionTrack => ({
  id: 1,
  title: 'a track',
  court: 'ON_ME',
  courtRule: null,
  courtReason: null,
  refs: [],
  ...over,
});

describe('asks', () => {
  it('names the session doing the asking, not just the track', () => {
    const [a] = asks([
      track({ refs: [session({ state: 'NEEDS_PERMISSION', label: 'migrate the schema' })] }),
    ]);
    expect(a?.sessionId).toBe('claude:aaa');
    expect(a?.says).toBe('migrate the schema · wants your approval');
  });

  it('lists every waiting session in a track, not one per track', () => {
    // The whole reason this exists: a track's court is ONE value, so a second
    // session asking while the first already is would otherwise be invisible.
    const out = asks([
      track({
        refs: [
          session({ id: 1, externalId: 'claude:aaa', state: 'NEEDS_INPUT' }),
          session({ id: 2, externalId: 'claude:bbb', state: 'NEEDS_PERMISSION' }),
        ],
      }),
    ]);
    expect(out.map((a) => a.sessionId)).toEqual(['claude:bbb', 'claude:aaa']);
  });

  it('ignores sessions that are not asking for anything', () => {
    const out = asks([
      track({
        refs: [
          session({ id: 1, externalId: 'claude:aaa', state: 'WORKING' }),
          session({ id: 2, externalId: 'claude:bbb', state: 'NEEDS_INPUT' }),
        ],
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.sessionId).toBe('claude:bbb');
  });

  it('falls back to the track itself when no session is asking', () => {
    // A failing PR puts a track ON_ME with nothing inside it to point at.
    const [a] = asks([
      track({ courtRule: 'gh.checks_failed', refs: [session({ state: 'WORKING' })] }),
    ]);
    expect(a?.sessionId).toBeNull();
    expect(a?.says).toBe('CI is failing');
  });

  it('leaves tracks in anyone else’s court alone', () => {
    expect(asks([track({ court: 'ON_CLAUDE' }), track({ id: 2, court: 'PARKED' })])).toEqual([]);
  });

  it('puts the most urgent ask first, across tracks', () => {
    const out = asks([
      track({ id: 1, refs: [session({ state: 'FAILED' })] }),
      track({ id: 2, refs: [session({ state: 'NEEDS_PERMISSION' })] }),
      track({ id: 3, refs: [session({ state: 'NEEDS_INPUT' })] }),
    ]);
    expect(out.map((a) => a.trackId)).toEqual([2, 3, 1]);
  });
});

describe('notifiable', () => {
  it('does not interrupt anyone over a week of silence', () => {
    expect(notifiable('track.stale')).toBe(false);
    expect(notifiable('default')).toBe(false);
  });

  it('interrupts for a session that is actually blocked', () => {
    expect(notifiable('claude.needs_permission')).toBe(true);
    expect(notifiable('claude.needs_input')).toBe(true);
    expect(notifiable('claude.failed')).toBe(true);
  });
});

describe('toNotify', () => {
  const ask = (state: string, trackId = 1) =>
    asks([track({ id: trackId, refs: [session({ state })] })]);

  it('fires when an ask appears', () => {
    const { fire } = toNotify([], ask('NEEDS_INPUT'), new Map(), NOW);
    expect(fire.map((a) => a.rule)).toEqual(['claude.needs_input']);
  });

  it('stays quiet about an ask that was already there', () => {
    const now = ask('NEEDS_INPUT');
    const { fire } = toNotify(now, now, new Map(), NOW);
    expect(fire).toEqual([]);
  });

  it('rings once for a session that flaps in and out', () => {
    // The real shape of flapping, and the one a memo pruned by liveness gets
    // wrong: the ask GOES AWAY between the two polls. If disappearing clears
    // the cooldown, every return rings, which is no rate limit at all.
    const waiting = ask('NEEDS_INPUT');
    const first = toNotify([], waiting, new Map(), NOW);
    expect(first.fire).toHaveLength(1);
    // Back to work: nothing is asking.
    const quiet = toNotify(waiting, [], first.memo, NOW + 30_000);
    expect(quiet.fire).toEqual([]);
    // Waiting again a minute later — a fresh edge, and still inside the cooldown.
    const again = toNotify([], waiting, quiet.memo, NOW + MIN);
    expect(again.fire).toEqual([]);
  });

  it('rings again once the cooldown is over', () => {
    const waiting = ask('NEEDS_INPUT');
    const first = toNotify([], waiting, new Map(), NOW);
    const later = toNotify([], waiting, first.memo, NOW + 6 * MIN);
    expect(later.fire).toHaveLength(1);
  });

  it('lets a more urgent ask break the cooldown', () => {
    // Finishing a turn and then asking to run something are not the same
    // interruption; a rate limit that hides the second is worse than none.
    const turn = toNotify([], ask('NEEDS_INPUT'), new Map(), NOW);
    const { fire } = toNotify(ask('NEEDS_INPUT'), ask('NEEDS_PERMISSION'), turn.memo, NOW + MIN);
    expect(fire.map((a) => a.rule)).toEqual(['claude.needs_permission']);
  });

  it('does not let a less urgent ask break it the other way round', () => {
    const perm = toNotify([], ask('NEEDS_PERMISSION'), new Map(), NOW);
    const { fire } = toNotify(ask('NEEDS_PERMISSION'), ask('NEEDS_INPUT'), perm.memo, NOW + MIN);
    expect(fire).toEqual([]);
  });

  it('rate-limits per session, so two tracks both get through', () => {
    const both = [...ask('NEEDS_INPUT', 1), ...ask('NEEDS_INPUT', 2)];
    const { fire } = toNotify([], both, new Map(), NOW);
    expect(fire.map((a) => a.trackId)).toEqual([1, 2]);
  });

  it('never notifies about a stale track', () => {
    const stale = asks([track({ courtRule: 'track.stale' })]);
    expect(stale).toHaveLength(1);
    expect(toNotify([], stale, new Map(), NOW).fire).toEqual([]);
  });

  it('forgets a subject once its cooldown has run out, and not before', () => {
    const waiting = ask('NEEDS_INPUT');
    const first = toNotify([], waiting, new Map(), NOW);
    expect(first.memo.size).toBe(1);
    // Still owed a cooldown a minute later, even with nothing asking.
    const soon = toNotify(waiting, [], first.memo, NOW + MIN);
    expect(soon.memo.size).toBe(1);
    // Past it, the entry goes, so the map cannot grow without bound.
    expect(toNotify([], [], soon.memo, NOW + 6 * MIN).memo.size).toBe(0);
  });
});

describe('ruleWeight', () => {
  it('agrees with the order derivation sorts by', () => {
    expect(ruleWeight('claude.needs_permission')).toBeGreaterThan(ruleWeight('claude.needs_input'));
    expect(ruleWeight('claude.needs_input')).toBeGreaterThan(ruleWeight('claude.failed'));
    expect(ruleWeight('track.stale')).toBeGreaterThan(0);
    expect(ruleWeight('nothing.like.this')).toBe(0);
  });
});
