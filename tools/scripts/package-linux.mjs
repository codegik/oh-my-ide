#!/usr/bin/env node
/**
 * Turns a built checkout into a self-contained Linux release: Electron, the app,
 * the daemon and its native modules, a launcher, a desktop entry and the icon,
 * laid out as a /usr prefix so a package only has to copy it into place.
 *
 *   release/oh-my-ide-<version>-linux-<arch>/
 *     bin/oh-my-ide                       launcher (packaging/linux/oh-my-ide)
 *     lib/oh-my-ide/oh-my-ide             the Electron binary, renamed
 *     lib/oh-my-ide/resources/app/        apps/desktop: Electron runs this with no args
 *     lib/oh-my-ide/resources/daemon/     apps/daemon, plus node-pty and better-sqlite3
 *     share/applications/oh-my-ide.desktop
 *     share/pixmaps/oh-my-ide.png
 *   release/oh-my-ide-<version>-linux-<arch>.tar.gz (+ .sha256)
 *
 * Electron is bundled, not taken from the system: Arch ships Electron up to the
 * previous major, and the native modules are built for exactly the one in
 * node_modules. The version comes from the root package.json.
 *
 * Before packing, it boots the packaged daemon under the packaged Electron on a
 * scratch socket and database and runs tools/scripts/smoke-daemon.mjs against
 * it, so a release that is missing a file fails here, not on a user's machine.
 *
 * Run after `pnpm build`: node tools/scripts/package-linux.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const r = (...p) => path.join(ROOT, ...p);

if (process.platform !== 'linux') fail('this packages the Linux release; run it on Linux');

const { version } = readJson(r('package.json'));
const arch = process.arch;
const name = `oh-my-ide-${version}-linux-${arch}`;
const OUT = r('release', name);
const LIB = path.join(OUT, 'lib', 'oh-my-ide');
const RES = path.join(LIB, 'resources');

// The desktop finds the daemon at ../../daemon/dist/index.cjs from its own dist/
// (apps/desktop/src/main.ts), so resources/app and resources/daemon mirror
// apps/desktop and apps/daemon and the relative path holds in both layouts.
const FILES = [
  ['apps/desktop/dist/main.cjs', 'app/dist/main.cjs'],
  ['apps/desktop/dist/preload.cjs', 'app/dist/preload.cjs'],
  ['apps/desktop/renderer/index.html', 'app/renderer/index.html'],
  ['apps/desktop/renderer/bundle.js', 'app/renderer/bundle.js'],
  ['apps/desktop/renderer/xterm.css', 'app/renderer/xterm.css'],
  ['apps/desktop/assets/icon.png', 'app/assets/icon.png'],
  ['apps/daemon/dist/index.cjs', 'daemon/dist/index.cjs'],
];
// The daemon bundle keeps these external (apps/daemon/tsup.config.ts). Neither
// has runtime dependencies of its own; both are N-API, and verify-abi.mjs has
// already proven they load under this Electron.
const NATIVES = ['node-pty', 'better-sqlite3'];

for (const [from] of FILES) {
  if (!fs.existsSync(r(from))) fail(`${from} is missing; run: pnpm build`);
}
const ELECTRON_DIST = r('node_modules/electron/dist');
if (!fs.existsSync(path.join(ELECTRON_DIST, 'electron'))) {
  fail('the electron binary is missing; run: node node_modules/electron/install.js');
}

console.log(`==> staging ${path.relative(ROOT, OUT)}`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(LIB, { recursive: true });

// Electron's default_app is the "drop an app here" page; with resources/app
// present it is never shown, so it only costs space.
fs.cpSync(ELECTRON_DIST, LIB, {
  recursive: true,
  verbatimSymlinks: true,
  filter: (src) => path.basename(src) !== 'default_app.asar',
});
// Renamed so `ps`, `top` and crash reports say what is running.
fs.renameSync(path.join(LIB, 'electron'), path.join(LIB, 'oh-my-ide'));

for (const [from, to] of FILES) copy(r(from), path.join(RES, to));

// Electron takes the app's name, version and Wayland app id from here. The name
// is the checkout's own, so the packaged app and `./start.sh` share a userData
// folder and window class.
const desktopPkg = readJson(r('apps/desktop/package.json'));
writeJson(path.join(RES, 'app', 'package.json'), {
  name: desktopPkg.name,
  version,
  main: desktopPkg.main,
  desktopName: desktopPkg.desktopName,
});

for (const mod of NATIVES) copyNative(mod, path.join(RES, 'daemon', 'node_modules', mod));

copy(r('packaging/linux/oh-my-ide'), path.join(OUT, 'bin', 'oh-my-ide'));
copy(
  r('packaging/linux/oh-my-ide.desktop'),
  path.join(OUT, 'share/applications/oh-my-ide.desktop'),
);
copy(r('apps/desktop/assets/icon.png'), path.join(OUT, 'share/pixmaps/oh-my-ide.png'));

console.log('==> smoke-testing the packaged daemon');
await smoke();

console.log('==> packing');
const tarball = `${OUT}.tar.gz`;
// Owner normalised so the archive does not carry the building machine's user.
execFileSync(
  'tar',
  ['--owner=0', '--group=0', '--numeric-owner', '-czf', tarball, '-C', path.dirname(OUT), name],
  { stdio: 'inherit' },
);
const sum = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
fs.writeFileSync(`${tarball}.sha256`, `${sum}  ${path.basename(tarball)}\n`);
const mb = (fs.statSync(tarball).size / 1e6).toFixed(0);
console.log(`\n${path.relative(ROOT, tarball)}  ${mb} MB\nsha256 ${sum}`);

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Only what loads at runtime: the package's JS and its binary for this platform.
 * node-pty also ships sources, other platforms' prebuilds and a 60MB build tree.
 */
