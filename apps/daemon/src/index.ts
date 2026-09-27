import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ClaudeCompat } from '@omi/claude-adapter';
import { ClaudeBgRunner, isSameSession, probe, shortIdOf } from '@omi/claude-adapter';
import type { AgentCompat, AgentId, NormalizedSession, SessionRunner } from '@omi/core';
import { AGENT_IDS, agentOf, parseRef, sessionIdOf, sessionKey, toAgentId } from '@omi/core';
import { Db } from '@omi/db';
import { HermesRunner } from '@omi/hermes-adapter';
import {
  encodeControl,
  FRAME_CONTROL,
  FRAME_PTY_IN,
  FrameDecoder,
  PROTOCOL_VERSION,
  runtimeDir,
  socketPath,
} from '@omi/protocol';
import { PtyHub } from './pty.js';

const DAEMON_VERSION = '0.0.2';
const STARTED_AT = Date.now();

/**
 * Which build of this file is actually running.
 *
 * The daemon outlives the app on purpose, so after a rebuild the new window
 * talks to whatever daemon was already listening — old code, new renderer. That
 * skew used to surface as `no such method: <whatever was added>` from deep
 * inside an unrelated click. Stamping the bundle we loaded lets the desktop
 * notice and restart us instead of guessing. mtime of our own file is enough:
 * a rebuild always rewrites it.
 */
const ENTRY = __filename;
const BUILD_ID = (() => {
  try {
    const st = fs.statSync(ENTRY);
    return `${Math.round(st.mtimeMs)}-${st.size}`;
  } catch {
    return 'unknown';
  }
})();

const DATA_DIR = path.join(
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
  'oh-my-ide',
);
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

/**
 * One runner per agent. Which one answers is decided by the track — a track's
 * sessions are all run by its own agent — or, on an id-only path, by the prefix
 * the session ref carries (`claude:` / `hermes:`).
 */
const hermesRunner = new HermesRunner();
const runners: Record<AgentId, SessionRunner> = {
  claude: new ClaudeBgRunner(),
  hermes: hermesRunner,
};
const runnerFor = (agent: AgentId): SessionRunner => runners[agent];
const runnerForRef = (externalId: string): SessionRunner => runners[agentOf(externalId)];

/**
 * Whether a listed session is the one a ref stored. Claude's own short-id rule
 * lives in its adapter; every other agent runs a session under the key we gave
 * it, so the id is the id.
 */
function isRefOf(s: NormalizedSession, externalId: string): boolean {
  if (s.agent !== agentOf(externalId)) return false;
  const id = sessionIdOf(externalId);
  return s.agent === 'claude' ? isSameSession(s, id) : s.sessionId === id;
}

const hub = new PtyHub();
const db = new Db(path.join(DATA_DIR, 'omid.db'));

let compat: ClaudeCompat | null = null;
let compatPromise: Promise<ClaudeCompat> | null = null;

