import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HOME, safeOpen } from './safe-fs.js';

/**
 * What a session has spent, read from its own transcript. Every assistant turn
 * in the JSONL carries the API's `usage` block, so this is Claude's number, not
 * an estimate — but it is tokens only. Dollars would need a price table that
 * goes stale on the next pricing change, and the CLI's own `cost-state` line is
 * only written when a session exits, so it lies about a session still running.
 */
export interface SessionUsage {
  sessionId: string;
  /** The model of the most recent turn, e.g. `claude-opus-5`. */
  model: string | null;
  gitBranch: string | null;
  /**
   * What the most recent request sent — fresh input plus cache reads and
   * writes. It is how much the conversation weighs right now, and it drops
   * after a compaction; the totals below never do.
   */
  contextTokens: number;
  /** API requests, each counted once however many lines it was split over. */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Subagents run by this session: their tokens are in the totals above too. */
  subagents: number;
  subagentTokens: number;
  lastActivityAt: number | null;
}

interface Totals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Parse state for one transcript file. Transcripts reach tens of megabytes and
 * the UI asks about the same one every few seconds while it works, so each call
 * reads only the bytes appended since the last one.
 */
interface FileScan extends Totals {
  ino: number;
  offset: number;
  /** A streamed reply is written as one line per content block, each repeating the same usage. */
  seen: Set<string>;
  model: string | null;
  gitBranch: string | null;
  contextTokens: number;
  lastActivityAt: number | null;
}

const scans = new Map<string, FileScan>();
const CHUNK = 1024 * 1024;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function freshScan(ino: number): FileScan {
  return {
    ino,
    offset: 0,
    seen: new Set(),
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    model: null,
    gitBranch: null,
    contextTokens: 0,
    lastActivityAt: null,
  };
}

function absorb(scan: FileScan, line: Record<string, unknown>): void {
  if (typeof line.gitBranch === 'string' && line.gitBranch) scan.gitBranch = line.gitBranch;
  if (line.type !== 'assistant') return;
  const message = line.message as { id?: unknown; model?: unknown; usage?: unknown } | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!message || !usage) return;

  const key =
    typeof message.id === 'string' ? message.id : String(line.requestId ?? line.uuid ?? '');
  if (key) {
    if (scan.seen.has(key)) return;
    scan.seen.add(key);
  }

  const input = num(usage.input_tokens);
  const read = num(usage.cache_read_input_tokens);
  const write = num(usage.cache_creation_input_tokens);
  scan.requests++;
  scan.inputTokens += input;
  scan.outputTokens += num(usage.output_tokens);
  scan.cacheReadTokens += read;
  scan.cacheWriteTokens += write;

  // `<synthetic>` marks a line the CLI wrote itself (an API error, an
  // interruption); it was never sent, so it says nothing about the context.
  // Sidechain lines are a subagent's conversation, not this one's.
  if (message.model === '<synthetic>' || line.isSidechain === true) return;
  if (typeof message.model === 'string') scan.model = message.model;
  scan.contextTokens = input + read + write;
  const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : Number.NaN;
  if (!Number.isNaN(at)) scan.lastActivityAt = at;
}

/** Brings the scan of one file up to date and returns it; null if it can't be read. */
function scanFile(file: string): FileScan | null {
  let fd: number;
  try {
    fd = safeOpen(file);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    let scan = scans.get(file);
    // Replaced or truncated: what we counted no longer describes this file.
    if (!scan || scan.ino !== st.ino || st.size < scan.offset) {
      scan = freshScan(st.ino);
      scans.set(file, scan);
    }
    // Split on bytes, not decoded text: a chunk boundary can land inside a
    // multi-byte character, and the offset has to stay a true byte position.
    let carry = Buffer.alloc(0);
    let pos = scan.offset;
    while (pos < st.size) {
      const chunk = Buffer.alloc(Math.min(CHUNK, st.size - pos));
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      const bytes = Buffer.concat([carry, chunk.subarray(0, n)]);
      const cut = bytes.lastIndexOf(0x0a);
      // Only advance past whole lines, so a line the CLI is halfway through
      // writing is read again, complete, next time.
      if (cut === -1) {
        carry = bytes;
        continue;
      }
      carry = bytes.subarray(cut + 1);
      for (const raw of bytes.toString('utf8', 0, cut).split('\n')) {
        // Most lines are tool results and snapshots; skip them before paying for a parse.
        if (!raw.includes('"type":"assistant"')) continue;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') absorb(scan, parsed as Record<string, unknown>);
        } catch {
          // Not JSON, or truncated — skip it.
        }
      }
    }
    scan.offset = pos - carry.length;
    return scan;
  } finally {
    fs.closeSync(fd);
  }
}

/** Resolved transcript paths. A session's file never moves once it exists. */
const located = new Map<string, string>();

/**
 * Finds `<sessionId>.jsonl` under `projects/`. The folder slug is only a guess
 * at where to look first (see slugIsNotAPath in safe-fs.ts); the file name is
 * the session id, so a hit is the right file whichever folder it is in.
 */
function locate(sessionId: string, cwdHint?: string): string | null {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return null;
  const known = located.get(sessionId);
  if (known && fs.existsSync(known)) return known;

  const name = `${sessionId}.jsonl`;
  const root = path.join(CLAUDE_HOME, 'projects');
  const dirs: string[] = [];
  if (cwdHint) dirs.push(cwdHint.replace(/[/.]/g, '-'));
  try {
    dirs.push(...fs.readdirSync(root));
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = path.join(root, dir, name);
    if (fs.existsSync(file)) {
      located.set(sessionId, file);
      return file;
    }
  }
  return null;
}

function subagentFiles(transcript: string): string[] {
  const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

const totalOf = (t: Totals) =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;

/**
 * Usage for one session, summed over every transcript it has written under the
 * ids given — a background job that moved into a worktree carries on under a
 * new id (see isSameSession), and both halves were spent by the same job. The
 * point-in-time fields (context, model) come from whichever was active last.
 * Null when no transcript for any of the ids exists yet.
 */
export function sessionUsage(sessionIds: string[], cwdHint?: string): SessionUsage | null {
  const out: SessionUsage = {
    sessionId: sessionIds[0] ?? '',
    model: null,
    gitBranch: null,
    contextTokens: 0,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    subagents: 0,
    subagentTokens: 0,
    lastActivityAt: null,
  };
  const add = (t: Totals) => {
    out.requests += t.requests;
    out.inputTokens += t.inputTokens;
    out.outputTokens += t.outputTokens;
    out.cacheReadTokens += t.cacheReadTokens;
    out.cacheWriteTokens += t.cacheWriteTokens;
  };

  let found = false;
  for (const id of new Set(sessionIds)) {
    const file = locate(id, cwdHint);
    const scan = file ? scanFile(file) : null;
    if (!file || !scan) continue;
    found = true;
    add(scan);
    if (scan.lastActivityAt !== null && scan.lastActivityAt >= (out.lastActivityAt ?? 0)) {
      out.sessionId = id;
      out.model = scan.model;
      out.gitBranch = scan.gitBranch;
      out.contextTokens = scan.contextTokens;
      out.lastActivityAt = scan.lastActivityAt;
    }
    for (const sub of subagentFiles(file)) {
      const s = scanFile(sub);
      if (!s || s.requests === 0) continue;
      add(s);
      out.subagents++;
      out.subagentTokens += totalOf(s);
    }
  }
  return found ? out : null;
}
