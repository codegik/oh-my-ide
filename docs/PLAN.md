# oh-my-ide — a cockpit for parallel work

<!-- Canonical copy. The working copy lives at ~/.claude/plans/ and may drift; this one is authoritative. -->

> **Status as of 2026-09-17:** approved. Phase 0 is complete — see
> [`decisions/0001-session-substrate.md`](decisions/0001-session-substrate.md) for the spike
> that settled the session-substrate gate in favour of `ClaudeBgRunner` (tmux is not used for
> Claude sessions). Phase 1 has not started. Where this document and an ADR disagree, the ADR
> wins: it records what was actually measured.

## Context

Three frustrations, stated by the user, drive this entire design:

1. **"I love terminals, but I open too many terminals to run Claude tasks. Sometimes they close and I lose the session."**
2. **"Hard to manage 200 things in flight — Slack threads, Jira tickets, open PRs, investigations, 100 Claude sessions. They aren't bound together. Someone asks me something, I ask Claude to investigate, it takes time, and I no longer know where the Slack conversation was."**
3. **"Every day I start working and don't know where to start."**

These are not three features. They are one problem seen from three angles: **work has no durable container.** A terminal is a container that dies. A Jira ticket is a container that knows nothing about the investigation. A Slack thread is a container that scrolls away.

So the product is a container — the **Track** — over a session substrate that cannot lose your work.

Target user: one staff engineer/architect. Local-first, single-user, no server, no auth, no sync.

---

## The concept: a Track

A Track is **an open loop** — something you owe, to someone or to yourself. Not a task, not a project.

| Part | What it is |
|---|---|
| **Origin** | Where it came from: a Slack permalink, a Jira ticket, an incident, or "me". Answers *"where was that conversation?"* — the conversation is the Track's birth certificate. |
| **Question** | What the Track exists to answer, phrased as a question. Questions can be answered; labels rot silently. |
| **Refs** | N typed links: `claude_session`, `github_pr`, `github_issue`, `slack_message`, `jira_issue`, `file`, `url`, `note`, `calendar_event`. Flat, many-to-many, no hierarchy. |
| **Timeline** | One merged, append-only stream of everything that ever happened. The memory — you read it instead of reconstructing. |
| **Next action** | One line. *"Reply in #payments with the retry-storm finding."* Coming back costs one line of reading. |
| **Court** | Whose ball it is. Derived, not groomed. |

### Court (status), not todo/doing/done

Todo/doing/done is why Jira can't tell you where to start. At 200 open loops the only question that matters is *whose court is the ball in*:

```
ON_ME       I owe the next action                   ← this is today's work
ON_CLAUDE   a session is running; the machine is thinking
ON_THEM     waiting on a human: review, answer, decision
ON_SYSTEM   waiting on CI, a deploy, a date
PARKED      deliberately not now — has a wake condition
```

Lifecycle (`open` / `done` / `dropped`) is a **separate, always-manual** field. Court is derived only while `lifecycle = 'open'`. Two things fall out:

- **Frustration #3 stops being a feature.** "Where do I start today" is a query over court. A saved filter, not a screen we invent.
- **You stop grooming statuses**, the only reason status fields ever survive past week three.

**We never auto-close a Track.** A merged PR with green checks sets a `suggest_done` flag rendered as a dismissible chip. Closing is always a human act.

### Court derivation — precedence, first match wins

```
1. TERMINAL   closed_at set                               → DONE | DROPPED
2. PARK       active park pin ∧ wake condition unmet       → PARKED
3. HARD PIN   active hard pin ∧ derived.weight ≤ override  → pinned value
4. SNOOZE     active snooze ∧ unexpired ∧ weight ≤ 85      → pinned value
5. DERIVED    highest-weight signal over blocking refs
6. DEFAULT    no signals                                   → ON_ME (weight 10)
```

Rule 6 is deliberate: **an open loop with no signal is yours.** Silence never means someone else's problem.

| Rule | Condition | Court | W |
|---|---|---|---|
| `claude.needs_permission` | session awaiting tool approval | ON_ME | 100 |
| `gh.changes_requested` | your PR, changes requested | ON_ME | 92 |
| `gh.checks_failed` | your PR, CI red | ON_ME | 88 |
| `gh.review_requested_of_me` | your review requested | ON_ME | 86 |
| `claude.needs_input` | assistant turn ended, awaiting you | ON_ME | 80 |
| `gh.ready_to_merge` | approved ∧ mergeable ∧ green | ON_ME | 78 |
| `gh.conflict` | your PR conflicts | ON_ME | 76 |
| `claude.failed` | session died mid-turn | ON_ME | 70 |
| `claude.working` | session running | ON_CLAUDE | 60 |
| `gh.checks_pending` | CI running | ON_SYSTEM | 45 |
| `gh.awaiting_review` | your PR, reviewers assigned | ON_THEM | 35 |
| `claude.idle` | idle > 30 min | ON_ME | 25 |
| `track.stale` | no event in 7 days | ON_ME | 15 |

A park whose wake condition fires, a snooze that expires, or a hard pin broken by a high-weight signal **auto-releases and writes a timeline event** explaining why it reappeared. Nothing changes silently.

### Capture: branch as the join key, inbox as the gate

- Starting a Claude session creates or attaches a Track, named from the session's own `ai-title`.
- **Git branch + cwd is the primary auto-join key.** Sessions record both; PRs have a head branch. Same branch ⇒ same Track, zero effort. If exactly one open Track holds either side, the other auto-attaches (marked, one-click detachable). If none or several match, it becomes an inbox candidate — **we never auto-create a Track.**
- Pasting any Slack / Jira / GitHub URL offers *attach* or *new Track*. **Pure regex, no API** — 80% of the linking value on day one.

### Integrations are read-only mirrors in v1

The app reflects external state and deep-links out; you act in Slack/Jira/GitHub as you do today. No write scopes, no conflict resolution, a fraction of the build. v1 ships **GitHub only**, via the already-authenticated `gh` CLI. Slack, Jira, and Calendar are adapters behind an interface — designed for, not built.

---

## UI

Five screens. Everything monospace-dense; this is a tool for someone with 200 things open, not a consumer app.

### Today — the 8am screen, answerable in five seconds

