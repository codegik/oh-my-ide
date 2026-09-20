import { describe, expect, it } from 'vitest';
import { resolveTerminal } from '../src/terminal.js';

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

  it('passes the folder to `open` on macOS, where cwd means nothing', () => {
    const l = resolveTerminal('/Users/me/proj', {
      platform: 'darwin',
      env: {},
      exists: () => false,
    });
    expect(l).toEqual({
      file: 'open',
      args: ['-a', 'Terminal', '/Users/me/proj'],
      cwd: '/Users/me/proj',
    });
  });

  it('honours $TERMINAL as an app name on macOS', () => {
    const l = resolveTerminal('/p', {
      platform: 'darwin',
      env: { TERMINAL: 'iTerm' },
      exists: () => false,
    });
    expect(l?.args).toEqual(['-a', 'iTerm', '/p']);
  });
});
