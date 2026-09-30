import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A real SQLite file shaped like the part of hermes' store we read. `HERMES_HOME`
 * is read when the module loads, so it is set before the import.
 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'omi-hermes-store-'));
process.env.HERMES_HOME = HOME;
const { HermesStore } = await import('../src/store.js');

const db = new Database(path.join(HOME, 'state.db'));
db.exec(`CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT, tool_name TEXT)`);
const add = db.prepare(
  'INSERT INTO messages (session_id, role, content, tool_name) VALUES (?, ?, ?, ?)',
);
const result = (cwd: string) => JSON.stringify({ output: '', exit_code: 0, cwd });

const store = new HermesStore();
afterAll(() => {
  store.close();
  db.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('shellCwd', () => {
  it('is where the last command left the shell', () => {
    add.run('s1', 'tool', result('/repo'), 'terminal');
    add.run('s1', 'tool', result('/repo/.claude/worktrees/fix'), 'terminal');
    add.run('s1', 'tool', '{"content": "a file"}', 'read_file');
    add.run('s1', 'assistant', 'done', null);
    expect(store.shellCwd('s1')).toBe('/repo/.claude/worktrees/fix');
  });

  it('ignores other sessions and output that is not JSON', () => {
    add.run('s2', 'tool', 'not json', 'terminal');
    add.run('s3', 'tool', result('/elsewhere'), 'terminal');
    expect(store.shellCwd('s2')).toBeNull();
  });

  it('is null for a session that never ran a command', () => {
    expect(store.shellCwd('nobody')).toBeNull();
  });
});
