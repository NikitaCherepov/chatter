'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

export type MonitorSettingsData = {
  enabled: boolean;
  intervalMinutes: number;
  action: 'notify' | 'cheapest' | 'throughput' | 'latency';
  recipientsMode: 'all_admins' | 'selected';
  recipientUserIds: number[];
  priceTracking: 'off' | 'notify' | 'update';
  priceThresholdPct: number;
};

export type MonitorStateData = {
  model_id: string;
  route: string | null;
  model_slug: string | null;
  provider_slug: string | null;
  status: 'unknown' | 'available' | 'missing' | 'check_failed' | 'model_missing';
  last_ok_at: number | null;
  last_check_at: number | null;
  consecutive_missing: number;
  unavailable_since: number | null;
  last_notified_at: number | null;
  previous_provider_slug: string | null;
  replacement_provider_slug: string | null;
  last_error: string | null;
  last_seen_prices?: string | null;
};

export type MonitorStatusData = {
  settings: MonitorSettingsData;
  states: MonitorStateData[];
  models: Array<{ uniqueId: string; route: string; modelSlug: string }>;
  admins: Array<{ id: number; name: string | null; hasTelegram: boolean }>;
};

const MONITOR_UPDATED_EVENT = 'chatter:openrouter-monitor-updated';

let cachedStatus: MonitorStatusData | null = null;
let inflight: Promise<MonitorStatusData> | null = null;

const loadStatus = async (force = false): Promise<MonitorStatusData> => {
  if (!force && cachedStatus) return cachedStatus;
  if (!force && inflight) return inflight;
  inflight = api<MonitorStatusData>('/api/openrouter-monitor/status')
    .then((data) => {
      cachedStatus = data;
      return data;
    })
    .finally(() => { inflight = null; });
  return inflight;
};

/**
 * Shared monitor status hook. One request per page load; every instance
 * refreshes together via a window event (e.g. after Check now / settings save).
 */
export function useOpenRouterMonitorStatus() {
  const [status, setStatus] = useState<MonitorStatusData | null>(cachedStatus);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const data = await loadStatus(force);
      setStatus(data);
    } catch {
      // status endpoint unavailable (old manager) — keep whatever we had
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(false);
    const handler = () => { void refresh(true); };
    window.addEventListener(MONITOR_UPDATED_EVENT, handler);
    return () => window.removeEventListener(MONITOR_UPDATED_EVENT, handler);
  }, [refresh]);

  const notifyOthers = useCallback(() => {
    window.dispatchEvent(new Event(MONITOR_UPDATED_EVENT));
  }, []);

  const checkModels = useCallback(async (modelIds?: string[]) => {
    await api<{ ok: boolean }>('/api/openrouter-monitor/check', {
      method: 'POST',
      body: JSON.stringify(modelIds?.length ? { modelIds } : {}),
    });
    await refresh(true);
    notifyOthers();
  }, [refresh, notifyOthers]);

  const saveSettings = useCallback(async (patch: Partial<MonitorSettingsData>) => {
    const saved = await api<MonitorSettingsData>('/api/openrouter-monitor/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    await refresh(true);
    notifyOthers();
    return saved;
  }, [refresh, notifyOthers]);

  const sendTestNotification = useCallback(async (kind: 'missing' | 'price') => {
    return api<{ ok: boolean }>('/api/openrouter-monitor/test-notification', {
      method: 'POST',
      body: JSON.stringify({ kind }),
    });
  }, []);

  return { status, loading, refresh, checkModels, saveSettings, sendTestNotification };
}
