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
  reason?: 'render'|'unresponsive'|'renderer-gone'|'watchdog'|'startup-timeout'|'load';
  detail?:string;
  stack?:string;
};
export type InteractiveFailure={
  reason:NonNullable<InteractiveStatus['reason']>;
  detail?:string;stack?:string;
  phase:'startup'|'runtime';recovering:boolean;at:number;
};
export type InteractiveInput = {
  language: InteractiveLanguage;
  source: string;
  dark: boolean;
  errorLabel: string;
  bridge?: 'appearance-chat-list-v1';
  themeId?: string;
  project?: AppearanceProject;
};
export type InteractivePlacement = {
  id: string;
  visible: boolean;
  bounds: InteractiveBounds;
  clip: InteractiveBounds;
  expanded?: boolean;
};