```
┌─ oh-my-ide ─────────────────────────────────────────────────────────────────┐
│  Today   Tracks   Sessions   Inbox⁴   Terminals                    ⌘K   ⚙  │
├─────────────────────────────────────────────────────────────────────────────┤
│  Thursday 17 September                                                      │
│  4 need you · 3 running · 6 waiting · 4 to triage                           │
│                                                                             │
│  ON ME                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │ ● Why are payments timing out after the retry change?             100 │ │
│  │   → reply in #payments with the retry-storm finding                   │ │
│  │   ⧗ claude waiting for permission · 8h   PAY-4412  #8821    why? ▸   │ │
│  ├───────────────────────────────────────────────────────────────────────┤ │
│  │ ● Should we roll back the auth migration?                          92 │ │
│  │   → decide before the 14:00 arch review                               │ │
│  │   ⧗ #8790 changes requested · 1d                            why? ▸   │ │
│  ├───────────────────────────────────────────────────────────────────────┤ │
│  │ ● Review: ledger slice extraction                                  86 │ │
│  │   → no next action set                                   + add one    │ │
│  │   ⧗ review requested by a teammate · 2d  #8834              why? ▸   │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  WAITING                                                            6 ▾     │
│  ○ migration audit         ON CLAUDE   session running 22m                  │
│  ○ perf investigation      ON SYSTEM   CI pending on #8801                  │
│  ○ quarterly arch doc      ON THEM     waiting on a reviewer · 4d      ⚠   │
│                                                                             │
│  WAKING TODAY                                                               │
│  ◔ vendor SDK upgrade      parked until today · "when 2.0 ships"            │
└─────────────────────────────────────────────────────────────────────────────┘
```

Three queues, nothing else. Every row is: court dot · question · next action · the evidence that put it there. The `⚠` on a 4-day ON_THEM is the rot signal — it's how the other 190 Tracks stay survivable without being managed.

### Sessions — the cockpit

```
┌─ oh-my-ide ── Sessions ─────────────────────────────────────────────────────┐
│  active 7d ▾     ● 3 running   ◐ 2 need you   ○ 7 idle            + new     │
├──────────────────────────────┬──────────────────────────────────────────────┤
│ ◐ retry-storm         NEEDS  │ ~/src/payments · fix/retry-storm · $0.42     │
│   ~/src/payments  8h    YOU  │ ┌──────────────────────────────────────────┐ │
│ ● migration-audit    RUN 22m │ │ ● Read  src/client/retry.ts              │ │
│   ~/src/ledger               │ │ ● Bash  pnpm test --grep retry           │ │
│ ● auth-refactor      RUN 4m  │ │                                          │ │
│   ~/src/auth                 │ │ I found 3 tests sharing global state.    │ │
│ ◐ flaky-test-hunt     NEEDS  │ │                                          │ │
│   ~/src/api       2h    YOU  │ │ ╭─ Bash ─────────────────────────────╮   │ │
│ ● doc-sweep          RUN 1m  │ │ │ git checkout main && pnpm bench    │   │ │
│ ○ payment-bug     idle 3h    │ │ ╰────────────────────────────────────╯   │ │
│ ○ perf-investigation idle 1h │ │ Do you want to proceed?                  │ │
│ ○ sdk-upgrade     idle 2d    │ │ ❯ 1. Yes                                 │ │
│ ○ ledger-slice    idle 4d    │ │   2. Yes, and don't ask again            │ │
│                              │ │   3. No, tell Claude what to do          │ │
│ ⟳ arch-doc       RESUMABLE   │ └──────────────────────────────────────────┘ │
│   since reboot · 2d   resume │ [1] [2] [Esc]   ⧉ attach in terminal         │
└──────────────────────────────┴──────────────────────────────────────────────┘
```

The pane on the right is **the real `claude` TUI in a real PTY** — full fidelity, nothing reimplemented. The app adds only the chrome: the header line (cwd, branch, cost), the quick-reply buttons for a pending permission prompt, and `⧉ attach in terminal`, which copies the exact command to reattach from a plain shell. `⟳ RESUMABLE` is an honest state, not an error — see the durability table.

### Track detail — where "I don't know where I was" dies

```
┌─ Track ── payment timeouts ─────────────────────────────────────── ON ME ──┐
│ Why are payments timing out after the retry change, and do we roll back?    │
│                                                                            │
│ → reply in #payments with the retry-storm finding                     ✎   │
│                                                                            │
│ origin  slack · #payments · a teammate asked · 2d ago                  ↗  │
├───────────────────────────────────────────┬────────────────────────────────┤
│ TIMELINE                                  │ REFS                           │
│                                           │                                │
│ 2d ┃ asked in #payments               ↗  │ ◆ slack #payments         ↗   │
│    ┃ "payments are timing out since…"     │   origin · 2d                  │
│ 2d ┃ track created                        │                                │
│ 2d ┃ session retry-storm started          │ ◆ PAY-4412  In Progress   ↗   │
│ 1d ┃ claude: found retry storm in the     │   tracker                      │
│    ┃ payment client · 14 tool calls       │                                │
│ 1d ┃ PAY-4412 linked                      │ ◆ #8821  2 comments       ↗   │
│ 4h ┃ PR #8821 opened                      │   implementation               │
│    ┃ auto-linked · fix/retry-storm        │   auto · fix/retry-storm   ⊗  │
│ 8h ┃ ⚠ claude waiting for permission      │                                │
│    ┃   → jump to terminal            ▸   │ ◆ session retry-storm     ▶   │
│                                           │   NEEDS YOU · 8h · $0.42       │
│ ┌───────────────────────────────────────┐ │                                │
│ │ note…                                 │ │ + attach   ⌘L paste a link     │
│ └───────────────────────────────────────┘ │                                │
└───────────────────────────────────────────┴────────────────────────────────┘
```

Every `↗` leaves the app and acts in the real tool (v1 is a read-only mirror). `▸ jump to terminal` uses `event.log_offset` to scroll the session's scrollback to the exact byte where that event happened — that one column is what turns the timeline from a log into a navigation surface.

### The "why?" popover — the honesty valve

