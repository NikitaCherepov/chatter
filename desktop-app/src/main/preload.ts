import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  // PixelAvatar: listen for avatar state pushes from main process
  onAvatarState: (callback: (payload: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('pixel-avatar:state', handler);
    return () => ipcRenderer.removeListener('pixel-avatar:state', handler);
  },
});
