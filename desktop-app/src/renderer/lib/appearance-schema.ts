// Canonical appearance contract. Run scripts/sync-appearance.mjs after editing.
import { parseAppearanceProject, APPEARANCE_PROJECT_LIMITS, APPEARANCE_PROJECT_MODULES, type AppearanceProject } from './appearance-project.js';
export type Palette = {
  background: string;
  text: string;
  accent: string;
  surface?: string;
  chat?: string;
};
export type AppearanceMaterial = {
  opacity: number;
  blur: number;
  shadow: 'none' | 'soft' | 'medium' | 'strong';
  border: 'none' | 'subtle' | 'defined';
  radius?: number;
};
export const DEFAULT_MATERIAL: AppearanceMaterial = {
  opacity: 1,
  blur: 0,
  shadow: 'none',
  border: 'subtle',
};
export type AppearanceMotion = {
  preset: 'none' | 'fade' | 'slide' | 'custom';
  duration: number;
  distance: number;
  scale: number;
  easing: 'ease-out' | 'ease-in-out' | 'linear';
};

// These are complete motion values, so existing clients can play them too.
export const APPEARANCE_MOTION_PRESETS = {
  none: { preset: 'none', duration: 0, distance: 0, scale: 1, easing: 'ease-out' },
  fade: { preset: 'fade', duration: 160, distance: 0, scale: 1, easing: 'ease-out' },
  slide: { preset: 'slide', duration: 220, distance: 8, scale: 1, easing: 'ease-out' },
  scale: { preset: 'custom', duration: 240, distance: 0, scale: 0.97, easing: 'ease-out' },
} as const satisfies Record<string, AppearanceMotion>;

export function appearanceMotionValues(motion: AppearanceMotion): AppearanceMotion {
  return {
    ...motion,
    distance: motion.preset === 'fade' || motion.preset === 'none' ? 0 : motion.distance,
    scale: motion.preset === 'custom' ? motion.scale : 1,
  };
}

export type AppearanceShell = {
  version: 1;
  language: 'html' | 'tsx';
  scope?: 'navigator' | 'workspace';
} & AppearanceProject;

export type AppearanceProfile = {
  id: string;
  name: string;
  revision: number;
  light: Palette;
  dark: Palette;
  typography: {
    uiFont: string;
    messageFont: string;
    codeFont: string;
    uiSize: number;
    messageSize: number;
    codeSize: number;
    lineHeight: number;
  };
  geometry: { radius: number; density: number };
  materials?: { panels?: AppearanceMaterial; composer?: AppearanceMaterial };
  shell?: AppearanceShell;
  background: {
    type: 'solid' | 'gradient' | 'image';
    color: string;
    color2: string;
    angle: number;
    image: string;
    dim: number;
    position: 'center' | 'top' | 'bottom';
  };
  motion: AppearanceMotion;
};
export type AppearanceSettings = {
  version: 1;
  revision: number;
  activeId: string | null;
  profiles: AppearanceProfile[];
};
export const DEFAULT_APPEARANCE: AppearanceSettings = {
  version: 1,
  revision: 0,
  activeId: null,
  profiles: [],
};
export const APPEARANCE_FONTS = [
  'Inter',
  'Segoe UI',
  'Arial',
  'Georgia',
  'Verdana',
  'Trebuchet MS',
  'Consolas',
  'Cascadia Code',
  'JetBrains Mono',
];
export function newAppearance(id = 'custom'): AppearanceProfile {
  return {
    id,
    name: 'Custom',
    revision: 0,
    light: { background: '#dfe6ef', text: '#0f1d30', accent: '#122d4d' },
    dark: { background: '#101722', text: '#e4ebf3', accent: '#7da6cf' },
    typography: {
      uiFont: 'Inter',
      messageFont: 'Inter',
      codeFont: 'Consolas',
      uiSize: 14,
      messageSize: 14,
      codeSize: 13,
      lineHeight: 1.6,
    },
    geometry: { radius: 8, density: 1 },
    background: {
      type: 'solid',
      color: '#101722',
      color2: '#243348',
      angle: 135,
      image: '',
      dim: 0.25,
      position: 'center',
    },
    motion: { ...APPEARANCE_MOTION_PRESETS.none },
  };
}
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (): never => {
  throw new Error('appearance_invalid');
};
const keys = (v: any, allowed: string[]) => {
  if (!object(v) || Object.keys(v).some((k) => !allowed.includes(k))) fail();
  return v;
};
const text = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : fail();
const number = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail();
const revision = (value: unknown): number => {
  const n = number(value, 0, 1e9);
  return Number.isSafeInteger(n) ? n : fail();
};
const choice = <T extends string>(v: unknown, items: readonly T[]): T =>
  items.includes(v as T) ? (v as T) : fail();
