import { z } from 'zod';

export * from './frames.js';

/**
 * Control-plane protocol between the daemon and the UI.
 *
 * SCOPE: this is control messages only, carried as newline-delimited JSON.
 * The plan specifies a length-prefixed BINARY framing for PTY output, because
 * base64-in-JSON wastes 33% on the one path that can be megabytes. That framing
 * lands with the PTY hub in Phase 1; nothing here streams terminal bytes yet.
 */

export const PROTOCOL_VERSION = 1;

export const Hello = z.object({
  t: z.literal('hello'),
  protocol: z.number(),
  client: z.string(),
  pid: z.number(),
});

export const Welcome = z.object({
  t: z.literal('welcome'),
  protocol: z.number(),
  daemonVersion: z.string(),
  pid: z.number(),
  startedAt: z.number(),
  /** So the UI can render the compat banner immediately, before any RPC. */
  claude: z.object({
    cliVersion: z.string(),
    tier: z.enum(['supported', 'degraded', 'unsupported']),
    notes: z.array(z.string()),
  }),
});

export const Rpc = z.object({
  t: z.literal('rpc'),
  id: z.number(),
  method: z.string(),
  params: z.unknown().optional(),
});

export const Result = z.object({
  t: z.literal('result'),
  id: z.number(),
  ok: z.literal(true),
  data: z.unknown(),
});

export const Failure = z.object({
  t: z.literal('error'),
  id: z.number(),
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});

export const ClientMsg = z.discriminatedUnion('t', [Hello, Rpc]);
export const ServerMsg = z.discriminatedUnion('t', [Welcome, Result, Failure]);

export type Hello = z.infer<typeof Hello>;
export type Welcome = z.infer<typeof Welcome>;
export type Rpc = z.infer<typeof Rpc>;
export type Result = z.infer<typeof Result>;
export type Failure = z.infer<typeof Failure>;
export type ClientMsg = z.infer<typeof ClientMsg>;
export type ServerMsg = z.infer<typeof ServerMsg>;

/**
 * Splits a byte stream into newline-delimited JSON values, holding any
 * incomplete trailing line. A socket read boundary lands mid-message often
 * enough that not buffering is a guaranteed bug.
 */
export class LineDecoder {
  private partial = '';

  push(chunk: Buffer | string): unknown[] {
    const text = this.partial + chunk.toString();
    const lines = text.split('\n');
    this.partial = lines.pop() ?? '';
    const out: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A malformed line is dropped, never fatal.
      }
    }
    return out;
  }
}

export function encodeLine(msg: unknown): string {
  return `${JSON.stringify(msg)}\n`;
}

/** Socket and runtime paths. XDG_RUNTIME_DIR is tmpfs and cleared at logout. */
export function runtimeDir(): string {
  const base = process.env.XDG_RUNTIME_DIR ?? `/tmp/omi-${process.getuid?.() ?? 0}`;
  return `${base}/oh-my-ide`;
}
export function socketPath(): string {
  return `${runtimeDir()}/daemon.sock`;
}
export function lockPath(): string {
  return `${runtimeDir()}/daemon.lock`;
}
