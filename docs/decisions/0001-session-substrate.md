# ADR 0001 — Claude Code's background supervisor owns session lifetime

Status: **accepted** · 2026-09-17 · supersedes the tmux-substrate option in the plan

## Context

Sessions must survive closing the window, quitting the app, and the app crashing.
The plan left one gate open: does Claude Code's own background supervisor
(`claude --bg` / `attach`) provide a full-fidelity interactive TUI and survive
detach? If not, we fall back to tmux (`TmuxRunner`).

## Spike (run 2026-09-17, Claude Code v2.1.272)

Launched `claude --bg -n omi-spike "<trivial prompt>"`, attached inside a real
PTY via `pty.fork()`, and inspected the raw byte stream.

| # | Question | Result |
|---|---|---|
| 1 | Full-fidelity TUI, redraw on attach? | **YES** — alt-screen (`?1049h`), `ED`/`CUP`, banner, prompt box, and all prior output present in the first 3.4 KB after attach |
| 2 | Is attach exclusive? | **NO** — two concurrent attaches each got a complete independent redraw |
| 3 | Does detach leave the job running? | **YES** — survived `SIGKILL` of the attach client and two clean detaches |

Also established:

- `claude agents --json` is a **documented, TTY-free** listing of both background
  and interactive sessions. No file reverse-engineering needed for discovery.
- `claude logs <id>` returns the session's **raw ANSI byte stream**, no TTY required.
- `claude --bg` prints `backgrounded · <shortId> · <name>` — parseable.
- The short id is the **first 8 hex chars of `sessionId`**.
- `--bg` and `--print` conflict; the prompt is positional.

## Decision

`ClaudeBgRunner` is the default `SessionRunner`. **tmux is not used for Claude
sessions.** It remains the substrate for plain shells only, where no supervisor
exists.

## Consequences

- We do not stack two supervisors, so there is no disagreement to arbitrate.
- The user can `claude attach <id>` from any terminal *while our app is attached*
  — Q2 makes the cockpit genuinely non-exclusive.
- Discovery and state move from tier-3 file reads to a documented CLI surface,
  which materially lowers Risk #1 in the plan.
- `TmuxRunner` stays in the interface as the hedge if these flags ever change.

## Schema asymmetry to normalize in the adapter

`claude agents --json` is not uniform:

| field | background | interactive |
|---|---|---|
| `id` (short) | present | `null` |
| `pid` | present | present |
| `state` | `blocked`/`done`/… | `null` |
| `status` | `idle` (sometimes) | `idle`/`busy` |

The adapter must present one normalized shape to the rest of the app.
