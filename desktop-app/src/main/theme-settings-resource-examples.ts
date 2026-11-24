/** Optional source examples, never mounted by the app. Copy, restyle or replace them. */
export const THEME_SETTINGS_RESOURCE_EXAMPLES: Record<string, string> = {
  'AccountSecurity.tsx': `import React from 'react';
import {useChatterState} from '@chatter/ui';
export default function AccountSecurity(){
 const state=useChatterState(), editor=state?.settings.editor;
 const [error,setError]=React.useState('');
 if(!editor||editor.sectionId!=='account'||editor.loading)return null;
 const submit=(mode:'changePassword'|'changeLogin')=>async(event:React.FormEvent<HTMLFormElement>)=>{
  event.preventDefault();const form=event.currentTarget, data=new FormData(form);
  const currentPassword=String(data.get('currentPassword')||''),value=String(data.get('value')||'');
  form.querySelectorAll<HTMLInputElement>('input[type=password]').forEach(input=>{input.value='';});setError('');
  try{if(mode==='changePassword')await window.chatter.requestSettings('account',mode,{currentPassword,newPassword:value});
   else await window.chatter.requestSettings('account',mode,{currentPassword,newLogin:value});
  }catch(reason){setError(reason instanceof Error?reason.message:'settings_operation_failed');}
 };
 return <section>{error&&<p role="alert">{error}</p>}{(['changePassword','changeLogin'] as const).map(mode=><form key={mode} onSubmit={submit(mode)}>
  <fieldset disabled={editor.busy}><legend>{editor.requests.find(item=>item.id===mode)?.label}</legend>
   <label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required/></label>
   <label>{mode==='changePassword'?'New password':'New login'}<input name="value" type={mode==='changePassword'?'password':'text'} autoComplete={mode==='changePassword'?'new-password':'username'} minLength={mode==='changePassword'?8:3} maxLength={mode==='changePassword'?128:64} required/></label>
   <button type="submit">{editor.requests.find(item=>item.id===mode)?.label}</button>
  </fieldset></form>)}</section>;
}
`,
  'MemoryLibrary.tsx': `import React from 'react';
import {useChatterState} from '@chatter/ui';
import type {SettingsMemorySpace,SettingsMemoryPage} from '../chatter';
export default function MemoryLibrary(){
 const state=useChatterState(),editor=state?.settings.editor,ready=editor?.sectionId==='memory'&&!editor.loading;
 const [data,setData]=React.useState<{editorId:string;spaces:SettingsMemorySpace[]}>();
 const [selected,setSelected]=React.useState<number>(),[page,setPage]=React.useState<{editorId:string;spaceId:number;query:string;value:SettingsMemoryPage}>();
 const [error,setError]=React.useState(''),[remove,setRemove]=React.useState<SettingsMemorySpace>();
 const refresh=async()=>{const result=await window.chatter.requestSettings('memory','listSpaces');setData({editorId:editor!.id,spaces:result.spaces});};
 React.useEffect(()=>{if(!ready)return;let alive=true;window.chatter.requestSettings('memory','listSpaces').then(result=>{if(alive)setData({editorId:editor!.id,spaces:result.spaces});},reason=>{if(alive)setError(reason.message);});return()=>{alive=false;};},[ready,editor?.id]);
 if(!ready||!editor)return null;
 const spaces=data?.editorId===editor.id?data.spaces:[],records=page?.editorId===editor.id&&page.spaceId===selected?page.value:null;
 const load=async(spaceId:number,query='',offset=0)=>{setError('');try{const value=await window.chatter.requestSettings('memory','listRecords',{spaceId,query,offset});setPage({editorId:editor.id,spaceId,query,value});}catch(reason){setError(reason instanceof Error?reason.message:'settings_operation_failed');}};
 return <section><form onSubmit={event=>{event.preventDefault();const form=event.currentTarget,name=String(new FormData(form).get('name')||'');void window.chatter.requestSettings('memory','createSpace',{name}).then(()=>{form.reset();return refresh();},reason=>setError(reason.message));}}>
  <label>New space<input name="name" required maxLength={100}/></label><button disabled={editor.busy}>Create</button></form>{error&&<p role="alert">{error}</p>}
  {spaces.map(space=><div key={space.id}><button type="button" onClick={()=>{setSelected(space.id);void load(space.id);}}>{space.name}</button><button type="button" disabled={editor.busy} onClick={()=>setRemove(space)}>Delete</button></div>)}
  {remove&&<section role="alertdialog" aria-label="Delete memory space"><p>Delete {remove.name} and all its records?</p><button type="button" onClick={()=>setRemove(undefined)}>Cancel</button><button type="button" disabled={editor.busy} onClick={()=>{void window.chatter.requestSettings('memory','deleteSpace',{spaceId:remove.id,confirmed:true}).then(()=>{setRemove(undefined);setSelected(undefined);setPage(undefined);return refresh();},reason=>setError(reason.message));}}>Delete permanently</button></section>}
  {selected&&<form key={selected} onSubmit={event=>{event.preventDefault();void load(selected,String(new FormData(event.currentTarget).get('query')||''));}}><label>Filter<input name="query" maxLength={300}/></label><button>Search</button></form>}
  {records?.records.map(record=><article key={record.id}><h4>{record.source}</h4><p>{record.text}</p></article>)}
  {records?.nextOffset!==null&&records?.nextOffset!==undefined&&selected&&<button type="button" onClick={()=>void load(selected,page?.query??'',records.nextOffset!)}>Next page</button>}
 </section>;
}
`,
  'ReadSettingsResource.tsx': `import React from 'react';
import {useChatterState} from '@chatter/ui';
export default function ReadSettingsResource({sectionId}:{sectionId:'agents'|'limits'}){
 const state=useChatterState(),editor=state?.settings.editor,ready=editor?.sectionId===sectionId&&!editor.loading;
 const [result,setResult]=React.useState<{editorId:string;value:unknown}>(),[error,setError]=React.useState('');
 React.useEffect(()=>{if(!ready)return;let alive=true;const request=sectionId==='agents'?window.chatter.requestSettings('agents','listAgents'):window.chatter.requestSettings('limits','getQuota');
  request.then(value=>{if(alive)setResult({editorId:editor!.id,value});},reason=>{if(alive)setError(reason.message);});return()=>{alive=false;};},[ready,editor?.id,sectionId]);
 return <section>{error&&<p role="alert">{error}</p>}{result?.editorId===editor?.id&&<pre>{JSON.stringify(result?.value,null,2)}</pre>}</section>;
}
`,
  'ThemeLibrary.tsx': `import React from 'react';
import {useChatterState} from '@chatter/ui';
import type {SettingsThemeList,SettingsThemeProfile} from '../chatter';
export default function ThemeLibrary(){
 const state=useChatterState(),editor=state?.settings.editor,ready=editor?.sectionId==='app'&&!editor.loading;
 const [library,setLibrary]=React.useState<{editorId:string;value:SettingsThemeList}>(),[source,setSource]=React.useState<{editorId:string;text:string}>();
 const [error,setError]=React.useState(''),[deleting,setDeleting]=React.useState<string>();
 const reload=async()=>{const value=await window.chatter.requestSettings('app','listThemes');setLibrary({editorId:editor!.id,value});};
 React.useEffect(()=>{if(!ready)return;let alive=true;window.chatter.requestSettings('app','listThemes').then(value=>{if(alive)setLibrary({editorId:editor!.id,value});},reason=>{if(alive)setError(reason.message);});return()=>{alive=false;};},[ready,editor?.id]);
 if(!ready||!editor)return null;
 const items=library?.editorId===editor.id?library.value.profiles:[],text=source?.editorId===editor.id?source.text:'';
 const run=async(action:()=>Promise<unknown>)=>{setError('');try{await action();}catch(reason){setError(reason instanceof Error?reason.message:'settings_operation_failed');}};
 return <section>{error&&<p role="alert">{error}</p>}
  <button type="button" onClick={()=>void run(async()=>{const result=await window.chatter.requestSettings('app','getAppearanceSchema');setSource({editorId:editor.id,text:JSON.stringify({...result.template,id:crypto.randomUUID(),name:'New theme'},null,2)});})}>New</button>
  {items.map(item=><article key={item.id}><strong>{item.name}</strong><button type="button" onClick={()=>void run(async()=>{const result=await window.chatter.requestSettings('app','getTheme',{id:item.id});setSource({editorId:editor.id,text:JSON.stringify(result.profile,null,2)});})}>Edit</button>
   <button type="button" disabled={editor.busy} onClick={()=>void run(()=>window.chatter.requestSettings('app','activateTheme',{id:item.id}))}>Apply</button><button type="button" onClick={()=>void run(()=>window.chatter.requestSettings('app','exportTheme',{id:item.id}))}>Export ZIP</button><button type="button" onClick={()=>setDeleting(item.id)}>Delete</button></article>)}
  {deleting&&<section role="alertdialog" aria-label="Delete theme"><p>Delete this theme and move its draft to trash?</p><button type="button" onClick={()=>setDeleting(undefined)}>Cancel</button><button type="button" disabled={editor.busy} onClick={()=>void run(async()=>{await window.chatter.requestSettings('app','deleteTheme',{id:deleting,confirmed:true});setDeleting(undefined);await reload();})}>Delete</button></section>}
  {text&&<form onSubmit={event=>{event.preventDefault();void run(async()=>{const profile=JSON.parse(text) as SettingsThemeProfile;await window.chatter.requestSettings('app','saveTheme',{profile,apply:true});await reload();});}}>
   <label>Theme profile<textarea value={text} onChange={event=>setSource({editorId:editor.id,text:event.target.value})}/></label><button type="submit" disabled={editor.busy}>Save and apply</button>
   <button type="button" disabled={editor.busy} onClick={()=>void run(async()=>{const result=await window.chatter.requestSettings('app','checkTheme',{profile:JSON.parse(text)});if(!result.valid)setError(JSON.stringify(result.diagnostics));})}>Check</button><button type="button" disabled={editor.busy} onClick={()=>void run(()=>window.chatter.requestSettings('app','writeDraft',{profile:JSON.parse(text)}))}>Save draft</button>
  </form>}
 </section>;
}
`,
};
