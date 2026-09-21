import type { NormalizedSession } from '@omi/claude-adapter';
import { describe, expect, it } from 'vitest';
import { IdleWatch } from '../src/idle.js';

const MIN = 60_000;

function session(o: Partial<NormalizedSession> & { shortId: string }): NormalizedSession {
  return {
    sessionId: `${o.shortId}-0000-0000-0000-000000000000`,
    kind: 'background',
    cwd: '/tmp',
    name: null,
    startedAt: 0,
    pid: 1234,
    state: 'NEEDS_INPUT',
    rawState: 'blocked',
    busy: false,
    confidence: 'observed',
    ...o,
  };
}

const all = () => true;

/**
 * Stopping a session nobody is using frees a few hundred MB; stopping one that
 * is working, or one the user is typing into, loses work. The watch has to get
 * that difference right from nothing more than a poll of `claude agents`.
 */
describe('IdleWatch', () => {
  it('stops a session only after it has been quiet for the whole window', () => {
    const w = new IdleWatch(10 * MIN);
    const s = [session({ shortId: 'aaaaaaaa' })];
    expect(w.observe(s, all, 0)).toEqual([]);
    expect(w.observe(s, all, 9 * MIN)).toEqual([]);
    expect(w.observe(s, all, 10 * MIN)).toEqual(['aaaaaaaa']);
  });

  it('starts the clock on first sight, not at some imagined earlier idle', () => {
    // A daemon that just started knows nothing about the last ten minutes.
    const w = new IdleWatch(10 * MIN);
    expect(w.observe([session({ shortId: 'aaaaaaaa' })], all, 60 * MIN)).toEqual([]);
  });

  it('restarts the clock whenever the session is busy', () => {
    const w = new IdleWatch(10 * MIN);
    w.observe([session({ shortId: 'aaaaaaaa' })], all, 0);
    w.observe([session({ shortId: 'aaaaaaaa', busy: true })], all, 8 * MIN);
    expect(w.observe([session({ shortId: 'aaaaaaaa' })], all, 12 * MIN)).toEqual([]);
    expect(w.observe([session({ shortId: 'aaaaaaaa' })], all, 18 * MIN)).toEqual(['aaaaaaaa']);
  });

  it('trusts busy over state: a woken job reads "working" while doing nothing', () => {
    const w = new IdleWatch(10 * MIN);
    const woken = session({ shortId: 'aaaaaaaa', state: 'WORKING', busy: false });
    w.observe([woken], all, 0);
    expect(w.observe([woken], all, 10 * MIN)).toEqual(['aaaaaaaa']);
  });

  it('falls back to state when the row has no busy flag', () => {
    const w = new IdleWatch(10 * MIN);
    const working = session({ shortId: 'aaaaaaaa', state: 'WORKING', busy: null });
    w.observe([working], all, 0);
    expect(w.observe([working], all, 30 * MIN)).toEqual([]);
  });

  it('counts typing as use, even before anything is sent', () => {
    const w = new IdleWatch(10 * MIN);
    const s = [session({ shortId: 'aaaaaaaa' })];
    w.observe(s, all, 0);
    w.touch('aaaaaaaa', 7 * MIN);
    expect(w.observe(s, all, 12 * MIN)).toEqual([]);
    expect(w.observe(s, all, 17 * MIN)).toEqual(['aaaaaaaa']);
  });

  it('leaves alone what is not ours, interactive, or has no process', () => {
    const w = new IdleWatch(10 * MIN);
    const s = [
      session({ shortId: 'theirs00' }),
      session({ shortId: 'interact', kind: 'interactive' }),
      session({ shortId: 'noproc00', pid: null }),
    ];
    const ours = (x: NormalizedSession) => x.shortId !== 'theirs00';
    w.observe(s, ours, 0);
    expect(w.observe(s, ours, 60 * MIN)).toEqual([]);
  });

  it('starts over for a session that left the listing and came back', () => {
    const w = new IdleWatch(10 * MIN);
    const s = [session({ shortId: 'aaaaaaaa' })];
    w.observe(s, all, 0);
    w.observe([], all, 5 * MIN); // stopped, say, and later woken
    w.observe(s, all, 6 * MIN);
    expect(w.observe(s, all, 11 * MIN)).toEqual([]);
    expect(w.observe(s, all, 16 * MIN)).toEqual(['aaaaaaaa']);
  });

  it('forgets a session once it is stopped, so it is not stopped twice', () => {
    const w = new IdleWatch(10 * MIN);
    const s = [session({ shortId: 'aaaaaaaa' })];
    w.observe(s, all, 0);
    expect(w.observe(s, all, 10 * MIN)).toEqual(['aaaaaaaa']);
    w.forget('aaaaaaaa');
    // Still listed on the next tick while `claude stop` finishes.
    expect(w.observe(s, all, 10 * MIN + 5000)).toEqual([]);
  });
});
