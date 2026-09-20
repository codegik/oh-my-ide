import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  encodeControl,
  encodePtyIn,
  FRAME_CONTROL,
  FRAME_PTY_OUT,
  FrameDecoder,
  PROTOCOL_VERSION,
  socketPath,
} from '@omi/protocol';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { hasMacApp, macScriptHandler, onPath, resolveTerminal } from './terminal.js';

// Hyprland/Wayland: without these Electron renders through XWayland and is blurry
// at fractional scaling.
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');

const DAEMON_ENTRY = path.join(__dirname, '..', '..', 'daemon', 'dist', 'index.cjs');
const RENDERER_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const RENDERER_URL = pathToFileURL(RENDERER_HTML).href;
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

/**
 * The app is one page, and the preload runs in whatever page a window shows. A
 * dropped file, a clicked link or an injected script that replaced it would
 * inherit `window.omi` — which can type into any Claude session. So nothing is
 * allowed to navigate, open a window, or embed a webview. `loadFile` does not
 * fire `will-navigate`, so blocking every navigation costs us nothing.
 */
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-redirect', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

/**
 * Second line behind the navigation lock: only our own page, in its top frame,
 * may drive the daemon. The fragment is ignored so in-page hash changes pass.
 */
function fromApp(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame;
  if (!frame || frame !== e.sender.mainFrame) return false;
  return frame.url.split('#')[0] === RENDERER_URL;
}

function guard<A extends unknown[], R>(
  fn: (e: IpcMainInvokeEvent, ...args: A) => R,
): (e: IpcMainInvokeEvent, ...args: A) => R {
  return (e, ...args) => {
    if (!fromApp(e)) throw new Error('ipc from an untrusted frame');
    return fn(e, ...args);
  };
}

/** Main is a dumb frame proxy: it owns the socket, the renderer owns no Node. */
class DaemonClient {
  private sock: net.Socket | null = null;
  private decoder = new FrameDecoder();
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  welcome: unknown = null;
  private welcomeReady!: Promise<unknown>;
  private resolveWelcome!: (v: unknown) => void;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  /** One restart per skew, so a daemon we cannot refresh never becomes a loop. */
  private replacedStaleDaemon = false;

  constructor() {
    this.armWelcome();
  }

  private armWelcome(): void {
    this.welcomeReady = new Promise((r) => {
      this.resolveWelcome = r;
    });
  }

  whenWelcome(timeoutMs = 5000): Promise<unknown> {
    return Promise.race([
      this.welcomeReady,
      new Promise((r) => setTimeout(() => r(null), timeoutMs)),
    ]);
  }

  async connect(): Promise<void> {
    this.decoder = new FrameDecoder(); // a new connection restarts the stream
    this.sock = await this.openSocket();

    this.sock.on('data', (chunk) => {
      let frames: ReturnType<FrameDecoder['push']>;
      try {
        frames = this.decoder.push(chunk);
      } catch {
        this.sock?.destroy(); // unrecoverable stream desync
        return;
      }
      for (const f of frames) {
        if (f.typ === FRAME_CONTROL) this.onControl(f.msg as Record<string, unknown>);
        else if (f.typ === FRAME_PTY_OUT) {
          // Raw bytes straight to the renderer; they never touch app state.
          for (const w of BrowserWindow.getAllWindows()) {
            w.webContents.send('omi:pty', f.viewId, f.epoch, f.offset.toString(), f.bytes);
          }
        }
      }
    });

    this.sock.on('close', () => {
      this.sock = null;
      for (const [, p] of this.pending) p.reject(new Error('daemon connection closed'));
      this.pending.clear();
      this.scheduleReconnect();
    });

    this.send({ t: 'hello', protocol: PROTOCOL_VERSION, client: 'desktop', pid: process.pid });
  }

  private onControl(msg: Record<string, unknown>): void {
    if (msg.t === 'welcome') {
      if (this.restartIfStale(msg)) return;
      const reconnected = this.welcome !== null;
      this.welcome = msg;
      this.resolveWelcome(msg);
      // A daemon that restarted has no pty views any more. Tell the renderer so
      // it can re-attach instead of sitting in front of a dead terminal until
      // someone reloads the window — surviving a daemon restart is the whole
      // point of keeping sessions outside the app.
      if (reconnected) {
        for (const w of BrowserWindow.getAllWindows()) {
          w.webContents.send('omi:event', { t: 'reconnected' });
        }
      }
      return;
    }
    if (msg.t === 'changed' || msg.t === 'pty.exit') {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('omi:event', msg);
      return;
    }
    const id = typeof msg.id === 'number' ? msg.id : -1;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (msg.t === 'result') p.resolve(msg.data);
    else p.reject(new Error(String(msg.message ?? 'rpc failed')));
  }

