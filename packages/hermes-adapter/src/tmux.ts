import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Hermes has no background supervisor of its own — no `--bg`, no `attach` — so
 * something else has to own a session's lifetime if closing the window is not
 * going to end the conversation. That something is a detached tmux session, the
 * substrate ADR 0001 kept in reserve for exactly this case: an agent with no
 * supervisor. See docs/decisions/0003-hermes-substrate.md.
 *
 * Everything here is deliberately thin. tmux is the only part of the stack that
 * outlives our daemon, so the less we ask of it the fewer ways it can surprise
 * us: create, attach, kill, and list.
 */

/** Every tmux session we own is named `omi-h-<session key>`; nothing else is ours. */
export const TMUX_PREFIX = 'omi-h-';

export function tmuxName(key: string): string {
  return `${TMUX_PREFIX}${key}`;
}

/** The session key back out of a tmux name, or null when the name is not ours. */
export function keyOfTmux(name: string): string | null {
  return name.startsWith(TMUX_PREFIX) ? name.slice(TMUX_PREFIX.length) : null;
}

const TMUX_FALLBACKS = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/bin/tmux'];

let resolvedTmux: string | null | undefined;

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function findTmux(): string | null {
  if (resolvedTmux !== undefined) return resolvedTmux;
  const candidates = [
    ...(process.env.TMUX_BIN ? [process.env.TMUX_BIN] : []),
    ...(process.env.PATH ?? '')
      .split(':')
      .filter(Boolean)
      .map((d) => path.join(d, 'tmux')),
    ...TMUX_FALLBACKS,
  ];
  resolvedTmux = candidates.find(isExecutable) ?? null;
  return resolvedTmux;
}

export function forgetTmux(): void {
  resolvedTmux = undefined;
}

export function tmuxBin(): string {
  const bin = findTmux();
  if (!bin)
    throw new Error('`tmux` was not found on PATH; it is what keeps a hermes session alive');
  return bin;
}

/**
 * tmux refuses to create a session from inside one ("sessions should be nested
 * with care"), so the variables that say we are inside one are dropped. The
 * daemon can perfectly well have been launched from a tmux pane.
 */
function tmuxEnv(): NodeJS.ProcessEnv {
  const { TMUX, TMUX_PANE, ...rest } = process.env;
  return rest;
}

/**
 * `=name` means "this session exactly, not a prefix of it" — but only where tmux
 * parses a SESSION target. `capture-pane`, `send-keys` and `set-option` parse a
 * pane or a window, and there `=name` is not a target at all: tmux 3.7 answers
 * "can't find pane: =omi-h-…" / "no such session: =omi-h-…". Those calls pass the
 * bare name, which is safe here for a reason worth writing down: every name we
 * create is `omi-h-` plus a fixed-length key, so no name of ours can be a strict
 * prefix of another and tmux's prefix matching has nothing to get wrong.
 */
const exact = (name: string) => `=${name}`;

