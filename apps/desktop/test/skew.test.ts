import { describe, expect, it } from 'vitest';
import { daemonSkew } from '../src/skew.js';

const OURS = { entry: '/home/me/app/apps/daemon/dist/index.cjs', buildId: '1700-42' };

describe('daemonSkew', () => {
  it('is happy with the daemon it would have spawned', () => {
    expect(daemonSkew({ entry: OURS.entry, buildId: '1700-42' }, OURS)).toEqual({ stale: false });
  });

  it('replaces our own daemon when the bundle has been rebuilt under it', () => {
    expect(daemonSkew({ entry: OURS.entry, buildId: '1600-40' }, OURS)).toEqual({
      stale: true,
      reason: 'build',
    });
  });

  /**
   * The case that shipped broken: a dev build run from a worktree next to a
   * daemon still listening from the main checkout. The paths differ, so the old
   * rule left it alone — and the new window silently drove a daemon that had
   * never heard of half the calls it was making.
   */
  it('replaces a daemon that came from a different checkout', () => {
    const other = '/home/me/app/.claude/worktrees/wt/apps/daemon/dist/index.cjs';
    expect(daemonSkew({ entry: other, buildId: '9999-99' }, OURS)).toEqual({
      stale: true,
      reason: 'install',
    });
    expect(
      daemonSkew({ entry: '/usr/lib/oh-my-ide/daemon/index.cjs', buildId: 'x' }, OURS),
    ).toEqual({ stale: true, reason: 'install' });
  });

  it('ignores the cosmetic differences in a path', () => {
    expect(
      daemonSkew({ entry: '/home/me/app/apps/daemon/./dist/index.cjs', buildId: '1700-42' }, OURS),
    ).toEqual({ stale: false });
    expect(
      daemonSkew(
        { entry: '/home/me/app/apps/daemon/dist/../dist/index.cjs', buildId: '1700-42' },
        OURS,
      ),
    ).toEqual({ stale: false });
  });

  it('leaves a daemon too old to stamp itself alone', () => {
    // It predates the check; restarting on a missing field would mean
    // restarting it on every single launch.
    expect(daemonSkew({ entry: undefined, buildId: undefined }, OURS)).toEqual({ stale: false });
    expect(daemonSkew({ entry: OURS.entry, buildId: undefined }, OURS)).toEqual({ stale: false });
  });

  it('leaves it alone when our own bundle cannot be read', () => {
    expect(
      daemonSkew({ entry: OURS.entry, buildId: '1600-40' }, { entry: OURS.entry, buildId: null }),
    ).toEqual({ stale: false });
  });
});
