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
    };
  }
}
