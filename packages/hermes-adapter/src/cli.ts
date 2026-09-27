import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class HermesCliError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'HermesCliError';
  }
}

/** `~/.hermes` unless the user moved it. Everything we read lives under here. */
export const HERMES_HOME = process.env.HERMES_HOME?.startsWith('/')
  ? process.env.HERMES_HOME
  : path.join(os.homedir(), '.hermes');

export const STATE_DB = path.join(HERMES_HOME, 'state.db');
export const TERMINAL_SESSIONS = path.join(HERMES_HOME, 'terminal-sessions');

/**
 * Where hermes is installed, resolved once.
 *
 * PATH alone is not enough here: the daemon can be started from a desktop
 * launcher whose PATH is not the login shell's — the same trap start.sh already
 * works around for node and pnpm — and hermes installs itself into
 * `~/.local/bin`, which such a PATH usually lacks. An absolute path also means
 * the command we hand tmux does not depend on tmux's own environment.
 */
const FALLBACKS = [
  path.join(os.homedir(), '.local', 'bin', 'hermes'),
  path.join(os.homedir(), '.hermes', 'bin', 'hermes'),
  '/usr/local/bin/hermes',
  '/usr/bin/hermes',
];

let resolved: string | null | undefined;

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The hermes binary, or null when it is not installed. */
export function findHermes(): string | null {
  if (resolved !== undefined) return resolved;
  const env = process.env.HERMES_BIN;
  const candidates = [
    ...(env ? [env] : []),
    ...(process.env.PATH ?? '')
      .split(':')
      .filter(Boolean)
      .map((d) => path.join(d, 'hermes')),
    ...FALLBACKS,
  ];
  resolved = candidates.find(isExecutable) ?? null;
  return resolved;
}

/** Forgets the cached lookup, so installing hermes does not need a daemon restart. */
export function forgetHermes(): void {
  resolved = undefined;
}

export function hermesBin(): string {
  const bin = findHermes();
  if (!bin) throw new HermesCliError('`hermes` was not found on PATH', null, '');
  return bin;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

/**
 * Always argv form — never a shell. Session ids and cwds are user data and must
 * never reach a shell parser.
 */
export function runHermes(args: string[], o: ExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      hermesBin(),
      args,
      {
        ...(o.cwd ? { cwd: o.cwd } : {}),
        timeout: o.timeoutMs ?? 30_000,
        maxBuffer: o.maxBuffer ?? 8 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: process.env.NO_COLOR ?? '1' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof err.code === 'number' ? err.code : null;
          reject(new HermesCliError(`hermes ${args[0]} failed: ${err.message}`, code, stderr));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** `Hermes Agent v0.21.5+3804.g04ea129 (2026.9.24) · upstream 04ea129b` → `0.21.5`. */
export function parseVersion(stdout: string): string {
  return /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? '0.0.0';
}
