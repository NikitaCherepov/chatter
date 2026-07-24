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
  const hasAnyDevices = devices.length > 0;
  const yandexDevices = devices.filter(d => d.provider === 'yandex');
  const zigbeeDevices = devices.filter(d => d.provider === 'zigbee');

  const syncBadge = (provider: string) => {
    const s = settings.find(x => x.provider === provider);
    if (!s?.synced_at) return null;
    return (
      <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: '8px' }}>
        {new Date(s.synced_at * 1000).toLocaleString(i18n.resolvedLanguage || i18n.language, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}
      </span>
    );
  };

  return (
    <div className={s.panel}>
      <div className={s.panelTitle}>{t('advanced.smart.title')}</div>

      {/* ════════════ Zigbee ════════════ */}
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
            {savingBroker ? t('common.saving') : t('advanced.smart.saveToken')}
          </button>
          {hasZigbeeBroker && (
            <button className={s.cancelBtn} style={{ color: '#e74c3c' }} onClick={() => setConfirmDeleteZigbee(true)}>
              {t('common.delete')}
            </button>
          )}
          {hasZigbeeBroker && (
            <button className={s.saveBtn} onClick={() => handleSync('zigbee')} disabled={!!syncingProvider}>
              {syncingProvider === 'zigbee' ? t('advanced.smart.syncing') : t('advanced.smart.sync')}
            </button>
          )}
        </div>
        {zigbeeSettings?.synced_at && (
          <div className={s.fieldLabel} style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
            {t('advanced.smart.lastSyncWithDate', { date: new Date(zigbeeSettings.synced_at * 1000).toLocaleString(i18n.resolvedLanguage || i18n.language) })}
          </div>
        )}
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
                  <code style={{ color: 'var(--accent)' }}>mqtt://localhost:1883</code>
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

      {/* ════════════ Yandex ════════════ */}
      <div style={{ height: '1px', background: 'var(--border-light, #ccc)', margin: '16px 0', flexShrink: 0 }} />
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
            <button className={s.cancelBtn} style={{ color: '#e74c3c' }} onClick={() => setConfirmDeleteYandex(true)}>
              {t('common.delete')}
            </button>
          )}
          {hasYandexToken && (
            <button className={s.saveBtn} onClick={() => handleSync('yandex')} disabled={!!syncingProvider}>
              {syncingProvider === 'yandex' ? t('advanced.smart.syncing') : t('advanced.smart.sync')}
            </button>
          )}
        </div>
        {yandexSettings?.synced_at && (
          <div className={s.fieldLabel} style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
            {t('advanced.smart.lastSyncWithDate', { date: new Date(yandexSettings.synced_at * 1000).toLocaleString(i18n.resolvedLanguage || i18n.language) })}
          </div>
        )}
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

      {/* ════════════ Devices ════════════ */}
      <div style={{ height: '1px', background: 'var(--border-light, #ccc)', margin: '16px 0', flexShrink: 0 }} />
      {hasAnyDevices && (
        <>
          <div className={s.fieldGroup}>
            <div className={s.fieldLabel} style={{ marginBottom: '8px', fontWeight: 600 }}>
              {t('advanced.smart.devicesCount', { count: devices.length })}
            </div>

            {zigbeeDevices.length > 0 && (
              <>
                <div className={s.fieldLabel} style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', fontWeight: 600 }}>
                  Zigbee {syncBadge('zigbee')}
                </div>
                {zigbeeDevices.map(d => (
                  <div key={d.id} className={s.macroCard}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontWeight: 500, fontSize: '13px' }}>{d.name}</span>
                        {d.is_group && (
                          <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '3px', background: 'var(--border-light)', color: 'var(--text-muted)' }}>
                            {t('advanced.smart.group')}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {d.type || ''}
                      </div>
                      {d.capabilities.length > 0 && (
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '6px' }}>
                          {d.capabilities.map(c => (
                            <code key={c} style={{ fontSize: '10px', color: 'var(--accent)', padding: '1px 6px', borderRadius: '3px', background: 'var(--bg-elevated)' }}>
                              {c}
                            </code>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}

            {yandexDevices.length > 0 && (
              <>
                <div className={s.fieldLabel} style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', marginTop: zigbeeDevices.length > 0 ? '10px' : '0', fontWeight: 600 }}>
                  Yandex {syncBadge('yandex')}
                </div>
                {yandexDevices.map(d => (
                  <div key={d.id} className={s.macroCard}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontWeight: 500, fontSize: '13px' }}>{d.name}</span>
                        {d.is_group && (
                          <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '3px', background: 'var(--border-light)', color: 'var(--text-muted)' }}>
                            {t('advanced.smart.group')}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {d.room_name ? `📍 ${d.room_name}` : ''}
                        {d.room_name && d.type ? ' · ' : ''}
                        {d.type ? d.type.replace('devices.types.', '') : ''}
                      </div>
                      {d.capabilities.length > 0 && (
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '6px' }}>
                          {d.capabilities.map(c => (
                            <code key={c} style={{ fontSize: '10px', color: 'var(--accent)', padding: '1px 6px', borderRadius: '3px', background: 'var(--bg-elevated)' }}>
                              {c}
                            </code>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}

      {!hasAnyDevices && (hasYandexToken || hasZigbeeBroker) && !syncingProvider && (
        <div className={s.fieldGroup}>
          <div className={s.fieldLabel} style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
            {t('advanced.smart.notSynced')}
          </div>
        </div>
      )}

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
