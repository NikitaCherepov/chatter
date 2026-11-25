import * as React from 'react';
import { useChatterState } from './chatter-state';
import { SettingsTask, SettingsFormStore, type SettingsResult } from './settings-store';
import { validGlobalIntuitionSettings } from '../main/settings-request-types';
import {
  parsePromptSections,
  serializePromptSections,
  PROMPT_SECTION_KEYS,
} from '../renderer/lib/promptSections';
import type { ThemeSettingField, ThemeSettingsState } from '../main/settings-shell-types';
import type {
  SettingsRequestContract,
  SettingsRequestParameters,
  SettingsRequestResult,
  SettingsPersonaInput,
  SettingsPromptSections,
  SettingsCustomPrompt,
  SettingsIntuitionSettings,
  SettingsIntuitionConfig,
  SettingsIntuitionQuestion,
  SettingsPersonaInstructions,
  SettingsPersonaSurvey,
  SettingsSurveyAnswer,
  SettingsProfileImage,
  SettingsCroppedProfileImage,
} from './settings-contract';
export type { SettingsResult } from './settings-store';
export type SettingsSectionId = keyof SettingsRequestContract | 'voice' | 'browser';
type Editor = NonNullable<ThemeSettingsState['editor']>;
type Bridge = {
  requestSettings: (section: string, operation: string, params?: object) => Promise<any>;
  openSettingsSession: (section: string) => boolean;
  setSettingValue: (section: string, key: string, value: unknown) => boolean;
  saveSettingsSection: (section: string) => boolean;
  discardSettingsSection: (section: string) => boolean;
  reloadSettingsSection: (section: string) => boolean;
  runSettingsAction: (section: string, operation: string) => boolean;
};
const bridge = (): Bridge => (window as any).chatter;
const stores = new Map<string, { owner: string; value: { dispose(): void } }>();
const draftSignals = new Map<string, { version: number; listeners: Set<() => void> }>();
function draftSignal(owner: string) {
  let signal = draftSignals.get(owner);
  if (!signal) {
    signal = { version: 0, listeners: new Set() };
    draftSignals.set(owner, signal);
  }
  return signal;
}
const hasStructuredChanges = (owner: string | undefined) =>
  !!owner &&
  [...stores.values()].some(
    (record) =>
      record.owner === owner &&
      record.value instanceof SettingsFormStore &&
      record.value.getSnapshot().dirty,
  );
const opened = new Set<string>();
let activeScope: string | undefined;
let liveEditors: Record<string, Editor> = {};
const keyOf = (value: unknown) => JSON.stringify(value);
const retryRead = (error: string | null) =>
  ['settings_scope_changed', 'settings_request_canceled'].includes(error ?? '');
function shared<T extends { dispose(): void }>(owner: string, key: string, create: () => T): T {
  const id = owner + ':' + key;
  let record = stores.get(id);
  if (!record) {
    record = { owner, value: create() };
    if (record.value instanceof SettingsFormStore)
      record.value.subscribe(() => {
        const signal = draftSignal(owner);
        signal.version++;
        signal.listeners.forEach((listener) => listener());
      });
    stores.set(id, record);
  }
  return record.value as T;
}
const current = (owner: string) => () =>
  Object.values(liveEditors).some((editor) => editor.id === owner);
export function updateSettingsScope(settings: ThemeSettingsState | undefined) {
  if (settings?.scopeId !== activeScope) {
    opened.clear();
    activeScope = settings?.scopeId;
  }
  liveEditors =
    settings?.editors ?? (settings?.editor ? { [settings.editor.sectionId]: settings.editor } : {});
  const ids = new Set(Object.values(liveEditors).map((editor) => editor.id));
  for (const [key, record] of stores)
    if (!ids.has(record.owner)) {
      record.value.dispose();
      stores.delete(key);
    }
  for (const owner of draftSignals.keys()) if (!ids.has(owner)) draftSignals.delete(owner);
  drainReads();
}
const deadTask = new SettingsTask<any>(() => false),
  deadForm = new SettingsFormStore<any>(() => false);
