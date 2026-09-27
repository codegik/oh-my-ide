# ADR 0003 — a track picks its agent; hermes sessions live in tmux

Status: **accepted** · 2026-09-27 · extends [ADR 0001](0001-session-substrate.md)

## Context

Hermes Agent (Nous Research) is installed on this machine alongside Claude Code,
and the cockpit should be able to run a conversation on either. Two questions
had to be answered before any of it could be built: **where the choice lives**
in the UI, and **who owns a hermes session's lifetime**.

ADR 0001 settled the second question for Claude: its own background supervisor
(`claude --bg` / `attach`) owns sessions, and tmux stays in reserve "as the
substrate for plain shells only, where no supervisor exists". Hermes turns out
to be exactly that case.

## What hermes gives us (measured 2026-09-27, v0.21.5)

| Question | Answer |
|---|---|
| A background/detach pair like `claude --bg` + `attach`? | **No.** `hermes --tui` is a foreground TUI; the closest things are `--resume <id>` and `-c` |
| A TTY-free listing like `claude agents --json`? | **No**, but better: `~/.hermes/state.db` has a row per session with `cwd`, `git_branch`, `title`, `last_activity_at`, `last_activity_description`, token counts and cost |
| A busy signal? | **Yes** — `session_turn_leases` holds a lease for the duration of a turn, and it expires on its own, so a crashed run cannot look busy forever |
| Does the TUI run under a detached tmux session? | **Yes** — full fidelity, verified by attaching from the app and reading the pane |
| When is a session written to the store? | **On its first message**, not at launch. A tab opened and not typed in has no hermes id at all |
| Per-request token counts? | **No.** Only per-session totals; `messages.token_count` is NULL for every row in the store |

## Decision

**1. The agent is a property of the Track.** One track, one CLI, every session
in it. It is chosen in the new-track sheet and can be changed until the track
has a session — the same rule as the track's folder, for the same reason: a
session is run by the CLI that started it and nothing can hand it to another.

**2. `HermesRunner` runs `hermes --tui` inside a detached tmux session**
(`omi-h-<key>`), and the daemon's PTY attaches to it. This is the tmux hedge
ADR 0001 reserved. It buys the three properties the app is built on: a session
that survives the window closing AND a daemon restart, a non-exclusive attach
(`tmux attach -t omi-h-…` from a real terminal works at the same time), and an
attach that can be closed without ending the conversation.

**3. A hermes session is keyed by OUR id, not hermes'.** Hermes files its
session on the first message, so a session we just started has no id of its own
to key by. The tmux name is the durable key; `track_ref.agent_session_id`
records hermes' id once it appears (migration 0005) and is what `--resume` and
every usage lookup use afterwards. Discovery is the tty marker
`~/.hermes/terminal-sessions/tty-dev-pts-N`, gated on the tmux session's start
time — pty numbers are recycled, and an ungated marker read hands back whatever
used that tty an hour ago.

**4. Nothing is renamed in the database.** The court stays `ON_CLAUDE`, refs stay
`claude_session`: those are the values every row holds and every rule matches
on, and renaming them means rebuilding two referenced tables to change a word
the UI does not print. The UI reads **THINKING**.

## Consequences

- **The cockpit's vocabulary is now agent-neutral.** `SessionRunner`,
  `NormalizedSession` and friends moved from `claude-adapter` to `core`;
  `packages/hermes-adapter` is a second quarantine, the only place allowed to
  know that `~/.hermes`, the `hermes` CLI or tmux exist.
- **tmux is a hard dependency for hermes**, and the wizard says so instead of
  hiding the option: without it, hermes is reported `unavailable` with the
  reason underneath a disabled button.
- **A hermes session's state is derived from two sources that cannot disagree**:
  tmux for "is it still there", the store for "what is it doing". Where the
  store has nothing yet, the state is reported with `confidence: 'derived'` —
  the hollow dot the UI already had for exactly this.
- **The session strip follows hermes' own titles.** Hermes titles a conversation
  from its first message and retitles it once it has read the work, so the label
  tracks the store rather than keeping whichever title arrived first. Only the
  first adoption writes a timeline event.
- **No context number for a hermes session.** It is the one figure hermes does
  not record, and the panel leaves the line out rather than printing an estimate
  that would look exactly as authoritative as Claude's real one. In exchange it
  shows something Claude's panel cannot: hermes prices its own conversations, so
  `cost` is a real figure rather than one we would have to keep a price table for.

## Traps found while building this (each cost real time)

**tmux's `=name` exact-match prefix only works on SESSION targets.** `attach-`,
`has-` and `kill-session` accept `-t =omi-h-…`; `capture-pane`, `send-keys` and
`set-option` parse a pane or window target and answer `can't find pane:
=omi-h-…`. Our `set-option` calls were failing silently for exactly this reason.
Bare names are safe here because every name we create is `omi-h-` plus a
fixed-length key, so no name can be a strict prefix of another.

**tmux `set-titles on` overwrites the terminal title with its own format.** The
daemon reads that title to name a session (`adoptTitle`), so with the user's
`set-titles-string '#h:#W'` every hermes session in the strip was labelled
`iomarchy:omi-hermes-work`. Our sessions set `set-titles off` and `status off`;
the prefix key is deliberately left alone so `tmux attach` still detaches the
way the user expects.

**`tmux new-session` refuses to run from inside tmux.** The daemon can perfectly
well be launched from a tmux pane, so `TMUX`/`TMUX_PANE` are dropped from the
environment of every tmux call we make.

## Verified by measurement, not assumption

Run against the real CLIs on 2026-09-27, through the built daemon and the real
window (`OMI_SMOKE_HERMES=1`, plus a CDP drive of the app on a hidden workspace):

| Claim | How |
|---|---|
| `hermes --tui` renders full-fidelity inside detached tmux | attached from the app, screenshotted the pane |
| a session started by the app is listed, attachable, in the right folder | smoke test, `sessions.list` |
| typing in the app reaches hermes | typed a prompt through the app's terminal; the turn ran |
| the state flips `IDLE → WORKING → IDLE` with the turn | polled `sessions.list`: `starting new turn`, busy, `confidence: observed` |
| hermes' own session id is discovered and persisted | `agentSessionId` appeared on the ref within one poll |
| the conversation can be picked up later | attached the same conversation to a new track; the pane showed the earlier turn |
| finishing a track stops its hermes session | smoke test; the tmux session was gone afterwards |
