import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * `HERMES_HOME` is read when the module loads, so it is set before the import.
 * The alternative — mocking node:fs — would test the mock.
 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'omi-hermes-'));
process.env.HERMES_HOME = HOME;
const { markerFileFor, readMarker } = await import('../src/store.js');

afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

function writeMarker(tty: string, body: unknown): void {
  fs.mkdirSync(path.join(HOME, 'terminal-sessions'), { recursive: true });
  fs.writeFileSync(markerFileFor(tty), JSON.stringify(body));
}

describe('markerFileFor', () => {
  it('names the file the way hermes does', () => {
    expect(markerFileFor('/dev/pts/11')).toBe(
      path.join(HOME, 'terminal-sessions', 'tty-dev-pts-11'),
    );
  });
});

describe('readMarker', () => {
  it('reads the session bound to a tty', () => {
    writeMarker('/dev/pts/3', {
      session_id: '20260927_184952_29391d',
      cwd: '/home/me/repo',
      ts: 1_790_547_124.1,
    });
    expect(readMarker('/dev/pts/3')).toEqual({
      sessionId: '20260927_184952_29391d',
      cwd: '/home/me/repo',
      at: 1_790_547_124_100,
    });
  });

  /**
   * The trap this guard exists for: pty numbers are recycled, so the marker next
   * to /dev/pts/3 is as likely to belong to whatever held that tty before us.
   */
  it('refuses a marker older than the session asking about it', () => {
    writeMarker('/dev/pts/4', { session_id: 'old', cwd: '/x', ts: 1_000 });
    expect(readMarker('/dev/pts/4', 2_000_000)).toBeNull();
    expect(readMarker('/dev/pts/4', 1_000_000)).not.toBeNull();
  });

  it('is null for a tty with no marker, and for junk', () => {
    expect(readMarker('/dev/pts/99')).toBeNull();
    fs.writeFileSync(markerFileFor('/dev/pts/5'), 'not json');
    expect(readMarker('/dev/pts/5')).toBeNull();
    writeMarker('/dev/pts/6', { cwd: '/x', ts: 5 });
    expect(readMarker('/dev/pts/6')).toBeNull();
  });
});
