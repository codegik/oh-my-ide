import { randomBytes } from 'node:crypto';
import type {
  AgentCompat,
  AgentId,
  NormalizedSession,
  PastSession,
  SessionRunner,
  SessionState,
  SessionUsage,
  StartedSession,
} from '@omi/core';
import { findHermes, hermesBin, parseVersion, runHermes } from './cli.js';
import { HermesStore, readMarker, type StoreSession } from './store.js';
import {
  attachArgv,
  capturePane,
  findTmux,
  hasSession,
  killSession,
  listSessions,
  newSession,
  sendKeys,
  type TmuxSession,
  tmuxName,
  tmuxVersion,
} from './tmux.js';

/** `20260927_184952_29391d` — how hermes names a session in its own store. */
const HERMES_ID = /^\d{8}_\d{6}_[0-9a-f]{6}$/;

export function isHermesSessionId(id: string): boolean {
  return HERMES_ID.test(id);
}

/** Our own key for a session, used until (and after) hermes files one of its own. */
function newKey(): string {
  return randomBytes(6).toString('hex');
}

/**
 * Anything hermes says it is waiting on us for. `last_activity_description` is
 * free text, so this is a guess that errs towards the harmless side: reading a
 * turn as "needs you" that merely runs a tool costs a false ON ME dot, where
 * missing a real approval prompt costs a session that sits blocked all evening.
 */
const WANTS_ME = /approv|permission|confirm|waiting for you|awaiting input/i;

/**
 * Hermes under a detached tmux session.
 *
 * Hermes has no `--bg`/`attach` pair of its own, so tmux owns session lifetime
 * here — the substrate ADR 0001 reserved for an agent with no supervisor. The
 * consequences the rest of the app has to know about:
 *
 * - The key we run a session by (`sessionId` here) is OURS, not hermes'. Hermes
 *   writes its session row on the first message, so a freshly opened tab has no
 *   hermes id at all for a while; `agentSessionId` fills in when it appears and
 *   is what `--resume` and every usage lookup then use.
 * - A session's state comes from two places that cannot disagree: tmux for "is
 *   it still there", the session store for "what is it doing".
 */
export class HermesRunner implements SessionRunner {
  readonly agent: AgentId = 'hermes';
  private readonly store: HermesStore;
  /** key → hermes session id, once discovered. Saves rescanning every poll. */
  private readonly ids = new Map<string, string>();

  constructor(store: HermesStore = new HermesStore()) {
    this.store = store;
  }

  /** Lets the daemon hand back what it persisted, so a restart does not re-discover. */
  remember(key: string, agentSessionId: string | null | undefined): void {
    if (agentSessionId) this.ids.set(key, agentSessionId);
  }

  /** The hermes-side id for one of our keys, as far as we know it. */
  agentSessionIdOf(key: string): string | null {
    return this.ids.get(key) ?? (isHermesSessionId(key) ? key : null);
  }

  async start(o: {
    cwd: string;
    prompt?: string;
    name?: string;
    sessionId?: string;
  }): Promise<StartedSession> {
    // `o.sessionId` is Claude's "start this session under an id I chose"; hermes
    // has no such flag, so the key is ours either way.
    const key = o.sessionId && !isHermesSessionId(o.sessionId) ? o.sessionId : newKey();
    const name = tmuxName(key);
    await newSession({ name, cwd: o.cwd, argv: [hermesBin(), '--tui'] });

    // A prompt is optional, and the UI never passes one: a new tab should open
    // idle and spend nothing until the user types. When one is given, it has to
    // wait for the TUI to be ready for keys — sending too early types into a
    // screen that is still painting.
    if (o.prompt) {
      await this.waitForPrompt(name);
      await sendKeys(name, o.prompt);
    }

    return {
      agent: this.agent,
      sessionId: key,
      shortId: key,
      name: o.name ?? null,
      cwd: o.cwd,
      agentSessionId: null,
    };
  }

