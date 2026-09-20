import fs from 'node:fs';
import path from 'node:path';

/**
 * Opening a real terminal in a track's folder. The app renders Claude sessions,
 * not shells: the moment you want to run `git log` or poke at a worktree by
 * hand, you want YOUR terminal, with your shell and your theme, already in the
 * right directory.
 *
 * Which terminal that is, is the desktop's business and not ours to guess at
 * length — $TERMINAL wins if it is set (Omarchy and friends set it), and the
 * fallback list only exists so a machine without one still opens something.
 */
const LINUX_TERMINALS = [
  // The freedesktop launcher: it knows the user's default terminal, so it
  // outranks any name we could hardcode.
  'xdg-terminal-exec',
  'ghostty',
  'alacritty',
  'kitty',
  'foot',
  'wezterm',
  'gnome-terminal',
  'konsole',
  'xterm',
];

export type TerminalLaunch = { file: string; args: string[]; cwd: string };

export type ResolveEnv = {
  platform: string;
  env: Record<string, string | undefined>;
  /** True when this command can be run: a PATH lookup, faked in tests. */
  exists: (cmd: string) => boolean;
};

/**
 * The folder is passed as the CHILD'S WORKING DIRECTORY rather than as a flag,
 * because every terminal spells that flag differently and all of them inherit a
 * cwd. The one exception is the freedesktop launcher, which may hand the job to
 * systemd and lose the cwd on the way, so it gets told explicitly as well.
 */
export function resolveTerminal(dir: string, ctx: ResolveEnv): TerminalLaunch | null {
  if (ctx.platform === 'darwin') {
    // `open` starts the app from launchd, where our cwd means nothing; on macOS
    // the folder is an argument and $TERMINAL is an app name, not a binary.
    return { file: 'open', args: ['-a', ctx.env.TERMINAL || 'Terminal', dir], cwd: dir };
  }
  const named = ctx.env.TERMINAL?.trim();
  const candidates = named ? [named, ...LINUX_TERMINALS] : LINUX_TERMINALS;
  const file = candidates.find((c) => ctx.exists(c));
  if (!file) return null;
  const args = path.basename(file) === 'xdg-terminal-exec' ? [`--dir=${dir}`] : [];
  return { file, args, cwd: dir };
}

/** Is `cmd` runnable — either a path to an executable, or a name on PATH. */
export function onPath(cmd: string, env: Record<string, string | undefined>): boolean {
  // isFile as well as X_OK: every directory on PATH is executable too.
  const runnable = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (cmd.includes(path.sep)) return runnable(cmd);
  return (env.PATH ?? '').split(path.delimiter).some((d) => d && runnable(path.join(d, cmd)));
}