let reading = 0;
const reads: Array<{ section: string; execute: () => void }> = [];
function drainReads() {
  const mutations = Object.values(liveEditors).filter((editor) => editor.busy).length;
  while (reading < Math.max(0, 3 - mutations)) {
    const index = reads.findIndex((item) => !liveEditors[item.section]?.busy);
    if (index < 0) return;
    reads.splice(index, 1)[0].execute();
  }
}
function read<T>(task: () => Promise<T>, section: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const execute = () => {
      reading++;
      let promise: Promise<T>;
      try {
        promise = task();
      } catch (error) {
        promise = Promise.reject(error);
      }
      promise.then(resolve, reject).finally(() => {
        reading--;
        drainReads();
      });
    };
    reads.push({ section, execute });
    drainReads();
  });
}

export type SettingsSectionController = {
  id: string;
  ready: boolean;
  loading: boolean;
  busy: boolean;
  dirty: boolean;
  error: string | null;
  fields: ThemeSettingField[];
  groups: Editor['groups'];
  links: Editor['links'];
  actions: Editor['actions'];
  requests: Editor['requests'];
  editorId: string | undefined;
  field: (id: string) => ThemeSettingField | undefined;
  bind: (id: string) => Record<string, any>;
  set: (id: string, value: unknown) => boolean;
  save: () => boolean;
  discard: () => boolean;
  reload: () => boolean;
  run: (id: string) => boolean;
  submit: (event?: { preventDefault(): void }) => boolean;
  canSave: boolean;
  canReload: boolean;
  hasDraftChanges: boolean;
};
export function useSettingsSection(id: string): SettingsSectionController {
  const state = useChatterState();
  liveEditors =
    state?.settings?.editors ??
    (state?.settings?.editor ? { [state.settings.editor.sectionId]: state.settings.editor } : {});
  const editor = liveEditors[id],
    available =
      state?.settings?.sections.some((section) => section.id === id && section.mode !== 'native') ??
      false;
  const scope = state?.settings?.scopeId ?? 'legacy';
  React.useEffect(() => {
    const key = scope + ':' + id;
    if (available && !opened.has(key)) {
      opened.add(key);
      if (!bridge().openSettingsSession(id)) opened.delete(key);
    }
  }, [id, scope, available, editor?.id]);
  const subscribeDrafts = React.useCallback(
    (listener: () => void) => {
      if (!editor) return () => {};
      const signal = draftSignal(editor.id);
      signal.listeners.add(listener);
      return () => {
        signal.listeners.delete(listener);
      };
    },
    [editor?.id],
  );
  React.useSyncExternalStore(subscribeDrafts, () =>
    editor ? (draftSignals.get(editor.id)?.version ?? 0) : 0,
  );
  const ready = !!editor && !editor.loading;
  const owns = () => !!editor && liveEditors[id]?.id === editor.id;
  const set = (key: string, value: unknown) => owns() && bridge().setSettingValue(id, key, value);
  const save = () => owns() && bridge().saveSettingsSection(id);
  return {
    id,
    ready,
    loading: available && !ready,
    busy: editor?.busy ?? false,
    dirty: editor?.dirty ?? false,
    hasDraftChanges: !!editor?.dirty || hasStructuredChanges(editor?.id),
    canReload: !!editor && !editor.busy && !editor.dirty && !hasStructuredChanges(editor.id),
    error: editor?.error ?? (!available && state ? 'settings_section_unavailable' : null),
    fields: editor?.fields ?? [],
    groups: editor?.groups ?? [],
    links: editor?.links ?? [],
    actions: editor?.actions ?? [],
    requests: editor?.requests ?? [],
    editorId: editor?.id,
    field: (key) => editor?.fields.find((field) => field.id === key),
    set,
    save,
    discard: () => owns() && bridge().discardSettingsSection(id),
    reload: () => owns() && !hasStructuredChanges(editor?.id) && bridge().reloadSettingsSection(id),
    run: (key) => owns() && bridge().runSettingsAction(id, key),
    submit: (event) => {
      event?.preventDefault();
      return save();
    },
    canSave:
      !!editor &&
      ready &&
      !editor.busy &&
      editor.dirty &&
      !editor.fields.some((field) => field.error),
    bind: (key) => {
      const field = editor?.fields.find((field) => field.id === key);
      return field
        ? {
            disabled: editor.busy || editor.loading,
            'aria-invalid': !!field.error,
            ...(field.type === 'toggle'
              ? {
                  checked: field.value === true,
                  onChange: (event: any) => set(key, event.target.checked),
                }
              : {
                  value: field.value ?? '',
                  onChange: (event: any) => set(key, event.target.value),
                }),
            ...(field.type === 'number'
              ? { min: field.min, max: field.max, step: field.step }
              : {}),
            maxLength: field.maxLength,
          }
        : { value: '', disabled: true };
    },
  };
}

