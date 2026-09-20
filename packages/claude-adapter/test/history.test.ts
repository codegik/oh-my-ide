import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// CLAUDE_HOME in safe-fs.ts is a module-level const read once at import time
// from CLAUDE_CONFIG_DIR. safe-fs.test.ts never reads real files, so it never
// had to deal with this; history.ts does, so the env var must be set before
// safe-fs.js/history.js are ever evaluated — hence the dynamic import below.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), 'omi-history-'));
const { hasTranscript, pastSessionsFor } = await import('../src/history.js');

const HOME = process.env.CLAUDE_CONFIG_DIR;

function slug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

function writeTranscript(
  cwd: string,
  sessionId: string,
  lines: unknown[],
  mtimeMs?: number,
): string {
  const dir = path.join(HOME, 'projects', slug(cwd));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  if (mtimeMs !== undefined) {
    const t = mtimeMs / 1000;
    utimesSync(file, t, t);
  }
  return file;
}

describe('pastSessionsFor', () => {
  it('returns nothing when the candidate directory does not exist', () => {
    expect(pastSessionsFor('/never/seen/this/one')).toEqual([]);
  });

  it('finds a real transcript and extracts its fields', () => {
    const cwd = '/tmp/omi-fixture-a';
    writeTranscript(cwd, '11111111-2222-3333-4444-555555555555', [
      { type: 'mode', mode: 'normal', sessionId: '11111111-2222-3333-4444-555555555555' },
      {
        type: 'user',
        message: { role: 'user', content: 'hello there' },
        cwd,
        sessionId: '11111111-2222-3333-4444-555555555555',
        gitBranch: 'main',
      },
    ]);
    const found = pastSessionsFor(cwd);
    expect(found).toHaveLength(1);
    const s = found[0]!;
    expect(s.sessionId).toBe('11111111-2222-3333-4444-555555555555');
    expect(s.shortId).toBe('11111111');
    expect(s.cwd).toBe(cwd);
    expect(s.gitBranch).toBe('main');
  });

  it('drops a file whose actual cwd field does not match the requested cwd (slug collision)', () => {
    // "-tmp-a-b" is ambiguous between "/tmp/a/b" and "/tmp/a-b" — the whole
    // point of verifying identity from inside the file, not the slug.
    const wrongCwd = '/tmp/a-b';
    writeTranscript(wrongCwd, '22222222-2222-3333-4444-555555555555', [
      {
        type: 'user',
        message: { role: 'user', content: 'x' },
        cwd: wrongCwd,
        sessionId: '22222222-2222-3333-4444-555555555555',
      },
    ]);
    expect(pastSessionsFor('/tmp/a/b')).toEqual([]);
  });

  it('drops a file with no discoverable cwd field', () => {
    const cwd = '/tmp/omi-fixture-nocwd';
    writeTranscript(cwd, '33333333-2222-3333-4444-555555555555', [
      { type: 'mode', mode: 'normal', sessionId: '33333333-2222-3333-4444-555555555555' },
      {
        type: 'last-prompt',
        lastPrompt: 'no cwd anywhere here',
        sessionId: '33333333-2222-3333-4444-555555555555',
      },
    ]);
    expect(pastSessionsFor(cwd)).toEqual([]);
  });

  it('prefers a last-prompt line for the preview, truncated and single-line', () => {
    const cwd = '/tmp/omi-fixture-preview';
    const long = `line one\nline two ${'x'.repeat(200)}`;
    writeTranscript(cwd, '44444444-2222-3333-4444-555555555555', [
      {
        type: 'user',
        message: { role: 'user', content: 'the head message, not the preview' },
        cwd,
        sessionId: '44444444-2222-3333-4444-555555555555',
      },
      { type: 'last-prompt', lastPrompt: long, sessionId: '44444444-2222-3333-4444-555555555555' },
    ]);
    const found = pastSessionsFor(cwd);
    expect(found).toHaveLength(1);
    const s = found[0]!;
    expect(s.preview).not.toBeNull();
    expect(s.preview!.length).toBeLessThanOrEqual(120);
    expect(s.preview).not.toMatch(/\n/);
    expect(s.preview).toContain('line one line two');
  });

  it('falls back to the first head user message when there is no last-prompt line', () => {
    const cwd = '/tmp/omi-fixture-fallback';
    writeTranscript(cwd, '55555555-2222-3333-4444-555555555555', [
      {
        type: 'user',
        message: { role: 'user', content: 'first real message here' },
        cwd,
        sessionId: '55555555-2222-3333-4444-555555555555',
      },
    ]);
    const found = pastSessionsFor(cwd);
    expect(found).toHaveLength(1);
    expect(found[0]!.preview).toBe('first real message here');
  });

  it('handles a file larger than the head+tail sampling window without loading it whole', () => {
    const cwd = '/tmp/omi-fixture-big';
    const sessionId = '66666666-2222-3333-4444-555555555555';
    const filler = Array.from({ length: 400 }, (_, i) => ({
      type: 'system',
      subtype: 'filler',
      pad: `MIDDLE_SENTINEL_${i}_${'z'.repeat(80)}`,
    }));
    writeTranscript(cwd, sessionId, [
      {
        type: 'user',
        message: { role: 'user', content: 'head message' },
        cwd,
        sessionId,
        gitBranch: 'feature/x',
      },
      ...filler,
      { type: 'last-prompt', lastPrompt: 'tail message', sessionId },
    ]);
    const found = pastSessionsFor(cwd);
    expect(found).toHaveLength(1);
    const s = found[0]!;
    expect(s.sessionId).toBe(sessionId);
    expect(s.gitBranch).toBe('feature/x');
    expect(s.preview).toBe('tail message');
  });

  it('sorts by last activity, newest first', () => {
    const cwd = '/tmp/omi-fixture-sort';
    const now = Date.now();
    writeTranscript(
      cwd,
      '77777777-2222-3333-4444-555555555555',
      [
        {
          type: 'user',
          message: { role: 'user', content: 'older' },
          cwd,
          sessionId: '77777777-2222-3333-4444-555555555555',
        },
      ],
      now - 60_000,
    );
    writeTranscript(
      cwd,
      '88888888-2222-3333-4444-555555555555',
      [
        {
          type: 'user',
          message: { role: 'user', content: 'newer' },
          cwd,
          sessionId: '88888888-2222-3333-4444-555555555555',
        },
      ],
      now,
    );
    const sessions = pastSessionsFor(cwd);
    expect(sessions.map((s) => s.sessionId)).toEqual([
      '88888888-2222-3333-4444-555555555555',
      '77777777-2222-3333-4444-555555555555',
    ]);
  });
});

describe('hasTranscript', () => {
  it('finds a transcript in any project folder, by full or short id', () => {
    writeTranscript('/tmp/omi-fixture-anywhere', 'abcdef01-2222-3333-4444-555555555555', [
      { cwd: '/x' },
    ]);
    expect(hasTranscript('abcdef01-2222-3333-4444-555555555555')).toBe(true);
    expect(hasTranscript('abcdef01')).toBe(true);
  });

  it('says so when the transcript is gone', () => {
    expect(hasTranscript('00000000-9999-9999-9999-999999999999')).toBe(false);
    expect(hasTranscript('0000dead')).toBe(false);
  });

  it('never lets a malformed id reach a path, and gives it the benefit of the doubt', () => {
    expect(hasTranscript('../../etc/passwd')).toBe(true);
  });
});
