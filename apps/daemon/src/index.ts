import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ClaudeCompat, NormalizedSession } from '@omi/claude-adapter';
import {
  ClaudeBgRunner,
  hasTranscript,
  isSameSession,
  pastSessionsFor,
  probe,
  sessionUsage,
  shortIdOf,
} from '@omi/claude-adapter';
import { parseRef } from '@omi/core';
import { Db } from '@omi/db';
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

const runner = new ClaudeBgRunner();
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
let lastListError = '';
async function listSessionsOrNone(): Promise<NormalizedSession[]> {
  try {
    const sessions = await runner.list();
    lastListError = '';
    return sessions;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== lastListError) {
      lastListError = msg;
      process.stderr.write(`[omid] could not list Claude sessions: ${msg}\n`);
    }
    return [];
  }
}

async function syncSessions(): Promise<NormalizedSession[]> {
  const sessions = await listSessionsOrNone();
  const touched = new Set<number>();
  // Walk our refs rather than the listing: a session can be listed under a
  // newer UUID than the one we stored (see isSameSession).
  for (const ext of new Set(db.listSessionRefs().map((r) => r.externalId))) {
    const s = sessions.find((x) => isSameSession(x, ext.replace(/^claude:/, '')));
    if (!s) continue;
    for (const id of db.setRefState('claude_session', ext, s.state)) touched.add(id);
  }
  if (touched.size > 0) broadcast({ t: 'changed', entity: 'track', ids: [...touched] });
  return sessions;
}

/**
 * The CLI's own name, which it sets as the title before the conversation has a
 * subject. It says nothing about this session, so it is never worth storing and
 * never worth keeping once a real title turns up.
 */
const GENERIC_TITLE = /^claude(\s+code)?$/i;

/**
 * A session starts life named after its own short id, because there is nothing
 * to call it yet. The first thing the user types gives it a subject, and the CLI
 * publishes that as its terminal title — so that title becomes the session's
 * name. A name the user chose, or one a session already carried, is theirs and
 * stays.
 */