export type SettingsApi<S extends keyof SettingsRequestContract> = {
  [O in keyof SettingsRequestContract[S]]: (
    ...args: SettingsRequestParameters<S, O>
  ) => Promise<SettingsRequestResult<S, O>>;
};
export function useSettingsApi<S extends keyof SettingsRequestContract>(
  section: S,
): SettingsApi<S> {
  const session = useSettingsSection(section),
    owner = session.editorId;
  return React.useMemo(
    () =>
      new Proxy({} as SettingsApi<S>, {
        get: (_target, operation) =>
          operation === 'then'
            ? undefined
            : (params?: object) => {
                const editor = liveEditors[section];
                if (!owner || editor?.id !== owner || editor.loading)
                  return Promise.reject(new Error('settings_scope_changed'));
                return bridge().requestSettings(section, String(operation), params);
              },
      }),
    [section, owner],
  );
}

export type SettingsTaskController<T> = {
  data: T | undefined;
  loading: boolean;
  busy: boolean;
  error: string | null;
  operation: string | null;
  run: (operation: string, task: () => Promise<T>) => Promise<SettingsResult<T>>;
  clear: () => void;
  clearError: () => void;
};
export function useSettingsTask<T>(
  section: SettingsSectionId,
  key: string,
): SettingsTaskController<T> {
  const session = useSettingsSection(section),
    owner = session.editorId;
  const store = owner
    ? shared(owner, 'task:' + key, () => new SettingsTask<T>(current(owner)))
    : (deadTask as SettingsTask<T>);
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
  return {
    ...state,
    busy: state.busy || session.busy,
    run: (operation, task) => store.run(operation, task),
    clear: store.clear,
    clearError: store.clearError,
  };
}
export type SettingsResourceController<T> = SettingsTaskController<T> & {
  reload: () => Promise<SettingsResult<T>>;
  receive: (value: T) => void;
};
export function useSettingsResource<
  S extends keyof SettingsRequestContract,
  O extends keyof SettingsRequestContract[S],
>(
  section: S,
  operation: O,
  ...params: SettingsRequestParameters<S, O>
): SettingsResourceController<SettingsRequestResult<S, O>> {
  type T = SettingsRequestResult<S, O>;
  const session = useSettingsSection(section),
    api = useSettingsApi(section),
    owner = session.editorId,
    key = keyOf([operation, params]);
  const store = owner
    ? shared(owner, 'resource:' + key, () => new SettingsTask<T>(current(owner)))
    : (deadTask as SettingsTask<T>);
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
  const load = () =>
    read(() => {
      if (!owner || !current(owner)()) throw new Error('settings_scope_changed');
      const descriptor = liveEditors[section]?.requests.find((item) => item.id === operation);
      if (!descriptor || descriptor.requiresGesture) throw new Error('settings_read_unavailable');
      return (api[operation] as any)(...params) as Promise<T>;
    }, section);
  React.useEffect(() => {
    if (
      session.ready &&
      !session.busy &&
      ((state.data === undefined && !state.error) || retryRead(state.error))
    )
      void (retryRead(state.error) ? store.retry(load) : store.load(load));
  }, [owner, session.ready, session.busy, key, state.error]);
  return {
    ...state,
    error: state.error ?? session.error,
    loading: session.loading || state.loading,
    busy: session.busy || state.busy,
    reload: () => store.load(load, true),
    receive: (value) => store.receive(value),
    run: (op, task) => store.run(op, task),
    clear: store.clear,
    clearError: store.clearError,
  };
}
export function useSettingsAction<
  S extends keyof SettingsRequestContract,
  O extends keyof SettingsRequestContract[S],
>(
  section: S,
  operation: O,
  key = String(operation),
): Omit<SettingsTaskController<SettingsRequestResult<S, O>>, 'run'> & {
  run: (
    ...params: SettingsRequestParameters<S, O>
  ) => Promise<SettingsResult<SettingsRequestResult<S, O>>>;
} {
  const api = useSettingsApi(section),
    task = useSettingsTask<SettingsRequestResult<S, O>>(section, key);
  return {
    ...task,
    run: (...params) => task.run(String(operation), () => (api[operation] as any)(...params)),
  };
}

