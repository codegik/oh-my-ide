# oh-my-ide

A local-first cockpit for running many parallel Claude Code sessions, built around
the **Track** — an open loop that binds sessions, PRs, tickets and Slack threads
into one thing with a status.

See [`docs/PLAN.md`](docs/PLAN.md) for the full design and
[`docs/decisions/`](docs/decisions/) for what has actually been settled by measurement.

## Running it

```sh
./start.sh            # build if needed, then open the app
```

The daemon keeps running after you close the window — that is deliberate, and it
is why closing the app never costs you a session.

Other commands:

| command | what it does |
|---|---|
| `./start.sh doctor` | check prerequisites (node, pnpm, claude, electron, socket) |
| `./start.sh status` | is the daemon up, and what sessions exist |
| `./start.sh build`  | force a rebuild |
| `./start.sh daemon` | run the daemon in the foreground with logs |
| `./start.sh stop`   | stop the daemon — **Claude sessions keep running** |
| `./start.sh install` | add oh-my-ide to the app launcher (walker, etc.) with its icon |

Requires Node 22+, pnpm, and Claude Code 2.1+ on `PATH`. From a fresh clone:

```sh
pnpm install
./start.sh            # fetches the electron binary on first run, then builds
```

## What works today

One window. **Tracks** on the left grouped by whose court the ball is in, open
tracks as **tabs** along the top, and the track itself in the middle: its
question, a one-line next action, a live terminal for its Claude session, its
refs, and a merged timeline.

- Create a track; it persists in SQLite.
- Paste a GitHub PR/issue URL, a Slack permalink, a Jira URL or a bare `PAY-123`
  and it becomes a typed ref. Pure regex — no API, no auth, works offline.
- Attach a background Claude session; its live TUI renders in the track, and you
  can type into it. Attach is non-exclusive, so `claude attach <id>` in your own
  terminal works at the same time.
- Court is **derived**: a running session makes a track ON CLAUDE, a session
  waiting on you makes it ON ME. Click the court chip to see which rule fired,
  and to pin, drop or close.
- Open tabs survive a restart.

There is deliberately **no Sessions screen**. Claude Code already has
`claude agents`; a session browser would duplicate it. A session is context
inside a track, not a destination.

Not built yet: the GitHub poller (so PR refs have no live state), branch-based
auto-join, the triage inbox, and Slack/Jira/Calendar.

## Architecture in one paragraph

Electron owns nothing durable and may be killed at any time. A detached daemon
(`omid`) owns the socket, the database and the pollers — but **no session
lifetime**. Claude Code's own background supervisor owns that, which is why
quitting the app cannot lose a session, and why `claude attach <id>` still works
from a plain terminal while the cockpit is attached to the same session.

```
Electron  ──unix socket──▶  omid daemon  ──documented CLI──▶  Claude supervisor
(disposable)                (restartable)                     (owns the sessions)
```

## Development

```sh
pnpm install
pnpm test                 # unit + contract tests
OMI_LIVE=1 pnpm vitest run # also run contract tests against the installed CLI
pnpm typecheck
```

`packages/claude-adapter` is the only package allowed to know that `~/.claude` or
the `claude` CLI exist. Everything it assumes is version-probed and degrades
rather than failing.