```
        ┌─ why is this ON ME? ─────────────────────────────┐
        │ rule   claude.needs_permission          weight 100│
        │ from   session retry-storm                        │
        │        waiting for approval on Bash · 8h          │
        │                                                   │
        │ also matched                                      │
        │   gh.changes_requested       #8821         92      │
        │   claude.idle                —             25      │
        │                                                   │
        │ ── override ─────────────────────────────────────│
        │ [pin ON THEM]  [park until…]  [snooze 1d]        │
        │ [mark done]    [drop]                            │
        └──────────────────────────────────────────────────┘
```

Derived status is only trustworthy if it can always explain itself and always be overridden. A pinned Track shows a `pin` badge everywhere, so you're never wondering whether the board is computing that row.

### Inbox — capture without clutter

```
┌─ Inbox ── 4 to triage ──────────────────────────────────────────────────────┐
│                                                                             │
│ ▸ PR #8821 opened · fix/retry-storm                                   2h    │
│   suggests → payment timeouts      branch matches a running session   0.9   │
│   [l] link    [n] new track    [d] dismiss    [s] snooze                    │
│                                                                             │
│   @you in #payments · a teammate                                      2h    │
│   "any update on the timeout thing?"                                        │
│   suggests → payment timeouts      the origin thread matches          0.8   │
│                                                                             │
│   PAY-4490 assigned to you                                            6h    │
│   no suggestion                                                             │
│                                                                             │
│   CI failed · auth-refactor · #8790                                   1d    │
│   suggests → auth migration rollback   branch matches                 0.9   │
└─────────────────────────────────────────────────────────────────────────────┘
```

Three keystrokes per item, no mouse. Pollers write here and **never** to `track`.

### Component structure

```
<App>
 └ <DaemonGate>                    handshake · protocol/schema mismatch wall
    ├ <CompatBanner/>              Claude adapter tier < supported
    └ <Shell>
       ├ <LeftRail/>               Today · Tracks · Sessions · Inbox · Terminals
       ├ <Router>
       │   ├ <TodayScreen>    <Queue kind="on_me"|"waiting"|"waking"/>
       │   ├ <TracksScreen>   <TrackList/> <TrackDetail>
       │   │      <NextActionEditor/> <StatusChip/>   ← the why? popover
       │   │      <RefRail/> <Timeline/> <NoteComposer/>
       │   ├ <SessionsScreen> <SessionTable/> <TerminalMosaic/>
       │   ├ <InboxScreen>    <CandidateRow/>*
       │   └ <TerminalsScreen><TerminalMosaic/>
       ├ <CommandPalette/>         ⌘K
       └ <StatusBar/>              daemon health · Claude compat tier
 └ <TerminalPortalRoot/>           xterm DOM lives HERE, outside the router
```

**The one non-obvious rule: xterm instances are not React state.** They live in a module-level `Map<viewId, {term, fit, webgl, epoch, expect}>` rendered into portals. React only mounts a positioned `<div>` and calls `fit()`. Unmounting a tab must never dispose the terminal — that throws away scrollback and forces a replay on every tab switch. Disposal is explicit: on close, or LRU past ~12 live terminals. Getting this wrong is the most common way xterm-in-React apps become unusable.

**State management:** TanStack Query v5 over the RPC channel for everything in SQLite — the daemon's `changed {entity, ids}` push maps directly to `invalidateQueries`. Zustand for UI-local state (layout, focus, mosaic geometry). **Terminal bytes go through neither** — straight from the IPC listener to `term.write()`. Tailwind v4 + Radix + lucide. Rejected: Redux (ceremony), any live-query-over-SQLite library (breaks the single-writer rule).

---

## Architecture

### The honest durability table

> **No process survives a reboot.** What survives is *identity*: the Track, the session id, the transcript, and the byte log. The PTY is a disposable attachment to that identity.

| Event | Guarantee |
|---|---|
| Close window | Untouched, still producing output |
| Quit app | Untouched |
| **Our own app or daemon crashes** | **Untouched, output still captured** |
| Logout / compositor crash | Survives only with `loginctl enable-linger` |
| Reboot | Process gone → `RESUMABLE`. One click resumes by session id; the full conversation replays from the transcript |

`loginctl show-user` reports `Linger=no` here. Surface `loginctl enable-linger $USER` as a one-click setup item **with the exact command shown** — never run it silently. Don't oversell this in UI copy: `RESUMABLE` gets its own color and a Resume button, because a revive is not a continuation.

### Processes

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ELECTRON — owns nothing durable, dies freely, ZERO native modules        │
│   renderer (React + xterm.js) ── preload (contextBridge) ── main (proxy) │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │ framed binary over
                             │ $XDG_RUNTIME_DIR/oh-my-ide/daemon.sock
┌────────────────────────────▼─────────────────────────────────────────────┐
│ omid DAEMON  (electron binary, ELECTRON_RUN_AS_NODE=1; systemd --user)   │
│   PtyHub (view PTYs, ring + raw log)   TranscriptWatcher (read-only)     │
│   Pollers (gh CLI)                     Core: state machine · derivation  │
│   SOLE WRITER → better-sqlite3 (WAL) ~/.local/share/oh-my-ide/omid.db    │
└──────────┬──────────────────────────────────────────┬────────────────────┘
           │ spawn, documented CLI only               │ read-only, never written
           ▼                                          ▲
┌──────────────────────────┐              ┌───────────┴────────────────────┐
│ SESSION SUBSTRATE        │ transcripts  │ ~/.claude/projects/**/*.jsonl  │
│ (SessionRunner — see     ├─────────────►│ tier-3 sessions//jobs/: flagged│
│  the Phase 0 gate)       │              └────────────────────────────────┘
└──────────────────────────┘
           ▲  user's own terminal, any time, no GUI:
           │  `claude attach <id>`   or   `tmux attach -t omid-<slug>`
