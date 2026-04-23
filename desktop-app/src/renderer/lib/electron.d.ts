export {};

declare global {
  interface Window {
    electronAPI: {
      platform: string;
      apiBaseUrl: string;
      onAvatarState: (callback: (payload: unknown) => void) => () => void;
    };
  }
}
