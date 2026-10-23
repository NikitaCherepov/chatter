export type InteractiveLanguage = 'interactive' | 'jsx' | 'tsx' | 'html';
export type InteractiveBounds = { x: number; y: number; width: number; height: number };
export type InteractiveStatus = { id: string; phase: 'loading' | 'ready' | 'stopped' | 'failed' };
export type InteractiveInput = { language: InteractiveLanguage; source: string; dark: boolean; errorLabel: string };
export type InteractivePlacement = { id: string; visible: boolean; bounds: InteractiveBounds; clip: InteractiveBounds };
