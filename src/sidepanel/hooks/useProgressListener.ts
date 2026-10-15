import { useEffect, useRef, useState } from 'react';

export interface ProgressState {
  current: number;
  total: number;
  message: string;
}

export function useProgressListener(messageType: string): {
  progress: ProgressState | null;
  clearProgress: () => void;
} {
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (msg: { type: string; current?: number; total?: number; message?: string }) => {
      if (msg.type !== messageType) return;
      if (msg.current === undefined || msg.total === undefined) return;

      setProgress({ current: msg.current, total: msg.total, message: msg.message ?? '' });

      // Auto-clear after completion
      if (msg.current >= msg.total) {
        if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
        clearTimerRef.current = setTimeout(() => setProgress(null), 2000);
      }
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => {
      chrome.runtime.onMessage.removeListener(handler);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, [messageType]);

  const clearProgress = () => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    setProgress(null);
  };

  return { progress, clearProgress };
}
