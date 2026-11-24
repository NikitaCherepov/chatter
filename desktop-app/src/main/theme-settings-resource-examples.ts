/** Optional source examples, never mounted by the app. Copy, restyle or replace them. */
export const THEME_SETTINGS_RESOURCE_EXAMPLES: Record<string, string> = {
  'ProfileLibrary.tsx': String.raw`import React from 'react';
import {useChatterState} from '@chatter/ui';
import type {SettingsPromptLibrary,SettingsPersonaLibrary} from '../chatter';

type Draft={id?:number;name:string;description:string;content:string;userInstructions:string;allowCoreMemoryUpdate:boolean};
type Item={id:number;name:string;active:boolean;editable:boolean;primary:boolean;draft?:Draft};
const blank=():Draft=>({name:'',description:'',content:'',userInstructions:'',allowCoreMemoryUpdate:true});
// One optional editor serves both sections. All markup and copy can be replaced.
export default function ProfileLibrary({sectionId}:{sectionId:'prompt'|'personas'}){
 const state=useChatterState(),editor=state?.settings.editor;
 const ready=editor?.sectionId===sectionId&&!editor.loading;
 const current=React.useRef(editor?.id);current.current=editor?.id;
 const [items,setItems]=React.useState<Item[]>(),[limit,setLimit]=React.useState<number>();
 const [form,setForm]=React.useState<{draft:Draft;saved:Draft}>();
 const [error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
 const [remove,setRemove]=React.useState<Item>(),[brief,setBrief]=React.useState(''),[proposal,setProposal]=React.useState<string>();
 const accept=(value:SettingsPromptLibrary|SettingsPersonaLibrary)=>{
  if('prompts' in value){setLimit(value.max_custom_prompt_length);setItems([
   ...value.prompts.map(p=>({id:p.id,name:p.name,active:value.selected_prompt_id===p.id,editable:false,primary:false})),
   ...value.custom_prompts.map(p=>({id:p.id,name:p.name,active:value.selected_prompt_id===p.id,editable:true,primary:false,draft:{...blank(),id:p.id,name:p.name,description:p.description,content:p.content}})),
   {id:-1,name:'Legacy custom prompt',active:value.selected_prompt_id===-1,editable:false,primary:false},
  ]);}else setItems(value.personas.map(p=>({id:p.id,name:p.name,active:p.active,editable:true,primary:p.primary,
   draft:{id:p.id,name:p.name,description:p.description,content:p.coreMemory,userInstructions:p.userInstructions,allowCoreMemoryUpdate:p.allowCoreMemoryUpdate}})));
 };
 const load=async()=>sectionId==='prompt'?window.chatter.requestSettings('prompt','listPrompts'):window.chatter.requestSettings('personas','listPersonas');
 React.useEffect(()=>{
  setItems(undefined);setForm(undefined);setError('');setRemove(undefined);setProposal(undefined);setBrief('');setBusy(false);setLimit(undefined);
  if(!ready)return;let alive=true;
  load().then(value=>{if(alive)accept(value);},reason=>{if(alive)setError(reason.message);});
  return()=>{alive=false;};
 },[ready,editor?.id,sectionId]);
 if(!ready||!editor)return null;
 const dirty=!!form&&JSON.stringify(form.draft)!==JSON.stringify(form.saved);
 const locked=busy||editor.busy;
 const run=async<R,>(action:()=>Promise<R>,commit:(result:R)=>void)=>{
  const id=editor.id;setError('');setBusy(true);
  try{const result=await action();if(current.current===id)commit(result);}
  catch(reason){if(current.current===id)setError(reason instanceof Error?reason.message:'settings_operation_failed');}
  finally{if(current.current===id)setBusy(false);}
 };
 const edit=(draft:Draft)=>{setForm({draft,saved:draft});setProposal(undefined);};
 const patch=(value:Partial<Draft>)=>{if(form)setForm({...form,draft:{...form.draft,...value}});};
 return <section aria-busy={locked}>
  {error&&<p role="alert">{error}</p>}{!items&&!error&&<p role="status">Loading…</p>}
  <button type="button" disabled={locked||dirty} onClick={()=>void run(load,accept)}>Reload</button>
  <button type="button" disabled={locked||dirty||!items} onClick={()=>edit(blank())}>New</button>
  {dirty&&<p>Save or discard your edits before choosing another profile.</p>}
  {items?.map(item=><article key={item.id}><strong>{item.name}{item.active?' ✓':''}</strong>
   <button type="button" disabled={locked||item.active} onClick={()=>void run(async()=>sectionId==='prompt'
    ?window.chatter.requestSettings('prompt','selectPrompt',{id:item.id}):window.chatter.requestSettings('personas','activatePersona',{id:item.id}),accept)}>Select</button>
   {item.editable&&<><button type="button" disabled={locked||dirty} onClick={()=>edit(item.draft!)}>Edit</button>
    <button type="button" disabled={locked||dirty||item.primary} onClick={()=>setRemove(item)}>Delete</button></>}
  </article>)}
  {remove&&<section role="alertdialog" aria-label="Delete profile"><p>Delete {remove.name}? {sectionId==='personas'&&'Chats using it will return to automatic persona selection.'}</p>
   <button type="button" disabled={locked} onClick={()=>setRemove(undefined)}>Cancel</button>
   <button type="button" disabled={locked} onClick={()=>void run(async()=>sectionId==='prompt'
    ?window.chatter.requestSettings('prompt','deletePrompt',{id:remove.id,confirmed:true}):window.chatter.requestSettings('personas','deletePersona',{id:remove.id,confirmed:true}),value=>{accept(value);setRemove(undefined);setForm(undefined);})}>Delete permanently</button>
  </section>}
  {form&&<form onSubmit={event=>{event.preventDefault();const d=form.draft;
   void run(async()=>sectionId==='prompt'
    ?d.id===undefined?window.chatter.requestSettings('prompt','createPrompt',{name:d.name,description:d.description,content:d.content})
     :window.chatter.requestSettings('prompt','updatePrompt',{id:d.id,name:d.name,description:d.description,content:d.content})
    :d.id===undefined?window.chatter.requestSettings('personas','createPersona',{name:d.name,description:d.description,coreMemory:d.content,userInstructions:d.userInstructions,allowCoreMemoryUpdate:d.allowCoreMemoryUpdate})
     :window.chatter.requestSettings('personas','updatePersona',{id:d.id,name:d.name,description:d.description,coreMemory:d.content,userInstructions:d.userInstructions,allowCoreMemoryUpdate:d.allowCoreMemoryUpdate}),value=>{accept(value);setForm(undefined);setProposal(undefined);});
  }}><fieldset disabled={locked}>
   <label>Name<input required maxLength={sectionId==='personas'?80:undefined} value={form.draft.name} onChange={event=>patch({name:event.target.value})}/></label>
   <label>Description<input maxLength={sectionId==='personas'?240:undefined} value={form.draft.description} onChange={event=>patch({description:event.target.value})}/></label>
   <label>{sectionId==='prompt'?'Prompt':'Core memory'}<textarea maxLength={sectionId==='prompt'?limit:undefined} value={form.draft.content} onChange={event=>patch({content:event.target.value})}/></label>
   {sectionId==='personas'&&<>
    <label>Instructions<textarea maxLength={12000} value={form.draft.userInstructions} onChange={event=>patch({userInstructions:event.target.value})}/></label>
    <label>Allow automatic memory updates<input type="checkbox" checked={form.draft.allowCoreMemoryUpdate} onChange={event=>patch({allowCoreMemoryUpdate:event.target.checked})}/></label>
   </>}
   <button type="button" onClick={()=>{setForm(undefined);setProposal(undefined);}}>Discard edits</button>
   <button type="submit">{sectionId==='prompt'&&form.draft.id===undefined?'Create and select':'Save'}</button>
  </fieldset></form>}
  {sectionId==='prompt'&&form&&<form onSubmit={event=>{event.preventDefault();void run(()=>window.chatter.requestSettings('prompt','generatePrompt',{instruction:brief,currentContent:form.draft.content}),result=>setProposal(result.generated_prompt));}}>
   <label>Describe a proposal<textarea required value={brief} onChange={event=>setBrief(event.target.value)}/></label>
   <button type="submit" disabled={locked}>Generate proposal</button>
  </form>}
  {proposal!==undefined&&<aside><pre>{proposal}</pre><button type="button" disabled={locked} onClick={()=>{patch({content:proposal});setProposal(undefined);}}>Use in draft</button><button type="button" onClick={()=>setProposal(undefined)}>Dismiss</button></aside>}
  {editor.links.map(link=><button key={link.id} type="button" disabled={locked||dirty} onClick={()=>window.chatter.openSettings(link.sectionId,link.target)}>Advanced native editor: {link.label}</button>)}
 </section>;
}
`,
  'IntuitionEditor.tsx': String.raw`import React from 'react';
import {useChatterState} from '@chatter/ui';
import type {SettingsIntuitionConfig, SettingsIntuitionSettings, SettingsIntuitionQuestion} from '../chatter';

export default function IntuitionEditor(){
  const state=useChatterState(), editor=state?.settings.editor;
  const ready=editor?.sectionId==='intuition'&&!editor.loading;
  const current=React.useRef(editor?.id); current.current=editor?.id;
  const [form,setForm]=React.useState<{id:string;config:SettingsIntuitionConfig;draft:SettingsIntuitionSettings}>();
  const [proposal,setProposal]=React.useState<SettingsIntuitionQuestion[]>();
  const [brief,setBrief]=React.useState('');
  const [error,setError]=React.useState('');
  const [busy,setBusy]=React.useState(false);
  React.useEffect(()=>{
    setForm(undefined);setProposal(undefined);setError('');setBusy(false);
    if(!ready||!editor)return;
    let alive=true;
    window.chatter.requestSettings('intuition','getIntuitionConfig').then(config=>{
      if(alive)setForm({id:editor.id,config,draft:config.settings});
    },reason=>{if(alive)setError(reason.message);});
    return ()=>{alive=false;};
  },[ready,editor?.id]);
  if(!ready||!editor)return null;
  const data=form?.id===editor.id?form:undefined;
  const run=async(action:()=>Promise<void>)=>{
    setBusy(true);setError('');const id=editor.id;
    try{await action();}catch(reason){if(current.current===id)setError(reason instanceof Error?reason.message:'settings_operation_failed');}
    finally{if(current.current===id)setBusy(false);}
  };
  const accept=(config:SettingsIntuitionConfig)=>{
    if(current.current===editor.id){setForm({id:editor.id,config,draft:config.settings});setProposal(undefined);}
  };
  const change=(patch:Partial<SettingsIntuitionSettings>)=>{
    if(data)setForm({...data,draft:{...data.draft,...patch}});
  };
  const questions=data?.draft.questions??data?.config.defaults??[];
  const changeQuestion=(id:string,patch:Partial<SettingsIntuitionQuestion>)=>change({questions:questions.map(item=>item.id===id?{...item,...patch}:item)});
  return <section aria-busy={busy||editor.busy}>
    {error&&<p role="alert">{error}</p>}
    <button type="button" disabled={busy||editor.busy} onClick={()=>void run(async()=>accept(await window.chatter.requestSettings('intuition','getIntuitionConfig')))}>Reload</button>
    {data&&<form onSubmit={event=>{event.preventDefault();void run(async()=>accept(await window.chatter.requestSettings('intuition','saveIntuitionConfig',{settings:data.draft})));}}>
      <fieldset disabled={busy||editor.busy}>
        {!data.config.available&&<p role="status">Evaluation service is unavailable. Preferences can still be saved.</p>}
        <label>Enabled<input type="checkbox" checked={data.draft.mode==='enabled'} onChange={event=>change({mode:event.target.checked?'enabled':'disabled'})}/></label>
        <label>Use default history depth<input type="checkbox" checked={data.draft.historyMessages===null} onChange={event=>change({historyMessages:event.target.checked?null:data.config.effective.historyMessages})}/></label>
        {data.draft.historyMessages!==null&&<label>Recent messages<input type="number" min={0} max={50} required value={data.draft.historyMessages} onChange={event=>change({historyMessages:Number(event.target.value)})}/></label>}
        {questions.map(question=><fieldset key={question.id}>
          <label>Active<input type="checkbox" checked={question.enabled} onChange={event=>changeQuestion(question.id,{enabled:event.target.checked})}/></label>
          <label>Name<input required maxLength={100} value={question.name} onChange={event=>changeQuestion(question.id,{name:event.target.value})}/></label>
          <label>Question<textarea required maxLength={1000} value={question.question} onChange={event=>changeQuestion(question.id,{question:event.target.value})}/></label>
          <button type="button" onClick={()=>change({questions:questions.filter(item=>item.id!==question.id)})}>Remove</button>
        </fieldset>)}
        <button type="button" disabled={questions.length>=20} onClick={()=>change({questions:[...questions,{id:'signal_'+crypto.randomUUID().replace(/-/g,''),name:'',question:'',enabled:true}]})}>Add question</button>
        <button type="button" onClick={()=>change({questions:null})}>Use default questions</button>
        <button type="button" onClick={()=>setForm({...data,draft:data.config.settings})}>Discard edits</button>
        <button type="submit">{state?.labels.save}</button>
      </fieldset>
    </form>}
    <form onSubmit={event=>{event.preventDefault();void run(async()=>{
      const result=await window.chatter.requestSettings('intuition','suggestIntuitionQuestions',{brief});
      if(current.current===editor.id)setProposal(result.questions);
    });}}>
      <label>Describe the proposed questions<textarea maxLength={2000} value={brief} onChange={event=>setBrief(event.target.value)}/></label>
      <button type="submit" disabled={busy||editor.busy||!data}>Suggest questions</button>
    </form>
    {proposal&&<aside><ul>{proposal.map(item=><li key={item.id}>{item.name}: {item.question}</li>)}</ul>
      <button type="button" disabled={busy||editor.busy} onClick={()=>{change({questions:proposal});setProposal(undefined);}}>Use in draft</button>
      <button type="button" onClick={()=>setProposal(undefined)}>Dismiss</button>
    </aside>}
  </section>;
}
`,
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
