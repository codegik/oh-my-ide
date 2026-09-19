# Working notes

Written 2026-09-17, at the end of the first build session. This is the orientation
document for a session starting cold: what exists, what is settled, what is
verified, and where the traps are.

Read order: this file → [`decisions/`](decisions/) → [`PLAN.md`](PLAN.md).
**Where PLAN.md and an ADR disagree, the ADR wins** — it records what was measured.

---

## What this is

A local-first Electron cockpit for a staff engineer running many parallel Claude
Code sessions. It exists to fix three stated frustrations:

1. losing Claude sessions when terminals close
2. Slack threads, Jira tickets, PRs and sessions not being bound to each other
3. not knowing where to start each morning

The central object is a **Track**: an open loop with an origin, a question, N
typed refs, a merged timeline and a one-line next action.

Frustration #1 turned out to be already solved by Claude Code itself (see ADR
0001), so the product's real weight is on #2 and #3.

---

## Layout (settled, ADR 0002)

One window. No Sessions screen, no Today screen.

```
┌ tabs: open tracks ─────────────────────────────────────────┐
├ track list ─┬ track: question · next action ───────────────┤
│ grouped by  │ ┌──────────────┬──────────────┐              │
│ court       │ │ live claude  │ refs         │              │
│ (= Today)   │ │ TUI in a PTY │ timeline     │              │
└─────────────┴─┴──────────────┴──────────────┘──────────────┘
```

Grouping the left rail by court **is** the morning view. "Where do I start" is
the ON ME group, already sorted — not a separate screen.

### Court, not todo/doing/done

`ON_ME · ON_CLAUDE · ON_THEM · ON_SYSTEM · PARKED`, derived from refs, with a
visible manual pin. Lifecycle (`open`/`done`/`dropped`) is separate and always
manual — **nothing ever auto-closes a Track.**

Two deliberate rules worth not "fixing":

- **An open loop with no signal is ON_ME.** Silence never means someone else's
  problem.
- **A high-weight signal breaks a hard pin**, and writes a timeline event saying
  why. Otherwise a pin could hide a session that is actively blocked on you.

---

## Repo map

```
packages/
  protocol/        binary framing + control message schemas. No deps but zod.
  core/            PURE, zero I/O: court derivation, ref URL parsing. All logic worth testing.
  db/              better-sqlite3, migration 0001, repositories. Daemon is the SOLE writer.
  claude-adapter/  THE quarantine — the only place allowed to know ~/.claude or the CLI exist.
apps/
  daemon/          omid: socket server, PTY hub, session→ref sync, court recompute tick.
  desktop/         Electron main (dumb frame proxy) + preload + renderer.
tools/
  fixtures/        real `claude --help` v2.1.272, kept as a contract fixture.
  scripts/         verify-abi.mjs, package-linux.mjs (the release tarball; see RELEASING.md)
packaging/
  linux/           /usr/bin/oh-my-ide launcher and the .desktop entry
  aur/             oh-my-ide-bin PKGBUILD; the release workflow publishes it
```

### Architectural spine

```
Electron (disposable) ──unix socket──▶ omid (restartable) ──documented CLI──▶ Claude supervisor
                                          │                                    (owns the sessions)
                                          └── SQLite (sole writer)
```

The daemon owns **no session lifetime**. That is why quitting the app cannot lose
a session, and why `systemctl --user restart` / a daemon crash costs nothing.

---

## Verified by measurement, not assumption

| Claim | How it was verified |
|---|---|
| `claude attach` gives a full-fidelity TUI with redraw | attached inside `pty.fork()`, saw `?1049h`, ED/CUP, banner, prior output |
| attach is **not** exclusive | two concurrent attaches, each got a complete independent redraw |
| a job survives detach | survived `SIGKILL` of the attach client plus two clean detaches |
| `claude agents --json` is TTY-free | ran it with stdout piped; it is the discovery source |
| `claude logs <id>` returns raw ANSI | dumped it through `cat -v` |
| native modules match Electron's ABI | `tools/scripts/verify-abi.mjs`, ABI 149 |
| the terminal pipeline works | real PTY output rendered in the app, screenshotted |

---

## Traps — each of these cost real time

**`pkill -f <path>` / `pgrep -f <path>` matches the process doing the matching.**
It killed the running shell twice. `./start.sh stop` now asks the daemon over its
socket via `daemon.shutdown`. Never reintroduce a broad pattern kill.

**`alert()` / `prompt()` / `confirm()` freeze the whole renderer** in Electron —
every terminal in every tab stops until dismissed. The "why?" popover and the
new-track input are inline for this reason. Do not reach for a modal.

**`claude attach` only works on BACKGROUND jobs.** An interactive session belongs
to a terminal the user already opened. The UI marks those un-attachable; an
attach on one fails with `No job matching <id>`.

**The compat probe must never sit on the `hello` path.** It shells out twice
(~200ms) and the UI asks for the welcome the moment the window loads, so a slow
welcome reads as "daemon unreachable". It is warmed at daemon boot.

**A socket FILE proves nothing.** Only a successful connect proves a live daemon;
a hard kill leaves the file behind. The listening socket is the single-instance
mutex — Node has no `flock`.

**The cwd→directory slug in `~/.claude/projects` is lossy.** A literal hyphen is
indistinguishable from a separator. Directory names may only enumerate candidate
files; identity always comes from the `cwd` field *inside* the JSONL.

**pnpm may skip electron's own postinstall**, so a fresh clone installs cleanly
and still has no electron binary to run. `./start.sh` fetches it on first build;
`./start.sh doctor` reports it. Verified from a clean clone.

**`pnpm` 10 blocks lifecycle scripts by default.** Without
`pnpm.onlyBuiltDependencies`, native modules install with no binary, silently.

**Build order matters.** Apps bundle the packages, so a stale `dist/` ships old
code. `./start.sh build` does packages before apps. Tests dodge this entirely by
aliasing `@omi/*` to source in `vitest.config.ts`.

**`claude agents --json` rows are not uniform.** Background rows carry
`id`/`state`; interactive rows carry `pid`/`status`. `packages/claude-adapter/src/agents.ts`
exists mostly to collapse that into one shape.

---

## State of play

Working: track CRUD, paste-to-link (GitHub/Slack/Jira/path/URL, pure regex),
attach a background session with a live interactive terminal, derived court with
a why-popover and pins, merged timeline, notes, tabs that survive restart.

Not built: the `gh` poller (**so PR refs have no live state and no `gh.*` court
rule can ever fire**), branch-based auto-join, the triage inbox, Slack/Jira/
Calendar, notifications, log persistence/replay beyond the in-memory ring.

### Known deviations from PLAN.md

- **The renderer is vanilla TS, not React + Zustand.** Deliberate: adding that
  build layer would not have changed what is on screen. Revisit when the UI grows.
- **No `event.log_offset` wiring yet** — the timeline cannot deep-link into
  terminal scrollback, because there is no persisted byte log, only a 2MB ring.

### The one non-obvious UI rule

`Terminal` instances live in a module-level `Map`, outside the view layer.
Re-rendering a tab must never dispose one — that throws away scrollback and forces
a full replay on every tab switch.

---

## Next step

The `gh` poller is the highest-value next move: it makes PR refs live, which turns
on the six `gh.*` court rules that are written and currently unreachable, and it
enables branch-based auto-join (`cwd` + `gitBranch` on a session vs a PR's head
branch). Without it, court derivation only ever sees Claude sessions.
