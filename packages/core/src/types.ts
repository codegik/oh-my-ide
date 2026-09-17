export type Court = 'ON_ME' | 'ON_CLAUDE' | 'ON_THEM' | 'ON_SYSTEM' | 'PARKED';
export type Lifecycle = 'open' | 'done' | 'dropped';

export type RefKind =
  | 'claude_session'
  | 'github_pr'
  | 'github_issue'
  | 'slack_message'
  | 'jira_issue'
  | 'file'
  | 'url'
  | 'note';

export interface TrackRef {
  id: number;
  kind: RefKind;
  externalId: string;
  url: string | null;
  label: string | null;
  /** Adapter-normalized state that derivation reads, e.g. 'NEEDS_INPUT', 'CHANGES_REQUESTED'. */
  state: string | null;
  isBlocking: boolean;
  /**
   * Which session inside the track this ref belongs to (a `claude:<uuid>` id), or
   * '' for the track as a whole. Two sessions on one track are usually working on
   * different things — different PR, different ticket — so a ref that is true for
   * one is not automatically true for the other. Derivation ignores this: whatever
   * any session is blocked on still puts the whole track in someone's court.
   */
  sessionId: string;
}

export interface TrackSnapshot {
  id: number;
  lifecycle: Lifecycle;
  refs: TrackRef[];
  snoozeUntil: number | null;
  waitingOn: string | null;
  lastActivityAt: number;
  pin: StatusPin | null;
}

export interface StatusPin {
  court: Court;
  kind: 'hard' | 'snooze' | 'park';
  expiresAt: number | null;
  overrideWeight: number;
  reason: string | null;
}

export interface Derivation {
  court: Court;
  weight: number;
  rule: string;
  reason: string;
  refId: number | null;
}

export interface Effective {
  court: Court | 'DONE' | 'DROPPED';
  source: 'derived' | 'pin' | 'park' | 'terminal';
  derivation: Derivation;
  /** Set when a pin was auto-released; the caller must write a timeline event. */
  released: { reason: string } | null;
}
