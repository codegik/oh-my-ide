import type { Court, Derivation, Effective, TrackRef, TrackSnapshot } from './types.js';

/**
 * Whose court is the ball in. Deliberately NOT todo/doing/done: at 200 open
 * loops the only question that matters is whether something is waiting on you.
 *
 * Each rule reads ONE ref and returns a candidate. Highest weight wins.
 */
interface Rule {
  id: string;
  match(ref: TrackRef): { court: Court; weight: number; reason: string } | null;
}

const RULES: Rule[] = [
  {
    id: 'claude.needs_permission',
    match: (r) =>
      r.kind === 'claude_session' && r.state === 'NEEDS_PERMISSION'
        ? { court: 'ON_ME', weight: 100, reason: 'a session is waiting for your approval' }
        : null,
  },
  {
    id: 'gh.changes_requested',
    match: (r) =>
      r.kind === 'github_pr' && r.state === 'CHANGES_REQUESTED'
        ? { court: 'ON_ME', weight: 92, reason: 'changes requested on your PR' }
        : null,
  },
  {
    id: 'gh.checks_failed',
    match: (r) =>
      r.kind === 'github_pr' && r.state === 'CHECKS_FAILED'
        ? { court: 'ON_ME', weight: 88, reason: 'CI is failing on your PR' }
        : null,
  },
  {
    id: 'gh.review_requested_of_me',
    match: (r) =>
      r.kind === 'github_pr' && r.state === 'REVIEW_REQUESTED_OF_ME'
        ? { court: 'ON_ME', weight: 86, reason: 'your review was requested' }
        : null,
  },
  {
    id: 'claude.needs_input',
    match: (r) =>
      r.kind === 'claude_session' && r.state === 'NEEDS_INPUT'
        ? { court: 'ON_ME', weight: 80, reason: 'a session finished its turn and is waiting on you' }
        : null,
  },
  {
    id: 'claude.failed',
    match: (r) =>
      r.kind === 'claude_session' && r.state === 'FAILED'
        ? { court: 'ON_ME', weight: 70, reason: 'a session failed' }
        : null,
  },
  {
    id: 'claude.working',
    match: (r) =>
      r.kind === 'claude_session' && r.state === 'WORKING'
        ? { court: 'ON_CLAUDE', weight: 60, reason: 'a session is running' }
        : null,
  },
  {
    id: 'gh.checks_pending',
    match: (r) =>
      r.kind === 'github_pr' && r.state === 'CHECKS_PENDING'
        ? { court: 'ON_SYSTEM', weight: 45, reason: 'CI is running' }
        : null,
  },
  {
    id: 'gh.awaiting_review',
    match: (r) =>
      r.kind === 'github_pr' && r.state === 'AWAITING_REVIEW'
        ? { court: 'ON_THEM', weight: 35, reason: 'your PR is awaiting review' }
        : null,
  },
];

const COURT_ORDER: Record<Court, number> = {
  ON_ME: 0,
  ON_CLAUDE: 1,
  ON_SYSTEM: 2,
  ON_THEM: 3,
  PARKED: 4,
};

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export function derive(t: TrackSnapshot, now: number): Derivation {
  const candidates: Derivation[] = [];

  for (const ref of t.refs) {
    if (!ref.isBlocking) continue;
    for (const rule of RULES) {
      const hit = rule.match(ref);
      if (hit) candidates.push({ ...hit, rule: rule.id, refId: ref.id });
    }
  }

  if (t.waitingOn && !candidates.some((c) => c.court === 'ON_ME')) {
    candidates.push({
      court: 'ON_THEM',
      weight: 30,
      rule: 'track.waiting_on',
      reason: `waiting on ${t.waitingOn}`,
      refId: null,
    });
  }

  if (now - t.lastActivityAt > STALE_MS) {
    candidates.push({
      court: 'ON_ME',
      weight: 15,
      rule: 'track.stale',
      reason: 'nothing has happened here in over a week',
      refId: null,
    });
  }

  if (candidates.length === 0) {
    // An open loop with no signal is YOURS. Silence never means someone else's problem.
    return {
      court: 'ON_ME',
      weight: 10,
      rule: 'default',
      reason: 'nothing is blocking this but you',
      refId: null,
    };
  }

  candidates.sort(
    (a, b) => b.weight - a.weight || COURT_ORDER[a.court] - COURT_ORDER[b.court],
  );
  return candidates[0] as Derivation;
}

/**
 * Applies lifecycle and any manual pin on top of the derived value.
 * Precedence: terminal > park > hard pin > snooze > derived.
 */
export function effective(t: TrackSnapshot, now: number): Effective {
  const d = derive(t, now);

  if (t.lifecycle !== 'open') {
    return {
      court: t.lifecycle === 'dropped' ? 'DROPPED' : 'DONE',
      source: 'terminal',
      derivation: d,
      released: null,
    };
  }

  const pin = t.pin;
  if (pin) {
    if (pin.kind === 'park') {
      const awake = t.snoozeUntil !== null && now >= t.snoozeUntil;
      if (!awake) return { court: 'PARKED', source: 'park', derivation: d, released: null };
      return { court: d.court, source: 'derived', derivation: d, released: { reason: 'wake_condition_met' } };
    }
    if (pin.kind === 'hard') {
      if (d.weight <= pin.overrideWeight)
        return { court: pin.court, source: 'pin', derivation: d, released: null };
      // A high-weight signal breaks a pin — otherwise a pin could hide a session
      // that is actively blocked on you.
      return { court: d.court, source: 'derived', derivation: d, released: { reason: 'signal_override' } };
    }
    // snooze
    const expired = pin.expiresAt !== null && now >= pin.expiresAt;
    if (!expired && d.weight <= 85)
      return { court: pin.court, source: 'pin', derivation: d, released: null };
    return {
      court: d.court,
      source: 'derived',
      derivation: d,
      released: { reason: expired ? 'expired' : 'signal_override' },
    };
  }

  return { court: d.court, source: 'derived', derivation: d, released: null };
}
