import type { Ask } from '@omi/core';
import { describe, expect, it } from 'vitest';
import { trayModel } from '../src/tray.js';

const ask = (over: Partial<Ask> = {}): Ask => ({
  trackId: 1,
  trackTitle: 'auth refactor',
  sessionId: 'claude:aaa',
  sessionLabel: 'migrate the schema',
  rule: 'claude.needs_input',
  weight: 80,
  says: 'migrate the schema · finished its turn',
  ...over,
});

describe('trayModel', () => {
  it('flies the quiet icon and says so when nothing is waiting', () => {
    const m = trayModel([]);
    expect(m.attention).toBe(false);
    expect(m.header).toBe('nothing is waiting');
    expect(m.items).toEqual([]);
  });

  it('counts what is waiting, in the singular where that is right', () => {
    expect(trayModel([ask()]).header).toBe('1 needs you');
    expect(trayModel([ask(), ask({ trackId: 2 })]).header).toBe('2 need you');
  });

  it('names the track and what it wants in one row', () => {
    const [row] = trayModel([ask()]).items;
    expect(row?.label).toBe('auth refactor — migrate the schema · finished its turn');
  });

  it('keeps the most urgent rows when there are too many to list', () => {
    // The caller hands them over already sorted, so truncation must take the
    // head — dropping the permission prompt to make room for row nine would be
    // exactly backwards.
    const many = Array.from({ length: 12 }, (_, i) => ask({ trackId: i + 1 }));
    const m = trayModel(many, 8);
    expect(m.items).toHaveLength(8);
    expect(m.items[0]?.ask.trackId).toBe(1);
    expect(m.count).toBe(12);
  });

  it('clips a long title rather than stretching the menu to fit it', () => {
    const m = trayModel([ask({ trackTitle: 'x'.repeat(200) })]);
    expect(m.items[0]?.label.length).toBeLessThanOrEqual(64);
    expect(m.items[0]?.label.endsWith('…')).toBe(true);
  });

  it('carries the ask through, so a click knows where to land', () => {
    const [row] = trayModel([ask()]).items;
    expect(row?.ask.trackId).toBe(1);
    expect(row?.ask.sessionId).toBe('claude:aaa');
  });
});
