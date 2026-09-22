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

/**
 * macOS has no $TERMINAL and no system-wide "which terminal" setting, so the
 * order below is: what you chose to open shell scripts with, then whichever of
 * these is installed, then Apple's own. Only apps that take a folder as an
 * argument belong here — kitty.app and Alacritty.app ignore one and would open
 * at your home directory, which is a worse answer than Terminal in the folder
 * you asked for.
 */
const MAC_TERMINALS = ['iTerm', 'Ghostty', 'WezTerm', 'Warp', 'Hyper'];

const ITERM_BUNDLE_ID = 'com.googlecode.iterm2';

export type TerminalLaunch = { file: string; args: string[]; cwd: string };

function isIterm(nameOrBundleId: string): boolean {
  const v = nameOrBundleId.trim().toLowerCase();
  return v === 'iterm' || v === 'iterm2' || v === ITERM_BUNDLE_ID;
}

function newItermWindow(dir: string): TerminalLaunch {
  const escaped = dir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = [
    'tell application "iTerm"',
    'activate',
    'create window with default profile',
    'tell current session of current window',
    `write text "cd " & quoted form of "${escaped}"`,
    'end tell',
    'end tell',
  ];
  const args = lines.flatMap((line) => ['-e', line]);
  return { file: 'osascript', args, cwd: dir };
}

export type ResolveEnv = {
  platform: string;
  env: Record<string, string | undefined>;
  /** True when this command can be run: a PATH lookup, faked in tests. */
  exists: (cmd: string) => boolean;
  /** macOS: is `<app>.app` installed? */
  hasApp?: (app: string) => boolean;
  /** macOS: the bundle id the user opens `.command` files with, if they set one. */
  scriptHandler?: () => string | null;
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
    const mac = (how: string[]): TerminalLaunch => ({
      file: 'open',
      args: [...how, dir],
      cwd: dir,
    });
    const named = ctx.env.TERMINAL?.trim();
    if (named) return isIterm(named) ? newItermWindow(dir) : mac(['-a', named]);
    // Set only when someone changed it, so an answer here is a real choice —
    // and it is the one iTerm, Ghostty and friends ask for when you make them
    // your default terminal.
    const chosen = ctx.scriptHandler?.();
    if (chosen) return isIterm(chosen) ? newItermWindow(dir) : mac(['-b', chosen]);
    const app = MAC_TERMINALS.find((a) => ctx.hasApp?.(a)) ?? 'Terminal';
    return isIterm(app) ? newItermWindow(dir) : mac(['-a', app]);
  }
  const named = ctx.env.TERMINAL?.trim();
  const candidates = named ? [named, ...LINUX_TERMINALS] : LINUX_TERMINALS;
  const file = candidates.find((c) => ctx.exists(c));
  if (!file) return null;
  const args = path.basename(file) === 'xdg-terminal-exec' ? [`--dir=${dir}`] : [];
  return { file, args, cwd: dir };
}

/** Is `<app>.app` installed, in any of the three places macOS keeps apps? */
export function hasMacApp(app: string): boolean {
  const home = process.env.HOME ?? '';
  return ['/Applications', `${home}/Applications`, '/System/Applications'].some((d) =>
    fs.existsSync(path.join(d, `${app}.app`)),
  );
}

/**
 * The bundle id set to open `.command` files, or null when the user never
 * changed it. LaunchServices keeps only overrides in this plist, which is what
 * makes it worth reading: anything in it was chosen on purpose.
 */
export function macScriptHandler(readPlist: (file: string) => string): string | null {
  const home = process.env.HOME ?? '';
  const plist = path.join(
    home,
    'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist',
  );
  try {
    const parsed = JSON.parse(readPlist(plist)) as {
      LSHandlers?: Array<Record<string, string>>;
    };
    const hit = parsed.LSHandlers?.find(
      (h) => h.LSHandlerContentType === 'com.apple.terminal.shell-script',
    );
    return hit?.LSHandlerRoleAll ?? hit?.LSHandlerRoleShell ?? null;
  } catch {
    return null;
  }
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