function tmux(args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      tmuxBin(),
      args,
      { env: tmuxEnv(), timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`tmux ${args[0]}: ${stderr.trim() || err.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** For the one call that has to be synchronous: `attachCommand` needs no I/O. */
function tmuxSync(args: string[]): string {
  return execFileSync(tmuxBin(), args, {
    env: tmuxEnv(),
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

export interface TmuxSession {
  name: string;
  key: string;
  /** The pane's tty, e.g. `/dev/pts/11` — how hermes files its session marker. */
  tty: string;
  cwd: string;
  /** ms epoch. */
  createdAt: number;
  pid: number | null;
}

const LIST_FORMAT =
  '#{session_name}\t#{pane_tty}\t#{session_path}\t#{session_created}\t#{pane_pid}';

export function parseSessions(stdout: string): TmuxSession[] {
  const out: TmuxSession[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name = '', tty = '', cwd = '', created = '', pid = ''] = line.split('\t');
    const key = keyOfTmux(name);
    if (!key) continue;
    out.push({
      name,
      key,
      tty,
      cwd,
      createdAt: Number(created) * 1000 || 0,
      pid: Number(pid) || null,
    });
  }
  return out;
}

/**
 * Our live sessions. An exit status of 1 with "no server running" is the normal
 * "nothing is running" answer, not a failure, so it reads as an empty list.
 */
export async function listSessions(): Promise<TmuxSession[]> {
  if (!findTmux()) return [];
  try {
    return parseSessions(await tmux(['list-sessions', '-F', LIST_FORMAT]));
  } catch {
    return [];
  }
}

export async function hasSession(name: string): Promise<boolean> {
  if (!findTmux()) return false;
  try {
    await tmux(['has-session', '-t', exact(name)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A detached session running one command. `-x`/`-y` matter: a detached session
 * has no client to take its size from, and a TUI drawn at tmux's 80×24 default
 * would reflow the first time a client attached.
 */
export async function newSession(o: {
  name: string;
  cwd: string;
  argv: string[];
  cols?: number;
  rows?: number;
}): Promise<void> {
  const [file, ...args] = o.argv;
  if (!file) throw new Error('nothing to run in the session');
  await tmux([
    'new-session',
    '-d',
    '-s',
    o.name,
    '-c',
    o.cwd,
    '-x',
    String(o.cols ?? 200),
    '-y',
    String(o.rows ?? 50),
    file,
    ...args,
  ]);
  /**
   * Two of the user's own tmux settings have to be turned off for OUR sessions,
   * and neither is cosmetic:
   *
   * - `status off`, because the session is only ever seen inside the app's
   *   terminal pane, where a tmux status bar is a row of someone else's chrome
   *   drawn over the agent's own UI.
   * - `set-titles off`, because with it on tmux OVERWRITES the terminal title
   *   with its own format (`#h:#W` in this user's config) — and the daemon reads
   *   the terminal title to name a session, so the whole session strip ended up
   *   labelled `iomarchy:omi-hermes-work`. With it off no title is published and
   *   the name comes from what hermes itself called the conversation.
   *
   * The prefix key is deliberately left alone, so `tmux attach` from a real
   * terminal still detaches with the keystroke the user already knows.
   *
   * A failure here is reported rather than swallowed: silence is what let the
   * wrong-target bug above sit unnoticed.
   */
  for (const [option, value] of [
    ['status', 'off'],
    ['set-titles', 'off'],
  ]) {
    try {
      await tmux(['set-option', '-t', o.name, option as string, value as string]);
    } catch (err) {
      process.stderr.write(
        `[hermes] could not set ${option} on ${o.name}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

/**
 * `detach-on-destroy on` is set as part of attaching, not left to the user's
 * config. Omarchy ships `detach-on-destroy off`, and with that, when the session
 * a pane is attached to ends (e.g. it was resumed under a new key), tmux does
 * not detach: it SWITCHES the client to another session. The tab then shows a
 * different conversation's terminal under its own label and dot. Setting it on
 * the session at attach time covers sessions created before this was added too.
 * `set-option` parses a pane target, so it gets the bare name (see `exact`).
 */
export function attachArgv(name: string): { file: string; args: string[] } {
  return {
    file: tmuxBin(),
    args: [
      'set-option',
      '-t',
      name,
      'detach-on-destroy',
      'on',
      ';',
      'attach-session',
      '-t',
      exact(name),
    ],
  };
}

export async function killSession(name: string): Promise<void> {
  if (!findTmux()) return;
  try {
    await tmux(['kill-session', '-t', exact(name)]);
  } catch {
    // Already gone, which is the state we were asking for.
  }
}

/** Visible scrollback with its escape sequences, the closest thing to `claude logs`. */
export async function capturePane(name: string, lines = 2000): Promise<string> {
  return tmux(['capture-pane', '-p', '-e', '-t', name, '-S', `-${lines}`]);
}

/** Types into a pane. Used only to hand a brand-new session its first prompt. */
export async function sendKeys(name: string, text: string): Promise<void> {
  await tmux(['send-keys', '-t', name, text]);
  await tmux(['send-keys', '-t', name, 'Enter']);
}

export function tmuxVersion(): string | null {
  if (!findTmux()) return null;
  try {
    return tmuxSync(['-V']).trim();
  } catch {
    return null;
  }
}
