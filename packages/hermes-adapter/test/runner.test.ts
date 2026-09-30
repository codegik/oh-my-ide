import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreSession } from '../src/store.js';

/**
 * tmux and the session store are the runner's two inputs, so both are faked and
 * the tests are about the one thing that is ours: what the two of them together
 * mean for a session's state.
 */
const listSessions = vi.fn<() => Promise<unknown[]>>(async () => []);
const capturePane = vi.fn<(...a: unknown[]) => Promise<string>>(async () => '❯ ');
const newSession = vi.fn<(o: unknown) => Promise<void>>(async () => undefined);
const killSession = vi.fn<(n: string) => Promise<void>>(async () => undefined);
const hasSession = vi.fn<(n: string) => Promise<boolean>>(async () => false);

vi.mock('../src/tmux.js', () => ({
  listSessions: () => listSessions(),
  capturePane: (...a: unknown[]) => capturePane(...a),
  newSession: (o: unknown) => newSession(o),
  killSession: (n: string) => killSession(n),
  hasSession: (n: string) => hasSession(n),
  sendKeys: async () => undefined,
  attachArgv: (name: string) => ({ file: 'tmux', args: ['attach-session', '-t', `=${name}`] }),
  findTmux: () => '/usr/bin/tmux',
  tmuxVersion: () => 'tmux 3.5a',
  tmuxName: (key: string) => `omi-h-${key}`,
  keyOfTmux: (n: string) => (n.startsWith('omi-h-') ? n.slice(6) : null),
  TMUX_PREFIX: 'omi-h-',
}));

vi.mock('../src/cli.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findHermes: () => '/home/me/.local/bin/hermes',
  hermesBin: () => '/home/me/.local/bin/hermes',
}));

const { HermesRunner } = await import('../src/runner.js');
const { readMarker } = await import('../src/store.js');
vi.mock('../src/store.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readMarker: vi.fn(() => null),
}));

const HID = '20260927_184952_29391d';

function row(over: Partial<StoreSession> = {}): StoreSession {
  return {
    id: HID,
    source: 'cli',
    cwd: '/home/me/repo',
    gitBranch: 'main',
    gitRepoRoot: '/home/me/repo',
    title: 'Fix the poller',
    model: 'claude-opus-5-5',
    startedAt: 1_790_548_000_000,
    lastActivityAt: 1_790_548_100_000,
    lastActivityDescription: '',
    endedAt: null,
    endReason: null,
    messageCount: 12,
    apiCalls: 7,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 900,
    cacheWriteTokens: 50,
    reasoningTokens: 5,
    costUsd: 0.1234,
    ...over,
  };
}

/** A store that answers from what a test puts in it, and nothing else. */
function fakeStore(
  o: { rows?: StoreSession[]; busy?: string[]; shell?: Record<string, string> } = {},
) {
  const rows = o.rows ?? [];
  return {
    available: () => true,
    byId: (id: string) => rows.find((r) => r.id === id) ?? null,
    byAnyId: (ids: string[]) => rows.find((r) => ids.includes(r.id)) ?? null,
    inFolder: (cwd: string) => rows.filter((r) => r.cwd === cwd || r.gitRepoRoot === cwd),
    newestIn: () => null,
    shellCwd: (id: string) => o.shell?.[id] ?? null,
    busyIds: () => new Set(o.busy ?? []),
    reset: () => undefined,
    close: () => undefined,
  } as never;
}

const tmuxRow = (over: Record<string, unknown> = {}) => ({
  name: 'omi-h-key1',
  key: 'key1',
  tty: '/dev/pts/9',
  cwd: '/home/me/repo',
  createdAt: 1_790_547_000_000,
  pid: 321,
  ...over,
});

beforeEach(() => {
  listSessions.mockReset().mockResolvedValue([]);
  vi.mocked(readMarker).mockReset().mockReturnValue(null);
});