export type SettingsForm<T extends object> = {
  draft: T | undefined;
  saved: T | undefined;
  dirty: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
  conflict: boolean;
  errors: Partial<Record<keyof T, string>>;
  canSave: boolean;
  set: <K extends keyof T>(key: K, value: T[K]) => void;
  replace: (value: T) => void;
  bind: <K extends keyof T>(key: K) => Record<string, any>;
  discard: () => void;
  rebase: () => void;
  save: () => Promise<SettingsResult<T>>;
  submit: (event?: { preventDefault(): void }) => Promise<SettingsResult<T>>;
  clearError: () => void;
};
export function useSettingsForm<T extends object>(
  section: SettingsSectionId,
  key: string,
  value: T | undefined,
  write: (draft: T) => Promise<T>,
  validate?: (draft: T) => Partial<Record<keyof T, string>>,
): SettingsForm<T> {
  const session = useSettingsSection(section),
    owner = session.editorId;
  const validator = React.useRef(validate);
  validator.current = validate;
  const store = owner
    ? shared(
        owner,
        'form:' + key,
        () => new SettingsFormStore<T>(current(owner), (draft) => validator.current?.(draft) ?? {}),
      )
    : (deadForm as SettingsFormStore<T>);
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot),
    signature = keyOf(value);
  React.useEffect(() => {
    if (owner && value !== undefined) store.receive(value);
  }, [owner, key, signature]);
  const save = () => store.save(write),
    busy = state.busy || session.busy;
  return {
    ...state,
    loading: session.loading || state.draft === undefined,
    busy,
    canSave:
      !!state.draft && state.dirty && !busy && !state.conflict && !Object.keys(state.errors).length,
    save,
    submit: (event) => {
      event?.preventDefault();
      return save();
    },
    set: store.set,
    replace: store.replace,
    discard: store.discard,
    rebase: store.rebase,
    clearError: store.clearError,
    bind: (key) => {
      const value = state.draft?.[key];
      return {
        disabled: busy || !state.draft,
        'aria-invalid': !!state.errors[key],
        ...(typeof value === 'boolean'
          ? { checked: value, onChange: (event: any) => store.set(key, event.target.checked) }
          : {
              value: typeof value === 'number' && !Number.isFinite(value) ? '' : (value ?? ''),
              onChange: (event: any) =>
                store.set(
                  key,
                  typeof value === 'number'
                    ? event.target.value === ''
                      ? NaN
                      : Number(event.target.value)
                    : event.target.value,
                ),
            }),
      };
    },
  };
}

export function useSettingsQuery<T>(
  section: SettingsSectionId,
  key: string,
  loader: () => Promise<T>,
  enabled = true,
): SettingsResourceController<T> {
  const session = useSettingsSection(section),
    owner = session.editorId;
  const store = owner
    ? shared(owner, 'query:' + key, () => new SettingsTask<T>(current(owner)))
    : (deadTask as SettingsTask<T>);
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
  const load = () =>
    read(() => {
      if (!owner || !current(owner)()) throw new Error('settings_scope_changed');
      return loader();
    }, section);
  React.useEffect(() => {
    if (
      session.ready &&
      !session.busy &&
      enabled &&
      ((state.data === undefined && !state.error) || retryRead(state.error))
    )
      void (retryRead(state.error) ? store.retry(load) : store.load(load));
  }, [owner, key, session.ready, session.busy, enabled, state.error]);
  return {
    ...state,
    error: state.error ?? session.error,
    loading: session.loading || state.loading,
    busy: state.busy || session.busy,
    reload: () =>
      enabled
        ? store.load(load, true)
        : Promise.resolve({ ok: false, error: 'settings_read_unavailable' }),
    receive: (value) => store.receive(value),
    run: (op, task) => store.run(op, task),
    clear: store.clear,
    clearError: store.clearError,
  };
}

