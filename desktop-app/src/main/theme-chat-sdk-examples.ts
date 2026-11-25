// Optional, unstyled examples. Theme-owned markup may be replaced or composed freely.
export const THEME_CHAT_EXAMPLES: Record<string, string> = {
  'Composer.tsx': `import React from 'react';
import {useComposer,useVoice} from '@chatter/ui';
export default function Composer() {
  const composer=useComposer(),voice=useVoice();
  return <form onSubmit={composer.submit}>
    {composer.items.map(item=><div key={item.id}>
      {item.source&&<img src={item.source} alt={item.name}/>}
      <span>{item.name}</span><button type="button" onClick={item.remove}>Remove</button>
    </div>)}
    <textarea {...composer.bind()}/>
    {composer.error&&<p role="alert">{composer.error}</p>}
    {voice.error&&<p role="alert">{voice.error}</p>}
    <button type="button" disabled={!composer.ready||composer.busy||composer.sending} onClick={composer.chooseAttachments}>Attach</button>
    {voice.status==='idle'?<button type="button" disabled={!voice.canStart} onClick={voice.start}>Record</button>
      :<><span>{voice.status}</span><button type="button" onClick={voice.status==='recording'?voice.stop:voice.cancel}>Stop/cancel</button></>}
    {composer.sending?<button type="button" onClick={composer.stop}>Stop generation</button>
      :<button disabled={!composer.canSend}>Send</button>}
  </form>;
}
`,
  'Models.tsx': `import React from 'react';
import {useModels} from '@chatter/ui';
export default function Models() {
  const models=useModels();
  return <section>
    <select aria-label="Model" {...models.bind()}>
      {models.options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    {models.reasoning.available&&<label>{models.reasoning.label}
      <select {...models.reasoning.bind()}>
        {models.reasoning.options.map(option=><option key={option.value??'auto'} value={option.value??''} disabled={option.disabled}>{option.label}</option>)}
      </select>
    </label>}
    {models.error&&<p role="alert">{models.error}</p>}
  </section>;
}
`,
  'Conversation.tsx': `import React from 'react';
import {useConversation,Markdown} from '@chatter/ui';
import Message from './Message';
export default function Conversation() {
  const chat=useConversation({navigation:true});
  return <main>
    {chat.hasOlder&&<button disabled={chat.loadingOlder} onClick={chat.loadOlder}>Older messages</button>}
    {chat.loading&&<p>Loading…</p>}
    {chat.timeline.map(item=>item.kind==='summary'
      ?<aside key={item.key} aria-label={item.summary.title}><h3>{item.summary.title}</h3><p>{item.summary.content}</p></aside>
      :<Message key={item.key} id={item.message.id}/>)}
  </main>;
}
`,
  'Message.tsx': `import React from 'react';
import {useMessage,Markdown,MessageImages,Attachments} from '@chatter/ui';
import MessageEditor from './MessageEditor';
import WorkLog from './WorkLog';
export default function Message({id}:{id:number}) {
  const item=useMessage(id),[editing,setEditing]=React.useState(false),[hint,setHint]=React.useState<string|null>(null);
  const message=item.message;
  if(!message)return null;
  return <article>
    <header>{message.role}{message.archived&&<small>Archived</small>}</header>
    {message.reasoningContent&&<details><summary>Reasoning</summary><Markdown messageId={id} content={message.reasoningContent}/></details>}
    <WorkLog id={id}/>
    {item.hasBody&&<section>
      {message.content&&<Markdown messageId={id} content={message.content}/>}
      <MessageImages message={message}/><Attachments message={message}/>
    </section>}
    {item.streaming&&!item.hasBody&&<span>Working…</span>}
    {item.actions.filter(action=>action.id!=='activateVariant').map(action=><button key={action.id} onClick={()=>{
      if(action.id==='edit')setEditing(true);
      else if(action.id==='regenerateHint')setHint('');
      else action.run();
    }}>{action.label}</button>)}
    {item.speechStatus!=='idle'&&<button onClick={item.stopSpeech}>Stop speech</button>}
    {item.variants.count>1&&<nav><button disabled={!item.variants.index} onClick={item.variants.previous}>Previous</button>
      {item.variants.index+1}/{item.variants.count}<button disabled={item.variants.index+1>=item.variants.count} onClick={item.variants.next}>Next</button></nav>}
    {editing&&<MessageEditor id={id} close={()=>setEditing(false)}/>}
    {hint!==null&&<form onSubmit={event=>{event.preventDefault();if(item.regenerate(hint))setHint(null);}}>
      <textarea value={hint} onChange={event=>setHint(event.currentTarget.value)}/><button disabled={!hint.trim()}>Regenerate with instruction</button>
      <button type="button" onClick={()=>setHint(null)}>Cancel</button>
    </form>}
  </article>;
}
`,
  'WorkLog.tsx': `import React from 'react';
import {useMessage,useChatterState,Markdown,type ChatMessage} from '@chatter/ui';
type Call=Extract<ChatMessage['workLog'][number],{type:'tool'}>['call'];
const value=(input:unknown)=>{try{return JSON.stringify(input,null,2)??'';}catch{return String(input);}};
function Tool({call}:{call:Call}){return <details open={call.status==='running'||undefined}>
  <summary>{call.label} · {call.status}{call.target&&' · '+call.target}</summary>
  <code>{call.name}</code><pre>{value(call.arguments)}</pre>
  {call.resultPreview&&<pre>{call.resultPreview}</pre>}
  {call.children.map((child,index)=><Tool key={child.id??index} call={child}/>)}
</details>;}
export default function WorkLog({id}:{id:number}){
  const item=useMessage(id),labels=useChatterState()?.labels;
  if(!item.hasActivity)return null;
  return <details open={item.streaming||undefined}><summary>{labels?.workLog??'Work log'}</summary>
    {item.activity.steps.map((step,index)=>step.type==='tool'?<Tool key={step.call.id??index} call={step.call}/>
      :step.type==='message'?<Markdown key={index} messageId={id} content={step.text}/>:<p key={index}>{step.text}</p>)}
    {item.activity.status&&<p role="status">{item.activity.status}</p>}
  </details>;
}
`,
  'MessageEditor.tsx': `import React from 'react';
import {useMessageEditor} from '@chatter/ui';
export default function MessageEditor({id,close}:{id:number;close:()=>void}) {
  const editor=useMessageEditor(id);
  return <form onSubmit={event=>{event.preventDefault();void editor.save().then(result=>{if(result.ok)close();});}}>
    <textarea {...editor.bind()}/>
    {editor.error&&<p role="alert">{editor.error}</p>}
    {editor.conflict&&<p>Message changed. Discard or reconcile before resubmitting.</p>}
    <button disabled={!editor.canSave}>Submit edit</button>
    <button type="button" onClick={()=>{editor.discard();close();}}>Cancel</button>
  </form>;
}
`,
  'MediaViewers.tsx': `import React from 'react';
import {useImageViewer,useDocumentViewer,Markdown} from '@chatter/ui';
export default function MediaViewers({messageId,imageUrl,attachmentIndex}:{messageId:number;imageUrl?:string;attachmentIndex?:number}) {
  const image=useImageViewer(),document=useDocumentViewer();
  return <>
    {imageUrl&&<button onClick={()=>image.open(messageId,imageUrl)}>View image</button>}
    {attachmentIndex!==undefined&&<button onClick={()=>document.open(messageId,attachmentIndex)}>Read document</button>}
    {image.visible&&<section role="dialog" aria-label="Image">
      <button onClick={image.close}>Close</button>
      {image.failed?<button onClick={image.retry}>Retry</button>:<img key={image.key} src={image.source} alt={image.alt} onError={image.onError} onLoad={image.onLoad}/>}
      <button onClick={image.download}>Download</button>
    </section>}
    {document.visible&&<section role="dialog" aria-label={document.file?.name}>
      <button onClick={document.close}>Close</button>
      {(document.loading||document.renderedPage.loading)&&<p>Loading…</p>}
      {(document.error||document.renderedPage.error)&&<button onClick={()=>void (document.error?document.reload():document.renderedPage.reload())}>Retry</button>}
      {document.data?.html?<div dangerouslySetInnerHTML={{__html:document.data.html}}/>
        :document.data?.kind==='pdf'?<><img src={document.renderedPage.data?.source} alt={'Page '+document.page}/>
          <button disabled={document.page<=1} onClick={()=>document.setPage(document.page-1)}>Previous</button>
          <button disabled={document.page>=(document.data.pageCount??1)} onClick={()=>document.setPage(document.page+1)}>Next</button></>
        :<pre>{document.data?.text}</pre>}
      <button onClick={document.download}>Download</button>
    </section>}
  </>;
}
`,
  'Confirmations.tsx': `import React from 'react';
import {useConfirmations,useConfirmation} from '@chatter/ui';
export default function Confirmations(){const list=useConfirmations();return <aside>{list.items.map(card=><Card key={card.id} id={card.id}/>)}</aside>;}
type Node=ReturnType<typeof useConfirmation>['content'][number];
function Content({nodes}:{nodes:Node[]}){return <>{nodes.map((node,index)=>
  node.type==='group'?<section key={index}><h4>{node.label}</h4><Content nodes={node.children}/></section>
  :node.type==='diff'?<section key={index}><h4>Before</h4><pre>{node.before}</pre><h4>After</h4><pre>{node.after}</pre></section>
  :node.type==='field'||node.type==='action'?null:<pre key={index}>{node.text}</pre>)}</>;}
function Card({id}:{id:string}) {
  const request=useConfirmation(id),[comment,setComment]=React.useState('');
  if(!request.card)return null;
  return <section aria-busy={!request.ready||request.busy}><h3>{request.card.title}</h3><p>{request.card.summary}</p>
    {!request.ready?<p>Loading…</p>:!request.card.customizable?<button onClick={request.review}>Review full request</button>:<>
      <Content nodes={request.content}/>
      {request.fields.map(field=><label key={field.id}>{field.label}
        {field.options?<select {...request.bind(field.id)}>{field.options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>
          :typeof field.value==='boolean'?<input type="checkbox" {...request.bind(field.id)}/>:<textarea {...request.bind(field.id)}/>}
      </label>)}
      {request.actions.some(action=>action.comment)&&<textarea aria-label="Comment" value={comment} onChange={event=>setComment(event.currentTarget.value)}/>}
      {request.actions.map(action=><button key={action.id} disabled={request.busy||action.disabled||action.comment&&!comment.trim()} onClick={()=>action.run(action.comment?comment:undefined)}>{action.label}</button>)}
    </>}
  </section>;
}
`,
  'Library.tsx': `import React from 'react';
import {useChatLibrary,useChatMenu,useFolderEditor} from '@chatter/ui';
export default function Library() {
  const library=useChatLibrary({navigation:true});
  return <aside><input aria-label="Search" {...library.bindSearch()}/><button onClick={library.newChat}>New chat</button>
    {library.error&&<p role="alert">{library.error}</p>}
    {library.groups.map(group=><section key={group.folderId??'unfiled'}><h3>{group.name} · {group.total}</h3>
      {group.chats.map(chat=><button key={chat.id} onClick={()=>library.open(chat.id)}>{chat.title}</button>)}
      {group.hasMore&&<button disabled={group.loading} onClick={()=>library.loadMore(group.folderId)}>Load more</button>}
    </section>)}
  </aside>;
}
`,
};

