import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  clean: true,
  // Bundle the workspace packages in. A detached process spawned from inside a
  // packaged app must not be resolving pnpm symlinks at runtime.
  noExternal: ['@omi/protocol', '@omi/claude-adapter', '@omi/core', '@omi/db', 'zod'],
  // Native modules must stay external: they are .node binaries, not bundleable.
  external: ['node-pty', 'better-sqlite3'],
});