export function usePersonas() {
  const api = useSettingsApi('personas'),
    library = useSettingsResource('personas', 'listPersonas'),
    action = useSettingsTask<SettingsRequestResult<'personas', 'listPersonas'>>(
      'personas',
      'library-actions',
    );
  const run = async (
    op: string,
    task: () => Promise<SettingsRequestResult<'personas', 'listPersonas'>>,
  ) => {
    const result = await action.run(op, task);
    if (result.ok) library.receive(result.value);
    return result;
  };
  return {
    ...library,
    items: library.data?.personas ?? [],
    busy: library.busy || action.busy,
    error: action.error ?? library.error,
    activate: (id: number) => run('activate', () => api.activatePersona({ id })),
    remove: (id: number, confirmed: true) =>
      run('delete', () => api.deletePersona({ id, confirmed })),
  };
}
export function usePrompts() {
  const api = useSettingsApi('prompt'),
    library = useSettingsResource('prompt', 'listPrompts'),
    action = useSettingsTask<SettingsRequestResult<'prompt', 'listPrompts'>>(
      'prompt',
      'library-actions',
    );
  const run = async (
    op: string,
    task: () => Promise<SettingsRequestResult<'prompt', 'listPrompts'>>,
  ) => {
    const result = await action.run(op, task);
    if (result.ok) library.receive(result.value);
    return result;
  };
  return {
    ...library,
    builtin: library.data?.prompts ?? [],
    items: library.data?.custom_prompts ?? [],
    selectedId: library.data?.selected_prompt_id ?? null,
    busy: library.busy || action.busy,
    error: action.error ?? library.error,
    select: (id: number) => run('select', () => api.selectPrompt({ id })),
    remove: (id: number, confirmed: true) =>
      run('delete', () => api.deletePrompt({ id, confirmed })),
  };
}

export function usePersonaInstructions(id: number) {
  const library = usePersonas(),
    api = useSettingsApi('personas');
  const models = useSettingsResource('personas', 'listGenerationModels');
  const resource = useSettingsQuery(
    'personas',
    'instructions:' + id,
    () => api.getPersonaInstructions({ id }),
    library.items.some((item) => item.id === id),
  );
  const action = useSettingsTask<{ survey: SettingsPersonaSurvey } | SettingsPersonaInstructions>(
    'personas',
    'survey-action:' + id,
  );
  const form = useSettingsForm(
    'personas',
    'instructions:' + id,
    resource.data ? { text: resource.data.text } : undefined,
    async (draft) => {
      const result = await api.savePersonaInstructions({ id, text: draft.text });
      resource.receive(result);
      return { text: result.text };
    },
    (draft) => (draft.text.length > 12000 ? { text: 'bad_user_instructions' } : {}),
  );
  const [selectedId, setSelectedId] = React.useState<string>();
  React.useEffect(() => setSelectedId(undefined), [id]);
  const selected = resource.data?.surveys.find((survey) => survey.id === selectedId);
  const receive = (value: { survey: SettingsPersonaSurvey } | SettingsPersonaInstructions) => {
    if ('survey' in value) {
      if (resource.data)
        resource.receive({
          ...resource.data,
          surveys: [
            value.survey,
            ...resource.data.surveys.filter((s) => s.id !== value.survey.id),
          ].slice(0, 50),
        });
      setSelectedId(value.survey.id);
    } else resource.receive(value);
  };
  const answers = useSettingsForm<Record<string, SettingsSurveyAnswer>>(
    'personas',
    'survey-answers:' + selectedId,
    selected ? (selected.answers ?? {}) : undefined,
    async (value) => {
      if (!selected) throw new Error('survey_not_found');
      const result = await api.answerPersonaSurvey({ id, surveyId: selected.id, answers: value });
      receive(result);
      return result.survey.answers ?? value;
    },
  );
  const proposal = useSettingsForm(
    'personas',
    'survey-proposal:' + selectedId,
    selected?.draft != null ? { text: selected.applied_text ?? selected.draft } : undefined,
    async (value) => {
      if (!selected) throw new Error('survey_not_found');
      const result = await api.applyPersonaSurvey({ id, surveyId: selected.id, text: value.text });
      receive(result);
      return { text: result.text };
    },
    (draft) => (draft.text.length > 12000 ? { text: 'bad_user_instructions' } : {}),
  );
  // Applying an unchanged AI proposal is still an explicit write, unlike an unchanged ordinary form.
  const apply = async () => {
    if (!selected || !proposal.draft) return { ok: false, error: 'survey_not_answered' } as const;
    if (proposal.conflict) return { ok: false, error: 'settings_conflict' } as const;
    const result = await action.run('apply', () =>
      api.applyPersonaSurvey({ id, surveyId: selected.id, text: proposal.draft!.text }),
    );
    if (result.ok) receive(result.value);
    else await resource.reload();
    return result;
  };
  const run = async (
    op: string,
    task: () => Promise<{ survey: SettingsPersonaSurvey } | SettingsPersonaInstructions>,
  ) => {
    const result = await action.run(op, task);
    if (result.ok) receive(result.value);
    else await resource.reload();
    return result;
  };
  const submitAnswers = () =>
    selected
      ? run('answer', () =>
          api.answerPersonaSurvey({ id, surveyId: selected.id, answers: answers.draft ?? {} }),
        )
      : Promise.resolve({ ok: false, error: 'survey_not_found' } as const);
  return {
    ...form,
    loading: library.loading || resource.loading,
    busy: form.busy || action.busy,
    error: form.error ?? action.error ?? resource.error ?? library.error,
    surveys: resource.data?.surveys ?? [],
    selected,
    select: setSelectedId,
    answers: {
      ...answers,
      save: submitAnswers,
      submit: (event?: { preventDefault(): void }) => {
        event?.preventDefault();
        return submitAnswers();
      },
      readonly: selected?.answers !== null,
      bind: (key: string) => ({
        ...answers.bind(key),
        disabled: answers.busy || action.busy || selected?.answers !== null,
      }),
    },
    proposal: {
      ...proposal,
      save: apply,
      submit: (event?: { preventDefault(): void }) => {
        event?.preventDefault();
        return apply();
      },
    },
    models: models.data?.models ?? [],
    selectedModel: models.data?.selectedId ?? null,
    reload: resource.reload,
    apply,
    create: (
      options: Omit<
        SettingsRequestContract['personas']['createPersonaSurvey']['params'],
        'id'
      > = {},
    ) =>
      run('create', () =>
        api.createPersonaSurvey({
          ...options,
          id,
          currentText: options.currentText ?? form.draft?.text,
        }),
      ),
    regenerate: () =>
      selected
        ? run('regenerate', () => api.regeneratePersonaSurvey({ id, surveyId: selected.id }))
        : Promise.resolve({ ok: false, error: 'survey_not_found' } as const),
    followUp: (brief = '') =>
      selected
        ? run('follow-up', () => api.followUpPersonaSurvey({ id, surveyId: selected.id, brief }))
        : Promise.resolve({ ok: false, error: 'survey_not_found' } as const),
    remove: (surveyId: string, removeApplied: boolean, confirmed: true) =>
      run('delete', () => api.deletePersonaSurvey({ id, surveyId, removeApplied, confirmed })),
  };
}