  /**
   * A daemon started before the last build is running old code: it will answer
   * some calls and reject others with `no such method`, which reads like a bug
   * in whatever the user just clicked. Comparing the bundle it loaded against
   * the one on disk turns that into a restart nobody has to think about —
   * Claude sessions live outside the daemon, so they ride it out untouched.
   */
  private restartIfStale(welcome: Record<string, unknown>): boolean {
    if (this.replacedStaleDaemon) return false;
    const entry = welcome.entry;
    const buildId = welcome.buildId;
    // An older daemon reports neither, and one launched from somewhere else is
    // not ours to compare against; leave both alone.
    if (typeof entry !== 'string' || typeof buildId !== 'string') return false;
    if (path.resolve(entry) !== path.resolve(DAEMON_ENTRY)) return false;
    let onDisk: string;
    try {
      const st = fs.statSync(DAEMON_ENTRY);
      onDisk = `${Math.round(st.mtimeMs)}-${st.size}`;
    } catch {
      return false;
    }
    if (onDisk === buildId) return false;

    this.replacedStaleDaemon = true;
    process.stderr.write('[desktop] daemon is running a stale build; restarting it\n');
    // Fire and forget: the daemon exits, `close` fires, and the usual reconnect
    // spawns the current build and tells the renderer to re-attach its terminals.
    this.send({ t: 'rpc', id: this.nextId++, method: 'daemon.shutdown' });
    return true;
  }

  private send(msg: unknown): void {
    this.sock?.write(encodeControl(msg));
  }

  ptyInput(viewId: string, bytes: Uint8Array): void {
    this.sock?.write(encodePtyIn(viewId, Buffer.from(bytes)));
  }