  /** The TUI prints its prompt marker when it is ready; give up after ~15s and type anyway. */
  private async waitForPrompt(name: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pane = await capturePane(name, 40).catch(() => '');
      if (/❯|›|Try "/.test(pane)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  attachCommand(s: { shortId: string }): { file: string; args: string[] } {
    return attachArgv(tmuxName(s.shortId));
  }

  /**
   * Puts a session back on screen. Two cases, and the difference is invisible in
   * the UI: the tmux session is still there (nothing to do but attach), or it is
   * gone and hermes re-reads the conversation from its store.
   */
  async resume(o: {
    sessionId: string;
    cwd?: string;
    fork?: boolean;
    agentSessionId?: string | null;
  }): Promise<StartedSession> {
    const key = o.sessionId;
    const name = tmuxName(key);
    const hid = o.agentSessionId ?? this.agentSessionIdOf(key);
    if (hid) this.ids.set(key, hid);

    if (await hasSession(name)) {
      const live = (await this.list()).find((s) => s.sessionId === key);
      return {
        agent: this.agent,
        sessionId: key,
        shortId: key,
        name: live?.name ?? null,
        cwd: live?.cwd ?? o.cwd ?? process.cwd(),
        agentSessionId: hid,
      };
    }

    const cwd = o.cwd ?? this.store.byAnyId(hid ? [hid] : [])?.cwd ?? process.cwd();
    const argv = [hermesBin(), '--tui'];
    if (hid) {
      // `--in` and `--no-restore-cwd` together: the folder the track works in
      // wins over the one the conversation happened to be started in, which is
      // what the user picked when they opened the track.
      argv.push('--resume', hid, '--in', cwd, '--no-restore-cwd');
    }
    await newSession({ name, cwd, argv });
    return {
      agent: this.agent,
      sessionId: key,
      shortId: key,
      name: null,
      cwd,
      agentSessionId: hid,
    };
  }

  /**
   * Ends the tmux session, and with it the hermes process. The conversation
   * itself is untouched — it lives in hermes' store and comes back with
   * `--resume`, which is what `RESUMABLE` means on a stopped hermes session.
   */
  async stop(s: { shortId: string }): Promise<void> {
    await killSession(tmuxName(s.shortId));
  }

  /** The same thing: we never delete a conversation out of the user's history. */
  async remove(s: { shortId: string }): Promise<void> {
    await this.stop(s);
  }

  async list(): Promise<NormalizedSession[]> {
    const live = await listSessions();
    const busy = this.store.busyIds();
    const out: NormalizedSession[] = [];
    const claimed = new Set<string>();

    for (const t of live) {
      const hid = this.discover(t);
      if (hid) claimed.add(hid);
      const row = hid ? this.store.byId(hid) : null;
      out.push(this.normalize(t, row, hid, busy));
    }

    // Sessions running outside our tmux — someone's own terminal. They cannot be
    // attached to, and the UI says so rather than offering a button that fails.
    // Only a live turn lease counts as "running": a row with no `ended_at` is
    // just as likely to be a session whose terminal was closed on it.
    for (const id of busy) {
      if (claimed.has(id)) continue;
      const row = this.store.byId(id);
      if (!row) continue;
      out.push({
        agent: this.agent,
        sessionId: id,
        shortId: id,
        kind: 'interactive',
        cwd: row.cwd ?? '',
        name: row.title,
        startedAt: row.startedAt,
        pid: null,
        state: 'WORKING',
        rawState: row.lastActivityDescription,
        busy: true,
        confidence: 'observed',
        agentSessionId: id,
      });
    }
    return out;
  }

  /**
   * Which hermes session a tmux session of ours is running.
   *
   * The tty marker is the exact answer — hermes writes the session id next to
   * the tty it took over — and the store is the fallback for the window before
   * that file appears. Both are gated on the tmux session's own start time, so
   * neither can hand back whatever used that pty before us.
   */
  private discover(t: TmuxSession): string | null {
    const known = this.ids.get(t.key);
    if (known) return known;
    if (isHermesSessionId(t.key)) return t.key; // resumed under its own id

    const marker = readMarker(t.tty, t.createdAt);
    const found = marker?.sessionId ?? this.store.newestIn(t.cwd, t.createdAt)?.id ?? null;
    if (found) this.ids.set(t.key, found);
    return found;
  }

  private normalize(
    t: TmuxSession,
    row: StoreSession | null,
    hid: string | null,
    busy: Set<string>,
  ): NormalizedSession {
    const working = hid !== null && busy.has(hid);
    const wantsMe = !working && WANTS_ME.test(row?.lastActivityDescription ?? '');
    const state: SessionState = working ? 'WORKING' : wantsMe ? 'NEEDS_PERMISSION' : 'IDLE';
    return {
      agent: this.agent,
      sessionId: t.key,
      shortId: t.key,
      // It survives the window closing and it can be attached to, which is
      // everything `background` means to the rest of the app.
      kind: 'background',
      cwd: row?.cwd ?? t.cwd,
      name: row?.title ?? null,
      startedAt: t.createdAt || row?.startedAt || 0,
      pid: t.pid,
      state,
      rawState: row?.lastActivityDescription ?? null,
      busy: working,
      // Nothing in the store yet means nothing has been said yet: the tab is
      // live, but "idle" is inferred from that rather than reported.
      confidence: row ? 'observed' : 'derived',
      agentSessionId: hid,
    };
  }

  /** tmux' own scrollback, which is as close as hermes gets to `claude logs`. */
  async logs(s: { shortId: string }): Promise<string> {
    return capturePane(tmuxName(s.shortId)).catch(() => '');
  }

  past(cwd: string): PastSession[] {
    return this.store.inFolder(cwd).map((s) => ({
      agent: this.agent,
      sessionId: s.id,
      cwd: s.cwd ?? cwd,
      gitBranch: s.gitBranch,
      preview: s.title,
      lastActivityAt: s.lastActivityAt ?? s.startedAt,
    }));
  }

  /**
   * A conversation can be picked up as long as hermes still has it. A session of
   * ours with no hermes id yet never said anything, so there is nothing that
   * could be missing — reopening its tab is a faithful continuation of an empty
   * conversation, not a dead end.
   */
  canResume(sessionId: string, agentSessionId?: string | null): boolean {
    const hid = agentSessionId ?? this.agentSessionIdOf(sessionId);
    if (!hid) return !isHermesSessionId(sessionId);
    // The store being unreadable must never take resume away from the user.
    if (!this.store.available()) return true;
    return this.store.byId(hid) !== null;
  }

  /**
   * Hermes keeps its own token counts per session, so unlike the Claude side
   * this needs no transcript parsing and no incremental reads.
   */
  usage(sessionIds: string[]): SessionUsage | null {
    const ids = sessionIds.flatMap((id) => {
      const hid = this.agentSessionIdOf(id);
      return hid ? [hid] : [];
    });
    const row = this.store.byAnyId(ids.length > 0 ? ids : sessionIds);
    if (!row) return null;
    return {
      sessionId: row.id,
      model: row.model,
      gitBranch: row.gitBranch,
      /**
       * Hermes keeps per-session totals and nothing per request, and
       * `messages.token_count` is NULL for every row it writes — so there is no
       * honest answer to "how much does this conversation weigh now". The panel
       * leaves the line out rather than printing a number we made up.
       */
      contextTokens: null,
      requests: row.apiCalls,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens + row.reasoningTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      // Hermes runs subagents inside the same session row, so there is no
      // separate number to report rather than invent.
      subagents: 0,
      subagentTokens: 0,
      // Hermes prices its own conversations, so unlike the Claude side this is
      // a real figure rather than one we would have to estimate.
      costUsd: row.costUsd,
      lastActivityAt: row.lastActivityAt,
    };
  }

  async probe(): Promise<AgentCompat> {
    const notes: string[] = [];
    if (!findHermes()) {
      return {
        agent: this.agent,
        cliVersion: 'unknown',
        tier: 'unsupported',
        available: false,
        notes: ['`hermes` was not found on PATH'],
      };
    }
    let cliVersion = 'unknown';
    try {
      cliVersion = parseVersion(await runHermes(['--version'], { timeoutMs: 20_000 }));
    } catch (err) {
      notes.push(`could not ask hermes its version: ${err instanceof Error ? err.message : err}`);
    }
    // No tmux, no session that outlives the window — and that is the whole
    // reason this app exists, so it is unsupported rather than degraded.
    if (!findTmux()) {
      return {
        agent: this.agent,
        cliVersion,
        tier: 'unsupported',
        available: false,
        notes: [...notes, '`tmux` was not found — it is what keeps a hermes session alive'],
      };
    }
    const tmuxV = tmuxVersion();
    if (tmuxV) notes.push(`session substrate: ${tmuxV}`);
    if (!this.store.available()) {
      notes.push(
        'hermes has no session store yet — state and token counts appear once a session has run',
      );
    }
    return {
      agent: this.agent,
      cliVersion,
      tier: cliVersion === 'unknown' ? 'degraded' : 'supported',
      available: true,
      notes,
    };
  }
}