```

**The daemon owns no session lifetime.** It owns disposable view PTYs, the SQLite write lock, the transcript watcher, pollers, derivation, and notifications-while-closed. That last one is why a daemon exists at all: "Claude finished while I was in a meeting" must be recorded and notified with no window open.

Blast radius is the governing principle. If our v1 daemon owned the sessions, one unhandled rejection loses 100 of them and breaks the product's core promise with our own bug. Here `systemctl --user restart omid` costs nothing.

### The Phase 0 gate: which substrate owns Claude sessions

Two candidates, and **the choice is empirical, not architectural.** Both sit behind one interface:

```ts
export interface SessionRunner {
  start(o: {cwd, name?, prompt?, sessionId?}): Promise<StartedSession>;
  attachCommand(s: {sessionId, jobId?}): {file: string; args: string[]};
  resume(o: {sessionId, fork?}): Promise<StartedSession>;
  stop(s: {sessionId}): Promise<void>;
  list(): Promise<ListedSession[]>;
}
class ClaudeBgRunner implements SessionRunner  // claude --bg / attach / stop / respawn / agents
class TmuxRunner     implements SessionRunner  // tmux new-session -d -s omid-<id> claude …
```

`ClaudeBgRunner` is preferred *if it passes the spike*: it avoids stacking two supervisors (which have no tiebreaker when they disagree), and `claude attach <id>` works from any bare terminal without our app. `TmuxRunner` is the hedge, and remains the substrate for plain shells regardless — one substrate per problem.

**Before any dependent code is written, answer three questions with a throwaway script in `tools/`:**
1. Does `claude attach <id>` inside a node-pty give a full-fidelity interactive TUI, with a redraw on attach?
2. Is attach exclusive, or can two clients attach at once?
3. Does detaching leave the background job running?

If 1 or 3 fails, flip the default to `TmuxRunner` before writing any UI. That is the entire reason the interface exists.

### Output capture and gapless replay

Per view the daemon keeps an in-memory **2 MB ring** plus an append-only **raw log** (`pty/<viewId>.<epoch>.raw`, rotate at 8 MB, keep 3 → 24 MB/view cap, `fsync` never — this is cache, not truth). `head` is a monotonic u64 byte offset since the view's epoch.

**The invariant that removes every edge case: one ordered outbound queue per (subscriber, view), with replay bytes enqueued into the same queue before any live byte.** Ordering becomes structural, not timing-dependent — a live chunk can never overtake a replay chunk, so there is no "switching to live" moment to get wrong.

```ts
attach(sub, haveEpoch, haveThrough, maxReplay) {
  let from: bigint;
  if (haveEpoch === this.epoch && haveThrough !== null &&
      haveThrough <= this.head && this.head - haveThrough <= BigInt(this.ring.size)) {
    from = haveThrough;                    // seamless resume, zero duplicate bytes
  } else {
    from = this.head - BigInt(Math.min(this.ring.length, maxReplay));
    sub.send({t:'pty.resync', viewId: this.id, epoch: this.epoch, head: this.head});
  }
  sub.push(from, this.ring.slice(from, this.head));   // replay FIRST, same queue
  this.subs.set(sub.id, sub);
}
```

The client's whole contract is one assertion — `offset === expect`, else re-attach from scratch. **Epoch** exists for exactly one reason: a view can be recreated (we re-ran attach after a daemon restart) and offsets restart at 0; without epochs a stale client silently splices two unrelated byte streams.

**Backpressure, three layers in order:**
1. **Never stall the PTY.** Always drain node-pty, always write to ring + log. Pausing would block the agent's stdout mid-task — our *viewer* must never affect agent progress.
2. **Coalesce at frame rate.** Flush each subscriber's queue on a 16 ms timer. 5000 small writes/sec becomes ~60 IPC frames/sec.
3. **Degrade to lossy.** Socket `write()` false and queue > 4 MB ⇒ drop the queue, and on `drain` send `pty.resync` + ring tail. A 200-line viewport cannot render 4 MB; dropping intermediate frames is *semantically correct* for a terminal view.

### Transport & framing

`AF_UNIX` at `$XDG_RUNTIME_DIR/oh-my-ide/daemon.sock`, mode 0600, `SO_PEERCRED` uid check. Electron main is a dumb frame proxy; renderer runs `nodeIntegration: false, contextIsolation: true, sandbox: true`. Terminal output is attacker-controlled bytes from arbitrary repos — there must be no path from it to Node in the renderer.

Length-prefixed binary, ~80 lines, zero deps. JSON-with-base64 wastes 33% on the one path that can be megabytes:

```
┌───────────┬────────┬────────────────────────────────────────────┐
│ u32be len │ u8 typ │ payload                                    │
└───────────┴────────┴────────────────────────────────────────────┘
0x01 CONTROL  UTF-8 JSON, zod discriminated union
0x02 PTY_OUT  [u16be idLen][viewId][u32be epoch][u64be offset][bytes]
0x03 PTY_IN   [u16be idLen][viewId][bytes]
```

`hello`/`welcome` carries a protocol integer, the DB schema version, and the Claude compat probe. Version skew (daemon from yesterday's build, UI from today's) is **guaranteed** in real use — show a blocking "restart daemon" banner. This is only tolerable because the daemon owns no session lifetime.

Singleton: `flock` on `daemon.lock` before binding. Electron startup: connect → else `systemctl --user start oh-my-ide-daemon` → else `spawn(detached:true, stdio:'ignore').unref()` → retry with backoff for 5 s. Never `stdio:'inherit'` — it keeps a pipe to Electron alive.

---

## The Claude adapter — the quarantine

`packages/claude-adapter` is the **only** place allowed to know `~/.claude` exists. Enforced by a lint rule plus a CI grep: no other package may contain the string `.claude`.

| Tier | Source | Trust | On failure |
|---|---|---|---|
| 1 | Documented CLI flags (`--bg`, `attach`, `logs`, `stop`, `respawn`, `agents`, `--resume`, `--fork-session`, `--session-id`, `-n`, `--from-pr`) | contractual | surfaced error |
| 2 | Transcript JSONL | high | lenient parse, unknown → generic event |
| 3 | `sessions/*.json`, `jobs/*/state.json` | **none** — feature-flagged enrichment | disable silently, never block |
| 4 | Internal unix sockets | forbidden — never touched | n/a |

**Nothing in tier 3 may ever be load-bearing.** A chaos test runs the full suite with tier 3 forced off and must pass identically.

**Degradation ladder.** (1) Full. (2) Tier 3 gone — no user-visible change. (3) Transcript schema unrecognized — sessions still start/attach/list; state falls back to "bytes flowing = working, 30 s quiet = idle". (4) No `--bg` — `SessionRunner` swaps to `TmuxRunner`. (5) Nothing works — a competent terminal multiplexer with a Track database. Still useful.

**Capability probe** parses `claude --version` + `--help` once per version, caches the result keyed by version, and re-probes when the `version` field observed in a transcript changes. A version change emits `compat.changed` and a one-line banner.

**Safety rails, enforced in one function** every read passes through:

```ts
const DENY = [/^\.credentials\.json$/, /\.key$/, /\.pem$/, /token/i];
const ALLOW = [{dir:'projects', ext:'.jsonl'}, {dir:'sessions', ext:'.json'}, {dir:'jobs', ext:'.json|.jsonl'}];
export function safeOpen(abs: string) { /* traversal check, denylist, allowlist, O_RDONLY */ }
```

**The cwd→directory slug is lossy** (a literal hyphen is indistinguishable from a separator). Directory names are used *only to enumerate candidate files*. Identity always comes from the `cwd` field inside the JSONL. Never reconstruct a path from a slug.

**Transcript tailer** keeps `(path, inode, offset, partial)` per session, persisted to the DB so a daemon restart resumes without re-ingesting. Inode change ⇒ rotated, reset. `size < offset` ⇒ truncated, resync. Incomplete trailing lines are held, never parsed. `parseRecordLenient` validates only what we depend on (`type`, `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `gitBranch`, `version`) with zod `.passthrough()`; unknown `type` values become neutral timeline dots, never errors. `event.dedupe_key = 'claude:' + record.uuid` makes ingestion idempotent regardless.

