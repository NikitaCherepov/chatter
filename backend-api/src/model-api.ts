import express from 'express';
import { createModelApiCompletion, ensureUtilityAiQuota, normalizeTokenUsage } from './services/ai.js';
import { withModelActor } from './services/model-access.js';
import { withChatGptActor } from './services/chatgpt-connections.js';
import { chargeTokens } from './services/token-quota.js';
import { beginModelApiRequest, finishModelApiRequest, isModelApiKeyActive, modelsForApiOwner, touchModelApiKey, validateModelApiKey } from './services/model-api-keys.js';

const active = new Map<number, Set<AbortController>>();
export function abortModelApiKeyRequests(id: number) { for (const controller of active.get(id) ?? []) controller.abort(); }
const apiError = (res: any, status: number, code: string, message: string, param: string | null = null) => res.status(status).json({ error: { message, type: status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'invalid_request_error', param, code } });
export function validateModelApiBody(body: any): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body';
  if (typeof body.model !== 'string' || !body.model || body.model.length > 200) return 'model';
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 10000) return 'messages';
  if (body.messages.some((m: any) => !m || !['system','developer','user','assistant','tool','function'].includes(m.role) || (m.content != null && typeof m.content !== 'string' && !Array.isArray(m.content)))) return 'messages';
  if (body.stream !== undefined && typeof body.stream !== 'boolean') return 'stream';
  if (body.stream_options !== undefined && (!body.stream || !body.stream_options || typeof body.stream_options !== 'object' || Array.isArray(body.stream_options))) return 'stream_options';
  if (body.n !== undefined && (!Number.isSafeInteger(body.n) || body.n < 1 || body.n > 8)) return 'n';
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 128)) return 'tools';
  const level = body.reasoning_effort ?? body.reasoning?.effort;
  if (level !== undefined && !['none','minimal','low','medium','high','xhigh','auto'].includes(level)) return 'reasoning_effort';
  return null;
}

