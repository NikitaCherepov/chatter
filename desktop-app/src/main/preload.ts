import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  appVersion: ipcRenderer.sendSync('get-app-version'),

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

  // Wakeword: start/stop ONNX openWakeWord pipeline and stream PCM chunks
  startWakeWord: () =>
    ipcRenderer.invoke('wakeword:start'),

  stopWakeWord: () =>
    ipcRenderer.invoke('wakeword:stop'),

  sendWakeWordAudioChunk: (buffer: ArrayBuffer) =>
    ipcRenderer.send('wakeword-audio-chunk', buffer),

  onWakeWordDetected: (callback: (payload: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('wakeword:detected', handler);
    return () => ipcRenderer.removeListener('wakeword:detected', handler);
  },

  // TTS: generate audio via Piper (local TTS engine)
  ttsGenerate: (text: string, voiceId?: string) =>
    ipcRenderer.invoke('tts:generate', text, voiceId),

  // Get path to sounds directory
  getSoundsPath: () =>
    ipcRenderer.invoke('get-sounds-path'),

  // Read sound file bytes for renderer playback
  readSoundFile: (fileName: string) =>
    ipcRenderer.invoke('read-sound-file', fileName),

  // Macro: execute an array of shell commands sequentially
  executeCommands: (commands: string[], options?: { background?: boolean }) =>
    ipcRenderer.invoke('execute-commands', commands, options),

  // Macro: read directory listing (read-only, ls-like)
  readDirectory: (targetPath: string) =>
    ipcRenderer.invoke('read-directory', targetPath),

  // File metadata: stat a file or directory without reading content
  getFileInfo: (payload: { file_path: string; include_line_count?: boolean }) =>
    ipcRenderer.invoke('get-file-info', payload),

  // File Action: read file natively (UTF-8, paginated, line numbers)
  readFile: (payload: { file_path: string; start_line?: number; max_lines?: number; line_numbers?: boolean }) =>
    ipcRenderer.invoke('read-file', payload),

  // File Action: read file as base64 (for pixel art / binary reads)
  readFileBase64: (payload: { file_path: string }) =>
    ipcRenderer.invoke('read-file-base64', payload),

  // File Action: search matching lines in a file
  searchFileKeywords: (payload: { file_path: string; query: string; max_matches?: number }) =>
    ipcRenderer.invoke('search-file-keywords', payload),

  // File Action: write file natively (UTF-8, overwrite or append)
  writeFile: (payload: { file_path: string; content: string; mode?: 'overwrite' | 'append' }) =>
    ipcRenderer.invoke('write-file', payload),

  // File Action: edit file lines (surgical splice)
  editFileLines: (payload: { file_path: string; start_line: number; end_line: number; new_content: string }) =>
    ipcRenderer.invoke('edit-file-lines', payload),

  // Visual Control: capture all monitors
  captureScreen: () =>
    ipcRenderer.invoke('capture-screen'),

  // Visual Control: execute mouse click at normalized coordinates (0.0–1.0)
  visualClick: (data: { display_id?: string; x: number; y: number; button?: string }) =>
    ipcRenderer.invoke('visual-click', data),

  // Visual Control: capture webcam photo
  captureWebcam: (payload?: { camera_name?: string }) =>
    ipcRenderer.invoke('capture-webcam', payload),


  readSshKeys: () =>
    ipcRenderer.invoke('read-ssh-keys'),

  // ── Custom Updater ──────────────────────────────────────────────────────

  // Check server for available update
  updateCheck: () =>
    ipcRenderer.invoke('update:check'),

  // Download update file (asar or exe) with progress events
  updateDownload: (downloadUrl: string) =>
    ipcRenderer.invoke('update:download', downloadUrl),

  // Install minor update (ASAR hot-swap via bat script + restart)
  updateInstallMinor: (tempPath: string) =>
    ipcRenderer.invoke('update:install-minor', tempPath),

  // Install major update (run full NSIS installer + quit)
  updateInstallMajor: (tempPath: string) =>
    ipcRenderer.invoke('update:install-major', tempPath),

  // Listen for auto-check result on startup
  onUpdateAvailable: (callback: (info: { version: string; type: string; downloadUrl: string; releaseNotes: string; size: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: unknown) => callback(info as any);
    ipcRenderer.on('update:available', handler);
    return () => ipcRenderer.removeListener('update:available', handler);
  },

  // Listen for download progress
  onUpdateProgress: (callback: (progress: { percent: number; transferred: number; total: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress as any);
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.removeListener('update:progress', handler);
  },
});