**Privacy.** Transcripts contain plaintext work data. Default to storing a 200-char summary plus structured metadata; full bodies behind an opt-in setting. DB and logs 0600. Nothing is ever transmitted — no server exists. Ship a documented "wipe local data" action.

---

## Session state machine — transcript first, process second, never the terminal stream

```
STARTING → WORKING ⇄ NEEDS_PERMISSION | NEEDS_INPUT | IDLE → STOPPED | FAILED
                                              (+ UNKNOWN, ARCHIVED, RESUMABLE)
```

| State | Primary signal (transcript) | Notes |
|---|---|---|
| `WORKING` | record appended < 15 s ago, or `tool_use` with a matching `tool_result` | the common case |
| `NEEDS_PERMISSION` | last record `assistant` `stop_reason='tool_use'`, **matching `tool_result` absent**, quiet > 8 s | the highest-value detection in the app |
| `NEEDS_INPUT` | last record `assistant` `stop_reason='end_turn'`, job alive | your turn |
| `IDLE` | `NEEDS_INPUT` held > 30 min | demoted, not an alert |
| `STOPPED` | job absent ∧ tail is a clean `end_turn` | |
| `FAILED` | job absent ∧ tail is mid-turn, or a `system` error record | |
| `RESUMABLE` | transcript exists, no process (e.g. post-reboot) | one-click resume |

```ts
// packages/core/src/session-state.ts — pure, no I/O, no reference to terminal bytes
export function nextState(prev, o: Observation, now): StateProposal {
  if (!o.jobAlive && o.jobListFresh)
    return o.tailIsCleanTurn ? mk('STOPPED','job gone, clean end_turn')
                             : mk('FAILED','job gone mid-turn');
  if (o.tail?.type === 'assistant' && o.tail.stopReason === 'tool_use' && !o.tailToolResolved)
    return now - o.lastRecordAt > 8_000
      ? mk('NEEDS_PERMISSION', `awaiting approval for ${o.tail.toolName}`)
      : mk('WORKING', 'tool in flight');
  if (o.tail?.type === 'assistant' && o.tail.stopReason === 'end_turn')
    return now - o.lastRecordAt > 30*60_000 ? mk('IDLE','idle > 30m')
                                            : mk('NEEDS_INPUT','assistant finished its turn');
  if (now - o.lastRecordAt < 15_000) return mk('WORKING','transcript advancing');
  return mk(prev, 'no change');
}
```

**The PTY is pixels; the transcript is truth.** Screen-scraping the TUI is a fallback (rung 3 of the ladder), never the primary path — that inverts the usual fragility. Rules for the fallback live in a user-editable `detectors.json`, hot-reloaded, so a TUI change never requires an app release.

Anti-flap: two consecutive observations before committing; hysteresis on the 8 s permission threshold (leave immediately on any new record); `state_confidence` ∈ `observed | derived | stale`, with `stale` rendered as a hollow dot — **honest ambiguity beats a confident lie.** Only `NEEDS_PERMISSION` and `FAILED` notify, rate-limited to one per session per 5 min. Poll cadence for the job list: 2 s while anything is working, 15 s when idle, 60 s when the window is hidden.

`packages/core` has **zero I/O imports**. Derivation and the state machine are pure functions over snapshots, exhaustively testable without a Claude install. This is the highest-leverage structural decision in the repo.

---

## Data model

`~/.local/share/oh-my-ide/omid.db`. `STRICT` tables, WAL, `foreign_keys=ON`, daemon is the sole writer, **terminal bytes never enter the DB**. Numbered `.sql` migrations gated on `PRAGMA user_version`. No ORM — `better-sqlite3` prepared statements in typed repositories.

The forward-compatibility bet: rather than a `track` table with `slack_url` / `jira_key` / `pr_url` columns (which rots the instant a Track has two PRs), `track_ref` is a generic typed link. Every mirror table keeps `raw` JSON so a provider schema change is a re-derive, not a re-fetch.