/** Dedicated bearer auth. These keys never authenticate desktop/admin routes. */
export function createModelApiRouter() {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set({ 'Cache-Control':'no-store', 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type, Authorization', 'Access-Control-Allow-Methods':'GET, POST, OPTIONS' });
    if (_req.method === 'OPTIONS') return void res.sendStatus(204);
    next();
  });
  router.use((req: any, res, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
    const key = validateModelApiKey(match?.[1]);
    if (!key) return void apiError(res,401,'invalid_api_key','Invalid or revoked API key.');
    req.modelApiKey = key; next();
  });
  router.use(express.json({limit:'16mb'}));
  const available = (req: any) => modelsForApiOwner(req.modelApiKey.owner_user_id).filter(m => req.modelApiKey.models.includes(m.id));
  router.get('/models', (req, res) => res.json({object:'list',data:available(req).map(m=>({id:m.id,object:'model',created:0,owned_by:'chatter'}))}));
  router.get('/models/:id', (req, res) => {
    const model=available(req).find(m=>m.id===req.params.id);
    return model ? res.json({id:model.id,object:'model',created:0,owned_by:'chatter'}) : apiError(res,404,'model_not_found','Model is not available for this key.','model');
  });
  router.post('/chat/completions', async (req: any, res) => {
    const bad = validateModelApiBody(req.body);
    if (bad) return void apiError(res,400,'invalid_request',`Invalid ${bad}.`,bad);
    const key = req.modelApiKey, model = available(req).find(m=>m.id===req.body.model);
    if (!model) return void apiError(res,404,'model_not_found','Model is not available for this key.','model');
    const total = [...active.values()].reduce((sum,set)=>sum+set.size,0);
    if ((active.get(key.id)?.size ?? 0)>=8 || total>=64) return void apiError(res,429,'too_many_requests','Too many simultaneous requests.');
    const controller = new AbortController(), running=active.get(key.id) ?? new Set<AbortController>();
    running.add(controller); active.set(key.id,running);
    let id: string;
    try { id = beginModelApiRequest(key.id,model.id); }
    catch { running.delete(controller); if(!running.size)active.delete(key.id); return void apiError(res,503,'service_unavailable','Request accounting is unavailable.'); }
    let usage: any = null, provider: string | null = null, status = 'failed';
    const timeout=setTimeout(()=>controller.abort(),10*60_000);
    const heartbeat=req.body.stream?setInterval(()=>{
      if(res.destroyed||res.writableEnded||controller.signal.aborted)return;
      if(!res.headersSent){res.status(200).set({'Content-Type':'text/event-stream','X-Accel-Buffering':'no'});res.flushHeaders();}
      res.write(': keep-alive\n\n');
    },15_000):null;
    const disconnected=()=>{if(!res.writableEnded)controller.abort();};
    req.on('aborted',disconnected);res.on('close',disconnected);
    const sendChunk=(chunk: any)=>{
      if (!isModelApiKeyActive(key.id)) controller.abort();
      controller.signal.throwIfAborted();
      if (res.writableLength>8*1024*1024) {controller.abort();controller.signal.throwIfAborted();}
      if (chunk.usage && !req.body.stream_options?.include_usage && !chunk.choices?.length) return;
      if(!res.headersSent){res.status(200).set({'Content-Type':'text/event-stream','X-Accel-Buffering':'no'});res.flushHeaders();}
      const output = {...chunk};
      if(!req.body.stream_options?.include_usage) delete output.usage;
      res.write('data: '+JSON.stringify(output)+'\n\n');
    };
    try {
      await withModelActor({userId:key.owner.id,isAdmin:key.owner.is_admin===1||key.owner.role==='admin'},()=>withChatGptActor(key.owner.is_admin===1||key.owner.role==='admin',async()=>{
        ensureUtilityAiQuota(key.owner.id,model.id,'pro');
        touchModelApiKey(key.id);
        const result = await createModelApiCompletion(model.id,req.body,controller.signal,sendChunk,(raw,upstream)=>{usage=raw;provider=typeof upstream==='string'?upstream:null;});
        controller.signal.throwIfAborted();
        if(!isModelApiKeyActive(key.id)) {controller.abort();controller.signal.throwIfAborted();}
        status='completed';
        if(req.body.stream){ if(!res.headersSent)sendChunk({id:'chatcmpl-'+id,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:model.id,choices:[]});res.end('data: [DONE]\n\n'); }
        else res.json(result);
      }));
    } catch(error: any) {
      status=controller.signal.aborted?'aborted':'failed';
      const quota = /quota|limit_reached/.test(error?.message||'');
      const unsupported = error?.message==='chatgpt_unsupported_parameter';
      const httpStatus=quota?429:unsupported?400:controller.signal.aborted?499:[400,402,403,404,409,422,429].includes(error?.status)?error.status:502;
      const message=quota?'Account quota is exhausted.':unsupported?'This ChatGPT connection does not support one or more request parameters.':controller.signal.aborted?'Request cancelled.':'The upstream provider could not complete the request.';
      if(!res.destroyed){
        if(res.headersSent)res.end('data: '+JSON.stringify({error:{message,type:'server_error',code:'upstream_error'}})+'\n\n');
        else apiError(res,httpStatus,'request_failed',message);
      }
    } finally {
      clearTimeout(timeout);if(heartbeat)clearInterval(heartbeat);req.off('aborted',disconnected);res.off('close',disconnected);
      running.delete(controller);if(!running.size)active.delete(key.id);
      const known = usage && typeof usage==='object' && ['prompt_tokens','input_tokens','total_tokens','completion_tokens','output_tokens'].some(k=>typeof usage[k]==='number'&&Number.isFinite(usage[k])&&usage[k]>=0);
      if(known){const tokens=normalizeTokenUsage(usage);chargeTokens({
        userId:key.owner.id,modelApiKeyId:key.id,apiRequestId:id,route:'external-api',modelId:model.id,modelName:model.name,providerName:'external-api',
        promptTokens:tokens.prompt_tokens,completionTokens:tokens.completion_tokens,cacheHitTokens:tokens.cache_hit_tokens,cacheMissTokens:tokens.cache_miss_tokens,
        reasoningTokens:tokens.reasoning_tokens,totalTokens:tokens.total_tokens,aborted:status==='aborted',upstreamProviderSlug:provider,
        actualCostUsd:typeof usage.cost==='number'&&Number.isFinite(usage.cost)&&usage.cost>=0?usage.cost:null,
      });}
      try { finishModelApiRequest(id,status,Boolean(known)); }
      catch { console.warn('[model-api] could not finalize request accounting', {requestId:id}); }
    }
  });
  router.use((_req,res)=>apiError(res,404,'not_found','Unknown model API endpoint.'));
  router.use((error: any,_req: any,res: any,_next: any)=>apiError(res,error?.type==='entity.too.large'?413:400,'invalid_request','Invalid JSON request or request body too large.'));
  return router;
}
