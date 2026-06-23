import { useState, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import * as api from '../lib/api';
import type { SmartDeviceDto, SmartHomeSettingsDto } from '../lib/api';
import { ConfirmDialog } from './ConfirmDialog';
import s from './SettingsModal.module.scss';

export function SmartHomeSettings() {
  const [settings, setSettings] = useState<SmartHomeSettingsDto | null>(null);
  const [devices, setDevices] = useState<SmartDeviceDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [settingsRes, devicesRes] = await Promise.all([
        api.getSmartHomeSettings(),
        api.getSmartHomeDevices(),
      ]);
      setSettings(settingsRes.settings);
      setDevices(devicesRes.devices || []);
    } catch {
      toast.error('Не удалось загрузить настройки умного дома');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSaveToken = async () => {
    const token = tokenInput.trim();
    if (!token) { toast.error('Введите токен'); return; }
    setSavingToken(true);
    try {
      await api.setSmartHomeToken(token);
      toast.success('Токен сохранён');
      setTokenInput('');
      await loadData();
    } catch {
      toast.error('Ошибка сохранения токена');
    } finally {
      setSavingToken(false);
    }
  };

  const handleDeleteToken = async () => {
    setConfirmDelete(false);
    try {
      await api.deleteSmartHomeToken();
      toast.success('Токен и устройства удалены');
      setSettings(null);
      setDevices([]);
    } catch {
      toast.error('Ошибка удаления токена');
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await api.syncSmartHomeDevices();
      toast.success(`Синхронизировано устройств: ${result.synced}`);
      await loadData();
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('no_token')) toast.error('Сначала сохраните токен');
      else if (msg.includes('401')) toast.error('Неверный или истекший токен Яндекса');
      else toast.error('Ошибка синхронизации: ' + msg);
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return <div className={s.panel}><div className={s.promptLoading}>Загрузка...</div></div>;
  }

  const hasToken = !!settings?.has_token;

  return (
    <div className={s.panel}>
      <div className={s.panelTitle}>Умный дом (Яндекс)</div>

      {/* Token input */}
      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>OAuth-токен Яндекса</label>
        <div className={s.commandRow}>
          <input
            className={s.fieldInput}
            type={showToken ? 'text' : 'password'}
            placeholder={hasToken ? '•••••••• (токен сохранён)' : 'Вставьте токен (y0_...)'}
            value={tokenInput}
            onChange={e => setTokenInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !savingToken) handleSaveToken(); }}
          />
          <button
            className={s.macroActionBtn}
            onClick={() => setShowToken(v => !v)}
            title={showToken ? 'Скрыть' : 'Показать'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {showToken ? (
                <>
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </>
              ) : (
                <>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              )}
            </svg>
          </button>
        </div>
        <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
          <button
            className={s.saveBtn}
            onClick={handleSaveToken}
            disabled={savingToken || !tokenInput.trim()}
          >
            {savingToken ? 'Сохранение...' : 'Сохранить токен'}
          </button>
          {hasToken && (
            <button
              className={s.cancelBtn}
              style={{ color: '#e74c3c' }}
              onClick={() => setConfirmDelete(true)}
            >
              Удалить
            </button>
          )}
        </div>
        {settings?.synced_at && (
          <div className={s.fieldLabel} style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
            Последняя синхронизация: {new Date(settings.synced_at * 1000).toLocaleString('ru-RU')}
          </div>
        )}
      </div>

      {/* Sync + devices */}
      {hasToken && (
        <>
          <div className={s.macroFormDivider} />

          <div className={s.fieldGroup}>
            <span className={s.fieldLabel} style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px', display: 'block' }}>
              Синхронизация устройств
            </span>
            <span className={s.fieldLabel} style={{ marginBottom: '8px', display: 'block' }}>
              Загрузить актуальный список устройств и групп из Яндекса
            </span>
            <button
              className={s.saveBtn}
              onClick={handleSync}
              disabled={syncing}
            >
              {syncing ? 'Синхронизация...' : 'Синхронизировать'}
            </button>
          </div>

          {devices.length > 0 && (
            <div className={s.fieldGroup}>
              <div className={s.fieldLabel} style={{ marginBottom: '8px' }}>
                Устройства ({devices.length})
              </div>
              {devices.map(d => (
                <div key={d.id} className={s.macroCard}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontWeight: 500, fontSize: '13px' }}>{d.name}</span>
                      {d.is_group && (
                        <span style={{
                          fontSize: '10px', padding: '1px 6px', borderRadius: '3px',
                          background: 'var(--border-light)', color: 'var(--text-muted)',
                        }}>
                          группа
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
                          <code key={c} style={{
                            fontSize: '10px', color: 'var(--accent)',
                            padding: '1px 6px', borderRadius: '3px',
                            background: 'var(--bg-elevated)',
                          }}>
                            {c}
                          </code>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {devices.length === 0 && !syncing && (
            <div className={s.fieldGroup}>
              <div className={s.fieldLabel} style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
                Устройства не синхронизированы. Нажмите кнопку выше.
              </div>
            </div>
          )}
        </>
      )}

      {/* Guide */}
      <div className={s.fieldGroup}>
        <div className={s.macroFormDivider} />
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
          <span>Как получить токен Яндекс.Умного Дома</span>
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
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
              <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>1. Создание приложения</span><br />
              Перейдите на сайт <code style={{ color: 'var(--accent)' }}>oauth.yandex.ru</code>. Нажмите «Создать приложение».
            </div>
            <div style={{ marginBottom: '10px' }}>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>2. Параметры</span><br />
              Название: любое (например, Chatter IoT). Платформа: «Веб-сервисы».<br />
              Redirect URI: <code style={{ color: 'var(--accent)' }}>https://oauth.yandex.ru/verification_code</code>
            </div>
            <div style={{ marginBottom: '10px' }}>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>3. Доступы</span><br />
              В блоке «Умный дом Яндекса» отметьте:<br />
              — <code style={{ color: 'var(--accent)' }}>iot:view</code> (просмотр устройств)<br />
              — <code style={{ color: 'var(--accent)' }}>iot:control</code> (управление)<br />
              Нажмите «Создать приложение».
            </div>
            <div style={{ marginBottom: '10px' }}>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>4. Получение токена</span><br />
              Скопируйте <code style={{ color: 'var(--accent)' }}>Client ID</code>. Подставьте его в ссылку и перейдите:<br />
              <code style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>https://oauth.yandex.ru/authorize?response_type=token&client_id=ВАШ_CLIENT_ID</code><br />
              Нажмите «Разрешить» — откроется страница с токеном.
            </div>
            <div style={{ marginBottom: '10px' }}>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>5. Готово</span><br />
              Скопируйте токен (начинается с <code style={{ color: 'var(--accent)' }}>y0_...</code>) и вставьте в поле выше.
            </div>
            <div style={{
              padding: '8px 10px', borderRadius: '6px',
              background: 'var(--bg-modal-hover)', fontSize: '11px',
              color: 'var(--text-muted)',
            }}>
              Токен хранится на сервере в зашифрованном виде (AES-256). Никому не передавайте его — он даёт полный доступ к управлению устройствами.
            </div>
          </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          open={true}
          title="Удаление токена"
          text="Удалить токен и все синхронизированные устройства?"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={handleDeleteToken}
        />
      )}
    </div>
  );
}
