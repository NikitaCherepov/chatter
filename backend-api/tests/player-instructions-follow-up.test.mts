import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `chatter-follow-up-${process.pid}-${Date.now()}.sqlite`);
process.env.API_DB_PATH = dbPath;
const { db } = await import('../src/db.js');
const prefs = await import('../src/services/player-instructions.js');
const memory = await import('../src/services/memory-foundation.js');
const chats = await import('../src/services/chats.js');
try {
  db.prepare("INSERT INTO users(id,name,language,status) VALUES (91,'Owner','en','approved'),(92,'Other','en','approved')").run();
  const persona = memory.createPersona(91,'Persona');
  memory.setActivePersona(91,persona.id);
  const chatId = chats.createUserChat(91,'Chat');
  await chats.appendChatMessage(91,chatId,'user','Original context');
  const target = {scope:'chat' as const,target_id:chatId};
  prefs.setPlayerInstructions(91,target,'Active instructions');
  const form = {id:'initial',title:'Initial questions',questions:[{id:'style',type:'text',label:'Preferred style?'}]};
  const extraForm = {id:'extra',title:'Clarifications',questions:[{id:'examples',type:'text',label:'Which examples?'}]};
  const parent = await prefs.createPlayerSurvey(91,{...target,model_id:'chosen-model',question_count:5,include_history:true,personalize:true},async()=>({
    text:JSON.stringify(form),toolCalls:[{tool:'read_memory',args:{memory_id:'example'},result:'Explicit user preference from memory'}],
  }));
  await assert.rejects(()=>prefs.followUpPlayerSurvey(91,parent.id,async()=>JSON.stringify(extraForm)),/survey_not_answered/);
  await assert.rejects(()=>prefs.followUpPlayerSurvey(92,parent.id,async()=>JSON.stringify(extraForm)),/survey_not_found/);
  await prefs.answerPlayerSurvey(91,parent.id,{style:'Concise'},async()=> 'First draft');
  const calls:any[]=[];
  for (const invalid of [null,123,'x'.repeat(2001)]) {
    await assert.rejects(()=>prefs.followUpPlayerSurvey(91,parent.id,async()=>JSON.stringify(extraForm),invalid),/bad_survey_request/);
  }
  const follow = await prefs.followUpPlayerSurvey(91,parent.id,async(userId,model,system,input,options)=>{
    calls.push({userId,model,system,input:JSON.parse(input),options});return JSON.stringify(extraForm);
  },'  More about examples  ');
  assert.equal(calls[0].input.follow_up_request,'More about examples');
  assert.match(calls[0].system,/prioritize the topics the user explicitly asks/);
  assert.notEqual(follow.id,parent.id);
  assert.equal(follow.answers,null);
  assert.equal(follow.draft,null);
  assert.equal(calls[0].model,'chosen-model');
  assert.deepEqual(calls[0].options,{stage:'questionnaire',personalize:false});
  assert.match(calls[0].system,/identify meaningful gaps/);
  assert.deepEqual(calls[0].input.previous_rounds,[{questionnaire:parent.questionnaire,answers:{style:'Concise'}}]);
  assert.equal(calls[0].input.history[0].content,'Original context');
  assert.equal(calls[0].input.tool_evidence[0].result,'Explicit user preference from memory');
  assert.equal(calls[0].input.question_count,5);
  assert.equal(calls[0].input.previous_draft,'First draft');
  assert.equal(prefs.getPlayerInstructions(91,target).text,'Active instructions');
  let finalInput:any;
  await prefs.answerPlayerSurvey(91,follow.id,{examples:'Code examples'},async(_u,_m,system,input)=>{
    assert.match(system,/latest explicit answer wins/);finalInput=JSON.parse(input);return 'Combined draft';
  });
  assert.equal(finalInput.previous_rounds[0].answers.style,'Concise');
  assert.equal(finalInput.follow_up_request,'More about examples','the focus is retained for final drafting');
  assert.match(finalInput.answers,/Code examples/);
  const next = await prefs.followUpPlayerSurvey(91,follow.id,async(_u,_m,_s,input)=>{
    const context=JSON.parse(input);
    assert.equal(context.previous_rounds.length,2);
    assert.equal(context.previous_rounds[1].request,'More about examples');
    assert.equal(context.follow_up_request,'','blank brief keeps automatic gap selection');
    return JSON.stringify(extraForm);
  });
  assert.equal(prefs.listPlayerSurveys(91,target).length,3);
  await assert.rejects(()=>prefs.followUpPlayerSurvey(91,parent.id,async()=>{throw new Error('provider_failed');}),/provider_failed/);
  assert.equal(prefs.listPlayerSurveys(91,target).length,3,'no empty survey on failure');
  assert.equal(prefs.listPlayerSurveys(91,target).find(s=>s.id===parent.id)?.draft,'First draft');
  let release!:()=>void;
  const gate = new Promise<void>(resolve=>{release=resolve;});
  const pending = prefs.followUpPlayerSurvey(91,parent.id,async()=>{await gate;return JSON.stringify(extraForm);});
  await assert.rejects(()=>prefs.followUpPlayerSurvey(91,parent.id,async()=>JSON.stringify(extraForm)),/survey_busy/);
  release();await pending;
  prefs.applyPlayerSurvey(91,follow.id,'Combined draft');
  assert.equal(prefs.getPlayerInstructions(91,target).text,'Combined draft');
  prefs.deletePlayerSurvey(91,parent.id);
  assert.equal(prefs.listPlayerSurveys(91,target).find(s=>s.id===next.id)?.questionnaire.title,'Clarifications','later rounds are independent saved snapshots');
  console.log('follow-up questions: ownership, original context, all rounds, explicit apply, failures and concurrency passed');
} finally {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath+suffix); } catch {} }
}