describe('list', () => {
  it('is empty when no session of ours is running', async () => {
    expect(await new HermesRunner(fakeStore()).list()).toEqual([]);
  });

  it('a session with a turn in flight is WORKING', async () => {
    listSessions.mockResolvedValue([tmuxRow()]);
    vi.mocked(readMarker).mockReturnValue({ sessionId: HID, cwd: '/home/me/repo', at: 1 });
    const [s] = await new HermesRunner(fakeStore({ rows: [row()], busy: [HID] })).list();
    expect(s).toMatchObject({
      agent: 'hermes',
      sessionId: 'key1',
      shortId: 'key1',
      kind: 'background',
      state: 'WORKING',
      busy: true,
      confidence: 'observed',
      agentSessionId: HID,
      name: 'Fix the poller',
    });
  });

  it('a session waiting on an approval is NEEDS_PERMISSION, so the track lands on ON ME', async () => {
    listSessions.mockResolvedValue([tmuxRow()]);
    vi.mocked(readMarker).mockReturnValue({ sessionId: HID, cwd: '/home/me/repo', at: 1 });
    const store = fakeStore({
      rows: [row({ lastActivityDescription: 'awaiting approval: run tests' })],
    });
    const [s] = await new HermesRunner(store).list();
    expect(s?.state).toBe('NEEDS_PERMISSION');
  });

  /**
   * The window between opening a tab and typing in it: hermes has not written a
   * session row yet, so the state is inferred rather than reported.
   */
  it('a session that has said nothing yet is IDLE, and says so is derived', async () => {
    listSessions.mockResolvedValue([tmuxRow()]);
    const [s] = await new HermesRunner(fakeStore()).list();
    expect(s).toMatchObject({ state: 'IDLE', confidence: 'derived', agentSessionId: null });
  });

  it('a session running outside our tmux is interactive, not attachable', async () => {
    const [s] = await new HermesRunner(fakeStore({ rows: [row()], busy: [HID] })).list();
    expect(s).toMatchObject({ kind: 'interactive', sessionId: HID, state: 'WORKING' });
  });

  it('does not list a session twice when it is one of ours', async () => {
    listSessions.mockResolvedValue([tmuxRow()]);
    vi.mocked(readMarker).mockReturnValue({ sessionId: HID, cwd: '/home/me/repo', at: 1 });
    const out = await new HermesRunner(fakeStore({ rows: [row()], busy: [HID] })).list();
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('background');
  });

  it('remembers a key it was told about rather than rediscovering it', async () => {
    listSessions.mockResolvedValue([tmuxRow()]);
    const r = new HermesRunner(fakeStore({ rows: [row()] }));
    r.remember('key1', HID);
    const [s] = await r.list();
    expect(s?.agentSessionId).toBe(HID);
    expect(readMarker).not.toHaveBeenCalled();
  });

  /** The terminal button opens where the session is, so this is what it gets. */
  it('reports the worktree the agent moved into, not the folder it was launched in', async () => {
    listSessions.mockResolvedValue([tmuxRow()]);
    const wt = '/home/me/repo/.claude/worktrees/fix';
    const r = new HermesRunner(fakeStore({ rows: [row()], shell: { [HID]: wt } }));
    r.remember('key1', HID);
    const [s] = await r.list();
    expect(s?.cwd).toBe(wt);
  });

  it('stays in its folder when the agent only cd-s into another project', async () => {
    listSessions.mockResolvedValue([tmuxRow()]);
    const r = new HermesRunner(fakeStore({ rows: [row()], shell: { [HID]: '/home/me/.hermes' } }));
    r.remember('key1', HID);
    const [s] = await r.list();
    expect(s?.cwd).toBe('/home/me/repo');
  });
});

describe('start', () => {
  it('runs the TUI in a detached session under a key of ours', async () => {
    const r = new HermesRunner(fakeStore());
    const started = await r.start({ cwd: '/home/me/repo' });
    expect(newSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/home/me/repo',
        argv: ['/home/me/.local/bin/hermes', '--tui'],
      }),
    );
    expect(started).toMatchObject({ agent: 'hermes', cwd: '/home/me/repo', agentSessionId: null });
    // Ours, not hermes': it has not filed one yet.
    expect(started.sessionId).toMatch(/^[0-9a-f]{12}$/);
    expect(started.shortId).toBe(started.sessionId);
  });
});

