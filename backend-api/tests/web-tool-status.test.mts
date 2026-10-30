import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {getWebToolStatus} = require('../src/services/web-tool-status.ts');
const ru = JSON.parse(fs.readFileSync(new URL('../src/i18n/locales/ru/translation.json', import.meta.url),'utf8'));
const page = fs.readFileSync(new URL('../src/services/ai.ts', import.meta.url),'utf8');
const start = page.indexOf('const getToolUserMessage =');
const end = page.indexOf('\nexport const sendMessageThroughAi',start);
const ts = await import('typescript');
const code = ts.transpileModule(page.slice(start,end)+'\nglobalThis.statusMessage = getToolUserMessage;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const context:any = {
  getWebToolStatus,
  translateForLanguage: (_:unknown,key:string,values:Record<string,string>={}) => key.split('.').reduce((v,k)=>v?.[k],ru)?.replace(/\{\{(\w+)\}\}/g,(_:string,k:string)=>values[k]??''),
  hasBackendTranslation: (key:string) => Boolean(key.split('.').reduce((v,k)=>v?.[k],ru)),
};
vm.createContext(context);vm.runInContext(code,context);
assert.equal(context.statusMessage('ru','search_web','{"query":"Томское деревянное зодчество"}'),'Ищу «Томское деревянное зодчество»');
assert.equal(context.statusMessage('ru','read_webpage','{"url":"https://example.com/tomsk"}'),'Читаю https://example.com/tomsk');
assert.equal(context.statusMessage('ru','read_webpage','{}'),'Читаю страницу…');
assert.equal(context.statusMessage('ru','generate_image','{}'),ru.toolStatus.generate_image);
assert.equal(getWebToolStatus('save_note',{query:'Unrelated'}),null);
assert.equal(getWebToolStatus('search_web','invalid'),null);
assert.equal(getWebToolStatus('read_webpage',{url:12}),null);
assert.deepEqual(getWebToolStatus('web_search',{query:'  Томск  ',secret:'never displayed'}),{key:'toolStatus.searchQuery',values:{query:'Томск'}});
console.log('PASS: actual tool status formatter shows the query/URL before execution, with safe fallbacks');
