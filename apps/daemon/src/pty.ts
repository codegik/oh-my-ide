import type net from 'node:net';
import { encodeControl, encodePtyOut } from '@omi/protocol';
import * as pty from 'node-pty';

/** Per-view scrollback kept in memory for instant re-attach. */
const RING_CAP = 2 * 1024 * 1024;

/**
 * Reads the session title out of a pty stream.
 *
 * The Claude CLI does not rename a session, but it does publish a running
 * summary of the conversation as the terminal title (OSC 0/2), and reading it
 * costs nothing: the bytes are already passing through.
 *
 * This is a state machine rather than a regex over each chunk because a title
 * can be split across writes, and because a title the CLI starts and abandons
 * must not be completed by an unrelated BEL later in the stream — that spliced
 * fragments together and produced titles like "tReply session".
 */
export class TitleScanner {
  /** Longest title we will assemble; past that it is not a title. */
  private static readonly MAX = 256;
  private buf: string | null = null;
  /** Digits of the OSC Ps code, while still being read; null once validated. */
  private ps: string | null = null;
  /** Set when the last byte was ESC, which may begin OSC or end it (ESC \\). */
  private sawEsc = false;

  /** Feeds a chunk and returns the last title completed in it, if any. */
  push(chunk: string): string | null {
    let done: string | null = null;
    for (const ch of chunk) {
      if (this.buf === null) {
        // Waiting for the "ESC ] 0 ;" / "ESC ] 2 ;" opener.
        if (this.sawEsc && ch === ']') {
          this.buf = '';
          this.ps = '';
          this.sawEsc = false;
          continue;
        }
        this.sawEsc = ch === '\x1b';
        continue;
      }
      if (this.ps !== null) {
        // Reading the Ps code: only 0 (icon) / 2 (window title) are a title.
        // Anything else — e.g. an OSC 9;4 progress report — is not one of ours.
        if (ch >= '0' && ch <= '9') {
          this.ps += ch;
          continue;
        }
        if (ch === ';' && (this.ps === '0' || this.ps === '2')) {
          this.ps = null;
          continue;
        }
        this.abandon();
        continue;
      }
      if (ch === '\x07') {
        done = this.finish() ?? done;
        continue;
      }
      if (this.sawEsc) {
        // ESC \\ terminates; any other escape means this was never a title.
        done = ch === '\\' ? (this.finish() ?? done) : done;
        if (ch !== '\\') this.abandon();
        this.sawEsc = false;
        continue;
      }
      if (ch === '\x1b') {
        this.sawEsc = true;
        continue;
      }
      if (this.buf.length >= TitleScanner.MAX) {
        this.abandon();
        continue;
      }
      this.buf += ch;
    }
    return done;
  }

  private finish(): string | null {
    const raw = this.buf ?? '';
    this.buf = null;
    this.ps = null;
    const clean = cleanTitle(raw);
    return clean.length > 0 ? clean : null;
  }

  private abandon(): void {
    this.buf = null;
    this.ps = null;
  }
}

/** Drops the CLI's status glyphs and squeezes whitespace. */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/[✀-➿☀-⛿←-⇿⬀-⯿■-◿]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

export interface OpenOptions {
  viewId: string;
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  /** Called when the session's own terminal title changes. */
  onTitle?: (viewId: string, title: string) => void;
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
  private title: string | null = null;
  private readonly onTitle: ((viewId: string, title: string) => void) | undefined;
  private readonly titles = new TitleScanner();
  /** Offset of the first byte still held in the ring. */
  private ringStart = 0n;
  private readonly subs = new Set<net.Socket>();
  exited: { code: number; signal: number | undefined } | null = null;

  constructor(o: OpenOptions) {
    this.id = o.viewId;
    this.onTitle = o.onTitle;
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
    this.scanTitle(bytes);

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

  /** Only the last title in a chunk matters; the CLI repaints it constantly. */
  private scanTitle(bytes: Buffer): void {
    if (!this.onTitle) return;
    const clean = this.titles.push(bytes.toString('utf8'));
    if (clean === null || clean === this.title) return;
    this.title = clean;
    this.onTitle(this.id, clean);
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
