import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// CLAUDE_HOME is read once at import time; see the note in history.test.ts.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), 'omi-usage-'));
const { sessionUsage } = await import('../src/usage.js');

const HOME = process.env.CLAUDE_CONFIG_DIR;

function transcriptPath(dir: string, sessionId: string): string {
  const d = path.join(HOME, 'projects', dir);
  mkdirSync(d, { recursive: true });
  return path.join(d, `${sessionId}.jsonl`);
}

const jsonl = (lines: unknown[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join('');

function turn(
  id: string,
  u: { input?: number; output?: number; read?: number; write?: number },
  extra: Record<string, unknown> = {},
) {
  return {
    type: 'assistant',
    gitBranch: 'main',
    timestamp: '2026-09-18T10:00:00.000Z',
    message: {
      id,
      model: 'claude-opus-5',
      usage: {
        input_tokens: u.input ?? 0,
        output_tokens: u.output ?? 0,
        cache_read_input_tokens: u.read ?? 0,
        cache_creation_input_tokens: u.write ?? 0,
      },
    },
    ...extra,
  };
}

describe('sessionUsage', () => {
  it('returns null when no transcript exists for any id', () => {
    expect(sessionUsage(['aaaaaaaa-0000-0000-0000-000000000000'])).toBeNull();
  });

  it('refuses ids that are not session ids', () => {
    expect(sessionUsage(['../../etc/passwd'])).toBeNull();
  });

  it('counts a reply split over several lines once, and takes context from the last turn', () => {
    const id = '11111111-0000-0000-0000-000000000000';
    writeFileSync(
      transcriptPath('-tmp-u1', id),
      jsonl([
        { type: 'user', message: { role: 'user', content: 'hi' }, gitBranch: 'main' },
        turn('msg_1', { input: 10, output: 5, read: 100, write: 50 }),
        // Same reply, second content block: same usage repeated.
        turn('msg_1', { input: 10, output: 5, read: 100, write: 50 }),
        turn('msg_2', { input: 2, output: 7, read: 160, write: 3 }, { gitBranch: 'feature' }),
      ]),
    );
    expect(sessionUsage([id], '/tmp/u1')).toMatchObject({
      requests: 2,
      inputTokens: 12,
      outputTokens: 12,
      cacheReadTokens: 260,
      cacheWriteTokens: 53,
      contextTokens: 165,
      model: 'claude-opus-5',
      gitBranch: 'feature',
      subagents: 0,
    });
  });

  it('finds a transcript whose folder does not match the hint', () => {
    const id = '22222222-0000-0000-0000-000000000000';
    writeFileSync(transcriptPath('-somewhere-else', id), jsonl([turn('m', { output: 1 })]));
    expect(sessionUsage([id], '/not/the/folder')?.outputTokens).toBe(1);
  });

  it('keeps synthetic and sidechain turns out of the context', () => {
    const id = '33333333-0000-0000-0000-000000000000';
    writeFileSync(
      transcriptPath('-tmp-u3', id),
      jsonl([
        turn('a', { input: 1, read: 500 }),
        {
          ...turn('b', {}),
          message: { id: 'b', model: '<synthetic>', usage: { input_tokens: 0 } },
        },
        turn('c', { input: 3, output: 4 }, { isSidechain: true }),
      ]),
    );
    const u = sessionUsage([id]);
    expect(u?.contextTokens).toBe(501);
    expect(u?.requests).toBe(3);
  });

  it('reads only what was appended, and ignores a half-written line until it is complete', () => {
    const id = '44444444-0000-0000-0000-000000000000';
    const file = transcriptPath('-tmp-u4', id);
    writeFileSync(file, jsonl([turn('a', { output: 10 })]));
    expect(sessionUsage([id])?.outputTokens).toBe(10);

    // Non-ASCII, so a byte offset and a character offset would disagree.
    const next = JSON.stringify(turn('b', { output: 5, read: 900 }, { note: 'café ✓' }));
    appendFileSync(file, next.slice(0, 40));
    expect(sessionUsage([id])?.outputTokens).toBe(10);

    appendFileSync(file, `${next.slice(40)}\n`);
    const u = sessionUsage([id]);
    expect(u?.outputTokens).toBe(15);
    expect(u?.contextTokens).toBe(900);

    appendFileSync(file, jsonl([turn('c', { output: 1, read: 950 })]));
    expect(sessionUsage([id])?.outputTokens).toBe(16);
  });

  it('starts over when the file is replaced by a shorter one', () => {
    const id = '55555555-0000-0000-0000-000000000000';
    const file = transcriptPath('-tmp-u5', id);
    writeFileSync(file, jsonl([turn('a', { output: 10 }), turn('b', { output: 20 })]));
    expect(sessionUsage([id])?.outputTokens).toBe(30);
    writeFileSync(file, jsonl([turn('c', { output: 1 })]));
    expect(sessionUsage([id])?.outputTokens).toBe(1);
  });

  it('adds subagents and a second id the session moved to', () => {
    const first = '66666666-0000-0000-0000-000000000000';
    const moved = '66666666-1111-0000-0000-000000000000';
    const file = transcriptPath('-tmp-u6', first);
    writeFileSync(file, jsonl([turn('a', { output: 10, read: 1000 })]));
    const subs = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
    mkdirSync(subs, { recursive: true });
    writeFileSync(path.join(subs, 'agent-x.jsonl'), jsonl([turn('s', { input: 5, output: 6 })]));
    writeFileSync(
      transcriptPath('-tmp-u6-worktree', moved),
      jsonl([
        {
          ...turn('b', { output: 1, read: 42 }, { gitBranch: 'wt' }),
          timestamp: '2026-09-18T11:00:00.000Z',
        },
      ]),
    );
    expect(sessionUsage([first, moved], '/tmp/u6')).toMatchObject({
      sessionId: moved,
      outputTokens: 17,
      inputTokens: 5,
      subagents: 1,
      subagentTokens: 11,
      contextTokens: 42,
      gitBranch: 'wt',
    });
  });
});
