import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Resolve workspace packages to SOURCE, so tests never depend on a build step
// being up to date. A stale dist silently testing the wrong code is worse than
// a slower test run.
const pkg = (name: string) => path.resolve(__dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      '@omi/core': pkg('core'),
      '@omi/protocol': pkg('protocol'),
      '@omi/claude-adapter': pkg('claude-adapter'),
      '@omi/db': pkg('db'),
    },
  },
  test: { include: ['packages/*/test/**/*.test.ts'], environment: 'node' },
});
