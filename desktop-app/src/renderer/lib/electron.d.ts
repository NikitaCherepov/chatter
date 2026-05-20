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
    };
  }
}
