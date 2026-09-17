import { describe, expect, it } from 'vitest';
import { ClaudeBgRunner, parseBackgroundedId } from '../src/runner.js';

describe('parseBackgroundedId', () => {
  it('reads the id from the real launch output', () => {
    // Verbatim from the Phase 0 spike, v2.1.272.
    const real = [
      'Starting background service…',
      'backgrounded · 5c482848 · omi-spike',
      '  claude agents             list sessions',
      '  claude attach 5c482848    open in this terminal',
    ].join('\n');
    expect(parseBackgroundedId(real)).toBe('5c482848');
  });

  it('survives decoration changes around the id', () => {
    expect(parseBackgroundedId('backgrounded [deadbeef] "some name"')).toBe('deadbeef');
  });

  it('returns null when there is no id at all', () => {
    expect(parseBackgroundedId('something went wrong')).toBeNull();
  });
});

describe('attachCommand', () => {
  it('is argv form, never a shell string', () => {
    const cmd = new ClaudeBgRunner().attachCommand({ shortId: '5c482848' });
    expect(cmd).toEqual({ file: 'claude', args: ['attach', '5c482848'] });
  });
});
