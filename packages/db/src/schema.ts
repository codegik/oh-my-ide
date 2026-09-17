/**
 * Migration 0001. The FULL Track shape ships now, even though only part of it is
 * written yet: adding it later is a migration, having it now means Tracks and
 * integrations are pure features with no schema pressure.
 */
export const MIGRATION_0001 = `
CREATE TABLE track (
  id               INTEGER PRIMARY KEY,
  public_id        TEXT    NOT NULL UNIQUE,
  title            TEXT    NOT NULL,
  question         TEXT,
  next_action      TEXT,

  origin_kind      TEXT    NOT NULL DEFAULT 'self'
                     CHECK (origin_kind IN ('slack','jira','incident','pr','issue',
                                            'calendar','email','self')),
  origin_url       TEXT,
  origin_actor     TEXT,
  origin_at        INTEGER,

  cwd              TEXT,
  git_branch       TEXT,

  lifecycle        TEXT    NOT NULL DEFAULT 'open'
                     CHECK (lifecycle IN ('open','done','dropped')),

  -- derived, cached so the left rail is one indexed query
  court            TEXT    NOT NULL DEFAULT 'ON_ME'
                     CHECK (court IN ('ON_ME','ON_CLAUDE','ON_THEM','ON_SYSTEM',
                                      'PARKED','DONE','DROPPED')),
  court_weight     INTEGER NOT NULL DEFAULT 0,
  court_rule       TEXT,
  court_reason     TEXT,
  court_source     TEXT    NOT NULL DEFAULT 'derived'
                     CHECK (court_source IN ('derived','pin','park','terminal')),

  waiting_on       TEXT,
  snooze_until     INTEGER,
  closed_at        INTEGER,
  closed_reason    TEXT CHECK (closed_reason IN ('done','dropped')),

  last_activity_at INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
) STRICT;
CREATE INDEX track_court ON track(court, court_weight DESC, last_activity_at DESC)
  WHERE closed_at IS NULL;
CREATE INDEX track_branch ON track(cwd, git_branch) WHERE git_branch IS NOT NULL;

CREATE TABLE track_ref (
  id           INTEGER PRIMARY KEY,
  track_id     INTEGER NOT NULL REFERENCES track(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('claude_session','github_pr','github_issue',
                 'slack_message','jira_issue','file','url','note')),
  external_id  TEXT NOT NULL,
  url          TEXT,
  label        TEXT,
  role         TEXT NOT NULL DEFAULT 'support'
                 CHECK (role IN ('origin','tracker','implementation','review',
                                 'discussion','reference','support')),
  state        TEXT,
  is_blocking  INTEGER NOT NULL DEFAULT 1,
  auto_linked  INTEGER NOT NULL DEFAULT 0,
  link_rule    TEXT,
  body         TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (track_id, kind, external_id)
) STRICT;
CREATE INDEX track_ref_track ON track_ref(track_id);
CREATE INDEX track_ref_ext   ON track_ref(kind, external_id);

CREATE TABLE event (
  id          INTEGER PRIMARY KEY,
  dedupe_key  TEXT NOT NULL UNIQUE,
  track_id    INTEGER REFERENCES track(id) ON DELETE CASCADE,
  ref_id      INTEGER REFERENCES track_ref(id) ON DELETE SET NULL,
  source      TEXT NOT NULL CHECK (source IN ('claude','github','slack','jira',
                'calendar','user','system')),
  kind        TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  importance  INTEGER NOT NULL DEFAULT 0,
  read_at     INTEGER
) STRICT;
CREATE INDEX event_track ON event(track_id, occurred_at DESC);

CREATE TRIGGER trg_event_touches_track AFTER INSERT ON event
WHEN NEW.track_id IS NOT NULL BEGIN
  UPDATE track SET last_activity_at = NEW.occurred_at, updated_at = NEW.occurred_at
   WHERE id = NEW.track_id AND last_activity_at < NEW.occurred_at;
END;

CREATE TABLE status_pin (
  id              INTEGER PRIMARY KEY,
  track_id        INTEGER NOT NULL REFERENCES track(id) ON DELETE CASCADE,
  court           TEXT NOT NULL CHECK (court IN ('ON_ME','ON_CLAUDE','ON_THEM',
                    'ON_SYSTEM','PARKED')),
  pin_kind        TEXT NOT NULL CHECK (pin_kind IN ('hard','snooze','park')),
  reason          TEXT,
  override_weight INTEGER NOT NULL DEFAULT 85,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER,
  released_at     INTEGER,
  release_reason  TEXT
) STRICT;
CREATE UNIQUE INDEX status_pin_active ON status_pin(track_id) WHERE released_at IS NULL;

CREATE TABLE setting (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
`;

export const MIGRATIONS: { version: number; sql: string }[] = [
  { version: 1, sql: MIGRATION_0001 },
];
