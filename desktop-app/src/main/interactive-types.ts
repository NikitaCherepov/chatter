export type InteractiveLanguage = 'interactive' | 'jsx' | 'tsx' | 'html';
import type { AppearanceProject } from './appearance-project';
export type InteractiveBounds = { x: number; y: number; width: number; height: number };
export type InteractiveStatus = {
  id: string;
  phase: 'loading' | 'ready' | 'stopped' | 'failed';
  escape?: boolean;
  reset?: boolean;
  confirmations?: boolean;
  visible?: boolean;
};
export type InteractiveInput = {
  language: InteractiveLanguage;
  source: string;
  dark: boolean;
  errorLabel: string;
  bridge?: 'appearance-chat-list-v1';
  project?: AppearanceProject;
};
export type InteractivePlacement = {
  id: string;
  visible: boolean;
  bounds: InteractiveBounds;
  clip: InteractiveBounds;
  expanded?: boolean;
};