export const THEME_CHAT_STARTER = {
  'App.tsx': `import React from 'react';
import {useConversation,useChatLibrary} from '@chatter/ui';
import Library from './components/Library';
import Conversation from './components/Conversation';
import Composer from './components/Composer';
import Models from './components/Models';
import Confirmations from './components/Confirmations';
import './styles.css';
export default function App(){
  const chat=useConversation({navigation:true}),library=useChatLibrary();
  if(!chat.ready)return <p>Loading…</p>;
  return <><Confirmations/><header><button onClick={library.home}>Chats</button><Models/></header>
    {chat.view==='home'?<Library/>:<><Conversation/><Composer/></>}
  </>;
}
`,
  ...Object.fromEntries(
    [
      'Library.tsx',
      'Conversation.tsx',
      'Composer.tsx',
      'Models.tsx',
      'Message.tsx',
      'MessageEditor.tsx',
      'WorkLog.tsx',
      'Confirmations.tsx',
    ].map((name) => ['components/' + name, THEME_CHAT_EXAMPLES[name]]),
  ),
  'styles.css':
    'body{margin:0;font:15px/1.6 system-ui,sans-serif;background:#101722;color:#e4ebf3}main,aside,body>header{max-width:900px;margin:auto;padding:24px}header,form,nav{display:flex;gap:12px;align-items:center;flex-wrap:wrap}button,input,textarea,select{padding:12px;border-radius:8px;border:1px solid #456;background:#182536;color:inherit}article{padding:16px;margin:16px 0;background:#182536;border-radius:8px}textarea{flex:1;min-width:180px}img{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}',
};
