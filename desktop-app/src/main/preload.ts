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

  // Voice transcription: send audio buffer → get text back
  transcribeAudio: (arrayBuffer: ArrayBuffer) =>
    ipcRenderer.invoke('transcribe-audio', arrayBuffer),

  // Wakeword: start/stop Python openWakeWord listener process
  startWakeWord: () =>
    ipcRenderer.invoke('wakeword:start'),

  stopWakeWord: () =>
    ipcRenderer.invoke('wakeword:stop'),

  onWakeWordDetected: (callback: (payload: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('wakeword:detected', handler);
    return () => ipcRenderer.removeListener('wakeword:detected', handler);
  },
});