export function useProfileAvatar(section: 'prompt' | 'personas', id: number) {
  const api = useSettingsApi(section);
  const library = useSettingsResource(
    section,
    section === 'prompt' ? 'listPrompts' : ('listPersonas' as any),
  ) as SettingsResourceController<any>;
  const resource = useSettingsQuery<{ source: string | null }>(
    section,
    'avatar:' + id,
    () =>
      section === 'prompt'
        ? (api as SettingsApi<'prompt'>).getPromptImageSource({ id })
        : (api as SettingsApi<'personas'>).getPersonaImageSource({ id }),
    !!library.data,
  );
  const source = resource.data?.source;
  const match = source && /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(source);
  const original = match
    ? { base64: match[2], mimeType: match[1] as SettingsProfileImage['mimeType'] }
    : null;
  const form = useSettingsForm<{ image: SettingsProfileImage | null }>(
    section,
    'avatar:' + id,
    resource.data ? { image: original } : undefined,
    async (draft) => {
      const result =
        section === 'prompt'
          ? await (api as SettingsApi<'prompt'>).setPromptImage({ id, ...draft.image! })
          : await (api as SettingsApi<'personas'>).setPersonaImage({ id, ...draft.image! });
      library.receive(result);
      resource.receive({
        source: draft.image
          ? 'data:' + draft.image.mimeType + ';base64,' + draft.image.base64
          : null,
      });
      return draft;
    },
    (draft) => (draft.image ? {} : { image: 'profile_image_invalid' }),
  );
  const task = useSettingsTask<SettingsProfileImage | null>(section, 'avatar-action:' + id);
  const choose = async () => {
    const result = await task.run('choose-file', () => {
      if (!form.draft) throw new Error('settings_read_required');
      return api.chooseProfileImage();
    });
    if (result.ok && result.value) form.set('image', result.value);
    return result;
  };
  const pick = async (file: File) => {
    const result = await task.run(
      'read-file',
      () =>
        new Promise<SettingsProfileImage>((resolve, reject) => {
          if (!form.draft) {
            reject(new Error('settings_read_required'));
            return;
          }
          if (
            file.size > 10 * 1024 * 1024 ||
            !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)
          ) {
            reject(new Error('profile_image_invalid'));
            return;
          }
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('profile_image_invalid'));
          reader.onload = () =>
            resolve({
              base64: String(reader.result).split(',')[1],
              mimeType: file.type as SettingsProfileImage['mimeType'],
            });
          reader.readAsDataURL(file);
        }),
    );
    if (result.ok) form.set('image', result.value);
    return result;
  };
  const crop = async (rect: { x: number; y: number; size: number }, outputSize?: number) => {
    const result = await task.run('crop', () => {
      if (!form.draft?.image) throw new Error('profile_image_invalid');
      return api.cropProfileImage({ ...form.draft.image, crop: rect, outputSize });
    });
    if (result.ok && result.value)
      form.set('image', { base64: result.value.base64, mimeType: result.value.mimeType });
    return result;
  };
  const remove = async () => {
    const result = await task.run('remove', async () => {
      const result =
        section === 'prompt'
          ? await (api as SettingsApi<'prompt'>).deletePromptImage({ id })
          : await (api as SettingsApi<'personas'>).deletePersonaImage({ id });
      library.receive(result);
      return null;
    });
    if (result.ok) {
      form.discard();
      resource.receive({ source: null });
    }
    return result;
  };
  return {
    ...form,
    loading: library.loading || resource.loading,
    busy: form.busy || task.busy,
    error: form.error ?? task.error ?? resource.error ?? library.error,
    source: form.draft?.image
      ? 'data:' + form.draft.image.mimeType + ';base64,' + form.draft.image.base64
      : null,
    choose,
    pick,
    crop,
    remove,
    reload: resource.reload,
  };
}

