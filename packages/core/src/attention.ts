import { ruleWeight } from './court.js';
import type { TrackRef } from './types.js';

/**
 * WHAT IS ASKING FOR YOU, as a list you can walk.
 *
 * The court says a track is ON_ME. That is enough to colour a dot, and not
 * enough to notify: "one of your tracks wants you" is not a sentence anyone can
 * act on. A notification has to name the thing — which track, which session,
 * what it wants — and land you on it. So this turns the court, which is one
 * value per track, back into the individual asks underneath it.
 *
 * Pure on purpose: it is the same list the tray menu lists and the notifier
 * fires from, and two copies of it would drift.
 */

/** A session state that puts the ball in your court, and the rule that says so. */
const SESSION_RULE: Record<string, string> = {
  NEEDS_PERMISSION: 'claude.needs_permission',
  NEEDS_INPUT: 'claude.needs_input',
  FAILED: 'claude.failed',
};

/** What each ask is called where a person reads it, short enough for a tray row. */
const RULE_SAYS: Record<string, string> = {
  'claude.needs_permission': 'wants your approval',
  'claude.needs_input': 'finished its turn',
  'claude.failed': 'failed',
  'gh.changes_requested': 'changes requested',
  'gh.checks_failed': 'CI is failing',
  'gh.review_requested_of_me': 'your review was requested',
  'track.stale': 'has been quiet for a week',
};

/** The track shape this needs — a subset of what `tracks.list` returns. */
export interface AttentionTrack {
  id: number;
  title: string;
  court: string;
  courtRule: string | null;
  courtReason: string | null;
  refs: TrackRef[];
}

export interface Ask {
  trackId: number;
  trackTitle: string;
  /** The session doing the asking (`claude:<uuid>`), or null when the track asks alone. */
  sessionId: string | null;
  sessionLabel: string | null;
  rule: string;
  /** How urgent, from the court rule table; what an escalation is measured against. */
  weight: number;
  /** One line, already written for a person: "auth refactor · wants your approval". */
  says: string;
}

/** Stable identity of an ask across polls: same track, same session, same rule. */
export const askKey = (a: Ask): string => `${a.trackId}/${a.sessionId ?? ''}/${a.rule}`;
/** Who is being interrupted, which is what a rate limit is per — not the rule. */
export const askSubject = (a: Ask): string => `${a.trackId}/${a.sessionId ?? ''}`;

/**
 * Every ask, most urgent first. A track can hold several sessions and more than
 * one of them can be waiting, so this is per (track, session) and not per track
 * — otherwise a second session asking while the first already was would be
 * silently swallowed by the track's single court value.
 *
 * A track can also be ON_ME with no session asking at all (a failing PR, a track
 * gone stale). Then the track itself is the ask, and `sessionId` is null.
 */
export function asks(tracks: AttentionTrack[]): Ask[] {
  const out: Ask[] = [];
  for (const t of tracks) {
    if (t.court !== 'ON_ME') continue;
    const asking = t.refs.filter(
      (r) => r.kind === 'claude_session' && SESSION_RULE[r.state ?? ''] !== undefined,
    );
    for (const r of asking) out.push(mk(t, r, SESSION_RULE[r.state ?? ''] as string));
    // Nothing inside the track is asking, so the track's own rule is the ask.
    if (asking.length === 0) out.push(mk(t, null, t.courtRule ?? 'default'));
  }
  return out.sort((a, b) => b.weight - a.weight || a.trackId - b.trackId);
}

function mk(t: AttentionTrack, ref: TrackRef | null, rule: string): Ask {
  const label = ref ? (ref.label ?? ref.externalId.replace(/^claude:/, '')) : null;
  const says = RULE_SAYS[rule] ?? t.courtReason ?? 'is waiting on you';
  return {
    trackId: t.id,
    trackTitle: t.title,
    sessionId: ref ? ref.externalId : null,
    sessionLabel: label,
    rule,
    weight: ruleWeight(rule),
    says: label ? `${label} · ${says}` : says,
  };
}

/**
 * Rules that are worth interrupting someone for.
 *
 * `track.stale` is deliberately not one: it fires at a week of silence, which is
 * true at an arbitrary second and urgent at none of them. The tray icon carries
 * it instead, which is what an ambient signal is for — the whole risk with a
 * notifier like this is that it cries wolf until it gets muted, and then the one
 * that mattered is muted too.
 */
export const notifiable = (rule: string): boolean => rule !== 'track.stale' && ruleWeight(rule) > 0;

/** What the notifier remembers between polls, per subject. */
export interface NotifyMemo {
  at: number;
  weight: number;
}

export interface NotifyDecision {
  /** Asks to fire now, most urgent first. */
  fire: Ask[];
  /** The memo to keep for the next call; replaces the one passed in. */
  memo: Map<string, NotifyMemo>;
}

const COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Which asks deserve a notification right now.
 *
 * Two gates, and both exist because of the same failure — a notifier nobody
 * trusts:
 *
 * 1. EDGES ONLY. An ask that was already there last poll has already been
 *    announced; a session sitting at NEEDS_INPUT for an hour is not news twelve
 *    times an hour.
 * 2. ONE PER SESSION PER FIVE MINUTES. A session that flaps between WORKING and
 *    NEEDS_INPUT produces a fresh edge every time, and the edge test alone would
 *    happily ring for each one.
 *
 * With one exception, because a rate limit that hides an escalation is worse
 * than no rate limit: a strictly more urgent ask about the same session breaks
 * the cooldown. Finishing a turn and then asking to run `rm -rf` are not the
 * same interruption, and the second must not be swallowed by the first.
 */
export function toNotify(
  prev: Ask[],
  next: Ask[],
  memo: Map<string, NotifyMemo>,
  now: number,
  cooldownMs = COOLDOWN_MS,
): NotifyDecision {
  const was = new Set(prev.map(askKey));
  const kept = new Map<string, NotifyMemo>();
  // Forgotten by AGE, never by whether the subject is still asking. Dropping a
  // memo the moment its ask goes away is the same thing as having no rate limit
  // at all: flapping is precisely a session whose ask keeps going away, and
  // each return would arrive to an empty memo and ring. Expiring at the
  // cooldown bounds the map just as well and keeps the limit honest.
  for (const [k, v] of memo) if (now - v.at < cooldownMs) kept.set(k, v);

  const fire: Ask[] = [];
  for (const a of next) {
    if (!notifiable(a.rule)) continue;
    if (was.has(askKey(a))) continue;
    const subject = askSubject(a);
    const last = kept.get(subject);
    const cooling = last !== undefined && now - last.at < cooldownMs;
    if (cooling && a.weight <= (last as NotifyMemo).weight) continue;
    fire.push(a);
    kept.set(subject, { at: now, weight: a.weight });
  }
  return { fire, memo: kept };
}
