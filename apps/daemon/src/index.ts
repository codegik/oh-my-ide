import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ClaudeBgRunner, probe } from '@omi/claude-adapter';
import type { ClaudeCompat, NormalizedSession } from '@omi/claude-adapter';
import { parseRef } from '@omi/core';
import { Db } from '@omi/db';
import {
  FRAME_CONTROL,
  FRAME_PTY_IN,
  FrameDecoder,
  PROTOCOL_VERSION,
  encodeControl,
  runtimeDir,
  socketPath,
} from '@omi/protocol';
import { PtyHub } from './pty.js';

const DAEMON_VERSION = '0.0.2';
const STARTED_AT = Date.now();

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
    .then((c) => ((compat = c), c))
    .catch((err) => {
      compatPromise = null;
      return {
        cliVersion: 'unknown',
        tier: 'degraded' as const,
        features: {
          background: false, attach: false, logs: false, stop: false, respawn: false,
          agentsJson: false, forkSession: false, sessionId: false, name: false,
        },
        notes: [`Could not probe the Claude CLI: ${err instanceof Error ? err.message : String(err)}`],
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
async function syncSessions(): Promise<NormalizedSession[]> {
  const sessions = await runner.list();
  const touched = new Set<number>();
  for (const s of sessions) {
    for (const id of db.setRefState('claude_session', `claude:${s.sessionId}`, s.state)) {
      touched.add(id);
    }
  }
  if (touched.size > 0) broadcast({ t: 'changed', entity: 'track', ids: [...touched] });
  return sessions;
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

  // ── tracks ────────────────────────────────────────────────────────────────
  'tracks.list': async () => {
    await syncSessions();
    return db.listTracks(false);
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
    const t = db.updateTrack(Number(p.id), p.patch ?? {});
    broadcast({ t: 'changed', entity: 'track', ids: [Number(p.id)] });
    return t;
  },
  'tracks.timeline': async (p) => db.timeline(Number(p.id)),
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
    const sessions = await runner.list();
    const s = sessions.find((x) => x.sessionId === p.sessionId || x.shortId === p.sessionId);
    if (!s) throw new Error('no such session');
    db.addRef({
      trackId: Number(p.id),
      kind: 'claude_session',
      externalId: `claude:${s.sessionId}`,
      label: s.name ?? s.shortId,
      state: s.state,
      role: 'implementation',
      linkRule: 'manual',
    });
    broadcast({ t: 'changed', entity: 'track', ids: [Number(p.id)] });
    return db.getTrack(Number(p.id));
  },

  'tracks.removeRef': async (p) => {
    db.removeRef(Number(p.id), Number(p.refId));
    broadcast({ t: 'changed', entity: 'track', ids: [Number(p.id)] });
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
    return db.timeline(Number(p.id));
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
    } catch (err) {
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
    sock.write(encodeControl({
      t: 'error', id, ok: false, code: 'unknown_method',
      message: `no such method: ${method}`, retryable: false,
    }));
    return;
  }
  try {
    const data = await handler((msg.params ?? {}) as any, sock);
    sock.write(encodeControl({ t: 'result', id, ok: true, data }));
  } catch (err) {
    sock.write(encodeControl({
      t: 'error', id, ok: false, code: 'handler_failed',
      message: err instanceof Error ? err.message : String(err), retryable: true,
    }));
  }
}

async function isDaemonAlive(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(sock)
      .on('connect', () => { s.destroy(); resolve(true); })
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
  try { fs.unlinkSync(sock); } catch { /* nothing stale to remove */ }

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
    db.recomputeAll();
  }, 5000).unref();

  const shutdown = () => {
    server.close();
    try { fs.unlinkSync(sock); } catch { /* already gone */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
