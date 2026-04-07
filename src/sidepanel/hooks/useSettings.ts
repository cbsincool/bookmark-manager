import { useState, useEffect, useCallback } from 'react';
import type { AppSettings } from '@/shared/types';
import { DEFAULT_SETTINGS } from '@/shared/constants';

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (resp) => {
      if (resp?.success) {
        setSettings(resp.data);
      }
      setIsLoading(false);
    });
  }, []);

  const updateSettings = useCallback(async (partial: Partial<AppSettings>) => {
    const optimistic = { ...settings, ...partial };
    setSettings(optimistic);
    await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: partial });
  }, [settings]);

  return { settings, updateSettings, isLoading };
}

export function useIndexStats() {
  const [stats, setStats] = useState<{ indexed: number; total: number } | null>(null);

  const refresh = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'GET_INDEX_STATS' }, (resp) => {
      if (resp?.success) setStats(resp.data);
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { stats, refresh };
}
