import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  // PixelAvatar: listen for avatar state pushes from main process
  onAvatarState: (callback: (payload: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('pixel-avatar:state', handler);
    return () => ipcRenderer.removeListener('pixel-avatar:state', handler);
  },

  // File save: shows save dialog, writes ArrayBuffer to chosen path
  saveFile: (fileName: string, data: ArrayBuffer) =>
    ipcRenderer.invoke('save-file', fileName, data),

  // Zoom
  setZoomLevel: (level: number) =>
    ipcRenderer.invoke('set-zoom-level', level),
  getZoomLevel: () =>
    ipcRenderer.invoke('get-zoom-level'),
});
