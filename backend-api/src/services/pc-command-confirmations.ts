/**
 * Shared in-memory store for pending PC action confirmations.
 * Used by ai.ts (registers) and server.ts (resolves/rejects via /approve endpoint).
 *
 * Supports these pending action kinds:
 *  - 'pc_command': execute a shell command on user's PC
 *  - 'file_action': read or write a file on user's PC via native fs
 *  - 'webcam_capture': capture a photo after explicit approval
 *  - 'browser_action': click or fill a previously-read browser element
 */

export type PendingActionKind = 'pc_command' | 'file_action' | 'webcam_capture' | 'browser_action';

type ExecutePayload = {
  ipcType: 'execute_commands';
  ipcPayload: { commands: string[]; background?: boolean };
};

type FileActionPayload = {
  ipcType: 'read_file' | 'write_file' | 'edit_file_lines' | 'search_file_keywords';
  ipcPayload: { file_path: string; start_line?: number; max_lines?: number; line_numbers?: boolean; content?: string; mode?: 'overwrite' | 'append'; end_line?: number; new_content?: string; expected_content?: string; expected_file_version?: string; query?: string; max_matches?: number };
};

type WebcamCapturePayload = {
  ipcType: 'capture_webcam';
  ipcPayload: { camera_name?: string; purpose?: string };
};

type BrowserActionPayload = {
  ipcType: 'browser_control';
  ipcPayload: {
    action: 'click' | 'fill';
    ref: string;
    text?: string;
  };
};

type ActionPayload = ExecutePayload | FileActionPayload | WebcamCapturePayload | BrowserActionPayload;

export type PendingPcCommandConfirmation = {
  userId: number;
  /** What kind of action this confirmation represents. */
  kind: PendingActionKind;
  /** Human-readable label for logs (command text, file path, etc.). */
  label: string;
  /** IPC command to execute after approval. */
  payload: ActionPayload;
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  createdAt: number;
};

const pendingConfirmations = new Map<string, PendingPcCommandConfirmation>();

export const registerPendingPcConfirmation = (id: string, pending: PendingPcCommandConfirmation) => {
  pendingConfirmations.set(id, pending);
};

export const getPendingPcConfirmation = (id: string): PendingPcCommandConfirmation | undefined => {
  return pendingConfirmations.get(id);
};

export const deletePendingPcConfirmation = (id: string): boolean => {
  return pendingConfirmations.delete(id);
};

// Auto-cleanup expired (5 min TTL)
setInterval(() => {
  const now = Date.now();
  for (const [id, pending] of pendingConfirmations) {
    if (now - pending.createdAt > 5 * 60 * 1000) {
      pending.reject(new Error('confirmation_expired'));
      pendingConfirmations.delete(id);
    }
  }
}, 30_000);
