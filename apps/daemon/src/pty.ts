import type net from 'node:net';
import * as pty from 'node-pty';
import { encodeControl, encodePtyOut } from '@omi/protocol';

/** Per-view scrollback kept in memory for instant re-attach. */
const RING_CAP = 2 * 1024 * 1024;

export interface OpenOptions {
  viewId: string;
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
}

/**
 * One PTY the daemon owns, plus the byte log needed to repaint a client that
 * attaches later. The Claude session itself is NOT owned here — it lives in
 * Claude's own supervisor, so closing a view never ends a session.
 */
class PtyView {
  readonly id: string;
  readonly proc: pty.IPty;
  epoch = 1;
  head = 0n;

  private chunks: Buffer[] = [];
  private ringBytes = 0;
  /** Offset of the first byte still held in the ring. */
  private ringStart = 0n;
  private readonly subs = new Set<net.Socket>();
  exited: { code: number; signal: number | undefined } | null = null;

  constructor(o: OpenOptions) {
    this.id = o.viewId;
    this.proc = pty.spawn(o.file, o.args, {
      name: 'xterm-256color',
      cols: o.cols,
      rows: o.rows,
      cwd: o.cwd,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    });

    this.proc.onData((data) => this.onData(Buffer.from(data, 'utf8')));
    this.proc.onExit(({ exitCode, signal }) => {
      this.exited = { code: exitCode, signal };
      this.broadcastControl({ t: 'pty.exit', viewId: this.id, code: exitCode, signal });
    });
  }

  private onData(bytes: Buffer): void {
    const start = this.head;
    this.head += BigInt(bytes.length);

    this.chunks.push(bytes);
    this.ringBytes += bytes.length;
    while (this.ringBytes > RING_CAP && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (!dropped) break;
      this.ringBytes -= dropped.length;
      this.ringStart += BigInt(dropped.length);
    }

    const frame = encodePtyOut(this.id, this.epoch, start, bytes);
    for (const s of this.subs) s.write(frame);
  }

  private broadcastControl(msg: unknown): void {
    const frame = encodeControl(msg);
    for (const s of this.subs) s.write(frame);
  }

  /**
   * Replay is written into the SAME socket before the subscriber is registered,
   * so a live chunk can never overtake it. Ordering is structural, not a matter
   * of timing.
   */
  attach(sock: net.Socket): { epoch: number; replayFrom: string; head: string } {
    const replay = Buffer.concat(this.chunks);
    if (replay.length > 0) {
      sock.write(encodePtyOut(this.id, this.epoch, this.ringStart, replay));
    }
    this.subs.add(sock);
    sock.once('close', () => this.subs.delete(sock));
    return { epoch: this.epoch, replayFrom: this.ringStart.toString(), head: this.head.toString() };
  }

  detach(sock: net.Socket): void {
    this.subs.delete(sock);
  }

  input(bytes: Buffer): void {
    if (!this.exited) this.proc.write(bytes.toString('utf8'));
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    try {
      this.proc.resize(Math.max(2, cols), Math.max(2, rows));
    } catch {
      // The pty can die between the check and the call; not worth crashing over.
    }
  }

  /** Closes OUR view. The Claude session keeps running under its own supervisor. */
  close(): void {
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
    this.subs.clear();
  }
}

export class PtyHub {
  private readonly views = new Map<string, PtyView>();

  open(o: OpenOptions): PtyView {
    const existing = this.views.get(o.viewId);
    if (existing && !existing.exited) return existing;
    const view = new PtyView(o);
    this.views.set(o.viewId, view);
    return view;
  }

  get(viewId: string): PtyView | undefined {
    return this.views.get(viewId);
  }

  close(viewId: string): void {
    this.views.get(viewId)?.close();
    this.views.delete(viewId);
  }

  detachAll(sock: net.Socket): void {
    for (const v of this.views.values()) v.detach(sock);
  }

  stats(): { viewId: string; head: string; alive: boolean }[] {
    return [...this.views.values()].map((v) => ({
      viewId: v.id,
      head: v.head.toString(),
      alive: v.exited === null,
    }));
  }
}
