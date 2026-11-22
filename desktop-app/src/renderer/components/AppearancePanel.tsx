import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppearance } from '../lib/appearance-service';
import {
  APPEARANCE_FONTS,
  APPEARANCE_MOTION_PRESETS,
  appearanceMotionValues,
  parseAppearanceMotion,
  type AppearanceMotion,
  DEFAULT_MATERIAL,
  type AppearanceMaterial,
  DEFAULT_APPEARANCE,
  newAppearance,
  parseAppearanceProfile,
  type AppearanceProfile,
} from '../lib/appearance-schema';
import {
  APPEARANCE_APPLIED_EVENT,
  animateMessageArrival,
  finishAppearancePreview,
  getAppearancePreview,
  previewAppearance,
} from '../lib/appearance-runtime';
import { appearanceColors, materialColors } from '../lib/appearance-colors';
import { apiFetch, resolveAuthenticatedAssetUrl } from '../lib/api';
import { Select } from './Select';
import Slider from './Slider';
import { AppearanceShellEditor } from './AppearanceShellEditor';
import { compileAppearanceProject } from '../lib/appearance-project';
import a from './SettingsModal.module.scss';
import s from './AppearancePanel.module.scss';

const motionPresets = ['none', 'fade', 'slide', 'scale'] as const;
type MotionPreset = (typeof motionPresets)[number];

function selectedMotionPreset(motion: AppearanceMotion): MotionPreset | 'custom' {
  if (motion.preset === 'none') return 'none';
  for (const name of ['fade', 'slide', 'scale'] as const) {
    const preset = APPEARANCE_MOTION_PRESETS[name];
    if (
      motion.preset === preset.preset &&
      motion.duration === preset.duration &&
      motion.distance === preset.distance &&
      motion.scale === preset.scale &&
      motion.easing === preset.easing
    )
      return name;
  }
  return 'custom';
}

