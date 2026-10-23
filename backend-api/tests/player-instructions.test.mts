import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dbPath = path.join(os.tmpdir(), `chatter-player-instructions-${process.pid}-${Date.now()}.sqlite`);
process.env.API_DB_PATH = dbPath;
const { db } = await import('../src/db.js');
const memory = await import('../src/services/memory-foundation.js');
const chats = await import('../src/services/chats.js');
const prefs = await import('../src/services/player-instructions.js');
const { importSillyTavernPersonas } = await import('../src/services/persona-import.js');
const { buildPlayerInstructions } = require('../src/services/player-instructions-prompt.ts');
try {
  db.prepare("INSERT INTO users(id,name,language,status,preferred_model) VALUES (81,'Player','en','approved','selected-model'), (82,'Other','en','approved',NULL), (83,'Member','en','approved',NULL)").run();
  const persona = memory.createPersona(81, 'Player persona', 'Brief biography', 'Secret persona facts', true, 'General preference');
  memory.setActivePersona(81, persona.id);
  assert.equal(memory.getPersona(81, persona.id)?.user_instructions, 'General preference');
  assert.equal(memory.createPersona(81, 'Old-style call').user_instructions, '', 'old callers/imports default to empty');
  assert.throws(() => memory.updatePersona(81, persona.id, { user_instructions: 'x'.repeat(12001) }), /bad_user_instructions/);
  const chatId = chats.createUserChat(81, 'Story');
  const otherChat = chats.createUserChat(81, 'Unrelated');
  const target = { scope: 'chat' as const, target_id: chatId };
  const personaTarget = { scope: 'persona' as const, target_id: persona.id };
  prefs.setPlayerInstructions(81, target, 'Local preference', false);
  assert.equal(memory.getChatMemorySettings(81, chatId).use_user_instructions, 0);
  assert.equal(memory.resolvePersonaForChat(81, chatId).persona.user_instructions, 'General preference');
  assert.throws(() => prefs.getPlayerInstructions(82, target), /chat_not_found/);
  assert.throws(() => prefs.getPlayerInstructions(82, personaTarget), /persona_not_found/);
  db.prepare("INSERT INTO chat_members(chat_id,user_id,role) VALUES (?,83,'member')").run(chatId);
  assert.equal(prefs.getPlayerInstructions(83, target).text, '', 'room members have their own preferences');
  prefs.setPlayerInstructions(83, target, 'Member preference', true);
  assert.equal(prefs.getPlayerInstructions(81, target).text, 'Local preference');
  const prompt = buildPlayerInstructions('General preference', 'Local preference');
  assert.match(prompt, /GENERAL PREFERENCES/); assert.match(prompt, /CHAT PREFERENCES/); assert.equal(buildPlayerInstructions('',''), '');
  await chats.appendChatMessage(81, chatId, 'user', 'Current conversation');
  await chats.appendChatMessage(81, otherChat, 'user', 'Unrelated conversation secret');
  const noHistory = prefs.surveyInput(81, target, {});
  assert.deepEqual(noHistory.input.history, []);
  assert.ok(!JSON.stringify(noHistory.input).includes('Secret persona facts'));
  const withHistory = prefs.surveyInput(81, target, { include_history: true });
  assert.ok(JSON.stringify(withHistory.input).includes('Current conversation'));
  assert.ok(!JSON.stringify(withHistory.input).includes('Unrelated conversation secret'));
  db.prepare('UPDATE users SET active_chat_id = ? WHERE id = 81').run(chatId);
  const generalInput = prefs.surveyInput(81, personaTarget, {});
  assert.equal(generalInput.chatId, null, 'general settings must not inherit the active chat');
  assert.equal('character' in generalInput.input, false, 'general settings must not inherit a chat character');
  assert.deepEqual(generalInput.input.history, []);
  assert.throws(() => prefs.surveyInput(81, personaTarget, { include_history: true }), /bad_survey_request/);
  assert.throws(() => prefs.surveyInput(81, personaTarget, { chat_id: chatId }), /bad_survey_request/);
  const form = { id:'preferences', title:'Story preferences', questions:[{id:'pace',type:'single',label:'Pacing?',required:true,options:['Slow','Fast']},{id:'notes',type:'text',label:'Anything else?'}] };
  const calls: any[] = [];
  const complete = async (userId: number, modelId: string | null, system: string, input: string, options?: unknown) => {
    calls.push({userId,modelId,system,input:JSON.parse(input),options});
    return calls.length === 1 ? JSON.stringify(form) : 'Slow story; preserve unrelated wishes.';
  };
  const before = db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n;
  const survey = await prefs.createPlayerSurvey(81, {...target, brief:'Pacing', include_history:true, personalize:true, model_id:'chosen-model'}, complete);
  assert.equal(survey.personalize, true);
  assert.deepEqual(calls[0].options, {personalize:true,stage:'questionnaire'});
  await assert.rejects(() => prefs.createPlayerSurvey(81,{...target,personalize:'yes'},complete), /bad_survey_request/);
  assert.equal(calls[0].modelId, 'chosen-model');
  assert.equal(prefs.listPlayerSurveys(81,target).length, 1);
  const storedInput = JSON.parse(db.prepare('SELECT input_json FROM player_instruction_surveys WHERE id=?').get(survey.id).input_json);
  assert.equal(storedInput.history, undefined, 'do not keep a duplicate conversation snapshot');
  await assert.rejects(() => prefs.answerPlayerSurvey(82,survey.id,{pace:'Slow'},complete), /survey_not_found/);
  await assert.rejects(() => prefs.answerPlayerSurvey(81,survey.id,{pace:'Wrong'},complete), /questionnaire_invalid/);
  const answered = await prefs.answerPlayerSurvey(81,survey.id,{pace:'Slow',notes:'More dialogue'},complete);
  assert.equal(calls[1].modelId,'chosen-model'); assert.equal(calls[1].input.history,undefined);
  assert.deepEqual(calls[1].options,{stage:'instructions'},'drafting must not reopen tools');
  assert.equal(prefs.getPlayerInstructions(81,target).text,'Local preference','draft must not apply itself');
  assert.equal(answered.draft,'Slow story; preserve unrelated wishes.');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n,before,'utility must not write the chat');
  await prefs.answerPlayerSurvey(81,survey.id,{pace:'Slow',notes:'More dialogue'},complete);
  assert.equal(calls.length,2,'retry must not charge another generation after success');
  await assert.rejects(() => prefs.answerPlayerSurvey(81,survey.id,{pace:'Fast'},complete), /survey_already_answered/);
  prefs.applyPlayerSurvey(81,survey.id,'Edited and approved instructions');
  assert.equal(prefs.getPlayerInstructions(81,target).text,'Edited and approved instructions');
  assert.equal(prefs.getPlayerInstructions(81,target).enabled,false,'applying must not silently enable instructions');
  assert.equal(memory.getPersona(81,persona.id)?.core_memory,'Secret persona facts');
  prefs.setPlayerInstructions(81,target,'Changed elsewhere');
  assert.throws(() => prefs.applyPlayerSurvey(81,survey.id,'Overwrite'), /instructions_changed/);
  assert.throws(() => prefs.deletePlayerSurvey(81,survey.id,true), /instructions_changed/);
  prefs.deletePlayerSurvey(81,survey.id,false);
  assert.equal(prefs.getPlayerInstructions(81,target).text,'Changed elsewhere');
  const completeAgain = async (_u: number, _m: string|null, system: string) => system.startsWith('You design') ? JSON.stringify(form) : 'New instructions';
  const personal = await prefs.createPlayerSurvey(81,personaTarget,completeAgain);
  assert.equal(personal.personalize,false,'personalization is opt-in');
  assert.equal(db.prepare('SELECT chat_id FROM player_instruction_surveys WHERE id=?').get(personal.id).chat_id,null);
  assert.equal(personal.model_id,'selected-model','persona uses selected profile model');
  await prefs.answerPlayerSurvey(81,personal.id,{pace:'Slow'},completeAgain);
  prefs.applyPlayerSurvey(81,personal.id,'Approved general instructions');
  prefs.deletePlayerSurvey(81,personal.id,true);
  assert.equal(prefs.getPlayerInstructions(81,personaTarget).text,'General preference','restore previous note only when it has not been edited');
  const backup = Buffer.from(JSON.stringify({personas:{'old.png':'Imported'},persona_descriptions:{'old.png':{description:'Imported biography'}}})).toString('base64');
  const imported = importSillyTavernPersonas(81,backup).personas[0];
  assert.equal(imported.user_instructions,'');
  memory.updatePersona(81,imported.id,{user_instructions:'Keep my preferences'});
  assert.equal(importSillyTavernPersonas(81,backup).personas[0].user_instructions,'Keep my preferences','re-import must not erase existing instructions');
  const fork = chats.forkChat(81,chatId,chats.getChatMessages(81,chatId)[0].id);
  assert.equal(prefs.getPlayerInstructions(81,{scope:'chat',target_id:fork.chat_id}).text,'Changed elsewhere');
  assert.equal(prefs.getPlayerInstructions(81,{scope:'chat',target_id:fork.chat_id}).enabled,false);
  const { runPreferenceAgent } = await import('../src/services/player-instructions-agent.js');
  const configs: any[] = [];
  const fakeRunner = async (params: any) => { configs.push(params); return {finalText:' result ',aborted:false,toolCalls:[],iterations:[],usage:null,usageCalls:[]}; };
  assert.equal(await runPreferenceAgent(81,'chosen-model','System','{}',{},fakeRunner),'result');
  assert.equal(configs[0].preferredModel,'chosen-model');
  assert.equal(configs[0].maxLoops,1); assert.deepEqual(configs[0].tools,[]);
  await runPreferenceAgent(81,'chosen-model','System','{}',{personalize:true},fakeRunner);
  assert.equal(configs[1].maxLoops,16);
  assert.deepEqual(configs[1].tools.map((tool:any)=>tool.definition.function.name),['list_recent_chats','search_chat_history','read_chat_context','search_cold_memory','read_memory']);
  assert.match(configs[1].systemPrompt,/explicitly enabled personalization/);
  await runPreferenceAgent(81,null,'System','{}',{personalize:true,stage:'instructions'},fakeRunner);
  assert.deepEqual(configs[2].tools,[]);
  assert.doesNotMatch(configs[2].systemPrompt,/explicitly enabled personalization/);
  const previousContext = db.prepare('SELECT max_context_tokens FROM users WHERE id=81').get().max_context_tokens;
  db.prepare('UPDATE users SET max_context_tokens=1000 WHERE id=81').run();
  await assert.rejects(()=>runPreferenceAgent(81,null,'System','word '.repeat(3000),{},fakeRunner),/survey_context_too_large/);
  db.prepare('UPDATE users SET max_context_tokens=? WHERE id=81').run(previousContext);
  await assert.rejects(()=>runPreferenceAgent(81,null,'System','{}',{},async p=>({...await fakeRunner(p),aborted:true})),/survey_aborted/);
  await assert.rejects(()=>runPreferenceAgent(81,null,'System','{}',{},async p=>({...await fakeRunner(p),finalText:''})),/empty_survey_response/);
  // Exercise the real runAgent -> runSubagent path with a fake provider, never a paid call.
  const { initSubagentRunner } = await import('../src/services/subagents/runner.js');
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = 81').run();
  const providerRequests: any[] = [];
  let step = 0;
  initSubagentRunner({
    runCompletion: async (_mode, payload) => {
      providerRequests.push(structuredClone(payload));
      const message = step++ === 0
        ? {content:null,tool_calls:[{id:'read1',type:'function',function:{name:'list_recent_chats',arguments:'{"limit":2}'}}]}
        : {content:JSON.stringify(form)};
      return {response:{choices:[{message}]}};
    },
    runTool: async () => { throw new Error('No shared or write tools permitted'); },
    throwIfAborted: signal => signal?.throwIfAborted(),
    withAbort: async promise => promise,
    toolDefinitions: [],
    normalizeTokenUsage: () => ({prompt_tokens:0,completion_tokens:0,total_tokens:0,cache_hit_tokens:0,cache_miss_tokens:0,reasoning_tokens:0}),
  });
  const runnerText = await runPreferenceAgent(81,null,'Return questionnaire JSON','{}',{personalize:true});
  assert.deepEqual(JSON.parse(runnerText),form);
  assert.equal(providerRequests.length,2,'real runner executes tools and then asks for final result');
  assert.equal(providerRequests[0].tools.length,5);
  assert.ok(providerRequests[1].messages.some((message:any)=>message.role==='tool'&&message.content.includes('chat_id:')));
  providerRequests.length=0;
  await runPreferenceAgent(81,null,'Return instructions','{}',{stage:'instructions'});
  assert.equal(providerRequests.length,1);
  assert.equal(providerRequests[0].tools,undefined,'plain stage does not advertise tools');
  console.log('player instructions: persistence, privacy, no implicit active chat, opt-in read tools and real runner path passed');
} finally {
  db.close(); for(const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath+suffix); } catch {} }
}
// ai.ts initializes service timers; the isolated CLI test owns this process.
process.exit(0);