function adoptTitle(viewId: string, title: string): void {
  if (GENERIC_TITLE.test(title)) return;
  const shortId = viewId.replace(/^claude:/, '');
  const touched: number[] = [];
  for (const r of db.listSessionRefs()) {
    if (shortIdOf(r.externalId.replace(/^claude:/, '')) !== shortId) continue;
    // Replaceable: the id it was born with, or the CLI's generic title.
    const placeholder = !r.label || r.label === shortId || GENERIC_TITLE.test(r.label);
    if (!placeholder) continue;
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
    if (s.kind !== 'background' || stopping.has(s.shortId)) continue;
    stopping.add(s.shortId);
    // Ours first, before its process goes: a view closed by us goes quietly,
    // where one whose `claude attach` died under it would announce an exit.
    hub.close(`claude:${s.shortId}`);
    try {
      await runner.stop({ shortId: s.shortId });
    } catch (err) {
      process.stderr.write(
        `[omid] could not stop session ${s.shortId}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } finally {
      stopping.delete(s.shortId);
    }
    for (const r of db.listSessionRefs()) {
      if (isSameSession(s, r.externalId.replace(/^claude:/, ''))) touched.add(r.trackId);
    }
  }
  if (touched.size > 0) broadcast({ t: 'changed', entity: 'track', ids: [...touched] });
}

/** The listed sessions behind these refs. */
async function sessionsBehind(externalIds: string[]): Promise<NormalizedSession[]> {
  if (externalIds.length === 0) return [];
  const listed = await listSessionsOrNone();
  return listed.filter((s) =>
    externalIds.some((ext) => isSameSession(s, ext.replace(/^claude:/, ''))),
  );
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
  // No prompt: the session opens idle and waits for the user to type into it,
  // which is what a new terminal should do. Nothing is spent up front, and the
  // first message is what ends up naming it (see adoptTitle).
  const prompt = String(p.prompt ?? '').trim();
  const started = await runner.start({
    cwd,
    ...(prompt ? { prompt } : {}),
    ...(p.name ? { name: String(p.name) } : {}),
  });
  db.addRef({
    trackId: track.id,
    kind: 'claude_session',
    externalId: `claude:${started.sessionId}`,
    label: started.name ?? started.shortId,
    state: 'STARTING',
    role: 'implementation',
    linkRule: 'started-here',
  });
  db.adoptOrphanRefs(track.id, `claude:${started.sessionId}`);
  return started;
}

type Handler = (params: any, sock: net.Socket) => Promise<unknown>;

const methods: Record<string, Handler> = {
  'daemon.ping': async () => ({ pong: true, uptimeMs: Date.now() - STARTED_AT }),
  'daemon.shutdown': async () => {
    setTimeout(() => process.exit(0), 50);
    return { stopping: true, pid: process.pid };
  },
  'claude.compat': async () => getCompat(),

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
    const liveHere = (await runner.list()).filter((s) => s.cwd === cwd);
    return pastSessionsFor(cwd)
      .filter((h) => !liveHere.some((s) => isSameSession(s, h.sessionId)))
      .slice(0, 20);
  },

  /**
   * Tokens a session has spent, from its transcript. Takes every id the session
   * has gone by — the one a ref stored and the one it is listed under now — and
   * reads only what was appended since the last ask, so the UI can call it
   * while a session works without re-reading megabytes.
   */
  'sessions.usage': async (p) => {
    const ids = (Array.isArray(p.ids) ? p.ids : []).map(String).filter(Boolean).slice(0, 4);
    if (ids.length === 0) return null;
    return sessionUsage(ids, p.cwd ? String(p.cwd) : undefined);
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
    return runner.start({
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

    const live = await runner.list();
    const found = live.find((x) => x.sessionId === p.sessionId || x.shortId === p.sessionId);

    let sessionId: string;
    let shortId: string;
    let cwd: string | null;
    let name: string | null;
    let state: string | null;
    if (found) {
      ({ sessionId, shortId, cwd, name, state } = found);
    } else {
      // Not currently running. Only resume it if a transcript for this
      // track's own folder actually claims that id — a cheap, local,
      // read-only check before any id reaches `claude --bg --resume`.
      const cwdForResume = track.cwd ?? undefined;
      const known =
        cwdForResume && pastSessionsFor(cwdForResume).some((h) => h.sessionId === p.sessionId);
      if (!known) throw new Error('no such session');
      const started = await runner.resume({ sessionId: String(p.sessionId), cwd: cwdForResume });
      sessionId = started.sessionId;
      shortId = started.shortId;
      cwd = started.cwd;
      name = started.name;
      state = 'STARTING';
    }

    // A track with no folder of its own takes the one the session is already
    // running in — the user picked the session, so they picked the folder with
    // it, and asking them again would only offer a chance to get it wrong.
    if (!track.cwd && cwd) db.updateTrack(track.id, { cwd });
    db.addRef({
      trackId: Number(p.id),
      kind: 'claude_session',
      externalId: `claude:${sessionId}`,
      label: name ?? shortId,
      state,
      role: 'implementation',
      linkRule: 'manual',
    });
    db.adoptOrphanRefs(Number(p.id), `claude:${sessionId}`);
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
      db.moveSessionRefs(track.id, p.carryFrom, `claude:${started.sessionId}`);
    }
    broadcast({ t: 'changed', entity: 'track', ids: [track.id] });
    return { track: db.getTrack(track.id), session: started };
  },

  /**
   * Whether a session can still be resumed at all. Asked only when a stopped
   * session is put on screen, never from the poll: it lists every project
   * folder Claude has.
   */
  'sessions.hasTranscript': async (p) =>
    hasTranscript(String(p.session ?? '').replace(/^claude:/, '')),

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
    const live = (await runner.list()).find((s) => isSameSession(s, ext.replace(/^claude:/, '')));
    if (live) throw new Error('that session is still running; open it instead');
    const started = await startTrackSession(track, p);
    const now = `claude:${started.sessionId}`;
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
    const sessionId = ext.replace(/^claude:/, '');
    // It may never have stopped — only looked that way to a caller matching on
    // the UUID. Resuming it again would start a second, empty session.
    const live = (await runner.list()).find((s) => isSameSession(s, sessionId));
    if (live) {
      db.setRefState('claude_session', ext, live.state);
      broadcast({ t: 'changed', entity: 'track', ids: [track.id] });
      return { track: db.getTrack(track.id), session: { ...live, sessionId } };
    }
    const started = await runner.resume({ sessionId, ...(track.cwd ? { cwd: track.cwd } : {}) });
    // The CLI can continue the conversation under a new id; follow it, or the
    // tab keeps pointing at the one that is gone.
    const now = `claude:${started.sessionId}`;
    if (now !== ext) db.repointSession(track.id, ext, now);
    db.setRefState('claude_session', now, 'STARTING');
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
   * Opens a view onto an EXISTING Claude session via `claude attach`. Attach is
   * non-exclusive, so the user can also attach from their own terminal at the
   * same time, and closing this view never stops the session.
   */
  'pty.open': async (p, sock) => {
    const shortId = String(p.shortId);
    const viewId = `claude:${shortId}`;
    const cmd = runner.attachCommand({ shortId });
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