const STANDARD_SAMPLE = newAppearance();
async function validateShell(profile: AppearanceProfile) {
  if (!profile.shell?.files) return;
  const compiler = await import('typescript');
  const { diagnostics } = compileAppearanceProject({ entry: profile.shell.entry, files: profile.shell.files }, compiler.default ?? compiler);
  if (diagnostics.length) throw Object.assign(new Error('appearance_build_failed'), { diagnostics });
}
export const AppearanceSample = memo(function AppearanceSample({
  profile,
}: {
  profile: AppearanceProfile;
}) {
  return (
    <div className={s.sample} aria-hidden="true">
      {(['light', 'dark'] as const).map((mode) => {
        const colors = appearanceColors(profile, mode, resolveAuthenticatedAssetUrl);
        const panel = profile.materials?.panels
          ? materialColors(
              profile[mode],
              profile.materials.panels,
              profile[mode].surface ?? colors.panel['--bg-secondary'],
            )
          : null;
        const composer = profile.materials?.composer
          ? materialColors(
              profile[mode],
              profile.materials.composer,
              profile[mode].surface ?? colors.panel['--bg-input'],
            )
          : null;
        return (
          <div
            className={s.mini}
            key={mode}
            style={{
              background: `${colors.background === 'none' ? '' : colors.background + ' center/cover '}${colors.chat['--bg-secondary']}`,
              color: colors.chat['--text-body'],
            }}
          >
            <aside
              style={{
                background: panel?.fill ?? colors.panel['--bg-secondary'],
                color: panel?.tokens['--text-body'] ?? colors.panel['--text-body'],
                backdropFilter: panel?.filter,
                boxShadow: panel?.shadow,
              }}
            />
            <div>
              <i />
              <i style={{ background: profile[mode].accent }} />
              <i />
              {composer && (
                <span
                  className={s.materialMini}
                  style={{
                    background: composer.fill,
                    color: composer.tokens['--text-body'],
                    backdropFilter: composer.filter,
                    boxShadow: composer.shadow,
                    borderColor: composer.border,
                    borderRadius: (composer.radius ?? profile.geometry.radius) / 2,
                  }}
                >
                  Aa
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
});
export function AppearancePanel({ initialDraft, onShellPreview }: {
  initialDraft?: AppearanceProfile;
  onShellPreview?: (profile: AppearanceProfile) => void;
} = {}) {
  const { t } = useTranslation(),
    query = useAppearance(),
    state = query.data ?? DEFAULT_APPEARANCE;
  const [draft, setDraft] = useState<AppearanceProfile | null>(() => initialDraft ? structuredClone(initialDraft) : null),
    [error, setError] = useState(''),
    [uploading, setUploading] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const importFile = useRef<HTMLInputElement>(null);
  const motionSample = useRef<HTMLDivElement>(null);
  const sampleAnimation = useRef<Animation | undefined>(undefined);
  const motion = draft ? appearanceMotionValues(draft.motion) : undefined;
  const motionPreset = motion ? selectedMotionPreset(motion) : 'none';
  useEffect(() => () => sampleAnimation.current?.cancel(), [draft?.motion]);
  useEffect(() => {
    const done = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (draft && detail.id === draft.id && detail.revision === draft.revision) setDraft(null);
    };
    window.addEventListener(APPEARANCE_APPLIED_EVENT, done);
    return () => window.removeEventListener(APPEARANCE_APPLIED_EVENT, done);
  }, [draft]);
  useEffect(() => {
    if (draft && getAppearancePreview()?.id === draft.id) {
      try {
        previewAppearance(parseAppearanceProfile(draft));
      } catch {}
    }
  }, [draft]);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (e: any) {
      if (Array.isArray(e?.diagnostics)) {
        setError(t('appearance.errors.appearance_build_failed') + '\n' + e.diagnostics
          .map((item: { file: string; line: number; column: number; message: string }) => `${item.file}:${item.line}:${item.column} ${item.message}`).join('\n'));
        return;
      }
      setError(
        t('appearance.errors.' + (e?.data?.error || e?.message), {
          defaultValue: t('appearance.failed'),
        }),
      );
    }
  };
  const open = (profile: AppearanceProfile) => {
    setError('');
    setDraft(structuredClone(profile));
    requestAnimationFrame(() =>
      editor.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    );
  };
  const importProfile = async (file: File) => {
    await run(async () => {
      if (file.size > 1_000_000) throw new Error('appearance_invalid');
      const profile = parseAppearanceProfile(JSON.parse((await file.text()).replace(/^\uFEFF/, '')));
      open({ ...profile, id: crypto.randomUUID(), revision: 0 });
    });
  };
  const exportProfile = (profile: AppearanceProfile) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = profile.id + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const duplicate = (profile: AppearanceProfile) =>
    open({
      ...profile,
      id: crypto.randomUUID(),
      revision: 0,
      name: profile.name + ' · ' + t('appearance.copy'),
    });
  const save = async (apply: boolean) => {
    if (!draft) return;
    await run(async () => {
      const profile = parseAppearanceProfile(draft);
      if (apply) await validateShell(profile);
      await query.change({ action: 'save', profile, apply });
      finishAppearancePreview(profile);
      setDraft(null);
    });
  };
  const input = (
    label: string,
    value: string | number,
    change: (value: string) => void,
    type = 'text',
    limits: any = {},
  ) => (
    <label key={label} className={s.field}>
      {label}
      <input
        className={a.fieldInput}
        type={type}
        value={value}
        {...limits}
        onChange={(e) => change(e.target.value)}
      />
    </label>
  );
  const options = (
    label: string,
    value: string,
    values: string[],
    change: (value: string) => void,
  ) => (
    <label className={s.field}>
      {label}
      <Select
        ariaLabel={label}
        value={value}
        options={values.map((value) => ({
          value,
          label: t('appearance.values.' + value, { defaultValue: value }),
        }))}
        onChange={change}
      />
    </label>
  );
  const part = <K extends 'typography' | 'geometry' | 'background' | 'motion'>(
    key: K,
    value: Partial<AppearanceProfile[K]>,
  ) => setDraft(draft ? { ...draft, [key]: { ...draft[key], ...value } } : null);
  const editMotion = (patch: Partial<AppearanceMotion>) => {
    if (motion) part('motion', { ...motion, ...patch, preset: 'custom' });
  };
  const playMotion = () => {
    if (!draft || !motionSample.current) return;
    const element = motionSample.current;
    sampleAnimation.current?.cancel();
    void run(async () => {
      sampleAnimation.current = animateMessageArrival(element, parseAppearanceMotion(draft.motion));
    });
  };
  const material = (region: 'panels' | 'composer', value: AppearanceMaterial | undefined) => {
    if (!draft) return;
    const materials = { ...draft.materials };
    if (value) materials[region] = value;
    else delete materials[region];
    const updated = { ...draft };
    if (Object.keys(materials).length) updated.materials = materials;
    else delete updated.materials;
    setDraft(updated);
  };
  const upload = async (file: File) => {
    setUploading(true);
    await run(async () => {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('appearance_image_invalid'));
        reader.readAsDataURL(file);
      });
      const result = await apiFetch<{ image: string }>('/api/v1/user/appearance/image', {
        method: 'POST',
        body: JSON.stringify({ base64: data }),
      });
      setDraft((current) =>
        current
          ? {
              ...current,
              background: { ...current.background, type: 'image', image: result.image },
            }
          : current,
      );
    });
    setUploading(false);
  };
  if (query.isPending) return <p className={s.hint}>{t('common.loading')}</p>;
  if (query.isError)
    return (
      <div className={s.section}>
        <p className={s.error}>{t('appearance.failed')}</p>
        <button className={a.cancelBtn} onClick={() => void query.refetch()}>
          {t('common.tryAgain')}
        </button>
      </div>
    );
  return (
    <section className={s.section}>
      <div className={s.heading}>
        <h3>{t('appearance.title')}</h3>
        <input ref={importFile} type="file" accept=".json,application/json" hidden
          aria-label={t('appearance.import')}
          onChange={event => {
            const file = event.target.files?.[0];
            if (file) void importProfile(file);
            event.target.value = '';
          }} />
        <button type="button" className={a.cancelBtn} onClick={() => importFile.current?.click()}>
          {t('appearance.import')}
        </button>
        <button
          className={a.saveBtn}
          disabled={query.saving || state.profiles.length >= 32}
          onClick={() =>
            open({ ...newAppearance(crypto.randomUUID()), name: t('appearance.newName') })
          }
        >
          {t('appearance.create')}
        </button>
      </div>
      <p className={s.hint}>
        {t('appearance.help')} {t('appearance.recoveryHint')}
      </p>
      {error && !draft && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      <div className={s.grid}>
        <article className={s.card} data-active={!state.activeId}>
          <AppearanceSample profile={STANDARD_SAMPLE} />
          <div className={s.name}>
            {t('appearance.standard')}
            {!state.activeId && <small>{t('appearance.active')}</small>}
          </div>
          <div className={s.actions}>
            <button
              className={a.cancelBtn}
              disabled={query.saving || !state.activeId}
              onClick={() =>
                void run(async () => {
                  await query.change({ action: 'activate', id: null, revision: state.revision });
                  previewAppearance(null);
                })
              }
            >
              {t('appearance.apply')}
            </button>
          </div>
        </article>
        {state.profiles.map((profile) => (
          <article className={s.card} key={profile.id} data-active={state.activeId === profile.id}>
            <AppearanceSample profile={profile} />
            <div className={s.name}>
              {profile.name}
              {state.activeId === profile.id && <small>{t('appearance.active')}</small>}
            </div>
            <div className={s.actions}>
              <button
                className={a.saveBtn}
                disabled={query.saving || state.activeId === profile.id}
                onClick={() =>
                  void run(async () => {
                    await query.change({
                      action: 'activate',
                      id: profile.id,
                      revision: state.revision,
                    });
                    previewAppearance(null);
                  })
                }
              >
                {t('appearance.apply')}
              </button>
              <button className={a.cancelBtn} disabled={query.saving} onClick={() => open(profile)}>
                {t('appearance.edit')}
              </button>
              <button type="button" className={a.cancelBtn} onClick={() => exportProfile(profile)}>
                {t('appearance.export')}
              </button>
              <button
                className={a.cancelBtn}
                disabled={query.saving || state.profiles.length >= 32}
                onClick={() => duplicate(profile)}
              >
                {t('appearance.copy')}
              </button>
              <button
                className={a.cancelBtn}
                disabled={query.saving}
                onClick={() =>
                  void run(async () => {
                    await query.change({
                      action: 'delete',
                      id: profile.id,
                      revision: state.revision,
                    });
                  })
                }
              >
                {t('common.delete')}
              </button>
            </div>
          </article>
        ))}
      </div>
      {draft && (
        <div ref={editor} className={s.editor}>
          <div className={s.heading}>
            <h3>{draft.name || t('appearance.newName')}</h3>
            <button
              className={a.cancelBtn}
              onClick={() => {
                previewAppearance(null);
                setDraft(null);
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
          <AppearanceSample profile={draft} />
          {input(t('appearance.name'), draft.name, (value) => setDraft({ ...draft, name: value }))}
          <div className={s.fields}>
            {(['light', 'dark'] as const).map((mode) => (
              <div className={s.colors} key={mode}>
                <strong>{t('appearance.' + mode)}</strong>
                {(['background', 'text', 'accent'] as const).map((key) => (
                  <label className={s.color} key={key}>
                    {t('appearance.' + (key === 'background' ? 'shellBackground' : key))}
                    <input
                      type="color"
                      aria-label={
                        t('appearance.' + mode) +
                        ' ' +
                        t('appearance.' + (key === 'background' ? 'shellBackground' : key))
                      }
                      value={draft[mode][key]}
                      onChange={(e) =>
                        setDraft({ ...draft, [mode]: { ...draft[mode], [key]: e.target.value } })
                      }
                    />
                  </label>
                ))}
                {(['surface', 'chat'] as const).map((key) => {
                  const colors = appearanceColors(draft, mode);
                  const label = t(
                    'appearance.' + (key === 'surface' ? 'panelBackground' : 'chatSolid'),
                  );
                  const fallback =
                    key === 'surface'
                      ? colors.panel['--bg-secondary']
                      : colors.chat['--bg-secondary'];
                  return (
                    <div className={s.color} key={key}>
                      <label>
                        {label}
                        <input
                          type="color"
                          aria-label={t('appearance.' + mode) + ' ' + label}
                          value={draft[mode][key] ?? fallback}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              [mode]: { ...draft[mode], [key]: event.target.value },
                            })
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className={a.cancelBtn}
                        disabled={draft[mode][key] === undefined}
                        aria-label={
                          t('appearance.' + mode) + ' ' + label + ' ' + t('appearance.auto')
                        }
                        onClick={() => {
                          const palette = { ...draft[mode] };
                          delete palette[key];
                          setDraft({ ...draft, [mode]: palette });
                        }}
                      >
                        {t('appearance.auto')}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <p className={s.hint}>{t('appearance.paletteHelp')}</p>
          <h4>{t('appearance.typography')}</h4>
          <div className={s.fields}>
            {(['uiFont', 'messageFont', 'codeFont'] as const).map((key) => (
              <label className={s.field} key={key}>
                {t('appearance.' + key)}
                <input
                  className={a.fieldInput}
                  list="appearance-fonts"
                  value={draft.typography[key]}
                  onChange={(e) => part('typography', { [key]: e.target.value })}
                />
              </label>
            ))}
            <datalist id="appearance-fonts">
              {APPEARANCE_FONTS.map((font) => (
                <option key={font} value={font} />
              ))}
            </datalist>
            {(['uiSize', 'messageSize', 'codeSize', 'lineHeight'] as const).map((key) =>
              input(
                t('appearance.' + key),
                draft.typography[key],
                (v) => part('typography', { [key]: Number(v) }),
                'number',
                {
                  min: key === 'lineHeight' ? 1.2 : key === 'codeSize' ? 11 : 12,
                  max:
                    key === 'lineHeight' ? 2 : key === 'uiSize' ? 20 : key === 'codeSize' ? 24 : 28,
                  step: key === 'lineHeight' ? 0.1 : 1,
                },
              ),
            )}
          </div>
          <p className={s.hint}>{t('appearance.fontHelp')}</p>
          <div className={s.fields}>
            <Slider
              mode="numeric"
              label={t('appearance.radius')}
              min={0}
              max={24}
              step={1}
              value={draft.geometry.radius}
              onChange={(v) => part('geometry', { radius: v ?? 8 })}
            />
            <Slider
              mode="numeric"
              label={t('appearance.density')}
              min={0.7}
              max={1.4}
              step={0.05}
              value={draft.geometry.density}
              formatValue={(v) => Math.round(v * 100) + '%'}
              onChange={(v) => part('geometry', { density: v ?? 1 })}
            />
          </div>
          <h4>{t('appearance.materialsTitle')}</h4>
          <p className={s.hint}>{t('appearance.materialsHelp')}</p>
          {draft.materials && (
            <>
              <p
                className={`${s.hint} ${s.materialReducedNotice}`}
                data-material-fallback="reduced"
                role="status"
              >
                {t('appearance.materialReducedNotice')}
              </p>
              <p className={`${s.hint} ${s.materialUnsupportedNotice}`} role="status">
                {t('appearance.materialUnsupportedNotice')}
              </p>
            </>
          )}

          <div className={s.fields}>
            {(['panels', 'composer'] as const).map((region) => {
              const value = draft.materials?.[region];
              const change = (patch: Partial<AppearanceMaterial>) =>
                material(region, { ...(value ?? DEFAULT_MATERIAL), ...patch });
              return (
                <div className={s.colors} key={region}>
                  <div className={s.heading}>
                    <strong>{t('appearance.materialRegions.' + region)}</strong>
                    <button
                      type="button"
                      className={a.cancelBtn}
                      aria-label={
                        t('appearance.materialRegions.' + region) + ' ' + t('appearance.auto')
                      }
                      disabled={!value}
                      onClick={() => material(region, undefined)}
                    >
                      {t('appearance.auto')}
                    </button>
                  </div>
                  <button
                    type="button"
                    className={a.cancelBtn}
                    disabled={!!value}
                    onClick={() =>
                      material(region, {
                        ...DEFAULT_MATERIAL,
                        opacity: 0.8,
                        blur: 16,
                        shadow: 'soft',
                      })
                    }
                  >
                    {value ? t('appearance.materialCustom') : t('appearance.materialEnable')}
                  </button>
                  {value && (
                    <>
                      {(['light', 'dark'] as const).some((mode) => {
                        const colors = appearanceColors(draft, mode);
                        const fill =
                          region === 'panels'
                            ? (draft[mode].surface ?? colors.panel['--bg-secondary'])
                            : (draft[mode].surface ?? colors.panel['--bg-input']);
                        return materialColors(draft[mode], value, fill).contrastRisk;
                      }) && (
                        <p className={s.hint} role="status">
                          {t('appearance.materialContrastHint')}
                        </p>
                      )}
                      <Slider
                        mode="numeric"
                        label={t('appearance.materialOpacity')}
                        min={0.55}
                        max={1}
                        step={0.05}
                        value={value.opacity}
                        formatValue={(v) => Math.round(v * 100) + '%'}
                        onChange={(v) => change({ opacity: v ?? 1 })}
                      />
                      <Slider
                        mode="numeric"
                        label={t('appearance.materialBlur')}
                        min={0}
                        max={32}
                        step={1}
                        value={value.blur}
                        formatValue={(v) => v + ' px'}
                        onChange={(v) => change({ blur: v ?? 0 })}
                      />
                      {options(
                        t('appearance.materialShadow'),
                        value.shadow,
                        ['none', 'soft', 'medium', 'strong'],
                        (v) => change({ shadow: v as AppearanceMaterial['shadow'] }),
                      )}
                      {options(
                        t('appearance.materialBorder'),
                        value.border,
                        ['none', 'subtle', 'defined'],
                        (v) => change({ border: v as AppearanceMaterial['border'] }),
                      )}
                      <Slider
                        mode="numeric"
                        label={t('appearance.materialRadius')}
                        min={0}
                        max={24}
                        step={1}
                        value={value.radius ?? draft.geometry.radius}
                        onChange={(v) => change({ radius: v ?? draft.geometry.radius })}
                      />
                      <button
                        type="button"
                        className={a.cancelBtn}
                        disabled={value.radius === undefined}
                        onClick={() => {
                          const next = { ...value };
                          delete next.radius;
                          material(region, next);
                        }}
                      >
                        {t('appearance.materialRadiusAuto')}
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <h4>{t('appearance.shellTitle')}</h4>
          <p className={s.hint}>{t('appearance.shellHelp')}</p>
          <label className={s.field}>
            <span>
              <input type="checkbox" checked={Boolean(draft.shell)}
                onChange={event => {
                  const updated = { ...draft };
                  if (event.target.checked)
                    updated.shell = { version: 1, language: 'html', source: '<main id="chats"></main>' };
                  else delete updated.shell;
                  setDraft(updated);
                }} />
              {t('appearance.shellEnable')}
            </span>
          </label>
          {draft.shell && (
            <>
              {options(t('appearance.shellScope'), draft.shell.scope ?? 'navigator', ['navigator', 'workspace'],
                scope => setDraft({ ...draft, shell: { ...draft.shell!, scope: scope as 'navigator' | 'workspace' } }))}
              <AppearanceShellEditor key={draft.id} shell={draft.shell}
                onChange={shell => setDraft({ ...draft, shell })} />
            </>
          )}
          <h4>{t('appearance.background')}</h4>
          <p className={s.hint}>{t('appearance.backgroundHelp')}</p>
          <div className={s.fields}>
            {options(
              t('appearance.backgroundType'),
              draft.background.type,
              ['solid', 'gradient', 'image'],
              (v) => part('background', { type: v as any }),
            )}
            {draft.background.type === 'gradient' && (
              <>
                {(['color', 'color2'] as const).map((key) => (
                  <label className={s.color} key={key}>
                    {t('appearance.' + key)}
                    <input
                      aria-label={t('appearance.' + key)}
                      type="color"
                      value={draft.background[key]}
                      onChange={(e) => part('background', { [key]: e.target.value })}
                    />
                  </label>
                ))}
                {input(
                  t('appearance.angle'),
                  draft.background.angle,
                  (v) => part('background', { angle: Number(v) }),
                  'number',
                  { min: 0, max: 360 },
                )}
              </>
            )}
            {draft.background.type === 'image' && (
              <>
                {input(
                  t('appearance.image'),
                  draft.background.image,
                  (v) => part('background', { image: v }),
                  'url',
                )}
                <label className={s.field}>
                  {t('appearance.upload')}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    disabled={uploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        if (f.size > 8 * 1024 * 1024)
                          setError(t('appearance.errors.appearance_image_invalid'));
                        else void upload(f);
                      }
                    }}
                  />
                </label>
                {options(
                  t('appearance.position'),
                  draft.background.position,
                  ['center', 'top', 'bottom'],
                  (v) => part('background', { position: v as any }),
                )}
                <Slider
                  mode="numeric"
                  label={t('appearance.dim')}
                  min={0}
                  max={0.9}
                  step={0.05}
                  value={draft.background.dim}
                  onChange={(v) => part('background', { dim: v ?? 0 })}
                />
              </>
            )}
          </div>
          <h4>{t('appearance.motion')}</h4>
          {motion && (
            <>
              <div className={s.fields}>
                {options(
                  t('appearance.motionPreset'),
                  motionPreset,
                  motionPreset === 'custom' ? [...motionPresets, 'custom'] : [...motionPresets],
                  (value) => {
                    if (value !== 'custom')
                      part('motion', APPEARANCE_MOTION_PRESETS[value as MotionPreset]);
                  },
                )}
                {motion.preset !== 'none' && (
                  <>
                    {input(
                      t('appearance.duration'),
                      motion.duration,
                      (v) => editMotion({ duration: Number(v) }),
                      'number',
                      { min: 0, max: 800, step: 1 },
                    )}
                    {input(
                      t('appearance.distance'),
                      motion.distance,
                      (v) => editMotion({ distance: Number(v) }),
                      'number',
                      { min: 0, max: 40, step: 'any' },
                    )}
                    {input(
                      t('appearance.scale'),
                      motion.scale,
                      (v) => editMotion({ scale: Number(v) }),
                      'number',
                      { min: 0.9, max: 1, step: 0.01 },
                    )}
                    {options(
                      t('appearance.easing'),
                      motion.easing,
                      ['ease-out', 'ease-in-out', 'linear'],
                      (value) => editMotion({ easing: value as AppearanceMotion['easing'] }),
                    )}
                  </>
                )}
              </div>
              <div className={s.motionPreview}>
                <div ref={motionSample} data-motion-sample className={s.motionMessage}>
                  <strong>Vega</strong>
                  <p>{t('appearance.motionExample')}</p>
                </div>
                <button
                  type="button"
                  className={a.cancelBtn}
                  onClick={playMotion}
                  disabled={motion.preset === 'none' || motion.duration === 0}
                >
                  {t('appearance.motionPlay')}
                </button>
              </div>
            </>
          )}
          <p className={s.hint}>{t('appearance.motionHelp')}</p>
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
          <div className={s.actions}>
            <button
              className={a.cancelBtn}
              disabled={uploading || query.saving}
              onClick={() =>
                void run(async () => {
                  const profile = parseAppearanceProfile(draft);
                  await validateShell(profile);
                  previewAppearance(profile);
                  if (profile.shell) onShellPreview?.(profile);
                })
              }
            >
              {t('appearance.preview')}
            </button>
            {state.activeId !== draft.id && (
              <button
                className={a.cancelBtn}
                disabled={uploading || query.saving}
                onClick={() => void save(false)}
              >
                {t('appearance.save')}
              </button>
            )}
            <button
              className={a.saveBtn}
              disabled={uploading || query.saving}
              onClick={() => void save(true)}
            >
              {t('appearance.saveApply')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