function getCompat(): Promise<ClaudeCompat> {
  if (compat) return Promise.resolve(compat);
  compatPromise ??= probe()
    .then((c) => {
      compat = c;
      return c;
    })
    .catch((err) => {
      compatPromise = null;
      return {
        cliVersion: 'unknown',
        tier: 'degraded' as const,
        features: {
          background: false,
          attach: false,
          logs: false,
          stop: false,
          respawn: false,
          agentsJson: false,
          forkSession: false,
          sessionId: false,
          name: false,
        },
        notes: [
          `Could not probe the Claude CLI: ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    });
  return compatPromise;
}

/**
 * What every agent can do, warmed at boot for the same reason the Claude probe
 * is: `hello` must never sit on a subprocess. Cached for the life of the daemon
 * except for a failure, which is retried — an agent installed while the app runs
 * should not need a restart to appear.
 */
const agentCompat = new Map<AgentId, AgentCompat>();
let agentsPromise: Promise<AgentCompat[]> | null = null;

function probeAgents(): Promise<AgentCompat[]> {
  agentsPromise ??= Promise.all(
    AGENT_IDS.map((id) =>
      runnerFor(id)
        .probe()
        .catch(
          (err): AgentCompat => ({
            agent: id,
            cliVersion: 'unknown',
            tier: 'unsupported',
            available: false,
            notes: [`could not probe ${id}: ${err instanceof Error ? err.message : String(err)}`],
          }),
        ),
    ),
  ).then((list) => {
    agentCompat.clear();
    for (const c of list) agentCompat.set(c.agent, c);
    // Retry a run where something was missing; keep a clean answer.
    if (list.some((c) => !c.available)) agentsPromise = null;
    return list;
  });
  return agentsPromise;
}

const clients = new Set<net.Socket>();
function broadcast(msg: unknown): void {
  const frame = encodeControl(msg);
  for (const c of clients) c.write(frame);
}

// ── session → ref state sync ────────────────────────────────────────────────

/**
 * Claude's own supervisor is the source of truth for session state. We mirror it
 * onto refs so court derivation has something to read, and so a session going
 * from WORKING to NEEDS_INPUT flips its Track to ON_ME by itself.
 */
/**
 * Asking the CLI for its sessions must never take the track rail down with it.
 * On a machine where Claude Code is not installed yet — a fresh package install
 * — `claude agents` fails with ENOENT, and since `tracks.list` syncs on every
 * poll, letting that through would turn "no sessions" into "no tracks", though
 * tracks live in SQLite and are perfectly readable without Claude. Degrades to
 * an empty listing, as getCompat degrades to its `degraded` tier. Logged only
 * when the message changes: the rail polls every few seconds.
 */
const lastListError = new Map<AgentId, string>();
async function listOne(agent: AgentId): Promise<NormalizedSession[]> {
  try {
    const sessions = await runnerFor(agent).list();
    lastListError.delete(agent);
    return sessions;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== lastListError.get(agent)) {
      lastListError.set(agent, msg);
      process.stderr.write(`[omid] could not list ${agent} sessions: ${msg}\n`);
    }
    return [];
  }
}

/** Every agent's sessions in one list. One agent failing never hides another's. */
async function listSessionsOrNone(): Promise<NormalizedSession[]> {
  const perAgent = await Promise.all(AGENT_IDS.map(listOne));
  return perAgent.flat();
}

async function syncSessions(): Promise<NormalizedSession[]> {
  const sessions = await listSessionsOrNone();
  const touched = new Set<number>();
  // Walk our refs rather than the listing: a session can be listed under a
  // newer UUID than the one we stored (see isSameSession).
  for (const ref of db.listSessionRefs()) {
    // Hand back what we already know, so a daemon restart does not have to
    // rediscover which hermes conversation a session key belongs to.
    if (agentOf(ref.externalId) === 'hermes') {
      hermesRunner.remember(sessionIdOf(ref.externalId), ref.agentSessionId);
    }
    const s = sessions.find((x) => isRefOf(x, ref.externalId));
    if (!s) continue;
    for (const id of db.setRefState('claude_session', ref.externalId, s.state)) touched.add(id);
    /**
     * An agent that files a conversation under an id of its own gets that id
     * recorded the first time we see it — hermes writes its session row on the
     * first message, so this is how a tab opened a minute ago becomes a
     * conversation that can be resumed, priced and titled.
     */
    if (s.agentSessionId && !ref.agentSessionId) {
      for (const id of db.setRefAgentSessionId(ref.externalId, s.agentSessionId)) touched.add(id);
    }
    /**
     * Some agents name their own sessions. Hermes titles one from its first
     * message and then RETITLES it once it has read the conversation — the
     * first title is the prompt verbatim, the second is about the work — so the
     * label follows the agent's name rather than keeping whichever arrived
     * first. Claude is excluded: its listed name is the one `-n` was given, and
     * its running title comes off the pty instead (adoptTitle).
     *
     * Only the first adoption writes a timeline event. A retitle is the agent
     * improving its own wording, not something that happened to the track.
     */
    const placeholder = isPlaceholderLabel(ref.label, sessionIdOf(ref.externalId));
    if (s.name && s.agent !== 'claude' && s.name !== ref.label) {
      db.setRefLabel(ref.id, s.name);
      if (placeholder) {
        db.addEvent({
          trackId: ref.trackId,
          source: 'claude',
          kind: 'session.named',
          title: `session named "${s.name}"`,
        });
      }
      touched.add(ref.trackId);
    }
  }
  if (touched.size > 0) broadcast({ t: 'changed', entity: 'track', ids: [...touched] });
  return sessions;
}

/**
 * The CLI's own name, which it sets as the title before the conversation has a
 * subject. It says nothing about this session, so it is never worth storing and
 * never worth keeping once a real title turns up.
 */
const GENERIC_TITLE = /^(claude(\s+code)?|hermes(\s+agent)?)$/i;

/**
 * Whether a session's label is still the stand-in it was born with, and so may
 * be replaced by a real title. A name the user chose, or one a session already
 * carried, is theirs and stays.
 */
function isPlaceholderLabel(label: string | null, key: string): boolean {
  if (!label) return true;
  return label === key || label === shortIdOf(key) || GENERIC_TITLE.test(label);
}

/**
 * A session starts life named after its own short id, because there is nothing
 * to call it yet. The first thing the user types gives it a subject, and the CLI
 * publishes that as its terminal title — so that title becomes the session's
 * name. A name the user chose, or one a session already carried, is theirs and
 * stays.
 */
function adoptTitle(viewId: string, title: string): void {
  if (GENERIC_TITLE.test(title)) return;
  const agent = agentOf(viewId);
  const shortId = sessionIdOf(viewId);
  const touched: number[] = [];
  for (const r of db.listSessionRefs()) {
    if (agentOf(r.externalId) !== agent) continue;
    const key = sessionIdOf(r.externalId);
    // Claude's view is keyed by the short id; every other agent's key is the
    // whole id, so there is nothing to shorten.
    if ((agent === 'claude' ? shortIdOf(key) : key) !== shortId) continue;
    if (!isPlaceholderLabel(r.label, key)) continue;
    db.setRefLabel(r.id, title);
    db.addEvent({
      trackId: r.trackId,
      source: 'claude',
      kind: 'session.named',
      title: `session named "${title}"`,
    });
    touched.push(r.trackId);
  }
  if (touched.length > 0) broadcast({ t: 'changed', entity: 'track', ids: [...new Set(touched)] });
}

// ── putting sessions down ───────────────────────────────────────────────────

/**
 * Claude's supervisor never stops a background session by itself, so every one
 * this app ever started would otherwise run until the next reboot. Only the
 * user's say-so stops one — closing its chip, or finishing its track — and never
 * mere idleness: a quiet session is one the user may come back to read, and it
 * should still be there, scrollback and all. Stopping keeps the transcript, and
 * a stopped job wakes under its own id (see tracks.resumeSession).
 *
 * The ref's state is left alone on purpose. A session that stopped while
 * waiting for a reply is still waiting for one; the track stays on the user's
 * side of the court instead of quietly dropping off it.
 */
const stopping = new Set<string>();
async function stopSessions(targets: NormalizedSession[]): Promise<void> {
  const touched = new Set<number>();
  for (const s of targets) {
    const key = sessionKey(s.agent, s.shortId);
    if (s.kind !== 'background' || stopping.has(key)) continue;
    stopping.add(key);
    // Ours first, before its process goes: a view closed by us goes quietly,
    // where one whose attach died under it would announce an exit.
    hub.close(key);
    try {
      await runnerFor(s.agent).stop({ shortId: s.shortId });
    } catch (err) {
      process.stderr.write(
        `[omid] could not stop ${s.agent} session ${s.shortId}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } finally {
      stopping.delete(key);
    }
    for (const r of db.listSessionRefs()) {
      if (isRefOf(s, r.externalId)) touched.add(r.trackId);
    }
  }
  if (touched.size > 0) broadcast({ t: 'changed', entity: 'track', ids: [...touched] });
}

/** The listed sessions behind these refs. */
async function sessionsBehind(externalIds: string[]): Promise<NormalizedSession[]> {
  if (externalIds.length === 0) return [];
  const listed = await listSessionsOrNone();
  return listed.filter((s) => externalIds.some((ext) => isRefOf(s, ext)));
}

/**
 * A finished track's sessions — except one another open track still uses,
 * which is not finished just because this one is.
 */
async function stopTrackSessions(trackId: number): Promise<void> {
  const refs = db.listSessionRefs();
  const mine = refs.filter((r) => r.trackId === trackId).map((r) => r.externalId);
  const elsewhere = (ext: string) =>
    refs.some(
      (r) =>
        r.trackId !== trackId &&
        r.externalId === ext &&
        db.getTrack(r.trackId)?.lifecycle === 'open',
    );
  await stopSessions(await sessionsBehind(mine.filter((ext) => !elsewhere(ext))));
}

/**
 * Starts a new session in a track's folder and links it. The track's unscoped
 * refs go to it, as they would to any first session.
 */
async function startTrackSession(
  track: NonNullable<ReturnType<Db['getTrack']>>,
  p: { cwd?: unknown; prompt?: unknown; name?: unknown },
) {
  const cwd = String(p.cwd ?? track.cwd ?? '').trim();
  if (!cwd) throw new Error('this track has no folder; pass one');
  await assertAgentUsable(track.agent);
  // No prompt: the session opens idle and waits for the user to type into it,
  // which is what a new terminal should do. Nothing is spent up front, and the
  // first message is what ends up naming it (see adoptTitle).
  const prompt = String(p.prompt ?? '').trim();
  const started = await runnerFor(track.agent).start({
    cwd,
    ...(prompt ? { prompt } : {}),
    ...(p.name ? { name: String(p.name) } : {}),
  });
  const ext = sessionKey(track.agent, started.sessionId);
  db.addRef({
    trackId: track.id,
    kind: 'claude_session',
    externalId: ext,
    label: started.name ?? started.shortId,
    state: 'STARTING',
    role: 'implementation',
    linkRule: 'started-here',
    agentSessionId: started.agentSessionId ?? null,
  });
  db.adoptOrphanRefs(track.id, ext);
  return started;
}

/**
 * Refuses before anything is spawned, with the reason the probe gave. A button
 * that reports "`tmux` was not found" is worth ten that fail obscurely three
 * calls deeper.
 */
async function assertAgentUsable(agent: AgentId): Promise<void> {
  const c = agentCompat.get(agent) ?? (await probeAgents()).find((x) => x.agent === agent);
  if (c && !c.available) {
    throw new Error(`${agent} cannot be used here: ${c.notes.join('; ') || 'not installed'}`);
  }
}

type Handler = (params: any, sock: net.Socket) => Promise<unknown>;

const methods: Record<string, Handler> = {
  'daemon.ping': async () => ({ pong: true, uptimeMs: Date.now() - STARTED_AT }),
  'daemon.shutdown': async () => {
    setTimeout(() => process.exit(0), 50);
    return { stopping: true, pid: process.pid };
  },
  'claude.compat': async () => getCompat(),

  /**
   * Which agents this machine can actually run, and what is missing when it
   * cannot. The wizard shows every agent either way — an option that silently
   * disappears is indistinguishable from a bug — so this has to say why.
   */
  'agents.list': async () => probeAgents(),

  'sessions.list': async () => (await syncSessions()).sort((a, b) => b.startedAt - a.startedAt),

  /**
   * On-demand, per-cwd only — called when the wizard's or attach-sheet's
   * folder changes, never from the poll/sessions.list path. Scanning
   * transcripts on every refresh would be exactly the "second, worse copy of
   * the supervisor" this file's other comments warn against.
   */
  'sessions.past': async (p) => {
    const cwd = String(p.cwd ?? '').trim();
    if (!cwd) throw new Error('a folder is required to look up past sessions');
    const agent = toAgentId(p.agent);
    const liveHere = (await listOne(agent)).filter((s) => s.cwd === cwd);
    return runnerFor(agent)
      .past(cwd)
      .filter((h) => !liveHere.some((s) => isRefOf(s, sessionKey(agent, h.sessionId))))
      .slice(0, 20);
  },

  /**
   * Tokens a session has spent, from its transcript. Takes every id the session
   * has gone by — the one a ref stored and the one it is listed under now — and
   * reads only what was appended since the last ask, so the UI can call it
   * while a session works without re-reading megabytes.
   */
  'sessions.usage': async (p) => {
    const agent = toAgentId(p.agent);
    const ids: string[] = (Array.isArray(p.ids) ? p.ids : [])
      .map(String)
      .filter(Boolean)
      .slice(0, 4);
    if (ids.length === 0) return null;
    // Whatever the agent files this conversation under counts as one of its
    // ids: for hermes that is where every number lives.
    const own = db
      .listSessionRefs()
      .filter((r) => ids.some((id) => r.externalId === sessionKey(agent, id)))
      .map((r) => r.agentSessionId)
      .filter((v): v is string => !!v);
    return runnerFor(agent).usage(
      [...new Set([...ids, ...own])].slice(0, 6),
      p.cwd ? String(p.cwd) : undefined,
    );
  },

  /** Starts a background session in a folder, idle unless a prompt is given. */
  'sessions.create': async (p) => {
    const cwd = String(p.cwd ?? '').trim();
    if (!cwd) throw new Error('a folder is required to start a session');
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`not a folder: ${cwd}`);
    }
    // exactOptionalPropertyTypes: an absent field and a field set to `undefined`
    // are not the same thing to the runner's arg type.
    const prompt = String(p.prompt ?? '').trim();
    const agent = toAgentId(p.agent);
    await assertAgentUsable(agent);
    return runnerFor(agent).start({
      cwd,
      ...(prompt ? { prompt } : {}),
      ...(p.name ? { name: String(p.name) } : {}),
    });
  },

  // ── tracks ────────────────────────────────────────────────────────────────
  'tracks.list': async () => {
    await syncSessions();
    return db.listTracks(false);
  },
  /**
   * Finished tracks, newest first. Separate from `tracks.list` because the rail
   * only asks for these when you open the `done` section — there is no reason to
   * carry a year of closed work in every five-second poll.
   */
  'tracks.closed': async () => db.listClosed(),
  /**
   * Archived tracks, newest archived first. Archiving only hides a finished
   * track: its done/dropped status is kept, so restoring puts it back as it was.
   */
  'tracks.archived': async () => db.listArchived(),
  'tracks.archive': async (p) => {
    const t = db.archiveTrack(Number(p.id));
    broadcast({ t: 'changed', entity: 'track', ids: [t.id] });
    return t;
  },
  'tracks.restore': async (p) => {
    const t = db.restoreTrack(Number(p.id));
    broadcast({ t: 'changed', entity: 'track', ids: [t.id] });
    return t;
  },
  'tracks.get': async (p) => db.getTrack(Number(p.id)),
  'tracks.create': async (p) => {
    const t = db.createTrack({
      title: String(p.title ?? 'untitled'),
      question: p.question ?? null,
      cwd: p.cwd ?? null,
      gitBranch: p.gitBranch ?? null,
      agent: toAgentId(p.agent),
    });
    broadcast({ t: 'changed', entity: 'track', ids: [t.id] });
    return t;
  },
  'tracks.update': async (p) => {
    const before = db.getTrack(Number(p.id));
    const t = db.updateTrack(Number(p.id), p.patch ?? {});
    broadcast({ t: 'changed', entity: 'track', ids: [Number(p.id)] });
    // Finished — done or dropped — means nobody is coming back to its sessions
    // soon. Not awaited: the tab closes on the answer, and `claude stop` has
    // nothing to tell it.
    if (before?.lifecycle === 'open' && t && t.lifecycle !== 'open') {
      void stopTrackSessions(t.id);
    }
    return t;
  },
  'tracks.timeline': async (p) => db.timeline(Number(p.id)),
  'tracks.notes': async (p) => db.notes(Number(p.id)),
  'tracks.pin': async (p) => {
    if (p.court === null) db.unpin(Number(p.id));
    else db.pin(Number(p.id), p.court, p.kind ?? 'hard', p.expiresAt ?? undefined);
    broadcast({ t: 'changed', entity: 'track', ids: [Number(p.id)] });
    return db.getTrack(Number(p.id));
  },

  /** Paste anything: a PR URL, a Slack permalink, a ticket key, a path. */
  'tracks.addLink': async (p) => {
    const parsed = parseRef(String(p.text ?? ''));
    if (!parsed) throw new Error('could not recognize that as a link, ticket key or path');
    db.addRef({
      trackId: Number(p.id),
      // Scoped to whichever session the user was looking at; '' means the track.
      sessionId: p.sessionId ? String(p.sessionId) : '',
      kind: parsed.kind,
      externalId: parsed.externalId,
      url: parsed.url,
      label: parsed.label,
      linkRule: 'manual',
    });
    broadcast({ t: 'changed', entity: 'track', ids: [Number(p.id)] });
    return db.getTrack(Number(p.id));
  },

  'tracks.attachSession': async (p) => {
    const track = db.getTrack(Number(p.id));
    if (!track) throw new Error('no such track');

    const agent = track.agent;
    await assertAgentUsable(agent);
    const live = await listOne(agent);
    const found = live.find((x) => x.sessionId === p.sessionId || x.shortId === p.sessionId);

    let sessionId: string;
    let shortId: string;
    let cwd: string | null;
    let name: string | null;
    let state: string | null;
    let agentSessionId: string | null = null;
    if (found) {
      ({ sessionId, shortId, cwd, name, state } = found);
      agentSessionId = found.agentSessionId ?? null;
    } else {
      // Not currently running. Only resume it if the agent's own history for
      // this track's folder actually claims that id — a cheap, local,
      // read-only check before any id reaches a `--resume`.
      const cwdForResume = track.cwd ?? undefined;
      const known =
        cwdForResume &&
        runnerFor(agent)
          .past(cwdForResume)
          .some((h) => h.sessionId === p.sessionId);
      if (!known) throw new Error('no such session');
      const started = await runnerFor(agent).resume({
        sessionId: String(p.sessionId),
        cwd: cwdForResume,
      });
      sessionId = started.sessionId;
      shortId = started.shortId;
      cwd = started.cwd;
      name = started.name;
      state = 'STARTING';
      agentSessionId = started.agentSessionId ?? null;
    }

    // A track with no folder of its own takes the one the session is already
    // running in — the user picked the session, so they picked the folder with
    // it, and asking them again would only offer a chance to get it wrong.
    if (!track.cwd && cwd) db.updateTrack(track.id, { cwd });
    const ext = sessionKey(agent, sessionId);
    db.addRef({
      trackId: Number(p.id),
      kind: 'claude_session',
      externalId: ext,
      label: name ?? shortId,
      state,
      role: 'implementation',
      linkRule: 'manual',
      agentSessionId,
    });
    db.adoptOrphanRefs(Number(p.id), ext);
    broadcast({ t: 'changed', entity: 'track', ids: [Number(p.id)] });
    return db.getTrack(Number(p.id));
  },

  /**
   * Starts a new session for a track, in the track's own folder, and links it.
   * This is the "+ session" path: one track, several conversations.
   */
  'tracks.startSession': async (p) => {
    const track = db.getTrack(Number(p.id));
    if (!track) throw new Error('no such track');
    const started = await startTrackSession(track, p);
    // Starting over from a session that is gone: bring its refs along.
    if (typeof p.carryFrom === 'string' && p.carryFrom) {
      db.moveSessionRefs(track.id, p.carryFrom, sessionKey(track.agent, started.sessionId));
    }
    broadcast({ t: 'changed', entity: 'track', ids: [track.id] });
    return { track: db.getTrack(track.id), session: started };
  },

  /**
   * Whether a session can still be resumed at all. Asked only when a stopped
   * session is put on screen, never from the poll: it lists every project
   * folder Claude has.
   */
  'sessions.hasTranscript': async (p) => {
    const ext = String(p.session ?? '');
    const ref = db.listSessionRefs().find((r) => r.externalId === ext);
    return runnerForRef(ext).canResume(sessionIdOf(ext), ref?.agentSessionId ?? null);
  },

  /**
   * For a session whose transcript is gone: a fresh one takes its place in the
   * track, with everything it held. Refuses while the old one is still running
   * — that one is not broken, and deleting its tab would orphan a live job.
   */
  'tracks.replaceSession': async (p) => {
    const track = db.getTrack(Number(p.id));
    if (!track) throw new Error('no such track');
    const ext = String(p.session ?? '');
    const old = track.refs.find((r) => r.kind === 'claude_session' && r.externalId === ext);
    if (!old) throw new Error('that session is not part of this track');
    const live = (await listOne(agentOf(ext))).find((s) => isRefOf(s, ext));
    if (live) throw new Error('that session is still running; open it instead');
    const started = await startTrackSession(track, p);
    const now = sessionKey(track.agent, started.sessionId);
    db.replaceSession(track.id, ext, now);
    db.addEvent({
      trackId: track.id,
      source: 'user',
      kind: 'session.replaced',
      title: `started a fresh session for "${old.label ?? ext}", which could not be resumed`,
    });
    broadcast({ t: 'changed', entity: 'track', ids: [track.id] });
    return { track: db.getTrack(track.id), session: started };
  },

  /**
   * Wakes a session that stopped. `claude --resume` without --fork-session keeps
   * the session id and its original folder, so every ref it held is still its
   * own — nothing to re-link.
   */
  'tracks.resumeSession': async (p) => {
    const track = db.getTrack(Number(p.id));
    if (!track) throw new Error('no such track');
    const ext = String(p.session ?? '');
    const ref = track.refs.find((r) => r.kind === 'claude_session' && r.externalId === ext);
    if (!ref) throw new Error('that session is not part of this track');
    const agent = agentOf(ext);
    const sessionId = sessionIdOf(ext);
    await assertAgentUsable(agent);
    // It may never have stopped — only looked that way to a caller matching on
    // the UUID. Resuming it again would start a second, empty session.
    const live = (await listOne(agent)).find((s) => isRefOf(s, ext));
    if (live) {
      db.setRefState('claude_session', ext, live.state);
      broadcast({ t: 'changed', entity: 'track', ids: [track.id] });
      return { track: db.getTrack(track.id), session: { ...live, sessionId } };
    }
    const started = await runnerFor(agent).resume({
      sessionId,
      ...(track.cwd ? { cwd: track.cwd } : {}),
      agentSessionId: ref.agentSessionId,
    });
    // The CLI can continue the conversation under a new id; follow it, or the
    // tab keeps pointing at the one that is gone.
    const now = sessionKey(agent, started.sessionId);
    if (now !== ext) db.repointSession(track.id, ext, now);
    db.setRefState('claude_session', now, 'STARTING');
    if (started.agentSessionId) db.setRefAgentSessionId(now, started.agentSessionId);
    broadcast({ t: 'changed', entity: 'track', ids: [track.id] });
    return { track: db.getTrack(track.id), session: started };
  },

  'tracks.removeRef': async (p) => {
    const ref = db.getTrack(Number(p.id))?.refs.find((r) => r.id === Number(p.refId));
    db.removeRef(Number(p.id), Number(p.refId));
    broadcast({ t: 'changed', entity: 'track', ids: [Number(p.id)] });
    // Closing a session's tab is the user saying they are done with it — unless
    // another track still has it, in which case it is only leaving this one.
    if (ref?.kind === 'claude_session') {
      const ext = ref.externalId;
      if (!db.listSessionRefs().some((r) => r.externalId === ext)) {
        void sessionsBehind([ext]).then(stopSessions);
      }
    }
    return db.getTrack(Number(p.id));
  },

  'tracks.addNote': async (p) => {
    db.addEvent({
      trackId: Number(p.id),
      source: 'user',
      kind: 'note',
      title: String(p.text ?? '').slice(0, 200),
      body: String(p.text ?? ''),
    });
    broadcast({ t: 'changed', entity: 'track', ids: [Number(p.id)] });
    return db.notes(Number(p.id));
  },

  // ── settings ──────────────────────────────────────────────────────────────
  /**
   * Small choices that outlive a window. The daemon holds them because it holds
   * the database, and because the one that exists so far — whether the tray may
   * interrupt you — has to be readable before the first window opens.
   */
  'settings.get': async (p) => ({ value: db.getSetting(String(p.key ?? '')) }),
  'settings.set': async (p) => {
    const key = String(p.key ?? '').trim();
    if (!key) throw new Error('a key is required');
    db.setSetting(key, String(p.value ?? ''));
    return { ok: true };
  },

  // ── pty ───────────────────────────────────────────────────────────────────
  /**
   * Opens a view onto an EXISTING session — `claude attach` for Claude, an
   * attach to its detached tmux session for hermes. Both are non-exclusive, so
   * the user can attach from their own terminal at the same time, and closing
   * this view never stops the session.
   */
  'pty.open': async (p, sock) => {
    const shortId = String(p.shortId);
    const agent = toAgentId(p.agent);
    const viewId = sessionKey(agent, shortId);
    const cmd = runnerFor(agent).attachCommand({ shortId });
    const view = hub.open({
      viewId,
      file: cmd.file,
      args: cmd.args,
      cwd: p.cwd ?? os.homedir(),
      cols: Number(p.cols ?? 120),
      rows: Number(p.rows ?? 32),
      onTitle: adoptTitle,
    });
    const info = view.attach(sock);
    return { viewId, ...info };
  },
  'pty.resize': async (p) => {
    hub.get(String(p.viewId))?.resize(Number(p.cols), Number(p.rows));
    return { ok: true };
  },
  'pty.close': async (p) => {
    hub.close(String(p.viewId));
    return { ok: true };
  },
  'pty.stats': async () => hub.stats(),
};

