import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_HOME, DeniedPathError, assertReadable } from '../src/safe-fs.js';

const inHome = (...p: string[]) => path.join(CLAUDE_HOME, ...p);

describe('assertReadable', () => {
  it('allows transcripts', () => {
    expect(() => assertReadable(inHome('projects', '-home-dev-x', 'abc.jsonl'))).not.toThrow();
  });

  it('allows tier-3 enrichment files', () => {
    expect(() => assertReadable(inHome('sessions', '1234.json'))).not.toThrow();
    expect(() => assertReadable(inHome('jobs', 'ab12', 'state.json'))).not.toThrow();
  });

  // These are the tests that must never regress.
  it.each([
    ['.credentials.json', inHome('.credentials.json')],
    ['a capability key', inHome('sessions', '1234.abcd.key')],
    ['a pem', inHome('projects', 'x.pem')],
    ['anything named token', inHome('sessions', 'token.json')],
  ])('refuses %s', (_label, p) => {
    expect(() => assertReadable(p)).toThrow(DeniedPathError);
  });

  it('refuses traversal out of the Claude home', () => {
    expect(() => assertReadable(inHome('projects', '..', '..', '.ssh', 'id_rsa'))).toThrow(
      DeniedPathError,
    );
    expect(() => assertReadable('/etc/passwd')).toThrow(DeniedPathError);
  });

  it('refuses allowed directories with the wrong extension', () => {
    expect(() => assertReadable(inHome('projects', 'notes.txt'))).toThrow(DeniedPathError);
  });

  it('refuses directories that are not on the allowlist', () => {
    expect(() => assertReadable(inHome('shell-snapshots', 'snap.sh'))).toThrow(DeniedPathError);
  });
});
