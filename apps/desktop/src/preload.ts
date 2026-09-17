import { contextBridge, ipcRenderer } from 'electron';

/**
 * The entire renderer-facing surface. Terminal output is attacker-controlled data
 * from arbitrary repos, so there is no path from it to Node.
 */
contextBridge.exposeInMainWorld('omi', {
  rpc: (method: string, params?: unknown) => ipcRenderer.invoke('omi:rpc', method, params),
  welcome: () => ipcRenderer.invoke('omi:welcome'),
  openExternal: (url: string) => ipcRenderer.invoke('omi:openExternal', url),

  ptyInput: (viewId: string, bytes: Uint8Array) => ipcRenderer.send('omi:ptyInput', viewId, bytes),
  onPty: (cb: (viewId: string, epoch: number, offset: string, bytes: Uint8Array) => void) =>
    ipcRenderer.on('omi:pty', (_e, viewId, epoch, offset, bytes) =>
      cb(viewId, epoch, offset, bytes),
    ),
  onEvent: (cb: (msg: unknown) => void) => ipcRenderer.on('omi:event', (_e, msg) => cb(msg)),
});
