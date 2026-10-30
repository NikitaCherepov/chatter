import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const ts=require('../node_modules/typescript');
const i18next=require('../node_modules/i18next');
const sourceRoot=fileURLToPath(new URL('../../backend-api/src/services/',import.meta.url));
const localesRoot=fileURLToPath(new URL('../src/renderer/i18n/locales/',import.meta.url));
const ids=new Set<string>();
function scan(directory:string){
 for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  const file=path.join(directory,entry.name);
  if(entry.isDirectory()){scan(file);continue;}
  if(!entry.name.endsWith('.ts'))continue;
  const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
  function visit(node:any){
   if(ts.isObjectLiteralExpression(node)){
    const fields=new Map(node.properties.filter(ts.isPropertyAssignment).map((p:any)=>[p.name.getText(ast).replace(/['"]/g,''),p.initializer]));
    const name:any=fields.get('name');
    if(name&&ts.isStringLiteral(name)&&fields.has('description')&&(fields.has('parameters')||fields.has('input_schema')))ids.add(name.text);
   }
   ts.forEachChild(node,visit);
  }
  visit(ast);
 }
}
scan(sourceRoot);
const translations:Record<string,any>={};
for(const lang of fs.readdirSync(localesRoot)){
 if(!fs.statSync(path.join(localesRoot,lang)).isDirectory())continue;
 const data=JSON.parse(fs.readFileSync(path.join(localesRoot,lang,'translation.json'),'utf8'));
 translations[lang]=data;
 assert.ok(data.toolActivity.labels.readPage,`${lang}: missing page-reading label`);
 assert.ok(data.toolActivity.names.read_webpage,`${lang}: missing read_webpage title`);
}
for(const lang of ['ru','en']){
 for(const id of ids)assert.ok(translations[lang].toolActivity.names[id],`${lang}: missing title for ${id}`);
}
for(const lang of Object.keys(translations)){
 const i18n=i18next.createInstance();
 await i18n.init({lng:lang,fallbackLng:'en',resources:{[lang]:{translation:translations[lang]},en:{translation:translations.en}}});
 assert.equal(i18n.t('toolActivity.names.read_webpage'),translations[lang].toolActivity.names.read_webpage);
 assert.equal(i18n.t('toolActivity.names.get_user_time'),lang==='ru'?'Текущее время':'Current time');
 assert.equal(i18n.t('toolActivity.names.future_tool',{defaultValue:'future_tool'}),'future_tool');
}
console.log(`PASS: ${ids.size} tool IDs have Russian/English titles; page reading is translated in ${Object.keys(translations).length} languages, including fallback behavior`);
