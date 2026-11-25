import type { InteractiveInput } from './interactive-types';
import { parseAppearanceProject } from './appearance-project';

export const INTERACTIVE_SCHEME = 'chatter-interactive';
export const MAX_INTERACTIVE_SOURCE = 100_000;

export const INTERACTIVE_CSP = [
  "sandbox allow-scripts allow-forms",
  "default-src 'none'", "script-src 'unsafe-inline' 'unsafe-eval' chatter-interactive:", "style-src 'unsafe-inline' chatter-interactive:",
  "img-src data: blob: chatter-interactive:", "connect-src chatter-interactive:", "font-src chatter-interactive:", "media-src 'none'",
  "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'",
].join('; ');

/** Runs before model HTML; optional appearance access is provided only by its narrow isolated preload. */
const lockdown = `(() => {
  const deny = () => { throw new Error('Unavailable in isolated preview'); };
  for (const name of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','WebTransport',
    'open','showOpenFilePicker','showSaveFilePicker','showDirectoryPicker','alert','confirm','prompt','print']) {
    try { Object.defineProperty(window,name,{value:deny,writable:false,configurable:false}); } catch {}
  }
  window.addEventListener('click', e => {
    if (e.composedPath().some(n => n instanceof HTMLInputElement && n.type === 'file')) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, true);
  for (const name of ['click','showPicker']) {
    const original = HTMLInputElement.prototype[name];
    if (original) Object.defineProperty(HTMLInputElement.prototype,name,{
      value:function(...args){ if(this.type === 'file') return; return original.apply(this,args); },
      writable:false,configurable:false
    });
  }
})();`;

export function validateInteractiveInput(value: unknown): InteractiveInput {
  const input = value as Partial<InteractiveInput> | null;
  if (!input || !['interactive', 'jsx', 'tsx', 'html'].includes(input.language ?? '')
    || typeof input.source !== 'string' || input.source.length > MAX_INTERACTIVE_SOURCE
    || typeof input.dark !== 'boolean' || typeof input.errorLabel !== 'string' || input.errorLabel.length > 200
    || (input.bridge !== undefined && input.bridge !== 'appearance-chat-list-v1')) {
    throw new Error('Invalid interactive preview');
  }
  if (input.project !== undefined) {
    if (input.bridge !== 'appearance-chat-list-v1' || !['tsx', 'html'].includes(input.language!) || input.source !== '')
      throw new Error('Invalid appearance project');
    const project = parseAppearanceProject(input.project);
    if ((input.language === 'html') !== project.entry.endsWith('.html')) throw new Error('Invalid appearance entry');
    return { ...input, project } as InteractiveInput;
  }
  return input as InteractiveInput;
}

export function interactiveDocument(input: InteractiveInput, runtime: string): string {
  const assets=JSON.stringify(Object.keys(input.project?.assets??{})).replace(/</g,'\\u003c');
  const background = input.dark ? '#151f2c' : '#ffffff';
  const foreground = input.dark ? '#e4edf9' : '#0f1d30';
  const head = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script>${lockdown}</script><style>:root{color-scheme:${input.dark ? 'dark' : 'light'}}html{height:100%;margin:0;padding:0;overflow:auto}body{margin:0;padding:0;min-height:100%;display:flow-root;box-sizing:border-box;background:${background};color:${foreground};font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}*{box-sizing:border-box}button,input,select,textarea{font:inherit}img,svg,canvas{max-width:100%}pre{white-space:pre-wrap}</style></head><body>`;
  if (input.language === 'html') return `${head}<script type="application/json" id="theme-assets">${assets}</script>${input.project ? input.project.files[input.project.entry] : input.source}</body></html>`;
  const payload = JSON.stringify({ source: input.source, project: input.project, errorLabel: input.errorLabel })
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `${head}<div id="root"></div><script type="application/json" id="theme-assets">${assets}</script><script type="application/json" id="preview-source">${payload}</script><script>${runtime.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
