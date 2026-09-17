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