function handleConnection(sock: net.Socket): void {
  clients.add(sock);
  const decoder = new FrameDecoder();
  sock.on('error', () => void 0);
  sock.on('close', () => {
    clients.delete(sock);
    hub.detachAll(sock);
  });

  sock.on('data', (chunk) => {
    let frames: ReturnType<FrameDecoder['push']>;
    try {
      frames = decoder.push(chunk);
    } catch {
      // A corrupt stream cannot be resynchronized; drop the client rather than
      // guessing at frame boundaries.
      sock.destroy();
      return;
    }
    for (const f of frames) {
      if (f.typ === FRAME_PTY_IN) {
        hub.get(f.viewId)?.input(f.bytes);
      } else if (f.typ === FRAME_CONTROL) {
        void dispatch(sock, f.msg as Record<string, unknown>);
      }
    }
  });
}

async function dispatch(sock: net.Socket, msg: Record<string, unknown>): Promise<void> {
  if (msg.t === 'hello') {
    const c = await getCompat();
    // Already warmed at boot, so this resolves without shelling out.
    const agents = await probeAgents();
    sock.write(
      encodeControl({
        t: 'welcome',
        protocol: PROTOCOL_VERSION,
        daemonVersion: DAEMON_VERSION,
        entry: ENTRY,
        buildId: BUILD_ID,
        pid: process.pid,
        startedAt: STARTED_AT,
        claude: { cliVersion: c.cliVersion, tier: c.tier, notes: c.notes },
        agents,
      }),
    );
    return;
  }
  if (msg.t !== 'rpc') return;

  const id = typeof msg.id === 'number' ? msg.id : -1;
  const method = String(msg.method ?? '');
  const handler = methods[method];
  if (!handler) {
    sock.write(
      encodeControl({
        t: 'error',
        id,
        ok: false,
        code: 'unknown_method',
        message: `no such method: ${method}`,
        retryable: false,
      }),
    );
    return;
  }
  try {
    const data = await handler((msg.params ?? {}) as any, sock);
    sock.write(encodeControl({ t: 'result', id, ok: true, data }));
  } catch (err) {
    sock.write(
      encodeControl({
        t: 'error',
        id,
        ok: false,
        code: 'handler_failed',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      }),
    );
  }
}

