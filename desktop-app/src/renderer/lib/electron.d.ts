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
      onWakeWordDetected: (callback: (payload: unknown) => void) => () => void;
      ttsGenerate: (text: string, voiceId?: string) => Promise<ArrayBuffer | null>;
      getSoundsPath: () => Promise<string>;
      readSoundFile: (fileName: string) => Promise<ArrayBuffer | Uint8Array | null>;
      executeCommands: (commands: string[]) => Promise<string>;
      readDirectory: (targetPath: string) => Promise<{ name: string; isDirectory: boolean; size?: number }[]>;
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