describe('resume', () => {
  it('re-reads the conversation from hermes when the tmux session is gone', async () => {
    hasSession.mockResolvedValue(false);
    const r = new HermesRunner(fakeStore({ rows: [row()] }));
    const out = await r.resume({ sessionId: 'key1', cwd: '/home/me/repo', agentSessionId: HID });
    expect(newSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        argv: [
          '/home/me/.local/bin/hermes',
          '--tui',
          '--resume',
          HID,
          '--in',
          '/home/me/repo',
          '--no-restore-cwd',
        ],
      }),
    );
    expect(out).toMatchObject({ sessionId: 'key1', agentSessionId: HID });
  });

  it('starts a fresh TUI under the same key when nothing was ever said', async () => {
    hasSession.mockResolvedValue(false);
    const r = new HermesRunner(fakeStore());
    await r.resume({ sessionId: 'key2', cwd: '/home/me/repo' });
    expect(newSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ argv: ['/home/me/.local/bin/hermes', '--tui'] }),
    );
  });

  it('does not start a second session when the first is still there', async () => {
    hasSession.mockResolvedValue(true);
    listSessions.mockResolvedValue([tmuxRow()]);
    newSession.mockClear();
    const r = new HermesRunner(fakeStore({ rows: [row()] }));
    r.remember('key1', HID);
    const out = await r.resume({ sessionId: 'key1', cwd: '/home/me/repo' });
    expect(newSession).not.toHaveBeenCalled();
    expect(out.agentSessionId).toBe(HID);
  });
});

describe('canResume', () => {
  it('is true while hermes still has the conversation', () => {
    const r = new HermesRunner(fakeStore({ rows: [row()] }));
    expect(r.canResume('key1', HID)).toBe(true);
  });

  it('is false once it has been deleted from hermes', () => {
    const r = new HermesRunner(fakeStore());
    expect(r.canResume('key1', HID)).toBe(false);
  });

  /** Nothing was ever said, so there is nothing that could be missing. */
  it('is true for a session with no hermes id at all', () => {
    expect(new HermesRunner(fakeStore()).canResume('key1')).toBe(true);
  });
});

describe('usage', () => {
  it('reports hermes’ own counts, with reasoning tokens as output and a real cost', () => {
    const r = new HermesRunner(fakeStore({ rows: [row()] }));
    r.remember('key1', HID);
    expect(r.usage(['key1'])).toEqual({
      sessionId: HID,
      model: 'claude-opus-5-5',
      gitBranch: 'main',
      // Hermes records no per-request figure, so there is no honest context
      // number to give — the panel leaves the line out rather than inventing it.
      contextTokens: null,
      requests: 7,
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
      subagents: 0,
      subagentTokens: 0,
      costUsd: 0.1234,
      lastActivityAt: 1_790_548_100_000,
    });
  });

  it('is null for a session hermes has never heard of', () => {
    expect(new HermesRunner(fakeStore()).usage(['key9'])).toBeNull();
  });

  /** Hermes leaves `git_branch` empty for most sessions; git knows. */
  it('reads the branch from git where the shell is, over what hermes recorded', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'omi-branch-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'feature-x', repo]);
      const r = new HermesRunner(
        fakeStore({ rows: [row({ cwd: repo, gitBranch: null })], shell: { [HID]: repo } }),
      );
      r.remember('key1', HID);
      expect(r.usage(['key1'])?.gitBranch).toBe('feature-x');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('past', () => {
  it('offers the folder’s own conversations, titled', () => {
    const r = new HermesRunner(fakeStore({ rows: [row()] }));
    expect(r.past('/home/me/repo')).toEqual([
      {
        agent: 'hermes',
        sessionId: HID,
        cwd: '/home/me/repo',
        gitBranch: 'main',
        preview: 'Fix the poller',
        lastActivityAt: 1_790_548_100_000,
      },
    ]);
  });
});

describe('stop', () => {
  it('ends the tmux session and leaves the conversation alone', async () => {
    await new HermesRunner(fakeStore()).stop({ shortId: 'key1' });
    expect(killSession).toHaveBeenCalledWith('omi-h-key1');
  });
});