async function isDaemonAlive(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net
      .connect(sock)
      .on('connect', () => {
        s.destroy();
        resolve(true);
      })
      .on('error', () => resolve(false));
  });
}

async function main(): Promise<void> {
  void getCompat(); // warm it: `hello` must never wait on a subprocess
  void probeAgents(); // same, for the wizard's agent row
  // Tell the hermes runner which conversation each of its session keys belongs
  // to before anything asks: a restart must not lose that, or a resume would
  // start an empty session next to the real one.
  for (const r of db.listSessionRefs()) {
    if (agentOf(r.externalId) === 'hermes') {
      hermesRunner.remember(sessionIdOf(r.externalId), r.agentSessionId);
    }
  }

  const dir = runtimeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sock = socketPath();

  if (await isDaemonAlive(sock)) {
    process.stdout.write('[omid] a daemon is already listening; exiting\n');
    process.exit(0);
  }
  try {
    fs.unlinkSync(sock);
  } catch {
    /* nothing stale to remove */
  }

  const server = net.createServer(handleConnection);
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stdout.write('[omid] lost the startup race; exiting\n');
      process.exit(0);
    }
    process.stderr.write(`[omid] fatal: ${err.message}\n`);
    process.exit(1);
  });
  server.listen(sock, () => {
    fs.chmodSync(sock, 0o600);
    process.stdout.write(`[omid] v${DAEMON_VERSION} on ${sock} · db ${DATA_DIR}/omid.db\n`);
  });

  // Time-based court rules (stale, snooze expiry) need a clock that ticks even
  // with no UI open. This is the main reason a daemon exists at all.
  setInterval(() => {
    void syncSessions().catch(() => void 0);
    // A court that moved on the clock alone has nothing else to announce it, so
    // this tick is the only thing that can. Without it the rail and the tray sit
    // on a value that stopped being true minutes ago.
    const moved = db.recomputeAll();
    if (moved.length > 0) broadcast({ t: 'changed', entity: 'track', ids: moved });
  }, 5000).unref();

  const shutdown = () => {
    server.close();
    try {
      fs.unlinkSync(sock);
    } catch {
      /* already gone */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
