import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // Electron main + preload: Node platform, CJS, electron stays external.
    name: 'electron',
    entry: ['src/main.ts', 'src/preload.ts'],
    format: ['cjs'],
    platform: 'node',
    target: 'node22',
    clean: true,
    outExtension: () => ({ js: '.cjs' }),
    external: ['electron'],
    noExternal: ['@omi/protocol', 'zod'],
  },
  {
    // Renderer: browser platform, IIFE, xterm bundled in. It has no Node at all.
    name: 'renderer',
    entry: { bundle: 'src/renderer/app.ts' },
    outDir: 'renderer',
    format: ['iife'],
    platform: 'browser',
    target: 'es2022',
    clean: false,
    outExtension: () => ({ js: '.js' }),
  },
]);
