import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import {
  FRAME_CONTROL,
  FRAME_PTY_OUT,
  FrameDecoder,
  PROTOCOL_VERSION,
  encodeControl,
  encodePtyIn,
  socketPath,
} from '@omi/protocol';

// Hyprland/Wayland: without these Electron renders through XWayland and is blurry
// at fractional scaling.
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');

const DAEMON_ENTRY = path.join(__dirname, '..', '..', 'daemon', 'dist', 'index.cjs');
const RENDERER_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const RENDERER_URL = pathToFileURL(RENDERER_HTML).href;

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

const client = new DaemonClient();

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 880,
    backgroundColor: '#0f1115',
    title: 'oh-my-ide',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  void win.loadFile(RENDERER_HTML);
}

app.whenReady().then(async () => {
  ipcMain.handle(
    'omi:rpc',
    guard((_e, method: string, params?: unknown) => client.rpc(method, params)),
  );
  ipcMain.handle('omi:welcome', guard(() => client.whenWelcome()));
  ipcMain.handle('omi:openExternal', guard((_e, url: string) => shell.openExternal(url)));
  /**
   * A native folder picker, not a text field: a track's folder decides which
   * sessions it can even see, and a typo there is a track pointed at nothing.
   * The dialog is modal to the window, which is safe — unlike a JS dialog in the
   * renderer, it does not block the terminals.
   */
  ipcMain.handle('omi:pickFolder', guard(async (e, startIn?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      title: 'choose a folder',
      properties: ['openDirectory' as const, 'createDirectory' as const],
      ...(startIn ? { defaultPath: startIn } : {}),
    };
    const r = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  }));
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
