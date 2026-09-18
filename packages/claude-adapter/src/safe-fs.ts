import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');

/**
 * Credentials must never be opened, whatever else changes. This list is a hard
 * stop, checked before the allowlist.
 */
const DENY_BASENAME = [/^\.credentials\.json$/i, /\.key$/i, /\.pem$/i, /^auth\.json$/i, /token/i];

/** Only these artifacts are ever read, and only read-only. */
const ALLOW = [
  { dir: 'projects', ext: /\.jsonl$/ },
  { dir: 'sessions', ext: /\.json$/ }, // tier 3 — enrichment only, never load-bearing
  { dir: 'jobs', ext: /\.(json|jsonl)$/ },
];

export class DeniedPathError extends Error {
  constructor(
    readonly target: string,
    reason: string,
  ) {
    super(`refusing to read ${target}: ${reason}`);
    this.name = 'DeniedPathError';
  }
}

export function assertReadable(abs: string): void {
  const resolved = path.resolve(abs);
  const rel = path.relative(CLAUDE_HOME, resolved);

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new DeniedPathError(abs, 'outside the Claude home directory');
  }
  const base = path.basename(resolved);
  if (DENY_BASENAME.some((r) => r.test(base))) {
    throw new DeniedPathError(abs, 'credential-like filename');
  }
  const ok = ALLOW.some((a) => rel.startsWith(`${a.dir}${path.sep}`) && a.ext.test(resolved));
  if (!ok) throw new DeniedPathError(abs, 'not an allowed artifact');
}

/** Every read in this package goes through here. Read-only, always. */
export function safeOpen(abs: string): number {
  assertReadable(abs);
  return fs.openSync(abs, 'r');
}

/**
 * The cwd -> directory-name slug is LOSSY: a literal hyphen in a path is
 * indistinguishable from a separator. Directory names may only be used to
 * enumerate candidate files. Identity always comes from the `cwd` field inside
 * the JSONL. This function exists so the rule is greppable, not so it is used.
 */
export function slugIsNotAPath(): never {
  throw new Error('never reconstruct a cwd from a directory slug — read it from the transcript');
}
