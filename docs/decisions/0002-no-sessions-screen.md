# ADR 0002 — No Sessions screen; the terminal lives inside a Track

Status: **accepted** · 2026-09-17

## Context

The plan had a top-level Sessions screen: a list of Claude sessions with an
embedded terminal. It was justified by the user's first frustration — "terminals
close and I lose the session."

[ADR 0001](0001-session-substrate.md) then found that Claude Code already ships
`claude --bg`, `claude attach`, and `claude agents`. That frustration is solved
by a tool the user already has.

The user put it directly: *"i don't need that screen, what that screen will bring
value to me?"*

## Decision

**There is no Sessions screen.** The layout is one window:

- a single Track list on the left, grouped by court
- open Tracks as tabs along the top
- the Track itself in the middle, with its session's terminal as one panel

A session is *context inside a Track*, not a destination.

## Why

A session list plus a terminal would have re-implemented `claude agents` with a
mouse. What it uniquely added was thin: several sessions visible at once, every
repo in one place, and notifications while the app is closed — a nicer tmux, not
a new capability.

The value was never the session. It is the **binding**: a session is worth
something when it is attached to the Slack thread that started it, the ticket it
belongs to, and the PR that came out of it. That is the gap nothing else fills.

## Consequences

- The Today screen also disappears. Grouping the left rail by court *is* the
  morning view — "where do I start" is the ON ME group, already sorted.
- The PTY hub, binary framing and xterm work all survive; only the browser around
  them was dropped.
- `claude attach` works **only on background jobs**. An interactive session
  belongs to a terminal the user already opened, so the UI marks those
  un-attachable rather than offering an attach that always fails.

## Rejected

**No embedded terminal at all** (spawn the user's real terminal instead). It
would have deleted the riskiest ~400 lines in the project, but loses side-by-side
watching and in-app scrollback. The `↗ open in my terminal` button keeps that
escape hatch, and attach being non-exclusive means both can be open at once.
