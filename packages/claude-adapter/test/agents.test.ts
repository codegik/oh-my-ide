import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  dropStaleInteractiveSessions,
  isPidAlive,
  isSameSession,
  normalizeRow,
  parseAgentList,
  shortIdOf,
} from '../src/agents.js';

const fixture = readFileSync(
  new URL('../../../tools/fixtures/agents-2.1.272.json', import.meta.url),
  'utf8',
);

describe('parseAgentList', () => {
  const { sessions, skipped } = parseAgentList(fixture);

  it('drops malformed rows instead of throwing', () => {
    expect(skipped).toBe(1);
    expect(sessions).toHaveLength(5);
  });

  it('normalizes the background/interactive field asymmetry', () => {
    const bg = sessions.find((s) => s.shortId === 'aaaaaaaa');
    const inter = sessions.find((s) => s.name === 'delta-cockpit');

    // background reports `state`, interactive reports `status` — one shape out.
    expect(bg?.kind).toBe('background');
    expect(bg?.state).toBe('NEEDS_INPUT'); // 'blocked' means it is waiting on you
    expect(inter?.kind).toBe('interactive');
    expect(inter?.state).toBe('WORKING'); // 'busy'
  });

  it('derives a short id when the row omits one', () => {
    const noId = sessions.find((s) => s.sessionId.startsWith('cccccccc'));
    expect(noId?.shortId).toBe('cccccccc');
  });

  it('maps an unknown state to UNKNOWN and keeps the raw value', () => {
    const future = sessions.find((s) => s.sessionId.startsWith('eeeeeeee'));
    expect(future?.state).toBe('UNKNOWN');
    expect(future?.rawState).toBe('some-future-state-we-dont-know');
  });

  it('never throws on garbage input', () => {
    expect(parseAgentList('not json').sessions).toEqual([]);
    expect(parseAgentList('{"not":"an array"}').sessions).toEqual([]);
    expect(parseAgentList('').sessions).toEqual([]);
  });
});

describe('shortIdOf', () => {
  it('is the first 8 hex chars of the session uuid', () => {
    expect(shortIdOf('5c482848-8e15-44c9-960b-09ecf55b9898')).toBe('5c482848');
  });
});

describe('normalizeRow', () => {
  it('prefers the reported id over the derived one', () => {
    const s = normalizeRow({
      id: 'deadbeef',
      sessionId: '11111111-2222-3333-4444-555555555555',
      cwd: '/x',
      kind: 'background',
      state: 'working',
    });
    expect(s.shortId).toBe('deadbeef');
    expect(s.state).toBe('WORKING');
  });
});

describe('empty-string state (regression)', () => {
  it('does not leak an empty string as a SessionState', () => {
    const s = normalizeRow({
      sessionId: '11111111-2222-3333-4444-555555555555',
      cwd: '/x',
      kind: 'background',
      state: '',
    });
    expect(s.state).toBe('UNKNOWN');
  });
});

describe('isSameSession', () => {
  // Observed: a --bg session that entered a worktree is listed under a new UUID
  // while its job keeps the short id it was launched with.
  const moved = normalizeRow({
    id: 'f366faee',
    sessionId: '854ac96e-41ee-4f6e-bf6b-2a115a5c184e',
    cwd: '/repo/.claude/worktrees/x',
    kind: 'background',
    state: 'done',
  });

  it('finds a background job by the id it was launched with', () => {
    expect(isSameSession(moved, 'f366faee-2b88-4621-b7db-403a517aab90')).toBe(true);
    expect(isSameSession(moved, '854ac96e-41ee-4f6e-bf6b-2a115a5c184e')).toBe(true);
    expect(isSameSession(moved, '5f49964c-851b-42af-8149-b02548c17b82')).toBe(false);
  });

  it('matches an interactive session only by its uuid', () => {
    const inter = normalizeRow({
      sessionId: 'aaaaaaaa-0000-0000-0000-000000000000',
      cwd: '/x',
      kind: 'interactive',
    });
    expect(isSameSession(inter, 'aaaaaaaa-0000-0000-0000-000000000000')).toBe(true);
  });
});

describe('isPidAlive', () => {
  it('is true for this test process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('is false for a pid that has already exited', () => {
    const { pid } = spawnSync('true');
    expect(isPidAlive(pid as number)).toBe(false);
  });
});

describe('dropStaleInteractiveSessions', () => {
  it('drops an interactive row whose terminal has already closed', () => {
    const { pid: dead } = spawnSync('true');
    const sessions = [
      normalizeRow({
        sessionId: 'aaaaaaaa-0000-0000-0000-000000000000',
        cwd: '/x',
        kind: 'interactive',
        pid: dead,
      }),
    ];
    expect(dropStaleInteractiveSessions(sessions)).toEqual([]);
  });

  it('keeps an interactive row whose terminal is still open', () => {
    const sessions = [
      normalizeRow({
        sessionId: 'aaaaaaaa-0000-0000-0000-000000000000',
        cwd: '/x',
        kind: 'interactive',
        pid: process.pid,
      }),
    ];
    expect(dropStaleInteractiveSessions(sessions)).toHaveLength(1);
  });

  it('never checks a background row, whose lifecycle the CLI already tracks', () => {
    const { pid: dead } = spawnSync('true');
    const sessions = [
      normalizeRow({
        sessionId: 'aaaaaaaa-0000-0000-0000-000000000000',
        cwd: '/x',
        kind: 'background',
        pid: dead,
      }),
    ];
    expect(dropStaleInteractiveSessions(sessions)).toHaveLength(1);
  });
});