```sql
PRAGMA journal_mode = WAL;  PRAGMA foreign_keys = ON;  PRAGMA busy_timeout = 5000;

CREATE TABLE workspace (
  id INTEGER PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,          -- absolute, from transcript cwd, NEVER the slug
  repo_host TEXT, repo_owner TEXT, repo_name TEXT, default_branch TEXT,
  last_seen_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE track (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,          -- ULID; deep links omid://track/<id>
  title TEXT NOT NULL,
  question TEXT,                           -- the open loop this exists to close
  next_action TEXT,                        -- one line; the only thing Today shows

  origin_kind TEXT NOT NULL CHECK (origin_kind IN
    ('slack','jira','incident','pr','issue','calendar','email','self')),
  origin_url TEXT, origin_actor TEXT, origin_at INTEGER,

  workspace_id INTEGER REFERENCES workspace(id) ON DELETE SET NULL,
  git_branch TEXT,                         -- PRIMARY AUTO-JOIN KEY

  derived_status TEXT CHECK (derived_status IN
    ('ON_ME','ON_CLAUDE','ON_THEM','ON_SYSTEM','PARKED','DONE','DROPPED')),
  derived_weight INTEGER NOT NULL DEFAULT 0,
  derived_rule TEXT,                       -- 'claude.needs_permission'
  derived_reason TEXT,                     -- human string for the why? popover
  derived_ref_id INTEGER, derived_at INTEGER,

  effective_status TEXT NOT NULL DEFAULT 'ON_ME' CHECK (effective_status IN
    ('ON_ME','ON_CLAUDE','ON_THEM','ON_SYSTEM','PARKED','DONE','DROPPED')),
  status_source TEXT NOT NULL DEFAULT 'derived'
    CHECK (status_source IN ('derived','pin','park','terminal')),
  status_changed_at INTEGER NOT NULL,

  priority INTEGER NOT NULL DEFAULT 0,
  closed_at INTEGER, closed_reason TEXT CHECK (closed_reason IN ('done','dropped')),
  last_activity_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX track_today  ON track(effective_status, derived_weight DESC, last_activity_at DESC)
                           WHERE closed_at IS NULL;
CREATE INDEX track_branch ON track(workspace_id, git_branch) WHERE git_branch IS NOT NULL;

CREATE TABLE track_ref (
  id INTEGER PRIMARY KEY,
  track_id INTEGER NOT NULL REFERENCES track(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('claude_session','github_pr','github_issue',
    'slack_message','jira_issue','file','url','note','calendar_event')),
  external_id TEXT NOT NULL,               -- 'claude:<uuid>', 'gh:owner/repo#123'
  url TEXT, label TEXT,
  role TEXT NOT NULL DEFAULT 'support' CHECK (role IN ('primary','support','evidence')),
  state TEXT, state_detail TEXT,           -- adapter-normalized; drives derivation
  is_blocking INTEGER NOT NULL DEFAULT 1,  -- 0 = informational, excluded from derivation
  auto_linked INTEGER NOT NULL DEFAULT 0,
  link_rule TEXT, link_confidence REAL,    -- 'branch+cwd' | 'manual' | 'inbox'
  body TEXT,                               -- for kind='note'
  mirrored_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(track_id, kind, external_id)
) STRICT;
CREATE INDEX track_ref_external ON track_ref(kind, external_id);

CREATE TABLE event (                       -- the spine: append-only, merged timeline
  id INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,         -- 'claude:<record.uuid>', 'gh:pr:123:review:456'
  track_id INTEGER REFERENCES track(id) ON DELETE SET NULL,   -- NULL = not yet bound
  ref_id INTEGER REFERENCES track_ref(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES claude_session(session_id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN
    ('claude','github','slack','jira','calendar','user','system')),
  kind TEXT NOT NULL,                      -- 'claude.assistant.turn', 'github.pr.checks.failed'
  occurred_at INTEGER NOT NULL, ingested_at INTEGER NOT NULL, actor TEXT,
  summary TEXT,                            -- <=200 chars, always safe to render
  body TEXT,                               -- gated by setting transcript.storeBodies
  payload TEXT,                            -- json, bounded 32KB
  log_offset INTEGER,                      -- deep-link into the byte log
  cost_usd REAL, tokens_in INTEGER, tokens_out INTEGER
) STRICT;
CREATE INDEX event_track   ON event(track_id, occurred_at DESC);
CREATE INDEX event_unbound ON event(occurred_at DESC) WHERE track_id IS NULL;

CREATE TABLE claude_session (
  session_id TEXT PRIMARY KEY,             -- Claude's uuid; our only join key to Claude
  transcript_path TEXT NOT NULL, transcript_inode INTEGER,
  transcript_offset INTEGER NOT NULL DEFAULT 0,
  cwd TEXT NOT NULL,                       -- from JSONL, authoritative
  git_branch TEXT,
  workspace_id INTEGER REFERENCES workspace(id) ON DELETE SET NULL,
  display_name TEXT, ai_title TEXT, last_prompt TEXT,
  cli_version TEXT, permission_mode TEXT,
  is_background INTEGER NOT NULL DEFAULT 0,
  job_short_id TEXT, supervisor_pid INTEGER,   -- TIER 3: nullable, never load-bearing
  parent_session_id TEXT,                      -- --resume / --fork-session lineage
  state TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (state IN ('STARTING','WORKING',
    'NEEDS_INPUT','NEEDS_PERMISSION','IDLE','FAILED','STOPPED','RESUMABLE','UNKNOWN','ARCHIVED')),
  state_reason TEXT, state_since INTEGER NOT NULL,
  state_confidence TEXT NOT NULL DEFAULT 'derived'
    CHECK (state_confidence IN ('observed','derived','stale')),
  last_record_uuid TEXT, last_activity_at INTEGER,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX session_state  ON claude_session(state, last_activity_at DESC);
CREATE INDEX session_branch ON claude_session(workspace_id, git_branch);

CREATE TABLE pty_view (                    -- OUR terminal views: disposable
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('claude_attach','shell')),
  session_id TEXT REFERENCES claude_session(session_id) ON DELETE SET NULL,
  track_id INTEGER REFERENCES track(id) ON DELETE SET NULL,
  tmux_name TEXT, cwd TEXT NOT NULL, argv TEXT NOT NULL,
  cols INTEGER NOT NULL DEFAULT 120, rows INTEGER NOT NULL DEFAULT 32,
  epoch INTEGER NOT NULL DEFAULT 1, log_path TEXT,
  head_offset INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','exited','orphaned')),
  exit_code INTEGER, created_at INTEGER NOT NULL, closed_at INTEGER
) STRICT;

CREATE TABLE status_pin (
  id INTEGER PRIMARY KEY,
  track_id INTEGER NOT NULL REFERENCES track(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ON_ME','ON_CLAUDE','ON_THEM','ON_SYSTEM','PARKED')),
  pin_kind TEXT NOT NULL CHECK (pin_kind IN ('hard','snooze','park')),
  note TEXT,
  wake_condition TEXT,                     -- json: {type:'time'|'ref_state'|'ref_event'|'any_activity'}
  override_weight INTEGER NOT NULL DEFAULT 85,
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL DEFAULT 'user',
  expires_at INTEGER, released_at INTEGER, release_reason TEXT
) STRICT;
CREATE UNIQUE INDEX status_pin_one_active ON status_pin(track_id) WHERE released_at IS NULL;

CREATE TABLE inbox_candidate (             -- pollers write HERE, never to track
  id INTEGER PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('github','slack','jira','calendar','claude','system')),
  kind TEXT NOT NULL, external_id TEXT NOT NULL,
  title TEXT NOT NULL, snippet TEXT, url TEXT, actor TEXT,
  occurred_at INTEGER NOT NULL, payload TEXT,
  suggested_track_id INTEGER REFERENCES track(id) ON DELETE SET NULL,
  suggestion_rule TEXT, suggestion_score REAL,
  status TEXT NOT NULL DEFAULT 'NEW'
    CHECK (status IN ('NEW','LINKED','TRACKED','DISMISSED','SNOOZED')),
  snoozed_until INTEGER, resolved_track_id INTEGER REFERENCES track(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX inbox_open ON inbox_candidate(status, occurred_at DESC);

CREATE TABLE github_pr (
  id TEXT PRIMARY KEY,                     -- 'owner/repo#123'
  repo_owner TEXT NOT NULL, repo_name TEXT NOT NULL, number INTEGER NOT NULL,
  title TEXT NOT NULL, url TEXT NOT NULL, author TEXT NOT NULL,
  is_author_me INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL, is_draft INTEGER NOT NULL DEFAULT 0,
  head_branch TEXT NOT NULL, base_branch TEXT NOT NULL,
  review_decision TEXT, mergeable TEXT, checks_state TEXT,
  unresolved_threads INTEGER NOT NULL DEFAULT 0, requested_reviewers TEXT,
  updated_at_remote INTEGER NOT NULL,
  raw TEXT NOT NULL,                       -- full gh json, for forward-compat
  fetched_at INTEGER NOT NULL
) STRICT;
CREATE INDEX github_pr_branch ON github_pr(repo_owner, repo_name, head_branch);
-- github_issue mirrors the same shape.

CREATE TABLE integration_cursor (
  integration TEXT NOT NULL, stream TEXT NOT NULL,   -- 'notifications','prs:owner/repo'
  cursor TEXT, last_run_at INTEGER, last_ok_at INTEGER, last_error TEXT,
  backoff_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (integration, stream)
) STRICT;

CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE notification (
  id INTEGER PRIMARY KEY, track_id INTEGER REFERENCES track(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES claude_session(session_id) ON DELETE CASCADE,
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
  created_at INTEGER NOT NULL, delivered_at INTEGER, read_at INTEGER, dedupe_key TEXT UNIQUE
) STRICT;

CREATE VIRTUAL TABLE track_fts USING fts5(title, question, next_action,
  content='track', content_rowid='id', tokenize='porter unicode61');
CREATE VIRTUAL TABLE event_fts USING fts5(summary, body,
  content='event', content_rowid='id', tokenize='porter unicode61');
-- sync triggers on insert/update/delete for both.
```

