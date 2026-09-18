import { parseAgentList, shortIdOf } from './agents.js';
import { runClaude } from './cli.js';
import type { NormalizedSession, SessionRunner, StartedSession } from './types.js';

/**
 * `claude --bg` prints, on success:
 *
 *   backgrounded · 5c482848 · omi-spike
 *
 * We match the short id rather than the whole line, so a change to the
 * surrounding decoration does not break launching.
 */
const BACKGROUNDED = /\bbackgrounded\b[^\n]*?\b([0-9a-f]{8})\b/i;
const ANY_SHORT_ID = /\b([0-9a-f]{8})\b/;

export function parseBackgroundedId(stdout: string): string | null {
  return (BACKGROUNDED.exec(stdout) ?? ANY_SHORT_ID.exec(stdout))?.[1] ?? null;
}

/**
 * The default substrate. See docs/decisions/0001-session-substrate.md — the spike
 * confirmed full TUI fidelity on attach, non-exclusive attach, and survival of
 * detach (even SIGKILL of the attach client).
 */
export class ClaudeBgRunner implements SessionRunner {
  async start(o: {
    cwd: string;
    /**
     * Optional: `claude --bg` with no prompt backgrounds an idle session
     * ("idle — send a prompt to start"), which is what opening a fresh terminal
     * should do. Nothing is spent until the user types.
     */
    prompt?: string;
    name?: string;
    sessionId?: string;
  }): Promise<StartedSession> {
    // NOTE: --bg and --print conflict; the prompt is positional.
    const args = ['--bg'];
    if (o.name) args.push('-n', o.name);
    if (o.sessionId) args.push('--session-id', o.sessionId);
    if (o.prompt) args.push(o.prompt);

    const stdout = await runClaude(args, { cwd: o.cwd, timeoutMs: 60_000 });
    const shortId = parseBackgroundedId(stdout);
    if (!shortId) {
      throw new Error(`could not find a session id in launch output: ${stdout.slice(0, 200)}`);
    }

    // The launch output gives us only the short id; resolve the full UUID from
    // the listing so callers always get the durable key.
    const sessionId = (await this.list()).find((s) => s.shortId === shortId)?.sessionId ?? null;

    return {
      shortId,
      sessionId: sessionId ?? shortId,
      name: o.name ?? null,
      cwd: o.cwd,
    };
  }

  attachCommand(s: { shortId: string }): { file: string; args: string[] } {
    return { file: 'claude', args: ['attach', s.shortId] };
  }

  async resume(o: { sessionId: string; cwd?: string; fork?: boolean }): Promise<StartedSession> {
    const args = ['--bg', '--resume', o.sessionId];
    if (o.fork) args.push('--fork-session');
    const stdout = await runClaude(args, { ...(o.cwd ? { cwd: o.cwd } : {}), timeoutMs: 60_000 });
    const shortId = parseBackgroundedId(stdout) ?? shortIdOf(o.sessionId);
    const found = (await this.list()).find((s) => s.shortId === shortId);
    return {
      shortId,
      sessionId: found?.sessionId ?? o.sessionId,
      name: found?.name ?? null,
      cwd: found?.cwd ?? o.cwd ?? process.cwd(),
    };
  }

  async stop(s: { shortId: string }): Promise<void> {
    await runClaude(['stop', s.shortId]);
  }

  async remove(s: { shortId: string }): Promise<void> {
    await runClaude(['rm', s.shortId]);
  }

  async list(): Promise<NormalizedSession[]> {
    const stdout = await runClaude(['agents', '--json'], { timeoutMs: 15_000 });
    return parseAgentList(stdout).sessions;
  }

  async logs(s: { shortId: string }): Promise<string> {
    return runClaude(['logs', s.shortId], { timeoutMs: 20_000 });
  }
}
