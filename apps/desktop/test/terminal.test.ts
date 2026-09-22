import { describe, expect, it } from 'vitest';
import { macScriptHandler, resolveTerminal } from '../src/terminal.js';

/**
 * The head row's terminal button lands here. Getting it wrong means a click that
 * opens nothing, or — worse — a shell in the wrong folder, which on a repo with
 * worktrees is a real way to commit to the wrong tree.
 */
describe('resolveTerminal', () => {
  const linux = (env: Record<string, string | undefined>, have: string[]) => ({
    platform: 'linux',
    env,
    exists: (cmd: string) => have.includes(cmd),
  });

  it('takes the folder as the child cwd, not as a flag', () => {
    const l = resolveTerminal('/home/me/proj', linux({}, ['alacritty']));
    expect(l).toEqual({ file: 'alacritty', args: [], cwd: '/home/me/proj' });
  });

  it('prefers $TERMINAL over anything we would have guessed', () => {
    const l = resolveTerminal('/w', linux({ TERMINAL: 'wezterm' }, ['wezterm', 'ghostty']));
    expect(l?.file).toBe('wezterm');
  });

  it('falls through a $TERMINAL that is not installed', () => {
    const l = resolveTerminal('/w', linux({ TERMINAL: 'gone' }, ['foot']));
    expect(l?.file).toBe('foot');
  });

  it('accepts an absolute $TERMINAL', () => {
    const l = resolveTerminal('/w', linux({ TERMINAL: '/opt/bin/term' }, ['/opt/bin/term']));
    expect(l).toEqual({ file: '/opt/bin/term', args: [], cwd: '/w' });
  });

  it('tells the freedesktop launcher the folder, which may lose our cwd', () => {
    const l = resolveTerminal('/w/tree', linux({}, ['xdg-terminal-exec', 'alacritty']));
    expect(l).toEqual({
      file: 'xdg-terminal-exec',
      args: ['--dir=/w/tree'],
      cwd: '/w/tree',
    });
  });

  it('answers null when the machine has no terminal we know of', () => {
    expect(resolveTerminal('/w', linux({ TERMINAL: '' }, []))).toBeNull();
  });

  const mac = (over: Partial<Parameters<typeof resolveTerminal>[1]> = {}) => ({
    platform: 'darwin',
    env: {},
    exists: () => false,
    ...over,
  });

  it('passes the folder to `open` on macOS, where cwd means nothing', () => {
    expect(resolveTerminal('/Users/me/proj', mac())).toEqual({
      file: 'open',
      args: ['-a', 'Terminal', '/Users/me/proj'],
      cwd: '/Users/me/proj',
    });
  });

  it('honours $TERMINAL as an app name on macOS', () => {
    const l = resolveTerminal('/p', mac({ env: { TERMINAL: 'Ghostty' } }));
    expect(l?.args).toEqual(['-a', 'Ghostty', '/p']);
  });

  it('scripts a new iTerm window instead of `open`, which can land in a tab', () => {
    const l = resolveTerminal('/p', mac({ env: { TERMINAL: 'iTerm' } }));
    expect(l?.file).toBe('osascript');
    expect(l?.args).toEqual([
      '-e',
      'tell application "iTerm"',
      '-e',
      'activate',
      '-e',
      'create window with default profile',
      '-e',
      'tell current session of current window',
      '-e',
      'write text "cd " & quoted form of "/p"',
      '-e',
      'end tell',
      '-e',
      'end tell',
    ]);
  });

  it('escapes quotes and backslashes in the folder for the AppleScript', () => {
    const l = resolveTerminal('/p/"weird"\\dir', mac({ env: { TERMINAL: 'iTerm' } }));
    expect(l?.args).toContain('write text "cd " & quoted form of "/p/\\"weird\\"\\\\dir"');
  });

  it('opens the app the user set for .command files, by bundle id', () => {
    const l = resolveTerminal(
      '/p',
      mac({
        scriptHandler: () => 'org.mozilla.firefox',
        // Installed and earlier in the list; the deliberate choice still wins.
        hasApp: (a) => a === 'Ghostty',
      }),
    );
    expect(l?.args).toEqual(['-b', 'org.mozilla.firefox', '/p']);
  });

  it('scripts a new iTerm window when the .command handler is iTerm, by bundle id', () => {
    const l = resolveTerminal(
      '/p',
      mac({ scriptHandler: () => 'com.googlecode.iterm2', hasApp: (a) => a === 'Ghostty' }),
    );
    expect(l?.file).toBe('osascript');
  });

  it('falls back to whichever known terminal is installed', () => {
    const l = resolveTerminal(
      '/p',
      mac({ scriptHandler: () => null, hasApp: (a) => a === 'Ghostty' }),
    );
    expect(l?.args).toEqual(['-a', 'Ghostty', '/p']);
  });

  it('scripts a new iTerm window when the fallback scan finds iTerm installed', () => {
    const l = resolveTerminal(
      '/p',
      mac({ scriptHandler: () => null, hasApp: (a) => a === 'iTerm' }),
    );
    expect(l?.file).toBe('osascript');
  });

  it('lands on Terminal when nothing else is installed', () => {
    const l = resolveTerminal('/p', mac({ scriptHandler: () => null, hasApp: () => false }));
    expect(l?.args).toEqual(['-a', 'Terminal', '/p']);
  });
});

/**
 * Reading what the user chose. The plist holds overrides only, so "no entry"
 * means "never changed it" — and answering null there is what lets the installed
 * -app scan have its say.
 */
describe('macScriptHandler', () => {
  const plist = (handlers: unknown) => () => JSON.stringify({ LSHandlers: handlers });

  it('finds the handler for shell scripts', () => {
    const id = macScriptHandler(
      plist([
        { LSHandlerContentType: 'public.html', LSHandlerRoleAll: 'org.mozilla.firefox' },
        {
          LSHandlerContentType: 'com.apple.terminal.shell-script',
          LSHandlerRoleAll: 'com.googlecode.iterm2',
        },
      ]),
    );
    expect(id).toBe('com.googlecode.iterm2');
  });

  it('answers null when the user never changed it', () => {
    expect(macScriptHandler(plist([{ LSHandlerContentType: 'public.html' }]))).toBeNull();
  });

  it('answers null when there is no plist to read', () => {
    expect(
      macScriptHandler(() => {
        throw new Error('ENOENT');
      }),
    ).toBeNull();
  });
});
