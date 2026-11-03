import { AnimatedCollapse } from './AnimatedDisclosure';
import { Icon } from './Icon';
import layout from './SmartHomeSettings.module.scss';
import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import * as api from '../lib/api';
import type { SmartDeviceDto, SmartHomeSettingsDto } from '../lib/api';
import { ConfirmDialog } from './ConfirmDialog';
import s from './SettingsModal.module.scss';

export function SmartHomeSettings() {
  const { t, i18n } = useTranslation();
  const [settings, setSettings] = useState<SmartHomeSettingsDto[]>([]);
  const [providerOpen, setProviderOpen] = useState<'zigbee' | 'yandex' | null>(null);
  const [deviceOpen, setDeviceOpen] = useState<string | null>(null);
  const [devices, setDevices] = useState<SmartDeviceDto[]>([]);
  const [loading, setLoading] = useState(true);

  // Yandex state
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const [confirmDeleteYandex, setConfirmDeleteYandex] = useState(false);

  // Zigbee state
  const [brokerInput, setBrokerInput] = useState('');
  const [savingBroker, setSavingBroker] = useState(false);
  const [confirmDeleteZigbee, setConfirmDeleteZigbee] = useState(false);

  // Sync state
  const [syncingProvider, setSyncingProvider] = useState<string | null>(null);

  // Guide
  const [showGuide, setShowGuide] = useState(false);
  const [showZigbeeGuide, setShowZigbeeGuide] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [settingsRes, devicesRes] = await Promise.all([
        api.getSmartHomeSettings(),
        api.getSmartHomeDevices(),
      ]);
      setSettings(settingsRes.settings || []);
      setDevices(devicesRes.devices || []);
    } catch {
      toast.error(t('advanced.smart.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Yandex handlers ──

  const handleSaveToken = async () => {
    const token = tokenInput.trim();
    if (!token) { toast.error(t('advanced.smart.enterToken')); return; }
    setSavingToken(true);
    try {
      await api.setSmartHomeToken(token);
      toast.success(t('advanced.smart.tokenSaved'));
      setTokenInput('');
      await loadData();
    } catch {
      toast.error(t('advanced.smart.tokenSaveFailed'));
    } finally {
      setSavingToken(false);
    }
  };

  const handleDeleteYandex = async () => {
    setConfirmDeleteYandex(false);
    try {
      await api.deleteSmartHomeToken();
      toast.success(t('advanced.smart.tokenDeleted'));
      await loadData();
    } catch {
      toast.error(t('advanced.smart.tokenDeleteFailed'));
    }
  };

  // ── Zigbee handlers ──

  const handleSaveBroker = async () => {
    const url = brokerInput.trim();
    if (!url) return;
    setSavingBroker(true);
    try {
      await api.setZigbeeBroker(url);
      toast.success(t('advanced.smart.zigbee.brokerSaved'));
      setBrokerInput('');
      await loadData();
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('invalid_broker_url')) toast.error(t('advanced.smart.zigbee.invalidUrl'));
      else toast.error(t('advanced.smart.zigbee.brokerSaveFailed'));
    } finally {
      setSavingBroker(false);
    }
  };

  const handleDeleteZigbee = async () => {
    setConfirmDeleteZigbee(false);
    try {
      await api.deleteZigbeeBroker();
      toast.success(t('advanced.smart.zigbee.brokerDeleted'));
      await loadData();
    } catch {
      toast.error(t('advanced.smart.zigbee.brokerDeleteFailed'));
    }
  };

  // ── Sync handler ──

  const handleSync = async (provider: string) => {
    setSyncingProvider(provider);
    try {
      const result = await api.syncSmartHomeDevices(provider);
      const label = provider === 'zigbee' ? 'Zigbee' : 'Yandex';
      toast.success(t('advanced.smart.zigbee.syncResult', { provider: label, count: result.synced }));
      await loadData();
    } catch (err: any) {
      const msg = err?.body?.detail || err?.body?.error || err?.message || '';
      if (msg.includes('no_token')) toast.error(t('advanced.smart.saveFirst'));
      else if (msg.includes('no_broker')) toast.error(t('advanced.smart.zigbee.saveBrokerFirst'));
      else toast.error(t('advanced.smart.zigbee.syncError', { message: msg }));
    } finally {
      setSyncingProvider(null);
    }
  };

  if (loading) {
    return <div className={s.panel}><div className={s.promptLoading}>{t('common.loading')}</div></div>;
  }

  const yandexSettings = settings.find(x => x.provider === 'yandex') || null;
  const zigbeeSettings = settings.find(x => x.provider === 'zigbee') || null;
  const hasYandexToken = !!yandexSettings?.has_token;
  const hasZigbeeBroker = !!zigbeeSettings?.has_token;
  const copy = (key: string) => t(`advanced.smart.layout.${key}`);
  const connections = [
    { id: 'yandex' as const, label: 'Yandex', configured: hasYandexToken, syncedAt: yandexSettings?.synced_at },
    { id: 'zigbee' as const, label: 'Zigbee2MQTT', configured: hasZigbeeBroker, syncedAt: zigbeeSettings?.synced_at },
  ];

  return (
    <div className={s.panel}>
      <div className={s.panelTitle}>{copy('title')}</div>
      <section className={layout.group}>
        <h3>{t('advanced.smart.devicesCount', { count: devices.length })}</h3>
        {!devices.length && <p className={layout.meta}>{hasYandexToken || hasZigbeeBroker ? t('advanced.smart.notSynced') : copy('empty')}</p>}
        {devices.map(device => {
          const id = `${device.provider}:${device.id}`;
          const expanded = deviceOpen === id;
          return <div className={layout.device} key={id}>
            <button type="button" className={layout.deviceButton} aria-expanded={expanded} onClick={() => setDeviceOpen(expanded ? null : id)}>
              <span className={layout.icon}><Icon name="monitor" size={17} /></span>
              <span className={layout.info}>
                <strong>{device.name}</strong>
                <span className={layout.meta}>{[device.room_name, connections.find(item => item.id === device.provider)?.label ?? device.provider, device.is_group && t('advanced.smart.group')].filter(Boolean).join(' · ')}</span>
              </span>
              <svg className={layout.chevron} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="m9 5 7 7-7 7" />
              </svg>
            </button>
            <AnimatedCollapse open={expanded}>
              <div className={layout.capabilities}>
                {device.type && <code>{device.type.replace('devices.types.', '')}</code>}
                {[...new Set(device.capabilities)].map(capability => <code key={capability}>{capability}</code>)}
                {!device.type && !device.capabilities.length && <span className={layout.meta}>{copy('noDetails')}</span>}
              </div>
            </AnimatedCollapse>
          </div>;
        })}
      </section>
      <section className={layout.group}>
        <h3>{copy('connections')}</h3>
        {connections.map(connection => {
          const expanded = providerOpen === connection.id;
          return <div className={layout.connection} key={connection.id}>
            <div className={layout.connectionHeader}>
              <span className={layout.icon}><Icon name="globe" size={17} /></span>
              <div className={layout.info}>
                <strong>{connection.label}</strong>
                <span className={layout.meta}>{copy(connection.configured ? 'configured' : 'notConfigured')}</span>
                {connection.syncedAt ? <span className={layout.meta}>{t('advanced.smart.lastSyncWithDate', {
                  date: new Date(connection.syncedAt * 1000).toLocaleString(i18n.resolvedLanguage || i18n.language),
                })}</span> : null}
              </div>
              <div className={layout.actions}>
                {connection.configured && <button type="button" className={s.cancelBtn} disabled={!!syncingProvider} onClick={() => handleSync(connection.id)}>
                  {t(syncingProvider === connection.id ? 'advanced.smart.syncing' : 'advanced.smart.sync')}
                </button>}
                <button type="button" className={s.cancelBtn} aria-expanded={expanded} onClick={() => setProviderOpen(expanded ? null : connection.id)}>
                  {copy(expanded ? 'collapse' : 'configure')}
                </button>
              </div>
            </div>
            <AnimatedCollapse open={expanded}>
              <div className={layout.configuration}>
                {connection.id === 'zigbee' ? <>
      <div className={s.fieldGroup}>
        <label className={s.fieldLabel} style={{ fontWeight: 600 }}>
          {t('advanced.smart.zigbee.title')}
        </label>
        <div className={s.commandRow}>
          <input
            className={s.fieldInput}
            type="text"
            placeholder={hasZigbeeBroker ? t('advanced.smart.zigbee.savedPlaceholder') : t('advanced.smart.zigbee.placeholder')}
            value={brokerInput}
            onChange={e => setBrokerInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !savingBroker) handleSaveBroker(); }}
          />
        </div>
        <div className={s.fieldLabel} style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
          {t('advanced.smart.zigbee.helpText')}
        </div>
        <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
          <button className={s.saveBtn} onClick={handleSaveBroker} disabled={savingBroker || !brokerInput.trim()}>
            {savingBroker ? t('common.saving') : t('advanced.smart.layout.saveBroker')}
          </button>
          {hasZigbeeBroker && (
            <button className={s.cancelBtn} style={{ color: 'var(--color-error)' }} onClick={() => setConfirmDeleteZigbee(true)}>
              {t('common.delete')}
            </button>
          )}
        </div>
      </div>

      {/* ── Zigbee Guide ── */}
      <div className={s.fieldGroup}>
        <button
          onClick={() => setShowZigbeeGuide(v => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: showZigbeeGuide ? 'var(--accent-icon)' : 'var(--text-muted)',
            fontSize: '13px', fontWeight: 500, padding: 0,
            transition: 'color 0.1s',
          }}
        >
          <span>{t('advanced.smart.zigbee.guideTitle')}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ transition: 'transform 0.15s', transform: showZigbeeGuide ? 'rotate(180deg)' : 'none' }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        <AnimatePresence initial={false}>
          {showZigbeeGuide && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto', transition: { duration: 0.2, ease: 'easeOut' } }}
              exit={{ opacity: 0, height: 0, transition: { duration: 0.15 } }}
              style={{ overflow: 'hidden' }}
            >
              <div className={s.fieldLabel} style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: 1.7, marginTop: '10px' }}>
                <div style={{ marginBottom: '10px' }}>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('advanced.smart.zigbee.step1')}</span><br />
                  {t('advanced.smart.zigbee.step1Text')}
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('advanced.smart.zigbee.step2')}</span><br />
                  {t('advanced.smart.zigbee.step2Text')}<br />
                  <code style={{ color: 'var(--accent)' }}>{'mqtt:\n  server: mqtt://localhost:1883'}</code>
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('advanced.smart.zigbee.step3')}</span><br />
                  {t('advanced.smart.zigbee.step3Text')}
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('advanced.smart.zigbee.step4')}</span><br />
                  {t('advanced.smart.zigbee.step4Text')}<br />
                  <code style={{ color: 'var(--accent)' }}>mqtt://192.168.1.100:1883</code><br />
                  <code style={{ color: 'var(--accent)' }}>mqtts://user:password@mqtt.example.com:8883</code>
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('advanced.smart.zigbee.step5')}</span><br />
                  {t('advanced.smart.zigbee.step5Text')}
                </div>
                <div style={{ padding: '8px 10px', borderRadius: '6px', background: 'var(--bg-modal-hover)', fontSize: '11px', color: 'var(--text-muted)' }}>
                  {t('advanced.smart.zigbee.note')}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

                </> : <>
      <div className={s.fieldGroup}>
        <label className={s.fieldLabel} style={{ fontWeight: 600 }}>
          Yandex
        </label>
        <div className={s.commandRow}>
          <input
            className={s.fieldInput}
            type={showToken ? 'text' : 'password'}
            placeholder={hasYandexToken ? t('advanced.smart.savedPlaceholder') : t('advanced.smart.tokenPlaceholder')}
            value={tokenInput}
            onChange={e => setTokenInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !savingToken) handleSaveToken(); }}
          />
          <button className={s.macroActionBtn} onClick={() => setShowToken(v => !v)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {showToken ? (
                <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></>
              ) : (
                <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>
              )}
            </svg>
          </button>
        </div>
        <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
          <button className={s.saveBtn} onClick={handleSaveToken} disabled={savingToken || !tokenInput.trim()}>
            {savingToken ? t('common.saving') : t('advanced.smart.saveToken')}
          </button>
          {hasYandexToken && (
            <button className={s.cancelBtn} style={{ color: 'var(--color-error)' }} onClick={() => setConfirmDeleteYandex(true)}>
              {t('common.delete')}
            </button>
          )}
        </div>
      </div>

      {/* ── Yandex Guide ── */}
      <div className={s.fieldGroup}>
        <button
          onClick={() => setShowGuide(v => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: showGuide ? 'var(--accent-icon)' : 'var(--text-muted)',
            fontSize: '13px', fontWeight: 500, padding: 0,
            transition: 'color 0.1s',
          }}
        >
          <span>{t('advanced.smart.instructionsTitle')}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ transition: 'transform 0.15s', transform: showGuide ? 'rotate(180deg)' : 'none' }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        <AnimatePresence initial={false}>
          {showGuide && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto', transition: { duration: 0.2, ease: 'easeOut' } }}
              exit={{ opacity: 0, height: 0, transition: { duration: 0.15 } }}
              style={{ overflow: 'hidden' }}
            >
              <div className={s.fieldLabel} style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: 1.7, marginTop: '10px' }}>
                <div style={{ marginBottom: '10px' }}>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('advanced.smart.step1')}</span><br />
                  {t('advanced.smart.goToSite')} <code style={{ color: 'var(--accent)' }}>oauth.yandex.ru</code>{t('advanced.smart.clickCreate')}
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('advanced.smart.step2')}</span><br />
                  {t('advanced.smart.parameters')}<br />
                  Redirect URI: <code style={{ color: 'var(--accent)' }}>https://oauth.yandex.ru/verification_code</code>
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('advanced.smart.step3')}</span><br />
                  {t('advanced.smart.selectScopes')}<br />
                  — <code style={{ color: 'var(--accent)' }}>iot:view</code> {t('advanced.smart.viewDevices')}<br />
                  — <code style={{ color: 'var(--accent)' }}>iot:control</code> {t('advanced.smart.controlDevices')}<br />
                  {t('advanced.smart.createApplication')}
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('advanced.smart.step4')}</span><br />
                  {t('advanced.smart.copy')} <code style={{ color: 'var(--accent)' }}>Client ID</code>{t('advanced.smart.insertClientId')}<br />
                  <code style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>{t('advanced.smart.authorizeUrl')}</code><br />
                  {t('advanced.smart.allow')}
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('advanced.smart.step5')}</span><br />
                  {t('advanced.smart.copyToken')} <code style={{ color: 'var(--accent)' }}>y0_...</code>{t('advanced.smart.pasteAbove')}
                </div>
                <div style={{ padding: '8px 10px', borderRadius: '6px', background: 'var(--bg-modal-hover)', fontSize: '11px', color: 'var(--text-muted)' }}>
                  {t('advanced.smart.security')}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

                </>}
              </div>
            </AnimatedCollapse>
          </div>;
        })}
      </section>

      {confirmDeleteYandex && (
        <ConfirmDialog open={true} title={t('advanced.smart.deleteTitle')} text={t('advanced.smart.deleteMessage')}
          onCancel={() => setConfirmDeleteYandex(false)} onConfirm={handleDeleteYandex} />
      )}
      {confirmDeleteZigbee && (
        <ConfirmDialog open={true} title={t('advanced.smart.zigbee.deleteTitle')} text={t('advanced.smart.zigbee.deleteMessage')}
          onCancel={() => setConfirmDeleteZigbee(false)} onConfirm={handleDeleteZigbee} />
      )}
    </div>
  );
}