Two decisions worth defending: **the full Track schema ships in migration 0001**, even though Phase 1 writes only sessions — adding it later is a migration, having it now means Tracks are a pure feature with zero pressure to build them early. And **`event.log_offset`** is what turns the timeline from a log into a navigation surface.

---

## Repo layout & build

```
oh-my-ide/
├─ packages/
│  ├─ protocol/        zod message union + frame codec (zero deps)
│  ├─ core/            PURE, no I/O: state machine, derivation, join rules
│  ├─ db/              better-sqlite3, migrations/*.sql, repositories
│  ├─ claude-adapter/  THE quarantine: probe, SessionRunner, tailer, safeOpen
│  ├─ integrations/    Integration interface + registry
│  └─ gh-adapter/      gh CLI wrapper
├─ apps/
│  ├─ daemon/          omid — tsup → single bundle
│  └─ desktop/         electron-vite: main / preload / renderer
└─ tools/fixtures/     redacted golden JSONL + gh JSON for contract tests
```

**One ABI, not two.** The daemon runs under the Electron binary with `ELECTRON_RUN_AS_NODE=1`, so there is exactly one native target in the repo — Electron 44's. No dual build, no "works in dev, breaks packaged," no dependency on the user's nvm-managed Node. `better-sqlite3` and `node-pty` are dependencies of `apps/daemon` only; **Electron main and renderer import zero native modules**, so a rebuild failure can never take down the UI shell.

```jsonc
// root package.json
"devDependencies": { "node-gyp": "^11", "@electron/rebuild": "^4", "electron": "44.4.1" },
// pnpm 10 BLOCKS lifecycle scripts by default — without this, node-pty and
// better-sqlite3 install with no binary, silently. The #1 first-day trap.
"pnpm": { "onlyBuiltDependencies": ["node-pty", "better-sqlite3", "electron"] },
"scripts": {
  "postinstall": "electron-rebuild -f -w node-pty,better-sqlite3 -m apps/daemon",
  "verify:abi":  "node tools/scripts/verify-abi.mjs"
}
```

`@electron/rebuild` vendors node-gyp as a library, so no global install is needed; `~/.electron-gyp` is created on first run. gcc 16.2.1 / make 4.4.1 / python3 are present as the compile fallback. `verify:abi` requires both natives under `ELECTRON_RUN_AS_NODE` and runs in `pretest` and the packaged smoke test — turning "ABI mismatch found by a user" into a build failure. Also set `.npmrc` `node-linker=hoisted` (electron-builder mis-resolves symlinked natives into the asar otherwise).

**Wayland/Hyprland** needs explicit hints or you get blurry XWayland and broken fractional scaling:
```ts
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
```
Ship a `~/.config/oh-my-ide/flags.conf` escape hatch — GPU/Wayland flags always need per-machine tweaking.

Tooling: electron-vite (desktop), tsup (daemon + packages), electron-builder (AppImage + pacman), vitest, biome.

---

## Milestones

**Phase 0 — spike + skeleton. ✅ DONE 2026-09-17.** The gate resolved in favour of
`ClaudeBgRunner`: attach gives a full-fidelity TUI with redraw, attach is *not* exclusive,
and the job survives detach (even SIGKILL of the client). **tmux is not used for Claude
sessions.** `claude agents --json` turned out to be a documented TTY-free listing, so
discovery and state come from a supported CLI surface rather than tier-3 file reads —
this materially lowers Risk #1. Full record: `docs/decisions/0001-session-substrate.md`.

