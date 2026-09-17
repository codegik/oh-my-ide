import { describe, expect, it } from 'vitest';
import { derive, effective } from '../src/court.js';
import type { StatusPin, TrackRef, TrackSnapshot } from '../src/types.js';

const NOW = 1_800_000_000_000;

const ref = (over: Partial<TrackRef> = {}): TrackRef => ({
  id: 1,
  kind: 'claude_session',
  externalId: 'claude:x',
  url: null,
  label: null,
  state: null,
  isBlocking: true,
  sessionId: '',
  ...over,
});

const track = (over: Partial<TrackSnapshot> = {}): TrackSnapshot => ({
  id: 1,
  lifecycle: 'open',
  refs: [],
  snoozeUntil: null,
  waitingOn: null,
  lastActivityAt: NOW,
  pin: null,
  ...over,
});

describe('derive', () => {
  it('an open loop with no signal is asking for nobody', () => {
    // Not ON_ME: a court everything falls into by default cannot also be the
    // court that means "act now". Staleness, not silence, is what reclaims one.
    const d = derive(track(), NOW);
    expect(d.court).toBe('PARKED');
    expect(d.rule).toBe('default');
  });

  it('a blocked session outranks a running one', () => {
    const d = derive(
      track({
        refs: [
          ref({ id: 1, state: 'WORKING' }),
          ref({ id: 2, state: 'NEEDS_PERMISSION' }),
        ],
      }),
      NOW,
    );
    expect(d.court).toBe('ON_ME');
    expect(d.rule).toBe('claude.needs_permission');
    expect(d.refId).toBe(2);
  });

  it('a running session with nothing blocking is ON_CLAUDE', () => {
    expect(derive(track({ refs: [ref({ state: 'WORKING' })] }), NOW).court).toBe('ON_CLAUDE');
  });

  it('a PR awaiting review is ON_THEM, but changes requested is ON_ME', () => {
    const awaiting = ref({ kind: 'github_pr', state: 'AWAITING_REVIEW' });
    expect(derive(track({ refs: [awaiting] }), NOW).court).toBe('ON_THEM');
    const changes = ref({ kind: 'github_pr', state: 'CHANGES_REQUESTED' });
    expect(derive(track({ refs: [changes] }), NOW).court).toBe('ON_ME');
  });

  it('ignores refs marked non-blocking', () => {
    const d = derive(track({ refs: [ref({ state: 'NEEDS_PERMISSION', isBlocking: false })] }), NOW);
    expect(d.rule).toBe('default');
  });

  it('flags a track nobody has touched in a week', () => {
    const d = derive(track({ lastActivityAt: NOW - 8 * 864e5 }), NOW);
    expect(d.rule).toBe('track.stale');
    expect(d.court).toBe('ON_ME');
  });

  it('waiting_on only applies when nothing is on you', () => {
    expect(derive(track({ waitingOn: 'a reviewer' }), NOW).court).toBe('ON_THEM');
    const withBlocker = track({
      waitingOn: 'a reviewer',
      refs: [ref({ state: 'NEEDS_INPUT' })],
    });
    expect(derive(withBlocker, NOW).court).toBe('ON_ME');
  });
});

describe('effective', () => {
  const pin = (over: Partial<StatusPin> = {}): StatusPin => ({
    court: 'ON_THEM',
    kind: 'hard',
    expiresAt: null,
    overrideWeight: 85,
    reason: null,
    ...over,
  });

  it('a closed track is terminal regardless of signals', () => {
    const e = effective(
      track({ lifecycle: 'done', refs: [ref({ state: 'NEEDS_PERMISSION' })] }),
      NOW,
    );
    expect(e.court).toBe('DONE');
    expect(e.source).toBe('terminal');
  });

  it('a hard pin holds against ordinary signals', () => {
    const e = effective(track({ pin: pin(), refs: [ref({ state: 'WORKING' })] }), NOW);
    expect(e.court).toBe('ON_THEM');
    expect(e.source).toBe('pin');
  });

  it('but a high-weight signal breaks it and reports the release', () => {
    // Otherwise a pin could hide a session that is actively blocked on you.
    const e = effective(track({ pin: pin(), refs: [ref({ state: 'NEEDS_PERMISSION' })] }), NOW);
    expect(e.court).toBe('ON_ME');
    expect(e.source).toBe('derived');
    expect(e.released?.reason).toBe('signal_override');
  });

  it('a park holds until its wake time, then releases', () => {
    const parked = track({ pin: pin({ kind: 'park' }), snoozeUntil: NOW + 1000 });
    const held = effective(parked, NOW);
    expect(held.court).toBe('PARKED');
    expect(held.source).toBe('park');

    // `source`, not the court, is what says a park is still holding: a woken
    // track with no signal derives PARKED too, and the two are not the same
    // thing — one is a decision, the other is just quiet.
    const awake = track({
      pin: pin({ kind: 'park' }),
      snoozeUntil: NOW - 1,
      refs: [ref({ state: 'WORKING' })],
    });
    const e = effective(awake, NOW);
    expect(e.source).toBe('derived');
    expect(e.court).toBe('ON_CLAUDE');
    expect(e.released?.reason).toBe('wake_condition_met');
  });

  it('an expired snooze releases', () => {
    const e = effective(track({ pin: pin({ kind: 'snooze', expiresAt: NOW - 1 }) }), NOW);
    expect(e.source).toBe('derived');
    expect(e.released?.reason).toBe('expired');
  });
});
