import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const express=require('express');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'chatter-model-api-'));
process.env.API_DB_PATH=path.join(directory,'test.sqlite');process.env.ENCRYPTION_KEY='test-only-not-secret';
for(const key of ['TIMEWEB_API_KEY','TIMEWEB_LITE_API_KEY','TIMEWEB_VISION_API_KEY','TIMEWEB_LITE_VISION_API_KEY','TIMEWEB_PRO_ENDPOINTS','TIMEWEB_LITE_ENDPOINTS','MODELS_MANUAL'])process.env[key]='';
const received:any[]=[];let cancelled=0;
const upstream=http.createServer(async(req,res)=>{
  let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data);received.push(body);
  const mode=body.messages.at(-1)?.content;
  if(mode==='fail'){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'upstream-secret-do-not-leak',type:'bad_request'}}));return;}
  const usage={prompt_tokens:10,completion_tokens:5,total_tokens:15,prompt_tokens_details:{cached_tokens:2},cost:.00321};
  if(mode==='estimated')delete (usage as any).cost;
  if(body.stream){
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const chunk=(delta:any,finish_reason:any=null,index=0)=>({id:'upstream-id',object:'chat.completion.chunk',created:123,model:body.model,choices:[{index,delta,finish_reason}]});
    res.write('data: '+JSON.stringify(chunk({role:'assistant',content:'Hello'}))+'\n\n');
    if(mode==='wait') {req.on('close',()=>{cancelled++;});res.on('close',()=>{cancelled++;});return;}
    res.write('data: '+JSON.stringify(chunk({tool_calls:[{index:0,id:'call-1',type:'function',function:{name:'read',arguments:'{"a":'}}]}))+'\n\n');
    res.write('data: '+JSON.stringify(chunk({tool_calls:[{index:0,function:{arguments:'1}'},extra_content:{google:{thought_signature:'signed'}}}]}))+'\n\n');
    res.write('data: '+JSON.stringify(chunk({},'tool_calls'))+'\n\n');
    res.end('data: '+JSON.stringify({id:'upstream-id',object:'chat.completion.chunk',model:body.model,choices:[],usage})+'\n\ndata: [DONE]\n\n');
  }else{
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'upstream-id',object:'chat.completion',created:123,model:body.model,choices:Array.from({length:body.n||1},(_,index)=>({index,message:{role:'assistant',content:'Hello'},finish_reason:'stop'})),...(mode==='unknown'?{}:{usage})}));
  }
});
await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
const baseUrl='http://127.0.0.1:'+(upstream.address() as any).port+'/v1';
const {db}=await import('../src/db.js');
const settings=await import('../src/services/model-settings.js');
const intervals:any[]=[];const originalInterval=globalThis.setInterval;
globalThis.setInterval=((...args:any[])=>{const timer=(originalInterval as any)(...args);intervals.push(timer);return timer;}) as any;
const ai=await import('../src/services/ai.js');globalThis.setInterval=originalInterval;
const keys=await import('../src/services/model-api-keys.js');
const {createModelApiRouter,abortModelApiKeyRequests}=await import('../src/model-api.js');
const {setModelProvider}=await import('../src/services/token-quota.js');
const app=express();app.use('/v1',createModelApiRouter());const server=http.createServer(app);
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+(server.address() as any).port+'/v1';
try{
  db.prepare("INSERT INTO users(id,name,status,is_admin)VALUES(1,'Admin','approved',1),(2,'Other','approved',1)").run();
  const upstreamKey=settings.importModelKey('Test upstream','fake-provider-key');
  const model={id:'card-public',uniqueId:'public-id',model:'upstream-model',baseUrl,apiKeyId:upstreamKey,accessMode:'all',supportsTools:true};
  const restricted={...model,id:'card-private',uniqueId:'private-id',model:'private-upstream',accessMode:'selected',allowedUserIds:[1]};
  settings.updateModelSettings({proModels:[model],liteModels:[],manualModels:[model,restricted],visionModel:{id:'vision',uniqueId:'vision',model:'',baseUrl:'',apiKeyId:null}});ai.refreshConfiguredModels();
  setModelProvider('public-id',{pricingMode:'manual',inputPricePerMillion:1,outputPricePerMillion:2,coefficient:1});
  const created=keys.createModelApiKey({name:'Client',owner_user_id:1,models:['public-id']});
  const stored=db.prepare('SELECT * FROM model_api_keys WHERE id=?').get(created.id) as any;
  assert.ok(!JSON.stringify(stored).includes(created.key));assert.equal(stored.key_hash.length,64);
  assert.throws(()=>keys.createModelApiKey({name:'Bad',owner_user_id:2,models:['private-id']}));
  assert.throws(()=>keys.createModelApiKey({name:'Bad',owner_user_id:1,models:[]}));
  const headers={Authorization:'Bearer '+created.key,'Content-Type':'application/json'};
  const post=(body:any,key=created.key)=>fetch(base+'/chat/completions',{method:'POST',headers:{...headers,Authorization:'Bearer '+key},body:JSON.stringify(body)});
  assert.equal((await fetch(base+'/models')).status,401);
  assert.equal((await fetch(base+'/models?api_key='+created.key)).status,401);
  assert.equal((await fetch(base+'/models',{headers:{Authorization:'Bearer chatter_sk_invalid'}})).status,401);
  const listed=await(await fetch(base+'/models',{headers})).json() as any;assert.deepEqual(listed.data.map((m:any)=>m.id),['public-id']);
  const input={model:'public-id',messages:[{role:'system',content:'Only caller context'},{role:'user',content:'Hello'}],tools:[{type:'function',function:{name:'read',parameters:{type:'object',properties:{a:{type:'number'}}}}}],temperature:.2,n:2,response_format:{type:'json_object'}};
  let response=await post(input);assert.equal(response.status,200);let result=await response.json() as any;assert.equal(result.model,'public-id');assert.equal(result.choices.length,2);
  assert.deepEqual(received.at(-1).messages,input.messages);assert.deepEqual(received.at(-1).tools,input.tools);assert.equal(received.at(-1).temperature,.2);assert.equal(received.at(-1).model,'upstream-model');
  const usageRow=db.prepare('SELECT * FROM user_token_usage WHERE model_api_key_id=?').get(created.id) as any;assert.equal(usageRow.total_tokens,15);assert.equal(usageRow.actual_cost_usd,.00321);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n,0,'API calls must not create chat history');
  const before=received.length;assert.equal((await post({...input,model:'private-id'})).status,404);assert.equal(received.length,before);
  assert.equal((await post({...input,stream:'yes'})).status,400);assert.equal((await post({...input,messages:[]})).status,400);
  response=await fetch(base+'/chat/completions',{method:'POST',headers,body:'{bad'});assert.equal(response.status,400);assert.ok((await response.json() as any).error.code);
  const streaming={...input,stream:true,stream_options:{include_usage:true}};
  response=await post(streaming);const stream=await response.text();assert.match(response.headers.get('content-type')||'',/event-stream/);assert.ok(stream.endsWith('data: [DONE]\n\n'));
  const chunks=stream.split('\n\n').filter(s=>s.startsWith('data: {')).map(s=>JSON.parse(s.slice(6)));
  assert.ok(chunks.some(c=>c.choices?.[0]?.delta?.tool_calls?.[0]?.extra_content?.google?.thought_signature==='signed'));
  assert.ok(chunks.every(c=>c.model==='public-id'));assert.equal(chunks.at(-1).usage.total_tokens,15);
  response=await post({...streaming,stream_options:{include_usage:false}});assert.ok(!(await response.text()).includes('"usage"'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_token_usage WHERE model_api_key_id=?').get(created.id).n,3,'one charge per request, not per chunk');
  await(await post({...input,messages:[{role:'user',content:'unknown'}]})).text();
  response=await post({...input,messages:[{role:'user',content:'fail'}]});assert.equal(response.status,400);assert.ok(!(await response.text()).includes('upstream-secret'));
  const rows=keys.listModelApiKeys() as any[];assert.equal(rows[0].request_count,5);assert.equal(rows[0].unknown_cost_count,2);assert.ok(Math.abs(rows[0].cost_usd-.00321*3)<1e-10);assert.ok(!JSON.stringify(rows).includes('key_hash'));
  await(await post({...input,messages:[{role:'user',content:'estimated'}]})).text();
  const estimated=db.prepare('SELECT * FROM user_token_usage WHERE model_api_key_id=? ORDER BY id DESC LIMIT 1').get(created.id) as any;
  assert.equal(estimated.actual_cost_usd,null);assert.ok(estimated.estimated_cost_usd>0);
  const oldRequest=db.prepare('SELECT id FROM model_api_requests WHERE key_id=? ORDER BY rowid LIMIT 1').get(created.id) as any;
  db.prepare('UPDATE model_api_requests SET created_at=0 WHERE id=?').run(oldRequest.id);
  const totals=(keys.listModelApiKeys() as any[]).find(row=>row.id===created.id);assert.ok(totals.cost_usd>totals.month_cost_usd,'UTC monthly cost must exclude older requests');
  const otherKey=keys.createModelApiKey({name:'Other client',owner_user_id:2,models:['public-id']});
  response=await post({...input,messages:[{role:'user',content:'wait'}],stream:true});const reader=response.body!.getReader();await reader.read();
  keys.revokeModelApiKey(created.id);abortModelApiKeyRequests(created.id);
  for(;;){const chunk=await reader.read();if(chunk.done)break;}
  assert.equal((await post(input)).status,401);assert.equal((await post(input,otherKey.key)).status,200);
  const last=db.prepare('SELECT * FROM model_api_requests WHERE key_id=? ORDER BY rowid DESC LIMIT 1').get(created.id) as any;assert.equal(last.status,'aborted');assert.equal(last.usage_received,0);
  const waitBody={...input,messages:[{role:'user',content:'wait'}],stream:true};
  const concurrent=await Promise.all(Array.from({length:8},()=>post(waitBody,otherKey.key)));
  assert.ok(concurrent.every(reply=>reply.status===200));assert.equal((await post(waitBody,otherKey.key)).status,429);
  await Promise.all(concurrent.map(reply=>reply.body!.cancel()));
  for(let attempt=0;attempt<30;attempt++){
    if(!(db.prepare("SELECT 1 FROM model_api_requests WHERE key_id=? AND status='running'").get(otherKey.id)))break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM model_api_requests WHERE key_id=? AND status='running'").get(otherKey.id).n,0,'client disconnect must abort and clean up requests');
  db.prepare("UPDATE users SET status='banned' WHERE id=2").run();assert.equal((await post(input,otherKey.key)).status,401);
  console.log('PASS: real HTTP gateway/SDK adapter, hashed keys, model ACLs, normal+stream/tool metadata, usage/cost accounting, unknown cost, no chat context, malformed requests, revocation+abort and owner ban');
}finally{
  for(const timer of intervals)clearInterval(timer);
  server.closeAllConnections();upstream.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));
  db.close();fs.rmSync(directory,{recursive:true,force:true});
}
