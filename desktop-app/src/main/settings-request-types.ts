import type { ThemeSettingsState } from './settings-shell-types';

export type SettingsOperation = { id: string; label: string; mutation: boolean; requiresGesture: boolean; requiresConfirmation: boolean };
export type ThemeSettingsRequest = { requestId: string; method: 'settings'; sectionId: string; editorId: string; operation: string; params: Record<string, unknown> };
// One allowlist is shared by IPC validation and the trusted section handlers.
export const SETTINGS_REQUESTS: Record<string, Record<string, { key: string; mutation?: boolean; gesture?: boolean; confirm?: boolean }>> = {
  account: { getAccount: { key: 'settings.sections.account' }, changePassword: { key: 'settings.account.changePassword', mutation: true }, changeLogin: { key: 'settings.account.changeLogin', mutation: true } },
  memory: {
    getMemoryStatus: { key: 'memorySetupNotice.title' },
    listSpaces: { key: 'chat.memory.globalSettings.spaceLabel' }, createSpace: { key: 'chat.memory.globalSettings.createSpaceAction', mutation: true },
    activateSpace: { key: 'chat.memory.globalSettings.spaceLabel', mutation: true }, renameSpace: { key: 'common.edit', mutation: true }, deleteSpace: { key: 'common.delete', mutation: true, confirm: true },
    listRecords: { key: 'memoryMap.list' }, getRecord: { key: 'common.edit' }, searchRecords: { key: 'chat.memory.search.placeholder', gesture: true }, getMemoryMap: { key: 'memoryMap.build', gesture: true, confirm: true },
    updateRecord: { key: 'common.edit', mutation: true }, deleteRecord: { key: 'common.delete', mutation: true, confirm: true },
  },
  agents: { listAgents: { key: 'settings.agents.specialists' } },
  intuition: {
    getIntuitionConfig: { key: 'intuition.title' },
    saveIntuitionConfig: { key: 'common.save', mutation: true },
    suggestIntuitionQuestions: { key: 'intuition.suggest', gesture: true },
  },
  prompt: {
    listGenerationModels: {key:'settings.voice.model'},
    parsePromptSections: {key:'settings.prompt.modeAdvanced'},
    serializePromptSections: {key:'settings.prompt.modeUsual'},
    cropProfileImage: {key:'settings.prompt.imageCropTitle',gesture:true},
    startPromptChat: {key:'settings.prompt.characterCard.startChat',mutation:true},
    listPrompts: {key:'settings.sections.prompt'},
    getPromptImageSource: {key:'chat.image.photoAlt'},
    selectPrompt: {key:'common.apply',mutation:true},
    createPrompt: {key:'settings.prompt.catalog.create',mutation:true},
    updatePrompt: {key:'common.save',mutation:true},
    deletePrompt: {key:'common.delete',mutation:true,confirm:true},
    generatePrompt: {key:'settings.prompt.generate',gesture:true},
    setPromptImage: {key:'settings.prompt.imageChoose',mutation:true},
    deletePromptImage: {key:'common.delete',mutation:true},
  },
  personas: {
    listGenerationModels: {key:'settings.voice.model'},
    cropProfileImage: {key:'settings.prompt.imageCropTitle',gesture:true},
    getPersonaInstructions: {key:'playerInstructions.general'},
    savePersonaInstructions: {key:'common.save',mutation:true},
    createPersonaSurvey: {key:'playerInstructions.generate',mutation:true},
    answerPersonaSurvey: {key:'common.send',mutation:true},
    regeneratePersonaSurvey: {key:'playerInstructions.regenerate',mutation:true},
    followUpPersonaSurvey: {key:'playerInstructions.startFollowUp',mutation:true},
    applyPersonaSurvey: {key:'playerInstructions.apply',mutation:true},
    deletePersonaSurvey: {key:'common.delete',mutation:true,confirm:true},
    listPersonas: {key:'settings.sections.personas'},
    getPersonaImageSource: {key:'chat.image.photoAlt'},
    createPersona: {key:'settings.account.personas.createTitle',mutation:true},
    updatePersona: {key:'common.save',mutation:true},
    activatePersona: {key:'common.apply',mutation:true},
    deletePersona: {key:'common.delete',mutation:true,confirm:true},
    setPersonaImage: {key:'settings.account.personas.image',mutation:true},
    deletePersonaImage: {key:'common.delete',mutation:true},
  },
  limits: { getQuota: { key: 'quota.title' } },
  app: {
    listThemes: { key: 'appearance.title' }, getTheme: { key: 'appearance.title' }, getAppearanceSchema: { key: 'appearance.title' },
    saveTheme: { key: 'common.save', mutation: true }, activateTheme: { key: 'appearance.apply', mutation: true },
    deleteTheme: { key: 'common.delete', mutation: true, confirm: true }, rollbackTheme: { key: 'appearance.previousVersion', mutation: true },
    prepareDraft: { key: 'appearance.createProject', mutation: true }, readDraft: { key: 'appearance.localDrafts' }, writeDraft: { key: 'common.save', mutation: true },
    previewDraft: { key: 'appearance.preview', mutation: true }, cancelPreview: { key: 'common.cancel', mutation: true },
    checkTheme: { key: 'appearance.preview', gesture: true }, openThemeFiles: { key: 'appearance.openFiles', gesture: true },
    chooseThemesDirectory: { key: 'appearance.chooseDirectory', mutation: true }, retryThemeMigration: { key: 'appearance.retryMigration', mutation: true },
    importTheme: { key: 'appearance.import', mutation: true }, exportTheme: { key: 'appearance.export', gesture: true }, storeThemeImage: { key: 'appearance.upload', mutation: true },
  },
};
export function settingsOperations(section: string, t: (key: string) => string): SettingsOperation[] {
  return Object.entries(SETTINGS_REQUESTS[section] ?? {}).map(([id, definition]) => ({ id, label: t(definition.key), mutation: definition.mutation === true,
    requiresGesture: definition.mutation === true || definition.gesture === true, requiresConfirmation: definition.confirm === true }));
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, max: number, blank = false) => typeof value === 'string' && value.length <= max && (blank || value.trim().length > 0);
const password = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max;
const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const themeId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const profileImage = (p:Record<string,unknown>) => text(p.base64,14*1024*1024) && typeof p.mimeType==='string' && ['image/png','image/jpeg','image/webp','image/gif'].includes(p.mimeType);
const modelId = (value:unknown) => value===undefined || text(value,200);
export function validGlobalIntuitionSettings(value:unknown):boolean {
  if (!object(value) || !['enabled','disabled'].includes(String(value.mode))) return false;
  if (value.historyMessages!==null && !(Number.isInteger(value.historyMessages) && Number(value.historyMessages)>=0 && Number(value.historyMessages)<=50)) return false;
  if (value.questions===null) return true;
  if (!Array.isArray(value.questions) || value.questions.length>20) return false;
  const ids=new Set<string>();
  return value.questions.every(question=>{
    if (!object(question) || typeof question.id!=='string' || !/^[a-z][a-z0-9_]{0,63}$/.test(question.id) || ids.has(question.id)
      || !text(question.name,100) || !text(question.question,1000) || typeof question.enabled!=='boolean') return false;
    ids.add(question.id);return true;
  });
}
export function parseSettingsRequest(value: unknown): ThemeSettingsRequest | null {
  if (!object(value) || value.method !== 'settings' || !text(value.requestId, 100) || !themeId(value.editorId)
      || typeof value.sectionId !== 'string' || typeof value.operation !== 'string') return null;
  const definition = SETTINGS_REQUESTS[value.sectionId]?.[value.operation];
  if (!definition || !object(value.params)) return null;
  const p = value.params, op = value.operation;
  // Serialize once to reject cycles, unsupported objects and oversized input before any operation.
  try { if (JSON.stringify(p).length > (['importTheme','storeThemeImage','setPromptImage','setPersonaImage','cropProfileImage'].includes(op) ? 17 * 1024 * 1024 : 2 * 1024 * 1024)) return null; } catch { return null; }
  let valid = false;
  const promptId=Number.isSafeInteger(p.id) && (Number(p.id)>0 || Number(p.id)<=-1000 || p.id===-1);
  const customPromptId=promptId && Number(p.id)<=-1000;
  if(op==='cropProfileImage') valid=profileImage(p) && object(p.crop) && ['x','y','size'].every(key=>typeof (p.crop as Record<string,unknown>)[key]==='number' && Number.isFinite((p.crop as Record<string,unknown>)[key]))
    && Number(p.crop.x)>=0 && Number(p.crop.y)>=0 && Number(p.crop.size)>0 && (p.outputSize===undefined||Number.isInteger(p.outputSize)&&Number(p.outputSize)>=1&&Number(p.outputSize)<=2048);
  else if(op==='parsePromptSections') valid=text(p.content,2*1024*1024,true);
  else if(op==='serializePromptSections') valid=object(p.sections)&&['description','personality','scenario','examples','other'].every(key=>text((p.sections as Record<string,unknown>)[key],2*1024*1024,true));
  else if(op==='getPersonaInstructions'||op==='savePersonaInstructions') valid=positive(p.id)&&(op==='getPersonaInstructions'||text(p.text,12000,true));
  else if(op==='createPersonaSurvey') valid=positive(p.id)&&(p.brief===undefined||text(p.brief,2000,true))&&(p.currentText===undefined||text(p.currentText,12000,true))
    && (p.questionCount===undefined||Number.isInteger(p.questionCount)&&Number(p.questionCount)>=1&&Number(p.questionCount)<=100)
    && (p.includePrompt===undefined||typeof p.includePrompt==='boolean')&&(p.personalize===undefined||typeof p.personalize==='boolean')&&(p.modelId===null||modelId(p.modelId));
  else if(['answerPersonaSurvey','regeneratePersonaSurvey','followUpPersonaSurvey','applyPersonaSurvey','deletePersonaSurvey'].includes(op)) valid=positive(p.id)&&typeof p.surveyId==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(p.surveyId)
    && (op!=='answerPersonaSurvey'||object(p.answers)&&JSON.stringify(p.answers).length<=64000)
    && (op!=='followUpPersonaSurvey'||p.brief===undefined||text(p.brief,2000,true))
    && (op!=='applyPersonaSurvey'||text(p.text,12000,true))&&(op!=='deletePersonaSurvey'||typeof p.removeApplied==='boolean');
  else if (op==='createPrompt'||op==='updatePrompt') valid=(op==='createPrompt'||customPromptId) && text(p.name,2*1024*1024) && text(p.content,2*1024*1024,true) && (p.description===undefined||text(p.description,2*1024*1024,true));
  else if (op==='selectPrompt') valid=promptId;
  else if (op==='deletePrompt'||op==='getPromptImageSource'||op==='startPromptChat') valid=customPromptId;
  else if (op==='generatePrompt') valid=text(p.instruction,2*1024*1024) && (p.currentContent===undefined||text(p.currentContent,2*1024*1024,true)) && (p.detail===undefined||['minimal','medium','detailed','none'].includes(String(p.detail)))&&modelId(p.modelId);
  else if(op==='createPersona'||op==='updatePersona') valid=(op==='createPersona'||positive(p.id)) && text(p.name,80) && text(p.description,240,true)
    && text(p.coreMemory,2*1024*1024,true) && typeof p.allowCoreMemoryUpdate==='boolean' && (p.userInstructions===undefined||text(p.userInstructions,12000,true));
  else if(op==='activatePersona'||op==='deletePersona'||op==='getPersonaImageSource') valid=positive(p.id);
  else if(['setPromptImage','setPersonaImage','deletePromptImage','deletePersonaImage'].includes(op)) valid=(op.includes('Prompt')?customPromptId:positive(p.id))
    && (!op.startsWith('set')||profileImage(p));
  else if (op === 'saveIntuitionConfig') valid=validGlobalIntuitionSettings(p.settings);
  else if (op === 'suggestIntuitionQuestions') valid=text(p.brief,2000,true);
  else if (op === 'changePassword') valid = password(p.currentPassword, 4096) && password(p.newPassword, 128) && (p.newPassword as string).length >= 8;
  else if (op === 'changeLogin') valid = password(p.currentPassword, 4096) && typeof p.newLogin === 'string' && /^[-_.a-z0-9]{3,64}$/i.test(p.newLogin.trim());
  else if (op === 'createSpace') valid = text(p.name, 100);
  else if (['activateSpace', 'renameSpace', 'deleteSpace'].includes(op)) valid = positive(p.spaceId) && (op !== 'renameSpace' || text(p.name, 100));
  else if (op === 'listRecords') valid = positive(p.spaceId) && (p.query === undefined || text(p.query, 300, true))
    && (p.limit === undefined || positive(p.limit) && Number(p.limit) <= 500) && (p.offset === undefined || Number.isSafeInteger(p.offset) && Number(p.offset) >= 0);
  else if (op === 'searchRecords') valid = positive(p.spaceId) && text(p.query, 300);
  else if (op === 'getMemoryMap') valid = positive(p.spaceId) && [100, 500, 1000, 2000, 5000].includes(Number(p.limit));
  else if (op === 'getRecord' || op === 'updateRecord' || op === 'deleteRecord') valid = text(p.recordId, 200) && (op !== 'updateRecord' || text(p.text, 4000)) && (p.source === undefined || text(p.source, 1000, true));
  else if (['getTheme', 'deleteTheme', 'rollbackTheme', 'readDraft', 'previewDraft', 'exportTheme'].includes(op)) valid = themeId(p.id);
  else if (op === 'prepareDraft') valid = themeId(p.id) && (p.project === undefined || typeof p.project === 'boolean');
  else if (op === 'openThemeFiles') valid = p.id === undefined || themeId(p.id);
  else if (op === 'activateTheme') valid = p.id === null || themeId(p.id);
  else if (op === 'saveTheme' || op === 'writeDraft' || op === 'checkTheme') valid = object(p.profile) && (p.apply === undefined || typeof p.apply === 'boolean');
  else if (op === 'importTheme') valid = ['json', 'zip'].includes(String(p.format)) && text(p.content, p.format === 'json' ? 2 * 1024 * 1024 : 17 * 1024 * 1024);
  else if (op === 'storeThemeImage') valid = text(p.base64, 12 * 1024 * 1024);
  else valid = ['listGenerationModels','listPrompts','listPersonas','getIntuitionConfig','getAccount', 'getMemoryStatus', 'listSpaces', 'listAgents', 'getQuota', 'listThemes', 'getAppearanceSchema', 'cancelPreview', 'chooseThemesDirectory', 'retryThemeMigration'].includes(op);
  if (!valid || definition.confirm && p.confirmed !== true) return null;
  // Credentials/params remain request-local; never copy them into settings state or diagnostic text.
  return { method: 'settings', requestId: value.requestId as string, sectionId: value.sectionId, editorId: value.editorId as string, operation: op, params: p };
}
export function settingsRequestScope(state: ThemeSettingsState | undefined, request: ThemeSettingsRequest): boolean {
  return Boolean(state?.editor && state.editor.id === request.editorId && state.editor.sectionId === request.sectionId
    && state.sections.some(section => section.id === request.sectionId && section.mode !== 'native'));
}
export function canRequestSettings(state: ThemeSettingsState | undefined, request: ThemeSettingsRequest): boolean {
  return settingsRequestScope(state, request) && !state!.editor!.loading && !state!.editor!.busy
    && Boolean(state!.editor!.requests?.some(operation => operation.id === request.operation));
}