type PersonaDraft = Omit<SettingsPersonaInput, 'userInstructions'>;
export function usePersonaEditor(id: number | null): SettingsForm<PersonaDraft> & {
  createdId: number | undefined;
  reload: () => Promise<SettingsResult<SettingsRequestResult<'personas', 'listPersonas'>>>;
} {
  const api = useSettingsApi('personas'),
    library = useSettingsResource('personas', 'listPersonas');
  const created = useSettingsTask<number>('personas', 'created:' + id);
  const item = library.data?.personas.find((item) => item.id === id);
  const value: PersonaDraft | undefined =
    id === null
      ? { name: '', description: '', coreMemory: '', allowCoreMemoryUpdate: true }
      : item
        ? {
            name: item.name,
            description: item.description,
            coreMemory: item.coreMemory,
            allowCoreMemoryUpdate: item.allowCoreMemoryUpdate,
          }
        : undefined;
  const form = useSettingsForm(
    'personas',
    'persona:' + id,
    value,
    async (draft) => {
      const result =
        id === null ? await api.createPersona(draft) : await api.updatePersona({ id, ...draft });
      library.receive(result);
      const selected = 'createdId' in result ? result.createdId : id;
      if ('createdId' in result)
        await created.run('created', () => Promise.resolve(Number(result.createdId)));
      const saved = result.personas.find((item) => item.id === selected)!;
      return {
        name: saved.name,
        description: saved.description,
        coreMemory: saved.coreMemory,
        allowCoreMemoryUpdate: saved.allowCoreMemoryUpdate,
      };
    },
    (draft) => ({
      ...(draft.name.trim() && draft.name.length <= 80 ? {} : { name: 'persona_name_required' }),
      ...(draft.description.length <= 240 ? {} : { description: 'settings_invalid' }),
    }),
  );
  return {
    ...form,
    loading: library.loading,
    error:
      form.error ??
      library.error ??
      (library.data && id !== null && !item ? 'settings_entity_unavailable' : null),
    createdId: created.data,
    reload: library.reload,
  };
}

