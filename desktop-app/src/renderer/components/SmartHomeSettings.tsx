import React, { useState, useEffect, useCallback } from 'react';
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

  const loadData = useCallback(async () => {
    try {
      const [settingsRes, devicesRes] = await Promise.all([
        api.getSmartHomeSettings(),
        api.getSmartHomeDevices(),
      ]);
      setSettings(settingsRes.settings);
      setDevices(devicesRes.devices || []);
    } catch (err: any) {
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
    } catch (err: any) {
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

  if (loading) return <div className={s.panelTitle}>Загрузка...</div>;

  const hasToken = !!settings?.has_token;

  return (
    <div>
      <div className={s.panelTitle}>Умный дом (Яндекс)</div>

      {/* Token section */}
      <div className={s.fieldGroup}>
        <label className={s.fieldLabel}>OAuth-токен Яндекса</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            className={s.fieldInput}
            type={showToken ? 'text' : 'password'}
            placeholder={hasToken ? '•••••••• (токен сохранён)' : 'Вставьте токен (y0_...)'}
            value={tokenInput}
            onChange={e => setTokenInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !savingToken) handleSaveToken(); }}
          />
          <button
            className={s.zoomBtn}
            onClick={() => setShowToken(v => !v)}
            title={showToken ? 'Скрыть' : 'Показать'}
          >
            {showToken ? '🙈' : '👁'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            className={s.saveBtn}
            onClick={handleSaveToken}
            disabled={savingToken || !tokenInput.trim()}
          >
            {savingToken ? 'Сохранение...' : 'Сохранить токен'}
          </button>
          {hasToken && (
            <button
              className={s.macroActionBtn}
              onClick={() => setConfirmDelete(true)}
              style={{ color: '#e74c3c' }}
            >
              Удалить токен
            </button>
          )}
        </div>
        {settings?.synced_at && (
          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
            Последняя синхронизация: {new Date(settings.synced_at * 1000).toLocaleString('ru-RU')}
          </div>
        )}
      </div>

      {/* Sync button */}
      {hasToken && (
        <div className={s.fieldGroup}>
          <button
            className={s.saveBtn}
            onClick={handleSync}
            disabled={syncing}
          >
            {syncing ? 'Синхронизация...' : '🔄 Синхронизировать устройства'}
          </button>
        </div>
      )}

      {/* Device list */}
      {devices.length > 0 && (
        <div className={s.fieldGroup}>
          <label className={s.fieldLabel}>Устройства ({devices.length})</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {devices.map(d => (
              <div key={d.id} className={s.macroCard} style={{ padding: '12px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span style={{ fontWeight: 600 }}>{d.name}</span>
                    {d.room_name && (
                      <span style={{ opacity: 0.6, marginLeft: 8 }}>📍 {d.room_name}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {d.is_group && (
                      <span style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 4,
                        background: 'rgba(255,255,255,0.08)', color: '#aaa',
                      }}>
                        группа
                      </span>
                    )}
                    <span style={{ fontSize: 11, opacity: 0.5 }}>
                      {d.provider}
                    </span>
                  </div>
                </div>
                {d.capabilities.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                    {d.capabilities.map(c => (
                      <span key={c} style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 4,
                        background: 'rgba(255,255,255,0.06)', color: '#999',
                      }}>
                        {c}
                      </span>
                    ))}
                  </div>
                )}
                <div style={{ fontSize: 11, opacity: 0.3, marginTop: 4, fontFamily: 'monospace' }}>
                  {d.id}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {hasToken && devices.length === 0 && !syncing && (
        <div className={s.fieldGroup} style={{ opacity: 0.6, textAlign: 'center' }}>
          Устройства не синхронизированы. Нажмите кнопку выше.
        </div>
      )}

      {/* Help */}
      {!hasToken && (
        <div className={s.fieldGroup} style={{ opacity: 0.6, fontSize: 13, lineHeight: 1.6 }}>
          <p style={{ margin: '0 0 8px' }}><b>Как получить токен:</b></p>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            <li>Перейдите на oauth.yandex.ru</li>
            <li>Создайте приложение (платформа — веб-сервисы)</li>
            <li>Права: «API Умного дома Яндекса»</li>
            <li>Получите отладочный OAuth-токен (y0_...)</li>
          </ol>
        </div>
      )}

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