const color = (v: unknown): string =>
  typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fail();
const font = (v: unknown): string => {
  const s = text(v, 100);
  return /^[\p{L}\p{N} _.-]+$/u.test(s) ? s : fail();
};
export function parseAppearanceMotion(value: unknown): AppearanceMotion {
  const motion = keys(value, ['preset', 'duration', 'distance', 'scale', 'easing']);
  return {
    preset: choice(motion.preset, ['none', 'fade', 'slide', 'custom']),
    duration: number(motion.duration, 0, 800),
    distance: number(motion.distance, 0, 40),
    scale: number(motion.scale, 0.9, 1),
    easing: choice(motion.easing, ['ease-out', 'ease-in-out', 'linear']),
  };
}

export function parseAppearanceProfile(value: unknown): AppearanceProfile {
  const v = keys(value, [
    'id',
    'name',
    'revision',
    'light',
    'dark',
    'typography',
    'geometry',
    'background',
    'motion',
    'materials',
    'shell',
  ]);
  const id = text(v.id, 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) fail();
  const palette = (p: any): Palette => {
    keys(p, ['background', 'text', 'accent', 'surface', 'chat']);
    return {
      background: color(p.background),
      text: color(p.text),
      accent: color(p.accent),
      ...(p.surface !== undefined ? { surface: color(p.surface) } : {}),
      ...(p.chat !== undefined ? { chat: color(p.chat) } : {}),
    };
  };
  const t = keys(v.typography, [
    'uiFont',
    'messageFont',
    'codeFont',
    'uiSize',
    'messageSize',
    'codeSize',
    'lineHeight',
  ]);
  const g = keys(v.geometry, ['radius', 'density']);
  const b = keys(v.background, ['type', 'color', 'color2', 'angle', 'image', 'dim', 'position']);
  if (typeof b.image !== 'string' || b.image.length > 2048) fail();
  if (b.type === 'image' && !b.image) fail();
  const localImage = /^chatter-theme:\/\/[a-f0-9]{24}\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(b.image)
    || /^assets\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(png|jpe?g|webp|gif)$/.test(b.image);
  if (b.image && !localImage && !/^\/api\/v1\/images\/[a-zA-Z0-9_.-]+$/.test(b.image)) {
    try {
      const url = new URL(b.image);
      if (url.protocol !== 'https:' || url.username || url.password) fail();
    } catch {
      fail();
    }
  }
  let materials: AppearanceProfile['materials'];
  if (v.materials !== undefined) {
    const source = keys(v.materials, ['panels', 'composer']);
    materials = {};
    for (const region of ['panels', 'composer'] as const) {
      if (source[region] === undefined) continue;
      const item = keys(source[region], ['opacity', 'blur', 'shadow', 'border', 'radius']);
      materials[region] = {
        opacity: number(item.opacity, 0.55, 1),
        blur: number(item.blur, 0, 32),
        shadow: choice(item.shadow, ['none', 'soft', 'medium', 'strong']),
        border: choice(item.border, ['none', 'subtle', 'defined']),
        ...(item.radius !== undefined ? { radius: number(item.radius, 0, 24) } : {}),
      };
    }
  }
  let shell: AppearanceShell | undefined;
  if (v.shell !== undefined) {
    const source = keys(v.shell, ['version', 'language', 'scope', 'entry', 'files']);
    if (source.version !== 1) fail();
    const project = parseAppearanceProject(source);
    if ((source.language === 'html') !== project.entry.endsWith('.html')) fail();
    shell = {
      version: 1,
      language: choice(source.language, ['html', 'tsx']),
      ...project,
      ...(source.scope !== undefined ? { scope: choice(source.scope, ['navigator', 'workspace'] as const) } : {}),
    };
  }
  return {
    id,
    name: text(v.name, 80),
    ...(shell ? { shell } : {}),
    revision: revision(v.revision ?? 0),
    ...(materials !== undefined ? { materials } : {}),
    light: palette(v.light),
    dark: palette(v.dark),
    typography: {
      uiFont: font(t.uiFont),
      messageFont: font(t.messageFont),
      codeFont: font(t.codeFont),
      uiSize: number(t.uiSize, 12, 20),
      messageSize: number(t.messageSize, 12, 28),
      codeSize: number(t.codeSize, 11, 24),
      lineHeight: number(t.lineHeight, 1.2, 2),
    },
    geometry: { radius: number(g.radius, 0, 24), density: number(g.density, 0.7, 1.4) },
    background: {
      type: choice(b.type, ['solid', 'gradient', 'image']),
      color: color(b.color),
      color2: color(b.color2),
      angle: number(b.angle, 0, 360),
      image: b.image,
      dim: number(b.dim, 0, 0.9),
      position: choice(b.position, ['center', 'top', 'bottom']),
    },
    motion: parseAppearanceMotion(v.motion),
  };
}
export function parseAppearanceSettings(value: unknown): AppearanceSettings {
  const v = keys(value, ['version', 'revision', 'activeId', 'profiles']);
  if (v.version !== 1 || !Array.isArray(v.profiles) || v.profiles.length > 32) fail();
  const profiles: AppearanceProfile[] = v.profiles.map(parseAppearanceProfile);
  if (new Set(profiles.map((p) => p.id)).size !== profiles.length) fail();
  if (v.activeId !== null && !profiles.some((p) => p.id === v.activeId)) fail();
  return {
    version: 1,
    revision: revision(v.revision),
    activeId: v.activeId,
    profiles,
  };
}
export const APPEARANCE_CAPABILITIES = {
  shell: {
    project: {
      description: 'A shell is a file project with entry and files. On disk theme.json stores entry and the app discovers files; files is assembled internally. HTML entries end in .html; React entries use JS/TS/JSX/TSX. All files stay inside one theme. Relative imports support TSX, TS, JSX, JS, CSS (side effects) and JSON. No package installation, disk or network access.',
      limits: APPEARANCE_PROJECT_LIMITS,
      modules: APPEARANCE_PROJECT_MODULES,
      template: { version: 1, language: 'tsx', scope: 'workspace', entry: 'App.tsx', files: {
        'App.tsx': 'import React from "react";\nimport {useChatterState} from "@chatter/ui";\nimport ChatList from "./components/ChatList";\nimport Conversation from "./components/Conversation";\nimport Confirmations from "./components/Confirmations";\nimport "./styles.css";\nexport default function App(){const state=useChatterState({navigation:true,confirmations:true});if(!state)return <p>Loading…</p>;return <><Confirmations state={state}/>{state.view==="home"?<ChatList state={state}/>:<Conversation state={state}/>}</>;}',
        'components/ChatList.tsx': 'import React from "react";\nexport default function ChatList({state}){return <main><header><h1>{state.labels.allChats}</h1><button onClick={()=>window.chatter.newChat()}>{state.labels.newChat}</button><button onClick={()=>window.chatter.openLibrary()}>{state.labels.allChats}</button></header><input aria-label={state.labels.search} placeholder={state.labels.search} value={state.query} onChange={event=>window.chatter.search(event.target.value)}/>{state.chats.map(chat=><button className="chat" key={chat.id} onClick={()=>window.chatter.openChat(chat.id)}>{chat.title}</button>)}{state.query.trim().length<3&&state.sections.filter(section=>section.hasMore).map(section=><button key={section.folderId??"unfiled"} disabled={section.loading} onClick={()=>window.chatter.loadMore(section.folderId)}>{state.labels.loadMore}</button>)}</main>;}',
        'components/Conversation.tsx': String.raw`import React from "react";
import Composer from "./Composer";
import MessageActions from "./MessageActions";
import WorkLog from "./WorkLog";
import {Markdown as MessageMarkdown, MessageImages, Attachments} from "@chatter/ui";
export default function Conversation({state}){
  const visible=state.messages.filter(message=>message.content.trim()||message.workLog?.length||message.reasoningContent||message.streaming||message.images?.length||message.attachments?.length);
  return <main><header><button onClick={()=>window.chatter.showHome()}>{state.labels.allChats}</button><button onClick={()=>window.chatter.openConversation()}>…</button></header>
    {state.hasOlderMessages&&<button disabled={state.olderMessagesLoading} onClick={()=>window.chatter.loadOlderMessages()}>{state.labels.loadMore}</button>}
    <section className="messages">{visible.map(message=><article key={message.id} data-role={message.role}>
      {message.reasoningContent&&<details><summary>{state.labels.reasoning}</summary><MessageMarkdown messageId={message.id} content={message.reasoningContent}/></details>}
      <WorkLog message={message} labels={state.labels}/>
      <MessageImages message={message}/><Attachments message={message}/>
      {message.content.trim()&&<MessageMarkdown messageId={message.id} content={message.content}/>}
      {message.streaming&&!message.content.trim()&&!message.workLog?.length&&!message.reasoningContent&&<p role="status">{state.labels.loading}</p>}
      <MessageActions message={message} state={state}/>
    </article>)}</section><Composer state={state}/></main>;
}`,
        'components/WorkLog.tsx': String.raw`import React from "react";
import {Markdown} from "@chatter/ui";
const value=text=>typeof text==='string'?text:JSON.stringify(text,null,2);
function Tool({call}){
  return <details data-tool-name={call.name} data-status={call.status}>
    <summary><span>{call.label||call.name}</span> {call.target} <span title={call.status}>{{running:'…',returned:'✓',error:'!',unknown:'·'}[call.status]}</span></summary>
    <code>{call.name}</code><pre>{value(call.arguments)}</pre>
    {call.resultPreview&&<pre>{call.resultPreview}</pre>}
    {call.children?.map((child,index)=><Tool key={child.id??index} call={child}/>)}
  </details>;
}
export default function WorkLog({message,labels}){
  const steps=message.workLog??[],current=message.toolStatus;
  const showCurrent=current&&!steps.some(step=>step.type==='activity'&&step.text===current||step.type==='tool'&&step.call.status==='running');
  if(!steps.length&&!current)return null;
  return <details open={message.streaming||undefined} className="work-log"><summary>{labels.workLog}</summary>
    {steps.map((step,index)=>step.type==='tool'?<Tool key={step.call.id??index} call={step.call}/>:step.type==='message'?<Markdown key={index} messageId={message.id} content={step.text}/>:<p key={index}>{step.text}</p>)}
    {showCurrent&&<p role="status">{current}</p>}
  </details>;
}`,
        'components/Confirmations.tsx': String.raw`import React from "react";
import Content from "./ConfirmationContent";
import Actions from "./ConfirmationActions";
function Card({card,state}){
  const [pending,setPending]=React.useState({});
  React.useEffect(()=>setPending(current=>{
    const next={...current};for(const id of Object.keys(next)){const field=card.fields.find(item=>item.id===id);if(!field||field.disabled||field.value===next[id])delete next[id];}
    return Object.keys(next).length===Object.keys(current).length?current:next;
  }),[card.fields]);
  const change=(field,value)=>{if(window.chatter.setConfirmationField(card.id,field.id,value))setPending(current=>({...current,[field.id]:value}));};
  const waiting=Object.keys(pending).length>0;
  return <section className="confirmation"><h2>{card.title}</h2><p>{card.summary}</p>{!card.ready?<p>{state.labels.loading}</p>:<>
    <Content nodes={card.content} card={card} pending={pending} change={change} waiting={waiting}/>
    {['primary','review','permissions'].map(group=><div data-action-group={group} key={group}><Actions card={card} actions={card.actions.filter(action=>action.group===group)} waiting={waiting}/></div>)}
  </>}</section>;
}
export default function Confirmations({state}){return <aside aria-live="polite">{(state.confirmations??[]).map(card=><Card key={card.id} card={card} state={state}/>)}</aside>;}`,
        'components/ConfirmationContent.tsx': String.raw`import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Actions from "./ConfirmationActions";
export default function Content({nodes,card,pending,change,waiting}){return <>{nodes.map((node,index)=>{
  if(node.type==='group')return <section key={index}>{node.label&&<strong>{node.label}</strong>}<Content nodes={node.children} card={card} pending={pending} change={change} waiting={waiting}/></section>;
  if(node.type==='diff')return <section key={index}><pre data-diff="before">{node.before}</pre><pre data-diff="after">{node.after}</pre></section>;
  if(node.type==='markdown')return <Markdown key={index} remarkPlugins={[remarkGfm]}>{node.text}</Markdown>;
  if(node.type==='action')return <Actions key={index} card={card} actions={card.actions.filter(action=>action.id===node.actionId)} waiting={waiting}/>;
  if(node.type==='field'){
    const field=card.fields.find(item=>item.id===node.fieldId);if(!field)return null;
    const value=Object.prototype.hasOwnProperty.call(pending,field.id)?pending[field.id]:field.value;
    const props={disabled:field.disabled||card.busy,'aria-label':field.label};
    return <label key={field.id}>{field.label}{field.type==='select'?<select {...props} value={String(value)} onChange={e=>change(field,e.target.value)}>{field.options?.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>:field.type==='textarea'?<textarea {...props} value={String(value)} onChange={e=>change(field,e.target.value)}/>:field.type==='checkbox'?<input {...props} type="checkbox" checked={Boolean(value)} onChange={e=>change(field,e.target.checked)}/>:<input {...props} type={field.type} value={String(value)} onChange={e=>change(field,e.target.value)}/>}</label>;
  }
  return node.type==='text'?<span key={index} style={{whiteSpace:'pre-wrap'}}>{node.text}</span>:<pre key={index}>{node.text}</pre>;
})}</>;}`,
        'components/ConfirmationActions.tsx': String.raw`import React from "react";
function Action({card,action,waiting}){
  const [comment,setComment]=React.useState('');
  const disabled=card.busy||action.disabled||waiting;
  const run=()=>window.chatter.runConfirmationAction(card.id,action.id,card.revision,action.comment?comment:undefined);
  return action.comment?<form onSubmit={event=>{event.preventDefault();if(!disabled&&comment.trim())run();}}><textarea aria-label={action.label} value={comment} disabled={disabled} onChange={event=>setComment(event.target.value)}/><button disabled={disabled||!comment.trim()}>{action.label}</button></form>:<button type="button" disabled={disabled} onClick={run}>{action.label}</button>;
}
export default function Actions({card,actions,waiting}){return <>{actions.map(action=><Action key={action.id} card={card} action={action} waiting={waiting}/>)}</>;}`,
        'components/MessageActions.tsx': String.raw`import React from "react";
export default function MessageActions({message,state}){
  const api=window.chatter,id=message.id,actions=message.actions??[],speech=state.speech??{},current=speech.messageId===id;
  const [editor,setEditor]=React.useState(null),[hint,setHint]=React.useState(null);
  const calls={copy:()=>api.copyMessage(id),downloadDocx:()=>api.downloadMessageDocx(id),sendTelegram:()=>api.sendMessageToTelegram(id),fork:()=>api.forkFromMessage(id),
    edit:()=>setEditor({text:message.editableContent??message.content,variantIndex:message.variantIndex}),delete:()=>api.deleteMessage(id),regenerate:()=>api.regenerateMessage(id),regenerateHint:()=>setHint(''),
    speak:()=>current?speech.status==='paused'?api.resumeSpeech():api.pauseSpeech():api.speakMessage(id)};
  const label=action=>current&&action==='speak'?state.labels[speech.status==='paused'?'resumeSpeech':'pauseSpeech']:state.labels[action];
  return <footer className="message-actions">{actions.filter(action=>calls[action]).map(action=><button type="button" key={action} onClick={calls[action]} aria-label={label(action)}>{label(action)}</button>)}
    {current&&<button onClick={()=>api.stopSpeech()}>{state.labels.stopSpeech}</button>}
    {editor&&<form onSubmit={event=>{event.preventDefault();if(api.editMessage(id,editor.text,editor.variantIndex))setEditor(null);}}><textarea aria-label={state.labels.edit} value={editor.text} onChange={event=>setEditor({...editor,text:event.target.value})}/><button disabled={!editor.text.trim()||editor.variantIndex!==message.variantIndex||!actions.includes('edit')}>{state.labels.save}</button><button type="button" onClick={()=>setEditor(null)}>{state.labels.cancel}</button></form>}
    {hint!==null&&<form onSubmit={event=>{event.preventDefault();if(api.regenerateMessage(id,hint))setHint(null);}}><textarea aria-label={state.labels.regenerateHint} value={hint} onChange={event=>setHint(event.target.value)}/><button disabled={!hint.trim()||!actions.includes('regenerate')}>{state.labels.regenerate}</button><button type="button" onClick={()=>setHint(null)}>{state.labels.cancel}</button></form>}
    {actions.includes('activateVariant')&&<><button disabled={!message.variantIndex} onClick={()=>api.activateMessageVariant(id,message.variantIndex-1)} aria-label={state.labels.previousVariant}>Previous</button><span>{message.variantIndex+1}/{message.variantCount}</span><button disabled={message.variantIndex+1>=message.variantCount} onClick={()=>api.activateMessageVariant(id,message.variantIndex+1)} aria-label={state.labels.nextVariant}>Next</button></>}
  </footer>;
}`,
        'components/Composer.tsx': String.raw`import React from "react";
export default function Composer({state}){
  const [text,setText]=React.useState("");const composer=state.composer??{items:[],busy:false,error:null};
  return <section><ul>{composer.items.map(item=><li key={item.id}>
    {item.kind==='image'&&<img src={window.chatter.pendingAttachmentSource(item.id)} alt={item.name} style={{maxWidth:80,maxHeight:60}}/>}
    {item.name} · {item.sizeBytes} B <button type="button" disabled={composer.busy||state.sending} onClick={()=>window.chatter.removePendingAttachment(item.id)}>Remove</button>
  </li>)}</ul>{composer.busy&&<p role="status">{state.labels.loading}</p>}{composer.error&&<p role="alert">{composer.error}</p>}
  <form onSubmit={event=>{event.preventDefault();if(state.canSend&&(text.trim()||state.attachmentCount)&&window.chatter.sendMessage(text))setText("");}}>
    <button type="button" disabled={!state.canSend||composer.busy} onClick={()=>window.chatter.chooseAttachments()}>Attach files</button>
    <textarea aria-label="Message" value={text} onChange={event=>setText(event.target.value)}/>
    {state.sending?<button type="button" onClick={()=>window.chatter.stopGeneration()}>Stop</button>:<button disabled={!state.canSend||(!text.trim()&&!state.attachmentCount)}>Send</button>}
  </form></section>;
}`,
        'styles.css': 'body{margin:0;font:15px/1.6 system-ui,sans-serif;background:#101722;color:#e4ebf3}main{max-width:900px;margin:auto;padding:24px}header,form{display:flex;gap:12px;align-items:center}button,input,textarea{padding:12px;border-radius:8px;border:1px solid #456;background:#182536;color:inherit}.chat{display:block;width:100%;margin-top:8px;text-align:left}article{padding:12px;margin:12px 0;background:#182536;border-radius:8px}textarea{flex:1;min-width:0}',
      } },
    },
    description: 'Optional independently coded full-screen UI inside this appearance. scope navigator opens selected chats in the native conversation; scope workspace keeps the shell visible and supplies actual messages and generation state. The shell owns its HTML/CSS/JS or React TSX. React, react-markdown and remark-gfm imports are bundled. No external resources or direct app/OS access.',
    template: { version: 1, language: 'html', entry: 'index.html', files: { 'index.html': '<main id="chats"></main><script>window.chatter.subscribe(state => { document.getElementById("chats").replaceChildren(...state.chats.map(chat => { const button = document.createElement("button"); button.textContent = chat.title; button.onclick = () => window.chatter.openChat(chat.id); return button; })); });</script>' } },
    documentation: 'Read THEMES.md, docs/ and chatter.d.ts in the local theme directory.',
    scopes: ['navigator', 'workspace'],
  },
  version: 1,
  fonts: APPEARANCE_FONTS,
  customFont: 'Installed font family name; other devices use a fallback. Installation is separate.',
  colors:
    'Six-digit hex. light/dark each contain background (application shell), text and accent. Optional surface colors panels, header, composer and settings; optional chat colors the solid conversation backdrop. Omit optional colors for automatic legacy behavior. Text contrast adapts independently in each region.',
  paletteExample: {
    background: '#07111f',
    surface: '#112237',
    chat: '#08192b',
    text: '#d5eaff',
    accent: '#f59542',
  },
  limits: {
    profiles: 32,
    uiSize: [12, 20],
    messageSize: [12, 28],
    codeSize: [11, 24],
    lineHeight: [1.2, 2],
    radius: [0, 24],
    density: [0.7, 1.4],
    duration: [0, 800],
    distance: [0, 40],
    scale: [0.9, 1],
  },
  background: {
    scope:
      'Conversation only. solid follows light/dark.chat or falls back to light/dark.background; gradient/image override that solid color. Never changes the application shell or theme preference.',
    type: ['solid', 'gradient', 'image'],
    image: 'On disk use a relative assets/image.png (PNG/JPEG/WebP/GIF, up to 8 MiB) or an HTTPS URL. Local uploads are managed by the app. Legacy /api/v1/images/file references remain supported for migration.',
    position: ['center', 'top', 'bottom'],
  },
  motion: {
    preset: ['none', 'fade', 'slide', 'custom'],
    easing: ['ease-out', 'ease-in-out', 'linear'],
    presets: APPEARANCE_MOTION_PRESETS,
    description:
      'For a ready-made message arrival, copy one complete value from motion.presets into profile.motion. For custom motion, use preset custom with duration in milliseconds, distance in pixels, starting scale and easing. Only new arrivals animate.',
  },
  materials: {
    regions: ['panels', 'composer'],
    template: DEFAULT_MATERIAL,
    limits: { opacity: [0.55, 1], blur: [0, 32], radius: [0, 24] },
    shadow: ['none', 'soft', 'medium', 'strong'],
    border: ['none', 'subtle', 'defined'],
    description:
      'Optional material per region. Omit a region for unchanged legacy styling. Opacity affects fill only; text remains opaque. Fill opacity is applied exactly as requested; only foreground colors adapt for contrast. The editor warns when a varied backdrop may reduce legibility. System reduced-transparency preferences use an opaque fallback. Blur affects content behind the surface, not text. It is only visible over varied content; panels over a flat background may show no visible blur. Optional radius overrides the global radius in this region only. Use the existing preview/confirmation flow.',
  },
  template: newAppearance(),
};
