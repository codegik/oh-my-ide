import { describe, expect, it } from 'vitest';
import { descendsFrom } from '../src/proc.js';

describe.skipIf(process.platform !== 'linux')('descendsFrom', () => {
  it('walks up the real process tree', () => {
    expect(descendsFrom(process.pid, process.pid)).toBe(true);
    expect(descendsFrom(process.pid, process.ppid)).toBe(true);
    expect(descendsFrom(process.ppid, process.pid)).toBe(false);
  });

  it('is false for a process that is gone', () => {
    expect(descendsFrom(2 ** 22 + 1, 1)).toBe(false);
  });
});
