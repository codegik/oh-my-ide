import { describe, expect, it } from 'vitest';
import { keyOfTmux, parseSessions, TMUX_PREFIX, tmuxName } from '../src/tmux.js';

describe('session names', () => {
  it('round-trips a key', () => {
    expect(tmuxName('abc123')).toBe(`${TMUX_PREFIX}abc123`);
    expect(keyOfTmux(tmuxName('abc123'))).toBe('abc123');
  });

  it('claims nothing that is not ours', () => {
    expect(keyOfTmux('main')).toBeNull();
    expect(keyOfTmux('omi')).toBeNull();
    expect(keyOfTmux('someone-omi-h-x')).toBeNull();
  });
});

describe('parseSessions', () => {
  it('reads the fields we ask tmux for', () => {
    const out = parseSessions(
      ['omi-h-deadbeef\t/dev/pts/7\t/home/me/repo\t1790548185\t4242', ''].join('\n'),
    );
    expect(out).toEqual([
      {
        name: 'omi-h-deadbeef',
        key: 'deadbeef',
        tty: '/dev/pts/7',
        cwd: '/home/me/repo',
        createdAt: 1_790_548_185_000,
        pid: 4242,
      },
    ]);
  });

  it('ignores the user’s own sessions', () => {
    const out = parseSessions(
      [
        'work\t/dev/pts/1\t/home/me\t1790548000\t11',
        'omi-h-aa\t/dev/pts/2\t/home/me\t1790548100\t12',
      ].join('\n'),
    );
    expect(out.map((s) => s.key)).toEqual(['aa']);
  });

  it('survives a row it cannot read rather than dropping the list', () => {
    const out = parseSessions('omi-h-bb\t/dev/pts/3\t/home/me\t\t');
    expect(out).toHaveLength(1);
    expect(out[0]?.createdAt).toBe(0);
    expect(out[0]?.pid).toBeNull();
  });
});