  rpc(method: string, params?: unknown): Promise<unknown> {
    if (!this.sock) return Promise.reject(new Error('not connected to the daemon'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ t: 'rpc', id, method, params });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`rpc timed out: ${method}`));
      }, 30_000);
    });
  }

  private scheduleReconnect(delayMs = 500): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.armWelcome();
      void this.connect().catch(() => this.scheduleReconnect(Math.min(delayMs * 2, 10_000)));
    }, delayMs);
  }

  retryLater(): void {
    this.scheduleReconnect();
  }

  private async openSocket(): Promise<net.Socket> {
    const p = socketPath();
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        return await tryConnect(p);
      } catch {
        if (attempt === 0) this.spawnDaemon();
        await delay(100);
      }
    }
    throw new Error(`daemon did not start; is ${DAEMON_ENTRY} built?`);
  }

  private spawnDaemon(): void {
    if (!fs.existsSync(DAEMON_ENTRY)) return;
    const logFd = fs.openSync(path.join(app.getPath('userData'), 'daemon.log'), 'a');
    const child = spawn(process.execPath, [DAEMON_ENTRY], {
      detached: true,
      // Never 'inherit': that ties the daemon's lifetime to ours.
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
  }
}

function tryConnect(p: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(p);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Backs the folder picker, which is a text box with completion rather than a
 * native dialog. A track's folder decides which sessions it can even see, so a
 * typo there is a track pointed at nothing — which is why this answers null for
 * anything that is not a directory, and the picker refuses to choose it.
 *
 * Only directory names come back, never files: that is all the picker needs,
 * and all the renderer gets to learn about the disk.
 */
const LIST_LIMIT = 2000;

async function listDir(
  raw: string,
): Promise<{ home: string; path: string; dirs: string[] } | null> {
  if (typeof raw !== 'string') return null;
  const home = os.homedir();
  const expanded = raw === '~' || raw.startsWith('~/') ? home + raw.slice(1) : raw;
  const abs = path.resolve(home, expanded);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(abs, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs: string[] = [];
  for (const d of entries) {
    if (dirs.length >= LIST_LIMIT) break;
    if (d.isDirectory()) dirs.push(d.name);
    else if (d.isSymbolicLink()) {
      const st = await fs.promises.stat(path.join(abs, d.name)).catch(() => null);
      if (st?.isDirectory()) dirs.push(d.name);
    }
  }
  dirs.sort((a, b) => a.localeCompare(b));
  return { home, path: abs, dirs };
}

/**
 * Opens the user's own terminal in `dir`, which the renderer takes from the
 * session on screen: a background job that moved into a worktree is not where
 * its track is, and the folder you want a shell in is the one it works in.
 *
 * The renderer can name any string, so the folder is checked here — and a folder
 * is all the terminal is ever given, never a command to run inside it.
 */
async function openTerminal(raw: string): Promise<{ ok: boolean; error?: string }> {
  if (typeof raw !== 'string' || !path.isAbsolute(raw)) return { ok: false, error: 'no folder' };
  const dir = path.resolve(raw);
  const st = await fs.promises.stat(dir).catch(() => null);
  if (!st?.isDirectory()) return { ok: false, error: `${dir} is not a folder` };

  const launch = resolveTerminal(dir, {
    platform: process.platform,
    env: process.env,
    exists: (cmd) => onPath(cmd, process.env),
    hasApp: hasMacApp,
    // Binary plist, so plutil does the reading; it ships with macOS.
    scriptHandler: () =>
      macScriptHandler((file) =>
        execFileSync('plutil', ['-convert', 'json', '-o', '-', file], {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      ),
  });
  if (!launch) return { ok: false, error: 'no terminal found — set $TERMINAL' };

  try {
    // Detached, like the daemon: closing the app must not take the shell with it.
    const child = spawn(launch.file, launch.args, {
      cwd: launch.cwd,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (e) => process.stderr.write(`[desktop] terminal: ${e.message}\n`));
    child.unref();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true };
}

const client = new DaemonClient();

/**
 * The desktop's own text size, in CSS px, or null where there is no setting to
 * read (not GNOME-ish, no gsettings) — the stylesheet's defaults cover that.
 *
 * Read once at startup: the renderer anchors every size to this, so the text you
 * read most in the app is the size you chose for the rest of the desktop.
 */
function osFontPx(key: 'font-name' | 'monospace-font-name'): number | null {
  if (process.platform !== 'linux') return null;
  const get = (k: string) =>
    execFileSync('gsettings', ['get', 'org.gnome.desktop.interface', k], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    // e.g. 'Adwaita Sans 11' — the size is always the last token, in points.
    const pt = Number(/(\d+(?:\.\d+)?)'?$/.exec(get(key))?.[1]);
    if (!Number.isFinite(pt) || pt <= 0) return null;
    const scaling = Number(get('text-scaling-factor')) || 1;
    const px = ((pt * 96) / 72) * scaling;
    return px >= 8 && px <= 40 ? Math.round(px * 100) / 100 : null;
  } catch {
    return null;
  }
}

function createWindow(): void {
  const uiPx = osFontPx('font-name');
  const monoPx = osFontPx('monospace-font-name');
  const win = new BrowserWindow({
    width: 1400,
    height: 880,
    backgroundColor: '#0f1115',
    title: 'oh-my-ide',
    // X11 and taskbars read this. Wayland ignores it and looks the icon up via the
    // .desktop file named by the app id (see `desktopName`, `./start.sh install`).
    // macOS ignores it too; see app.dock.setIcon in whenReady.
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The only way to hand a value to a sandboxed preload before first paint.
      additionalArguments: [
        ...(uiPx ? [`--omi-ui-font-px=${uiPx}`] : []),
        ...(monoPx ? [`--omi-mono-font-px=${monoPx}`] : []),
      ],
    },
  });
  // Electron's default menu takes a row of the window, and its accelerators
  // steal keys the terminals need (Ctrl+R reloads, Ctrl+W closes the window).
  // macOS keeps it: it lives in the system bar and carries Cmd+C/V/Q there.
  if (process.platform !== 'darwin') win.removeMenu();
  void win.loadFile(RENDERER_HTML);
}

app.whenReady().then(async () => {
  // macOS ignores the window `icon`: the Dock and Cmd+Tab show the bundle's
  // icon, which unpackaged is Electron.app's. This swaps in ours at runtime.
  if (process.platform === 'darwin') app.dock?.setIcon(ICON);

  ipcMain.handle(
    'omi:rpc',
    guard((_e, method: string, params?: unknown) => client.rpc(method, params)),
  );
  ipcMain.handle(
    'omi:welcome',
    guard(() => client.whenWelcome()),
  );
  ipcMain.handle(
    'omi:openExternal',
    guard((_e, url: string) => shell.openExternal(url)),
  );
  ipcMain.handle(
    'omi:listDir',
    guard((_e, raw: string) => listDir(raw)),
  );
  ipcMain.handle(
    'omi:openTerminal',
    guard((_e, dir: string) => openTerminal(dir)),
  );
  ipcMain.on('omi:ptyInput', (e, viewId: string, bytes: Uint8Array) => {
    if (fromApp(e)) client.ptyInput(viewId, bytes);
  });

  try {
    await client.connect();
  } catch (err) {
    process.stderr.write(`[desktop] ${err instanceof Error ? err.message : String(err)}\n`);
    client.retryLater();
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quitting must NOT stop the daemon, and closing a terminal view must not stop a
// Claude session. That is the whole point of the architecture.
app.on('window-all-closed', () => app.quit());
