#!/usr/bin/env node
/**
 * Native modules are built for ELECTRON's ABI, because the daemon runs under the
 * Electron binary with ELECTRON_RUN_AS_NODE=1. This turns "ABI mismatch found by
 * a user at runtime" into a build failure.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON = electronPath;
const NATIVES = ['node-pty', 'better-sqlite3'];

if (!existsSync(ELECTRON)) {
  console.error(`✗ electron binary missing at ${ELECTRON}`);
  console.error('  run: node node_modules/electron/install.js');
  process.exit(1);
}

const script = NATIVES.map((m) => `require(${JSON.stringify(m)}); console.log("  ok  ${m}");`).join(
  '\n',
);

try {
  const out = execFileSync(
    ELECTRON,
    ['-e', `${script}\nconsole.log("  abi " + process.versions.modules);`],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      cwd: path.join(ROOT, 'apps/daemon'),
    },
  );
  console.log('native modules load under the Electron ABI:');
  process.stdout.write(out);
} catch (err) {
  console.error('✗ a native module failed to load under the Electron ABI');
  console.error(
    String(err.stderr || err.message)
      .split('\n')
      .slice(0, 6)
      .join('\n'),
  );
  console.error('  fix: npx electron-rebuild -f -w node-pty -m apps/daemon');
  process.exit(1);
}
