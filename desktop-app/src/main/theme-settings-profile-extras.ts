/** Optional data-driven form examples. They are copied into the handbook, never mounted by the app. */
export const THEME_SETTINGS_PROFILE_EXTRAS: Record<string, string> = {
  'SurveyQuestions.tsx': String.raw`import React from 'react';
import type {SettingsPersonaSurvey,SettingsSurveyAnswer} from '../chatter';
export default function SurveyQuestions({survey,answers,onChange,disabled}:{survey:SettingsPersonaSurvey;answers:Record<string,SettingsSurveyAnswer>;onChange:(value:Record<string,SettingsSurveyAnswer>)=>void;disabled:boolean}){
 const set=(key:string,value:SettingsSurveyAnswer)=>onChange({...answers,[key]:value});
 return <section><h4>{survey.questionnaire.title}</h4>{survey.questionnaire.questions.map(q=>{
  const value=answers[q.id],custom=typeof value==='object'&&!Array.isArray(value)?value:undefined;
  const selected=Array.isArray(value)?value:custom?.selected??[];
  return <fieldset key={q.id} disabled={disabled}><legend>{q.label}{q.required?' *':''}</legend>
   {q.image&&<small>{q.image.alt}</small>}
   {q.type==='text'||q.type==='textarea'?q.type==='text'
    ?<input aria-label={q.label} required={q.required} maxLength={1000} value={typeof value==='string'?value:''} onChange={e=>set(q.id,e.target.value)}/>
    :<textarea aria-label={q.label} required={q.required} maxLength={4000} value={typeof value==='string'?value:''} onChange={e=>set(q.id,e.target.value)}/>
    :<>{q.options?.map(option=><label key={option}><input type={q.type==='single'?'radio':'checkbox'} name={survey.id+'-'+q.id}
      checked={q.type==='single'?value===option:selected.includes(option)} onChange={e=>{
       if(q.type==='single')set(q.id,option);else{const next=e.target.checked?[...selected,option]:selected.filter(v=>v!==option);set(q.id,custom?{other:custom.other,selected:next}:next);}
      }}/>{option}</label>)}
      {q.allowOther&&<label><input type={q.type==='single'?'radio':'checkbox'} name={survey.id+'-'+q.id} checked={!!custom} onChange={e=>set(q.id,e.target.checked?{other:'',...(q.type==='multiple'?{selected}: {})}:q.type==='multiple'?selected:'')}/>Other</label>}
      {custom&&<input aria-label={q.label+' — other'} required maxLength={1000} value={custom.other} onChange={e=>set(q.id,{...custom,other:e.target.value})}/>}
    </>}
  </fieldset>;
 })}</section>;
}
`,
  'PersonaInstructions.tsx': String.raw`import React from 'react';
import {useChatterState} from '@chatter/ui';
import type {SettingsPersonaInstructions,SettingsPersonaSurvey,SettingsSurveyAnswer,SettingsGenerationModels} from '../chatter';
import SurveyQuestions from './SurveyQuestions';

export default function PersonaInstructions({id}:{id:number}){
 const state=useChatterState(),editor=state?.settings.editor,ready=editor?.sectionId==='personas'&&!editor.loading;
 const scope=String(editor?.id)+':'+id,current=React.useRef(scope);current.current=scope;
 const [data,setData]=React.useState<SettingsPersonaInstructions>(),[text,setText]=React.useState('');
 const [selected,setSelected]=React.useState<SettingsPersonaSurvey>(),[answers,setAnswers]=React.useState<Record<string,SettingsSurveyAnswer>>({}),[proposal,setProposal]=React.useState('');
 const [brief,setBrief]=React.useState(''),[followBrief,setFollowBrief]=React.useState(''),[count,setCount]=React.useState(10);
 const [includePrompt,setIncludePrompt]=React.useState(false),[personalize,setPersonalize]=React.useState(false);
 const [models,setModels]=React.useState<SettingsGenerationModels>(),[model,setModel]=React.useState('default');
 const [busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[remove,setRemove]=React.useState(false),[restore,setRestore]=React.useState(false);
 const accept=(value:SettingsPersonaInstructions)=>{setData(value);setText(value.text);};
 const choose=(survey:SettingsPersonaSurvey)=>{setSelected(survey);setAnswers(survey.answers??{});setProposal(survey.draft??'');setFollowBrief('');setRemove(false);setRestore(false);};
 React.useEffect(()=>{
  setData(undefined);setText('');setSelected(undefined);setError('');setBusy(false);setRemove(false);setModels(undefined);setModel('default');setBrief('');setFollowBrief('');setCount(10);setIncludePrompt(false);setPersonalize(false);
  if(!ready)return;let alive=true;
  window.chatter.requestSettings('personas','getPersonaInstructions',{id}).then(value=>{if(alive)accept(value);},reason=>{if(alive)setError(reason.message);});
  window.chatter.requestSettings('personas','listGenerationModels').then(value=>{if(alive)setModels(value);},()=>{});
  return()=>{alive=false;};
 },[scope,ready]);
 if(!ready||!editor)return null;
 const locked=busy||editor.busy;
 const run=async<R,>(action:()=>Promise<R>,commit:(value:R)=>void)=>{
  const owner=scope;setBusy(true);setError('');
  try{const value=await action();if(current.current===owner)commit(value);}
  catch(reason){if(current.current===owner)setError(reason instanceof Error?reason.message:'settings_operation_failed');}
  finally{if(current.current===owner)setBusy(false);}
 };
 const remember=(survey:SettingsPersonaSurvey)=>{if(data)setData({...data,surveys:[survey,...data.surveys.filter(s=>s.id!==survey.id)]});choose(survey);};
 return <section aria-busy={locked}>
  <h3>Instructions and questionnaires</h3>{error&&<p role="alert">{error}</p>}
  <button type="button" disabled={locked} onClick={()=>void run(()=>window.chatter.requestSettings('personas','getPersonaInstructions',{id}),value=>{
   // Preserve the local text/proposal on explicit refresh; compare before replacing either.
   setData(value);if(selected){const saved=value.surveys.find(s=>s.id===selected.id);if(saved){setSelected(saved);setAnswers(saved.answers??{});}else setSelected(undefined);}
  })}>Reload stored state (keep local text)</button>
  <form onSubmit={e=>{e.preventDefault();void run(()=>window.chatter.requestSettings('personas','savePersonaInstructions',{id,text}),accept);}}>
   <fieldset disabled={locked||!data}><label>Instructions<textarea maxLength={12000} value={text} onChange={e=>setText(e.target.value)}/></label>
    <button type="submit">Save instructions</button><button type="button" onClick={()=>setText(data!.text)}>Use stored instructions</button>
   </fieldset>
  </form>
  <form onSubmit={e=>{e.preventDefault();void run(()=>window.chatter.requestSettings('personas','createPersonaSurvey',{
   id,brief,currentText:text,questionCount:count,includePrompt,personalize,...(model==='default'?{}:{modelId:model==='auto'?null:model}),
  }),value=>remember(value.survey));}}><fieldset disabled={locked||!data}>
   <label>Questionnaire brief<textarea maxLength={2000} value={brief} onChange={e=>setBrief(e.target.value)}/></label>
   <label>Question count<input type="number" required min={1} max={100} step={1} value={count} onChange={e=>setCount(Number(e.target.value))}/></label>
   <label>Model<select value={model} onChange={e=>setModel(e.target.value)}><option value="default">Server preference</option><option value="auto">Automatic</option>{models?.models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
   <label><input type="checkbox" checked={includePrompt} onChange={e=>setIncludePrompt(e.target.checked)}/>Include selected assistant prompt</label>
   <label><input type="checkbox" checked={personalize} onChange={e=>setPersonalize(e.target.checked)}/>Allow the preference agent to consult permitted memory</label>
   <p>Generation uses model quota. It creates proposals; only Apply changes active instructions.</p>
   <button type="submit">Create questionnaire</button>
  </fieldset></form>
  {data?.surveys.map(survey=><button key={survey.id} type="button" disabled={locked} onClick={()=>choose(survey)}>{survey.questionnaire.title}{survey.applied_text!==null?' ✓':''}</button>)}
  {selected&&<section>
   <form onSubmit={e=>{e.preventDefault();void run(()=>window.chatter.requestSettings('personas','answerPersonaSurvey',{id,surveyId:selected.id,answers}),value=>remember(value.survey));}}>
    <SurveyQuestions survey={selected} answers={answers} onChange={setAnswers} disabled={locked||selected.answers!==null}/>
    {selected.answers===null&&<button type="submit" disabled={locked}>Submit answers and generate proposal</button>}
   </form>
   {selected.answers!==null&&<>
    <button type="button" disabled={locked} onClick={()=>void run(()=>window.chatter.requestSettings('personas','regeneratePersonaSurvey',{id,surveyId:selected.id}),value=>remember(value.survey))}>Regenerate proposal</button>
    <form onSubmit={e=>{e.preventDefault();void run(()=>window.chatter.requestSettings('personas','followUpPersonaSurvey',{id,surveyId:selected.id,brief:followBrief}),value=>remember(value.survey));}}>
     <label>Additional questions about<textarea maxLength={2000} value={followBrief} onChange={e=>setFollowBrief(e.target.value)}/></label><button type="submit" disabled={locked}>Create another round</button>
    </form>
   </>}
   {selected.draft!==null&&<form onSubmit={e=>{e.preventDefault();void run(()=>window.chatter.requestSettings('personas','applyPersonaSurvey',{id,surveyId:selected.id,text:proposal}),value=>{accept(value);const saved=value.surveys.find(s=>s.id===selected.id);if(saved)choose(saved);});}}>
    <label>Review proposed instructions<textarea maxLength={12000} value={proposal} onChange={e=>setProposal(e.target.value)}/></label>
    <button type="submit" disabled={locked}>Apply these instructions</button>
   </form>}
   <button type="button" disabled={locked} onClick={()=>setRemove(true)}>Delete questionnaire</button>
   {remove&&<section role="alertdialog" aria-label="Delete questionnaire"><p>Delete this questionnaire? Instructions remain unless you choose to restore them.</p>
    {selected.applied_text!==null&&<label><input type="checkbox" checked={restore} onChange={e=>setRestore(e.target.checked)}/>Restore instructions from before this questionnaire</label>}
    <button type="button" disabled={locked} onClick={()=>setRemove(false)}>Cancel</button>
    <button type="button" disabled={locked} onClick={()=>void run(()=>window.chatter.requestSettings('personas','deletePersonaSurvey',{id,surveyId:selected.id,removeApplied:restore,confirmed:true}),value=>{
     setData(value);if(restore)setText(value.text);setSelected(undefined);setRemove(false);
    })}>Confirm deletion</button>
   </section>}
  </section>}
 </section>;
}
`,
  'ProfileAvatar.tsx': String.raw`import React from 'react';
import {useChatterState} from '@chatter/ui';
import type {SettingsProfileImage,SettingsCroppedProfileImage} from '../chatter';
export default function ProfileAvatar({sectionId,id}:{sectionId:'prompt'|'personas';id:number}){
 const state=useChatterState(),editor=state?.settings.editor,ready=editor?.sectionId===sectionId&&!editor.loading;
 const scope=String(editor?.id)+':'+sectionId+':'+id,current=React.useRef(scope);current.current=scope;
 const [source,setSource]=React.useState(''),[image,setImage]=React.useState<SettingsProfileImage>(),[output,setOutput]=React.useState<SettingsCroppedProfileImage>();
 const [size,setSize]=React.useState({width:0,height:0}),[zoom,setZoom]=React.useState(1),[horizontal,setHorizontal]=React.useState(.5),[vertical,setVertical]=React.useState(.5);
 const [busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
 const useSource=(url:string)=>{
  setSource(url);setOutput(undefined);setSize({width:0,height:0});setZoom(1);setHorizontal(.5);setVertical(.5);
  const match=/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(url);
  setImage(match?{mimeType:match[1] as SettingsProfileImage['mimeType'],base64:match[2]}:undefined);
 };
 React.useEffect(()=>{
  useSource('');setBusy(!!ready);setError('');if(!ready)return;let alive=true;
  const request=sectionId==='prompt'?window.chatter.requestSettings('prompt','getPromptImageSource',{id}):window.chatter.requestSettings('personas','getPersonaImageSource',{id});
  request.then(value=>{if(alive)useSource(value.source??'');},reason=>{if(alive)setError(reason.message);}).finally(()=>{if(alive)setBusy(false);});return()=>{alive=false;};
 },[scope,ready]);
 if(!ready||!editor)return null;
 const locked=busy||editor.busy;
 const run=async<R,>(action:()=>Promise<R>,commit:(result:R)=>void)=>{
  const owner=scope;setBusy(true);setError('');try{const result=await action();if(current.current===owner)commit(result);}
  catch(reason){if(current.current===owner)setError(reason instanceof Error?reason.message:'settings_operation_failed');}finally{if(current.current===owner)setBusy(false);}
 };
 const pick=(file:File)=>{void run(()=>new Promise<string>((resolve,reject)=>{
  if(file.size>10*1024*1024||!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)){reject(new Error('profile_image_invalid'));return;}
  const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('profile_image_invalid'));reader.readAsDataURL(file);
 }),useSource);};
 return <section aria-busy={locked}><h4>Avatar</h4>{error&&<p role="alert">{error}</p>}
  <input aria-label="Choose avatar" type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={locked} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)pick(file);}}/>
  {source&&<img alt="Source avatar" src={source} style={{maxWidth:240,maxHeight:240}} onLoad={e=>setSize({width:e.currentTarget.naturalWidth,height:e.currentTarget.naturalHeight})} onError={()=>setError('profile_image_invalid')}/>}
  <fieldset disabled={locked||!image||!size.width}>
   <label>Zoom<input type="range" min={1} max={3} step={.01} value={zoom} onChange={e=>{setZoom(Number(e.target.value));setOutput(undefined);}}/></label>
   <label>Horizontal position<input type="range" min={0} max={1} step={.01} value={horizontal} onChange={e=>{setHorizontal(Number(e.target.value));setOutput(undefined);}}/></label>
   <label>Vertical position<input type="range" min={0} max={1} step={.01} value={vertical} onChange={e=>{setVertical(Number(e.target.value));setOutput(undefined);}}/></label>
   <button type="button" onClick={()=>{if(!image)return;const side=Math.min(size.width,size.height)/zoom;
    void run(async()=>window.chatter.requestSettings(sectionId,'cropProfileImage',{...image,crop:{x:(size.width-side)*horizontal,y:(size.height-side)*vertical,size:side}}),setOutput);
   }}>Prepare cropped preview</button>
  </fieldset>
  {output&&<img alt="Cropped avatar preview" src={output.previewUrl} width={128} height={128}/>}
  <button type="button" disabled={locked||!image} onClick={()=>{const value=output??image;if(!value)return;
   void run(async()=>sectionId==='prompt'?window.chatter.requestSettings('prompt','setPromptImage',{id,base64:value.base64,mimeType:value.mimeType}):window.chatter.requestSettings('personas','setPersonaImage',{id,base64:value.base64,mimeType:value.mimeType}),()=>useSource(output?.previewUrl??source));
  }}>Save avatar</button>
  <button type="button" disabled={locked} onClick={()=>void run(async()=>sectionId==='prompt'?window.chatter.requestSettings('prompt','deletePromptImage',{id}):window.chatter.requestSettings('personas','deletePersonaImage',{id}),()=>useSource(''))}>Remove avatar</button>
 </section>;
}
`,
};
