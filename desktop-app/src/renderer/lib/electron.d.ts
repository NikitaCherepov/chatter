export {};

declare global {
  interface Window {
    electronAPI: {
      platform: string;
      apiBaseUrl: string;
      appVersion: string;
      getSystemLanguages: () => Promise<string[]>;
      setTitleBarOverlay: (colors: { color: string; symbolColor: string }) => Promise<void>;
      authorizeServer: (server: string, key: string, forceValidation?: boolean) => Promise<{ apiBase: string; reloadRequired: boolean }>;
      clearTrustedServer: () => Promise<{ reloadRequired: boolean }>;
      browserGetState: () => Promise<BrowserState>;
      browserSetVisible: (payload: { visible: boolean; ownerId: string; bounds?: BrowserBounds }) => Promise<BrowserState>;
      browserSetBounds: (bounds: BrowserBounds) => Promise<BrowserState>;
      browserControl: (payload: BrowserControlPayload) => Promise<any>;
      onBrowserState: (callback: (payload: BrowserState) => void) => () => void;
      onBrowserDownloadRequested: (callback: (payload: BrowserDownloadRequest) => void) => () => void;
      onBrowserDownloadResolved: (callback: (payload: { download_id: string; status: string; file_path?: string }) => void) => () => void;
      openToolWindow: (payload: { toolId: string; title: string; activeChatId?: number | null }) => Promise<{ opened: boolean }>;
      dockToolWindow: (toolId: string) => Promise<{ docked: boolean }>;
      updateToolWindowContext: (payload: { toolId: string; activeChatId?: number | null }) => Promise<{ updated: boolean }>;
      onToolWindowContext: (callback: (payload: { activeChatId?: number | null }) => void) => () => void;
      onToolWindowClosed: (callback: (payload: { toolId: string }) => void) => () => void;
      onAvatarState: (callback: (payload: unknown) => void) => () => void;
      saveFile: (fileName: string, data: ArrayBuffer) => Promise<{ canceled: boolean; filePath?: string }>;
      setZoomLevel: (level: number) => Promise<void>;
      getZoomLevel: () => Promise<number>;
      transcribeAudio: (arrayBuffer: ArrayBuffer, language?: string) => Promise<string>;
      startWakeWord: () => Promise<{ ok: boolean; alreadyRunning?: boolean; error?: string }>;
      stopWakeWord: () => Promise<{ ok: boolean; alreadyStopped?: boolean }>;
      sendWakeWordAudioChunk: (buffer: ArrayBuffer) => void;
      onWakeWordDetected: (callback: (payload: unknown) => void) => () => void;
      listPiperVoices: () => Promise<Array<{ id: string; name: string; lang: string }>>;
      ttsGenerate: (text: string, voiceId?: string) => Promise<ArrayBuffer | null>;
      getSoundsPath: () => Promise<string>;
      readSoundFile: (fileName: string) => Promise<ArrayBuffer | Uint8Array | null>;
      executeCommands: (commands: string[], options?: { background?: boolean }) => Promise<string>;
      readDirectory: (targetPath: string) => Promise<{ name: string; isDirectory: boolean; size?: number }[]>;
      convertVideo: (payload: { request_id: string; source_path: string; output_path?: string; output_format: 'mp4' | 'webm' | 'mkv' | 'mov'; quality?: 'high' | 'balanced' | 'small' }) => Promise<{ source_path: string; output_path: string; output_format: string; quality: string; size_bytes: number }>;
      cancelVideoConversion: (requestId: string) => Promise<{ cancelled: boolean }>;
      getFileInfo: (payload: { file_path: string; include_line_count?: boolean }) => Promise<any>;
      readFile: (payload: { file_path: string; start_line?: number; max_lines?: number; line_numbers?: boolean }) => Promise<any>;
      searchFileKeywords: (payload: { file_path: string; query: string; max_matches?: number }) => Promise<any>;
      writeFile: (payload: { file_path: string; content: string; mode?: 'overwrite' | 'append' }) => Promise<any>;
      grantSessionWriteFolder: (filePath: string) => Promise<{ canceled: boolean; folder?: string }>;
      canAutoWrite: (filePath: string) => Promise<boolean>;
      grantDetectedSessionWriteFolder: (filePath: string) => Promise<{ granted: boolean; folder?: string; reason?: string }>;
      editFileLines: (payload: { file_path: string; start_line: number; end_line: number; new_content: string; expected_content: string; expected_file_version: string }) => Promise<any>;
      readSshKeys: () => Promise<{ name: string; filename: string; publicKey?: string; privateKey?: string }[]>;
      getNotificationsEnabled: () => Promise<boolean>;
      setNotificationsEnabled: (enabled: boolean) => Promise<boolean>;
      setNotificationLabels: (labels: { open: string; notifications: string; quit: string }) => Promise<void>;
      showDesktopNotification: (payload: {
        id: string;
        title: string;
        body: string;
        chatId?: number;
        confirmationId?: string;
        sensitive?: boolean;
        actions?: { open: string; allow: string; decline: string };
      }) => Promise<boolean>;
      onNotificationsEnabledChanged: (callback: (enabled: boolean) => void) => () => void;
      onNotificationOpenChat: (callback: (payload: { chatId: number }) => void) => () => void;
      onNotificationConfirmationAction: (callback: (payload: { confirmationId: string; action: 'allow' | 'decline' }) => void) => () => void;
      updateCheck: () => Promise<{
        updateAvailable?: boolean;
        version?: string;
        releaseNotes?: string;
        size?: number;
        error?: string;
      }>;
      updateDownload: () => Promise<{ success?: boolean; error?: string }>;
      updateInstall: () => Promise<{ success?: boolean; error?: string }>;
      onUpdateAvailable: (callback: (info: {
        version: string;
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

type BrowserBounds = { x: number; y: number; width: number; height: number };

type BrowserState = {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  visible: boolean;
};

type BrowserControlPayload = {
  action: 'open' | 'read' | 'back' | 'forward' | 'reload' | 'scroll' | 'click' | 'fill' | 'check_site_permission' | 'grant_site_permission' | 'resolve_download';
  url?: string;
  ref?: string;
  text?: string;
  permission_action?: 'click' | 'fill';
  origin?: string;
  expected_origin?: string;
  mode?: 'viewport' | 'delta' | 'full';
  direction?: 'up' | 'down';
  amount?: number;
  download_id?: string;
  approved?: boolean;
  destination?: 'prompt' | 'downloads';
};

type BrowserDownloadRequest = {
  download_id: string;
  filename: string;
  url: string;
  mime_type: string;
  total_bytes: number;
  origin: string | null;
  created_at: number;
};
