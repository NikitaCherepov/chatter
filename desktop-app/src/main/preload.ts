import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  appVersion: ipcRenderer.sendSync('get-app-version'),

  getSystemLanguages: () =>
    ipcRenderer.invoke('i18n:get-system-languages'),

  setTitleBarOverlay: (colors: { color: string; symbolColor: string }) =>
    ipcRenderer.invoke('window:set-title-bar-overlay', colors),

  authorizeServer: (server: string, key: string, forceValidation = false) =>
    ipcRenderer.invoke('security:authorize-server', server, key, forceValidation),

  clearTrustedServer: () =>
    ipcRenderer.invoke('security:clear-server'),

  // Embedded browser: isolated WebContentsView controlled by the trusted renderer.
  browserGetState: () =>
    ipcRenderer.invoke('browser:get-state'),
  browserSetVisible: (payload: { visible: boolean; ownerId: string; bounds?: { x: number; y: number; width: number; height: number } }) =>
    ipcRenderer.invoke('browser:set-visible', payload),
  browserSetBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('browser:set-bounds', bounds),
  browserControl: (payload: {
    action: 'open' | 'read' | 'back' | 'forward' | 'reload' | 'scroll' | 'click' | 'fill';
    url?: string;
    ref?: string;
    text?: string;
    mode?: 'viewport' | 'delta' | 'full';
    direction?: 'up' | 'down';
    amount?: number;
  }) => ipcRenderer.invoke('browser:control', payload),
  onBrowserState: (callback: (payload: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('browser:state', handler);
    return () => ipcRenderer.removeListener('browser:state', handler);
  },

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
  transcribeAudio: (arrayBuffer: ArrayBuffer, language: string = 'auto') =>
    ipcRenderer.invoke('transcribe-audio', arrayBuffer, language),

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
  listPiperVoices: () =>
    ipcRenderer.invoke('tts:list-piper-voices'),

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

  // File converter: constrained ffmpeg conversion and cancellation
  convertVideo: (payload: { request_id: string; source_path: string; output_path?: string; output_format: 'mp4' | 'webm' | 'mkv' | 'mov'; quality?: 'high' | 'balanced' | 'small' }) =>
    ipcRenderer.invoke('convert-video', payload),
  cancelVideoConversion: (requestId: string) =>
    ipcRenderer.invoke('cancel-video-conversion', requestId),

  // File metadata: stat a file or directory without reading content
  getFileInfo: (payload: { file_path: string; include_line_count?: boolean }) =>
    ipcRenderer.invoke('get-file-info', payload),

  // File Action: read file natively (UTF-8, paginated, line numbers)
  readFile: (payload: { file_path: string; start_line?: number; max_lines?: number; line_numbers?: boolean }) =>
    ipcRenderer.invoke('read-file', payload),

  // File Action: search matching lines in a file
  searchFileKeywords: (payload: { file_path: string; query: string; max_matches?: number }) =>
    ipcRenderer.invoke('search-file-keywords', payload),

  // File Action: write file natively (UTF-8, overwrite or append)
  writeFile: (payload: { file_path: string; content: string; mode?: 'overwrite' | 'append' }) =>
    ipcRenderer.invoke('write-file', payload),

  grantSessionWriteFolder: (filePath: string) =>
    ipcRenderer.invoke('workspace:grant-session-write-folder', filePath),

  canAutoWrite: (filePath: string) =>
    ipcRenderer.invoke('workspace:can-auto-write', filePath),

  grantDetectedSessionWriteFolder: (filePath: string) =>
    ipcRenderer.invoke('workspace:grant-detected-session-write-folder', filePath),

  // File Action: edit file lines (surgical splice)
  editFileLines: (payload: { file_path: string; start_line: number; end_line: number; new_content: string; expected_content: string; expected_file_version: string }) =>
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

  // Download the GitHub Release update with progress events
  updateDownload: () =>
    ipcRenderer.invoke('update:download'),

  // Install the downloaded update and restart
  updateInstall: () =>
    ipcRenderer.invoke('update:install'),

  // Listen for auto-check result on startup
  onUpdateAvailable: (callback: (info: { version: string; releaseNotes: string; size: number }) => void) => {
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
