import { execFile } from 'node:child_process';

export class ClaudeCliError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'ClaudeCliError';
  }
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Raw ANSI output can be large; `claude logs` in particular. */
  maxBuffer?: number;
}

/**
 * Always argv form — never a shell. Session names and cwds are user data and
 * must never reach a shell parser.
 */
export function runClaude(args: string[], o: ExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'claude',
      args,
      {
        cwd: o.cwd,
        timeout: o.timeoutMs ?? 30_000,
        maxBuffer: o.maxBuffer ?? 16 * 1024 * 1024,
        encoding: 'utf8',
        // Keep the CLI from trying to be clever about a non-TTY parent.
        env: { ...process.env, NO_COLOR: process.env.NO_COLOR ?? '' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof err.code === 'number' ? err.code : null;
          reject(new ClaudeCliError(`claude ${args[0]} failed: ${err.message}`, code, stderr));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