function copyNative(mod, dest) {
  const src = r('node_modules', mod);
  const pkg = readJson(path.join(src, 'package.json'));
  const keep = (rel) => {
    const [top] = rel.split(path.sep);
    if (rel === 'package.json' || /^LICEN[SC]E/i.test(rel)) return true;
    if (top === 'lib') return !/\.(test\.js|map)$/.test(rel);
    // build/Release/*.node, plus node-pty's spawn-helper where it has one.
    if (rel.startsWith(path.join('build', 'Release') + path.sep)) {
      return (
        !rel.includes(`${path.sep}obj.target${path.sep}`) && /(\.node|spawn-helper)$/.test(rel)
      );
    }
    // prebuilds/linux-x64.node (better-sqlite3) or prebuilds/linux-x64/… (node-pty).
    if (top === 'prebuilds') return rel.split(path.sep)[1]?.startsWith(`linux-${arch}`) ?? false;
    return false;
  };
  let natives = 0;
  for (const rel of walk(src)) {
    if (!keep(rel)) continue;
    copy(path.join(src, rel), path.join(dest, rel));
    if (rel.endsWith('.node')) natives++;
  }
  if (natives === 0) fail(`${mod}@${pkg.version}: no native binary for linux-${arch}`);
}

/** Boot resources/daemon under the packaged binary and run the wire-level smoke test. */
async function smoke() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omi-package.'));
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: path.join(scratch, 'run'),
    XDG_DATA_HOME: path.join(scratch, 'data'),
  };
  fs.mkdirSync(env.XDG_RUNTIME_DIR);
  const sock = path.join(env.XDG_RUNTIME_DIR, 'oh-my-ide', 'daemon.sock');
  const log = path.join(scratch, 'daemon.log');
  const logFd = fs.openSync(log, 'a');
  const daemon = spawn(path.join(LIB, 'oh-my-ide'), [path.join(RES, 'daemon/dist/index.cjs')], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', logFd, logFd],
  });
  let exited = false;
  daemon.on('exit', () => {
    exited = true;
  });
  let error = null;
  try {
    for (let i = 0; i < 100 && !exited && !fs.existsSync(sock); i++) await sleep(100);
    if (!fs.existsSync(sock)) throw new Error('the packaged daemon did not come up');
    // No Claude checks: this proves the package, not the machine it is built on.
    execFileSync(process.execPath, [r('tools/scripts/smoke-daemon.mjs')], {
      env: { ...env, OMI_SMOKE_CLAUDE: '0' },
      stdio: 'inherit',
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`daemon log:\n${fs.readFileSync(log, 'utf8').replace(/^/gm, '    ')}`);
  } finally {
    // SIGTERM runs the daemon's own shutdown, which unlinks the socket.
    daemon.kill('SIGTERM');
    for (let i = 0; i < 50 && !exited; i++) await sleep(100);
    if (!exited) daemon.kill('SIGKILL');
    fs.closeSync(logFd);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  // Only now: exiting from inside the try would leave the daemon running.
  if (error) fail(error);
}

function* walk(dir, base = dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, base);
    else yield path.relative(base, p);
  }
}

/** Copies one file, keeping its mode: the launcher and binaries must stay executable. */
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, fs.statSync(from).mode & 0o777);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
}
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