export function usePromptEditor(id: number | null) {
  const api = useSettingsApi('prompt'),
    library = useSettingsResource('prompt', 'listPrompts');
  const models = useSettingsResource('prompt', 'listGenerationModels');
  const generation = useSettingsTask<{ generated_prompt: string }>('prompt', 'proposal:' + id),
    created = useSettingsTask<number>('prompt', 'created:' + id);
  const item = library.data?.custom_prompts.find((item) => item.id === id);
  const value =
    id === null
      ? { name: '', description: '', content: '' }
      : item
        ? { name: item.name, description: item.description, content: item.content }
        : undefined;
  const form = useSettingsForm(
    'prompt',
    'prompt:' + id,
    value,
    async (draft) => {
      const result =
        id === null ? await api.createPrompt(draft) : await api.updatePrompt({ id, ...draft });
      library.receive(result);
      const selected = 'createdId' in result ? result.createdId : id;
      if ('createdId' in result)
        await created.run('created', () => Promise.resolve(Number(result.createdId)));
      const saved = result.custom_prompts.find((item) => item.id === selected)!;
      return { name: saved.name, description: saved.description, content: saved.content };
    },
    (draft) => ({
      ...(draft.name.trim() ? {} : { name: 'settings_invalid' }),
      ...(library.data?.max_custom_prompt_length !== undefined &&
      draft.content.length > library.data.max_custom_prompt_length
        ? { content: 'settings_invalid' }
        : {}),
    }),
  );
  return {
    ...form,
    loading: library.loading,
    error:
      form.error ??
      library.error ??
      generation.error ??
      (library.data && id !== null && !item ? 'settings_entity_unavailable' : null),
    createdId: created.data,
    maxLength: library.data?.max_custom_prompt_length,
    reload: library.reload,
    sections: parsePromptSections(form.draft?.content ?? '') as SettingsPromptSections,
    sectionKeys: PROMPT_SECTION_KEYS,
    setSection: (key: keyof SettingsPromptSections, value: string) =>
      form.set(
        'content',
        serializePromptSections({
          ...parsePromptSections(form.draft?.content ?? ''),
          [key]: value,
        }),
      ),
    models: models.data?.models ?? [],
    selectedModel: models.data?.selectedId ?? null,
    generate: (
      instruction: string,
      options?: { detail?: 'minimal' | 'medium' | 'detailed' | 'none'; modelId?: string },
    ) =>
      generation.run('generate', () =>
        api.generatePrompt({ instruction, currentContent: form.draft?.content, ...options }),
      ),
    proposal: generation.data?.generated_prompt,
    useProposal: () => {
      if (generation.data) {
        form.set('content', generation.data.generated_prompt);
        generation.clear();
      }
    },
  };
}

export function useIntuitionEditor() {
  const api = useSettingsApi('intuition'),
    resource = useSettingsResource('intuition', 'getIntuitionConfig'),
    generation = useSettingsTask<{ questions: SettingsIntuitionQuestion[] }>(
      'intuition',
      'proposal',
    );
  const form = useSettingsForm(
    'intuition',
    'config',
    resource.data?.settings,
    async (settings) => {
      const result = await api.saveIntuitionConfig({ settings });
      resource.receive(result);
      return result.settings;
    },
    (settings) => (validGlobalIntuitionSettings(settings) ? {} : { questions: 'settings_invalid' }),
  );
  const questions = form.draft?.questions ?? resource.data?.defaults ?? [];
  return {
    ...form,
    loading: resource.loading,
    error: form.error ?? resource.error ?? generation.error,
    config: resource.data,
    questions: form.draft?.questions ?? resource.data?.defaults ?? [],
    proposal: generation.data?.questions,
    suggest: (brief = '') =>
      generation.run('suggest', () => api.suggestIntuitionQuestions({ brief })),
    useProposal: () => {
      if (generation.data) {
        form.set('questions', generation.data.questions);
        generation.clear();
      }
    },
    reload: resource.reload,
    addQuestion: () => {
      if (questions.length < 20)
        form.set('questions', [
          ...questions,
          {
            id: 'signal_' + crypto.randomUUID().replace(/-/g, ''),
            name: '',
            question: '',
            enabled: true,
          },
        ]);
    },
    updateQuestion: (id: string, patch: Partial<Omit<SettingsIntuitionQuestion, 'id'>>) =>
      form.set(
        'questions',
        questions.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      ),
    removeQuestion: (id: string) =>
      form.set(
        'questions',
        questions.filter((item) => item.id !== id),
      ),
    useDefaults: () => form.set('questions', null),
    canAddQuestion: questions.length < 20,
  };
}