**Phase 0 original scope (superseded):** Not shippable; de-risks everything. Answer the three `SessionRunner` questions above with a throwaway script **before any dependent code exists**, then: monorepo, electron-vite, daemon socket handshake, migration 0001, `verify:abi` green, Wayland flags, one empty window. **Gate:** if attach fidelity or detach-survival fails, default to `TmuxRunner` now.

**Phase 1 — session cockpit (~1 week). The smallest genuinely useful thing.**
Discover every existing session from transcripts (cwd, branch, title, last prompt, cost); start a named session with an initial prompt; attach it in an xterm tab; **close the window, reopen, reattach with replay, session untouched**; real state chips from the state machine; desktop notification on NEEDS_PERMISSION / FAILED; "copy `claude attach <id>`"; one tmux-backed plain shell.
*Frustration #1 is dead.* Everything after is upside.
**Acceptance:** start 3 sessions, `kill -9` Electron, restart, all 3 still running, reattach each, no lost output, no duplicated bytes.

**Phase 2 — Tracks core (~1 week).** Track CRUD with origin/question/next action; attach sessions, URLs, files, notes; timeline fed by transcript events; manual status + pin/park/snooze with wake conditions; FTS; ⌘K palette; "new Track from this session" and "new session in this Track's cwd/branch." Worth it as a purely manual container before any integration exists.

**Phase 3 — GitHub mirror + derivation (~1 week).** `gh` poller with cursors and backoff; `github_pr`/`github_issue` mirrors; workspace repo detection; **branch+cwd auto-join**; the full rule set; the why? popover; Inbox with suggestions. Status now moves by itself.

**Phase 4 — Today (~4 days).** The three queues, the digest line, notification policy and quiet hours, rot view, tray badge with an on-me count, `omid://` deep links, systemd unit installer + linger prompt.

**Phase 5 — packaging & hardening (~4 days).** AppImage + pacman, packaged smoke test, log rotation and retention sweep, DB backup-on-migrate, golden-fixture contract tests in CI, `--safe-mode` that boots with the Claude adapter disabled.

**Phase 6+ — Slack, Jira, Calendar** behind the existing interface, ~2–3 days each because the schema, cursors, inbox, and derivation hooks already exist. Still read-only.

---

## Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Claude CLI drift** breaks transcript parsing or flags. | One quarantined adapter; version-keyed probe; lenient `.passthrough()` parsing where unknown types degrade to neutral dots; golden fixtures in CI; a five-rung degradation ladder whose bottom rung is still useful; `SessionRunner` makes losing `--bg` a config flip, not a rewrite. |
| 2 | **`claude attach` semantics differ from assumption** (exclusive, no redraw, detach kills the job). | The Phase 0 gate, tested before any dependent code. Fallback already designed. |
| 3 | **Tier-3 file reads create hidden coupling.** | Feature-flagged, non-load-bearing, nullable at every consumer; a chaos test runs the suite with tier 3 off and must pass identically. |
| 4 | **Native ABI / pnpm 10 silently skipping builds.** | Single ABI target, explicit `node-gyp`, `onlyBuiltDependencies`, `verify:abi` preflight that fails the build instead of the user. |
| 5 | **PTY flood** from a session dumping megabytes. | Never stall the PTY; 16 ms coalescing; lossy degradation with resync; bounded ring + 24 MB/view log cap; xterm scrollback clamp + webgl. |
| 6 | **Replay gaps/duplicates** after a restart. | One ordered per-subscriber queue (ordering is structural), epoch+offset on every frame, client-side assertion with auto re-attach, idempotent ingest via `dedupe_key`. |
| 7 | **Privacy** — plaintext work data in an unencrypted DB. | Summaries + metadata by default, bodies opt-in; credential denylist in one `safeOpen`; 0600 files; documented wipe action; nothing transmitted. |
| 8 | **Notification fatigue** at 100 sessions. | Only NEEDS_PERMISSION and FAILED notify; 5-min per-session rate limit; quiet hours; tray badge as the ambient default; two-observation debounce so flapping never reaches the notifier. |
| 9 | **Reboot expectations.** | `RESUMABLE` is a distinct state with its own color and a Resume button. Don't oversell in copy. Offer `enable-linger` explicitly. |
| 10 | **Scope creep from Track into a project manager.** The biggest *product* risk. | Hard phase gate: nothing from Phase 2 starts until the Phase 1 acceptance test passes on video. Schema is already forward-compatible, so there is no engineering reason to start early. Read-only integrations remove an enormous surface. |

---

## Verification

**Phase 1 acceptance — the one that matters.** Manual, end to end:
1. Start a Claude session in a real repo; let it run a multi-minute task.
2. `kill -9` the Electron process. Restart the app.
3. Scrollback is complete, the session is still producing output, typing still reaches it.
4. `systemctl --user restart oh-my-ide-daemon` mid-stream → UI reconnects, no gap, no duplicate bytes.
5. Attach the same session from a plain terminal with the copied command.
6. Reboot → `RESUMABLE`; Resume restores it with the conversation replayed from the transcript.

**Automated:**
- `packages/core` — the reducer and derivation against recorded fixtures. Capture real sessions once, replay forever.
- `packages/protocol` — **fuzz the frame decoder with random chunk splits.** Highest-value test in the repo.
- `packages/claude-adapter` — golden redacted JSONL fixtures; traversal and credential-path attempts against `safeOpen` must throw; a chaos run with tier 3 disabled must pass identically.
- Offset invariant — subscribe, kill the daemon mid-stream, restart, resubscribe from the stored offset, assert concatenated bytes equal the on-disk log exactly.

**Load benchmark (standing, each phase):** 20 concurrent sessions, one running `find / | cat`, one `yes`, one `cat` of a 200 MB file. Assert 60fps UI, no other session's state detection lagging > 2 s, bounded daemon RSS, zero dropped or duplicated bytes in the quiet sessions.

**Phase 3 spot-check:** open a PR on a branch a session is running on → it auto-joins that Track by branch, lands in the timeline, and the court flips to `ON_THEM` while awaiting review and `ON_ME` once a review comment arrives.
