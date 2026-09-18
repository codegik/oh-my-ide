import fs from 'node:fs';
import path from 'node:path';
import { shortIdOf } from './agents.js';
import { CLAUDE_HOME, safeOpen } from './safe-fs.js';

export interface PastSession {
  sessionId: string;
  shortId: string;
  cwd: string;
  gitBranch: string | null;
  /** File birthtime, ms epoch; null if the filesystem can't report one. */
  startedAt: number | null;
  /** File mtime, ms epoch — the cheap, reliable proxy for "last touched". */
  lastActivityAt: number;
  /** Single line, <=120 chars; null if nothing usable was found. */
  preview: string | null;
}

const HEAD_BYTES = 8 * 1024;
const TAIL_BYTES = 16 * 1024;
const PREVIEW_MAX = 120;

/**
 * Best-effort, LOSSY candidate directory name — see slugIsNotAPath() in
 * safe-fs.ts. Every `/` and `.` becomes `-`. A literal hyphen in the cwd is
 * indistinguishable from a separator, so this is ONLY used to shortlist
 * files; every candidate is still verified against the transcript's own
 * `cwd` field before it is trusted.
 */
function candidateSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/** A line straddling a chunk boundary parses as garbage; drop it, never guess. */
function parseLines(chunk: string, opts: { dropFirst: boolean; dropLast: boolean }): Record<string, unknown>[] {
  const lines = chunk.split('\n');
  if (opts.dropFirst) lines.shift();
  if (opts.dropLast) lines.pop();
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>);
    } catch {
      // Not JSON, or truncated — skip it.
    }
  }
  return out;
}

function firstString(lines: Record<string, unknown>[], field: string): string | null {
  for (const l of lines) {
    const v = l[field];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** Best-effort text out of a user turn's `message.content`, which may be a string or a content-block array. */
function userTextOf(line: Record<string, unknown>): string | null {
  const message = line.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string') return text;
      }
    }
  }
  return null;
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX);
}

function readSession(file: string, wantCwd: string): PastSession | null {
  const fd = safeOpen(file);
  try {
    const st = fs.fstatSync(fd);
    const headLen = Math.min(HEAD_BYTES, st.size);
    const headBuf = Buffer.alloc(headLen);
    fs.readSync(fd, headBuf, 0, headLen, 0);
    const head = parseLines(headBuf.toString('utf8'), { dropFirst: false, dropLast: st.size > headLen });

    let tail: Record<string, unknown>[] = [];
    if (st.size > HEAD_BYTES) {
      const tailLen = Math.min(TAIL_BYTES, st.size);
      const tailBuf = Buffer.alloc(tailLen);
      const tailStart = st.size - tailLen;
      fs.readSync(fd, tailBuf, 0, tailLen, tailStart);
      tail = parseLines(tailBuf.toString('utf8'), { dropFirst: tailStart > 0, dropLast: false });
    }

    const all = [...head, ...tail];
    const cwd = firstString(all, 'cwd');
    if (cwd !== wantCwd) return null;

    const sessionId = firstString(all, 'sessionId');
    if (!sessionId) return null;

    const lastPrompt = firstString(tail.length > 0 ? tail : all, 'lastPrompt');
    const firstUserText = head.map(userTextOf).find((t): t is string => !!t) ?? null;
    const preview = lastPrompt ? squash(lastPrompt) : firstUserText ? squash(firstUserText) : null;

    return {
      sessionId,
      shortId: shortIdOf(sessionId),
      cwd,
      gitBranch: firstString(all, 'gitBranch'),
      startedAt: st.birthtimeMs > 0 ? Math.round(st.birthtimeMs) : null,
      lastActivityAt: Math.round(st.mtimeMs),
      preview: preview || null,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * All past sessions on disk for an exact cwd, newest-activity first. A missing
 * candidate directory means this exact cwd has never run — the slug is a
 * deterministic function of the cwd string, so there is no broader tree scan
 * that could find something identity-verification wouldn't reject anyway.
 *
 * Never capped or deduped against live sessions here — that is a display
 * policy, and belongs to the caller that also knows the live list (the
 * daemon), not to "what's on disk for this folder".
 */
export function pastSessionsFor(cwd: string): PastSession[] {
  const dir = path.join(CLAUDE_HOME, 'projects', candidateSlug(cwd));
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: PastSession[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const s = readSession(path.join(dir, name), cwd);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}
