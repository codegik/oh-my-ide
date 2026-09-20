import { contextBridge, ipcRenderer } from 'electron';

/**
 * The entire renderer-facing surface. Terminal output is attacker-controlled data
 * from arbitrary repos, so there is no path from it to Node.
 */
/** Desktop font sizes from main (see `osFontPx`), or null to keep the defaults. */
const argPx = (name: string): number | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const n = hit ? Number(hit.slice(name.length + 3)) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

contextBridge.exposeInMainWorld('omi', {
  osFont: { ui: argPx('omi-ui-font-px'), mono: argPx('omi-mono-font-px') },
  rpc: (method: string, params?: unknown) => ipcRenderer.invoke('omi:rpc', method, params),
  welcome: () => ipcRenderer.invoke('omi:welcome'),
  openExternal: (url: string) => ipcRenderer.invoke('omi:openExternal', url),
  listDir: (raw: string) => ipcRenderer.invoke('omi:listDir', raw),
  openTerminal: (dir: string) => ipcRenderer.invoke('omi:openTerminal', dir),

  ptyInput: (viewId: string, bytes: Uint8Array) => ipcRenderer.send('omi:ptyInput', viewId, bytes),
  onPty: (cb: (viewId: string, epoch: number, offset: string, bytes: Uint8Array) => void) =>
    ipcRenderer.on('omi:pty', (_e, viewId, epoch, offset, bytes) =>
      cb(viewId, epoch, offset, bytes),
    ),
  onEvent: (cb: (msg: unknown) => void) => ipcRenderer.on('omi:event', (_e, msg) => cb(msg)),
});
