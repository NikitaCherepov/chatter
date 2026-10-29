'use client';
import { Fragment, FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { formatDateTime } from '../../../lib/formatDate';
import { Card } from '../../ui/Card/Card';
import { Select } from '../../ui/Select/Select';
import { ConfirmModal } from '../../ui/ConfirmModal/ConfirmModal';
import s from './ModelApiPage.module.css';

type User = {id:number;name:string;is_admin:number;role:string};
type Model = {id:string;name:string};
type Key = {id:number;name:string;owner_name:string;owner_user_id:number;key_prefix:string;models:string[];revoked_at:string|null;last_used_at:string|null;request_count:number;total_tokens:number;cost_usd:number;month_cost_usd:number;unknown_cost_count:number};

export function ModelApiPage() {
  const {t,i18n}=useTranslation();
  const [keys,setKeys]=useState<Key[]>([]), [users,setUsers]=useState<User[]>([]), [models,setModels]=useState<Model[]>([]);
  const [owner,setOwner]=useState(''), [name,setName]=useState(''), [selected,setSelected]=useState<string[]>([]), [base,setBase]=useState('');
  const [secret,setSecret]=useState(''), [pending,setPending]=useState(false), [loadingModels,setLoadingModels]=useState(false), [message,setMessage]=useState(''), [revoke,setRevoke]=useState<Key|null>(null);
  const [editingId,setEditingId]=useState<number|null>(null), [editModels,setEditModels]=useState<Model[]>([]), [editSelected,setEditSelected]=useState<string[]>([]);
  const [editLoading,setEditLoading]=useState(false), [editSaving,setEditSaving]=useState(false), [editError,setEditError]=useState('');
  const [editLoaded,setEditLoaded]=useState(false);
  const editingKey=keys.find(key=>key.id===editingId);
  const load=useCallback(async()=>{const result=await api<{keys:Key[]}>('/api/model-api/keys');setKeys(result.keys);},[]);
  useEffect(()=>{
    const direct=Boolean(window.location.port&&window.location.port!=='443');
    setBase(direct?`${window.location.protocol}//${window.location.hostname}:3050/v1`:`${window.location.origin}/backend/v1`);
    void Promise.all([load(),api<{users:User[]}>('/api/model-access-users').then(result=>setUsers(result.users))]).catch(()=>setMessage(t('modelApi.failed')));
  },[load,t]);
  useEffect(()=>{
    let cancelled=false;setModels([]);setSelected([]);
    if(!owner)return;
    setLoadingModels(true);
    void api<{models:Model[]}>(`/api/model-api/models?owner_user_id=${encodeURIComponent(owner)}`).then(result=>{if(!cancelled)setModels(result.models);}).catch(()=>{if(!cancelled)setMessage(t('modelApi.failed'));}).finally(()=>{if(!cancelled)setLoadingModels(false);});
    return()=>{cancelled=true;};
  },[owner,t]);
  useEffect(()=>{
    let cancelled=false;
    setEditError('');setEditModels([]);setEditLoaded(false);
    if(!editingKey)return;
    setEditSelected(editingKey.models);setEditLoading(true);
    void api<{models:Model[]}>(`/api/model-api/models?owner_user_id=${encodeURIComponent(editingKey.owner_user_id)}`)
      .then(result=>{if(!cancelled){setEditModels(result.models);setEditLoaded(true);}})
      .catch(()=>{if(!cancelled)setEditError(t('modelApi.failed'));})
      .finally(()=>{if(!cancelled)setEditLoading(false);});
    return()=>{cancelled=true;};
  },[editingId,editingKey?.owner_user_id,t]);
  function toggleSettings(key:Key){
    if(key.revoked_at||editSaving)return;
    setEditingId(current=>current===key.id?null:key.id);
  }
  async function saveModels(){
    if(!editingKey||editSaving||editLoading||!editLoaded)return;
    setEditSaving(true);setEditError('');
    try{
      const result=await api<{id:number;models:string[]}>(`/api/model-api/keys/${editingKey.id}`,{method:'PATCH',body:JSON.stringify({models:editSelected})});
      setKeys(previous=>previous.map(key=>key.id===result.id?{...key,models:result.models}:key));
      setMessage(t('modelApi.modelsSaved'));setEditingId(null);
    }catch{setEditError(t('modelApi.failed'));}finally{setEditSaving(false);}
  }
  async function create(event:FormEvent){
    event.preventDefault();if(!owner||!selected.length||pending)return;setPending(true);setSecret('');setMessage('');
    try{const result=await api<{key:string}>('/api/model-api/keys',{method:'POST',body:JSON.stringify({name,owner_user_id:Number(owner),models:selected})});setSecret(result.key);setName('');await load();}
    catch{setMessage(t('modelApi.failed'));}finally{setPending(false);}
  }
  async function copy(value:string){try{await navigator.clipboard.writeText(value);setMessage(t('modelApi.copied'));}catch{setMessage(t('modelApi.copyFailed'));}}
  async function confirmRevoke(){
    if(!revoke||pending)return;setPending(true);
    try{await api(`/api/model-api/keys/${revoke.id}`,{method:'DELETE'});setSecret('');setRevoke(null);setEditingId(null);setMessage(t('modelApi.revoked'));await load();}
    catch{setMessage(t('modelApi.failed'));}finally{setPending(false);}
  }
  const money=(value:number)=>new Intl.NumberFormat(i18n.language,{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:6}).format(value);
  const number=(value:number)=>new Intl.NumberFormat(i18n.language).format(value);
  const example = [
    `curl "${base.replace(/\/$/,'')}/chat/completions" \\`,
    '  -H "Authorization: Bearer YOUR_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '${JSON.stringify({model:selected[0]||models[0]?.id||'MODEL_ID',messages:[{role:'user',content:'Hello'}],stream:true},null,2)}'`,
  ].join('\n');
  return <div className={s.stack}>
    <Card title={t('modelApi.createTitle')} description={t('modelApi.createHelp')}>
      <form className={s.form} onSubmit={create}>
        <label>{t('modelApi.name')}<input value={name} onChange={e=>setName(e.target.value)} maxLength={100} required autoComplete="off" /></label>
        <label>{t('modelApi.owner')}<Select value={owner} onChange={setOwner} options={users.map(user=>({value:String(user.id),label:`${user.name||user.id} · #${user.id}`}))} placeholder={t('modelApi.chooseOwner')} searchable disabled={pending} aria-label={t('modelApi.owner')} /></label>
        <label className={s.wide}>{t('modelApi.models')}<Select value="" onChange={()=>{}} selectedValues={selected} onSelectionChange={setSelected} options={models.map(model=>({value:model.id,label:model.name,hint:model.id}))} placeholder={t(loadingModels?'modelApi.loading':'modelApi.chooseModels')} searchable disabled={!owner||loadingModels||pending} aria-label={t('modelApi.models')} /></label>
        <p className={s.help}>{t('modelApi.ownerHelp')}</p>
        <button type="submit" disabled={pending||!name.trim()||!selected.length||!owner}>{t(pending?'modelApi.working':'modelApi.create')}</button>
      </form>
      {secret&&<div className={s.secret} role="status"><strong>{t('modelApi.oneTime')}</strong><div className={s.copy}><input aria-label={t('modelApi.secret')} value={secret} readOnly autoComplete="off" spellCheck={false}/><button type="button" onClick={()=>void copy(secret)}>{t('modelApi.copy')}</button><button type="button" className="buttonSecondary" onClick={()=>setSecret('')}>{t('modelApi.hide')}</button></div></div>}
      {message&&<p role="status">{message}</p>}
    </Card>
    <Card title={t('modelApi.connect')} description={t('modelApi.connectHelp')}>
      <label className={s.copy}>{t('modelApi.baseUrl')}<input value={base} onChange={e=>setBase(e.target.value)} aria-label={t('modelApi.baseUrl')}/><button type="button" onClick={()=>void copy(base)}>{t('modelApi.copy')}</button></label>
      <p className={s.help}>{t('modelApi.urlHelp')}</p><pre className={s.code}><code>{example}</code></pre><button type="button" className="buttonSecondary" onClick={()=>void copy(example)}>{t('modelApi.copyExample')}</button>
    </Card>
    <Card title={t('modelApi.keys')} description={t('modelApi.costHelp')}>
      <button type="button" className="buttonSecondary" onClick={()=>void load().catch(()=>setMessage(t('modelApi.failed')))}>{t('modelApi.refresh')}</button>
      <div className={s.table}><table><thead><tr>{['key','models','requests','tokens','month','total','lastUsed','actions'].map(label=><th key={label}>{t(`modelApi.${label}`)}</th>)}</tr></thead><tbody>{keys.map(key=><Fragment key={key.id}><tr className={!key.revoked_at?s.keyRow:undefined} onClick={event=>{if(!(event.target as HTMLElement).closest('button,a,input,label'))toggleSettings(key);}}>
        <td>{key.revoked_at?<strong>{key.name}</strong>:<button type="button" className={s.keyButton} onClick={()=>toggleSettings(key)} aria-expanded={editingId===key.id} aria-controls={`model-api-settings-${key.id}`} disabled={editSaving}>{key.name}</button>}<small>{key.key_prefix}</small><small>{key.owner_name||`#${key.owner_user_id}`}</small>{key.revoked_at&&<small>{t('modelApi.revoked')}</small>}</td>
        <td>{key.models.map(id=><code className={s.model} key={id}>{id}</code>)}</td>
        <td>{number(key.request_count)}</td><td>{number(key.total_tokens)}</td><td>{money(key.month_cost_usd)}</td><td>{money(key.cost_usd)}{key.unknown_cost_count>0&&<small>{t('modelApi.unknown',{count:key.unknown_cost_count})}</small>}</td>
        <td>{formatDateTime(key.last_used_at,i18n.language)}</td><td>{!key.revoked_at&&<button type="button" className="buttonSecondary" disabled={editSaving} onClick={()=>setRevoke(key)}>{t('modelApi.revoke')}</button>}</td>
      </tr>{editingId===key.id&&!key.revoked_at&&<tr><td colSpan={8} className={s.settingsCell}><div id={`model-api-settings-${key.id}`} className={s.settings} role="region" aria-label={t('modelApi.settingsTitle',{name:key.name})}>
        <strong>{t('modelApi.settingsTitle',{name:key.name})}</strong><p className={s.help}>{t('modelApi.editHelp')}</p>
        <Select value="" onChange={()=>{}} selectedValues={editSelected} onSelectionChange={setEditSelected} options={[
          ...editModels.map(model=>({value:model.id,label:model.name,hint:model.id})),
          ...key.models.filter(id=>!editModels.some(model=>model.id===id)).map(id=>({value:id,label:id,hint:t('modelApi.unavailable'),disabled:!editSelected.includes(id)})),
        ]} placeholder={t(editLoading?'modelApi.loading':'modelApi.chooseModels')} searchable disabled={editLoading||editSaving||!editLoaded} aria-label={t('modelApi.editModels')} />
        {editError&&<p role="alert">{editError}</p>}
        <div className={s.editActions}><button type="button" disabled={editLoading||editSaving||!editLoaded||editSelected.some(id=>!editModels.some(model=>model.id===id))} onClick={()=>void saveModels()}>{t(editSaving?'modelApi.working':'modelApi.saveModels')}</button><button type="button" className="buttonSecondary" disabled={editSaving} onClick={()=>setEditingId(null)}>{t('modelApi.cancel')}</button></div>
      </div></td></tr>}</Fragment>)}</tbody></table>{!keys.length&&<p className={s.help}>{t('modelApi.empty')}</p>}</div>
    </Card>
    {revoke&&<ConfirmModal title={t('modelApi.revoke')} onClose={()=>{if(!pending)setRevoke(null);}} actions={[{label:t('modelApi.cancel'),onClick:()=>setRevoke(null),disabled:pending},{label:t('modelApi.revoke'),variant:'danger',onClick:confirmRevoke,disabled:pending}]}>{t('modelApi.confirm',{name:revoke.name})}</ConfirmModal>}
  </div>;
}
