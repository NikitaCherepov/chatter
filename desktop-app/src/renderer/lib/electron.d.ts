export {};

declare global {
  interface Window {
    electronAPI: {
      platform: string;
      apiBaseUrl: string;
      onAvatarState: (callback: (payload: unknown) => void) => () => void;
      saveFile: (fileName: string, data: ArrayBuffer) => Promise<{ canceled: boolean; filePath?: string }>;
      setZoomLevel: (level: number) => Promise<void>;
      getZoomLevel: () => Promise<number>;
      transcribeAudio: (arrayBuffer: ArrayBuffer) => Promise<string>;
      startWakeWord: () => Promise<{ ok: boolean; alreadyRunning?: boolean; error?: string }>;
      stopWakeWord: () => Promise<{ ok: boolean; alreadyStopped?: boolean }>;
      sendWakeWordAudioChunk: (buffer: ArrayBuffer) => void;
      onWakeWordDetected: (callback: (payload: unknown) => void) => () => void;
      ttsGenerate: (text: string, voiceId?: string) => Promise<ArrayBuffer | null>;
      getSoundsPath: () => Promise<string>;
      readSoundFile: (fileName: string) => Promise<ArrayBuffer | Uint8Array | null>;
      executeCommands: (commands: string[], options?: { background?: boolean }) => Promise<string>;
      readDirectory: (targetPath: string) => Promise<{ name: string; isDirectory: boolean; size?: number }[]>;
      getFileInfo: (payload: { file_path: string; include_line_count?: boolean }) => Promise<any>;
      readFile: (payload: { file_path: string; start_line?: number; max_lines?: number; line_numbers?: boolean }) => Promise<any>;
      searchFileKeywords: (payload: { file_path: string; query: string; max_matches?: number }) => Promise<any>;
      writeFile: (payload: { file_path: string; content: string; mode?: 'overwrite' | 'append' }) => Promise<any>;
      editFileLines: (payload: { file_path: string; start_line: number; end_line: number; new_content: string }) => Promise<any>;
      readSshKeys: () => Promise<{ name: string; filename: string; publicKey?: string; privateKey?: string }[]>;
      updateCheck: () => Promise<{
        updateAvailable?: boolean;
        version?: string;
        type?: 'minor' | 'major';
        downloadUrl?: string;
        releaseNotes?: string;
        size?: number;
        error?: string;
      }>;
      updateDownload: (downloadUrl: string) => Promise<{ success?: boolean; tempPath?: string; error?: string }>;
      updateInstallMinor: (tempPath: string) => Promise<{ success?: boolean; error?: string }>;
      updateInstallMajor: (tempPath: string) => Promise<{ success?: boolean; error?: string }>;
      onUpdateAvailable: (callback: (info: {
        version: string;
        type: 'minor' | 'major';
        downloadUrl: string;
        releaseNotes: string;
        size: number;
      }) => void) => () => void;
      onUpdateProgress: (callback: (progress: {
        percent: number;
        transferred: number;
        total: number;
      }) => void) => () => void;
    };
  }
}
