import React, { useState, useEffect, useCallback } from 'react';
import { useSettings, useIndexStats } from '../hooks/useSettings';
import { setLocale } from '../i18n';
import { t } from '../i18n';
import { useProgressListener } from '../hooks/useProgressListener';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      {children}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between">
      <span className="text-sm text-gray-600">{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4 text-primary rounded" />
    </label>
  );
}

interface TextInputProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: (v: string) => void;
  type?: string;
  placeholder?: string;
}

function TextInput({ label, value, onChange, onBlur, type = 'text', placeholder }: TextInputProps) {
  return (
    <label className="block">
      <span className="text-sm text-gray-600">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onBlur(e.target.value)}
        className="w-full mt-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-400"
      />
    </label>
  );
}

export function SettingsPage() {
  const { settings, updateSettings, isLoading } = useSettings();
  const { stats, refresh: refreshStats } = useIndexStats();
  const [testResult, setTestResult] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isRebuilding, setIsRebuilding] = useState(false);

  const { progress: rebuildProgress } = useProgressListener('REBUILD_INDEX_PROGRESS');

  // Local state for text inputs to avoid async writes on every keystroke
  const [apiEndpoint, setApiEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiModel, setApiModel] = useState('');
  const [embeddingEndpoint, setEmbeddingEndpoint] = useState('');
  const [rerankerEndpoint, setRerankerEndpoint] = useState('');

  // Sync local state only once when settings finish loading
  useEffect(() => {
    if (!isLoading) {
      setApiEndpoint(settings.apiEndpoint);
      setApiKey(settings.apiKey);
      setApiModel(settings.apiModel);
      setEmbeddingEndpoint(settings.embeddingEndpoint);
      setRerankerEndpoint(settings.rerankerEndpoint);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  const handleBlurEndpoint = useCallback((v: string) => { updateSettings({ apiEndpoint: v }); setTestResult(null); }, [updateSettings]);
  const handleBlurKey = useCallback((v: string) => { updateSettings({ apiKey: v }); setTestResult(null); }, [updateSettings]);
  const handleBlurModel = useCallback((v: string) => { updateSettings({ apiModel: v }); setTestResult(null); }, [updateSettings]);
  const handleBlurEmbedding = useCallback((v: string) => { updateSettings({ embeddingEndpoint: v }); }, [updateSettings]);
  const handleBlurReranker = useCallback((v: string) => { updateSettings({ rerankerEndpoint: v }); }, [updateSettings]);

  if (isLoading) {
    return <div className="p-4 text-gray-400">Loading...</div>;
  }

  const handleTestConnection = async () => {
    setTestResult(null);
    setIsTesting(true);
    await updateSettings({ apiEndpoint, apiKey, apiModel });
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'TEST_AI_CONNECTION' });
      if (resp?.success) {
        const { ok, message } = resp.data as { ok: boolean; message: string };
        setTestResult(ok ? `✅ ${message}` : `❌ ${message}`);
      } else {
        setTestResult(`❌ ${resp?.error ?? t('settings.ai.testFailed')}`);
      }
    } catch (err) {
      setTestResult(`❌ ${t('settings.ai.connectFailed', { error: err instanceof Error ? err.message : String(err) })}`);
    } finally {
      setIsTesting(false);
    }
  };

  const handleRebuildIndex = async () => {
    setIsRebuilding(true);
    try {
      await chrome.runtime.sendMessage({ type: 'REBUILD_INDEX' });
      await refreshStats();
    } finally {
      setIsRebuilding(false);
    }
  };

  return (
    <div className="p-4 space-y-4 overflow-y-auto">
      <h2 className="text-base font-semibold text-gray-800">{t('settings.title')}</h2>

      <Section title={t('settings.ai.title')}>
        <label className="block">
          <span className="text-sm text-gray-600">{t('settings.ai.format')}</span>
          <select
            value={settings.apiFormat ?? 'openai'}
            onChange={(e) => { updateSettings({ apiFormat: e.target.value as 'openai' | 'anthropic' }); setTestResult(null); }}
            className="w-full mt-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-400"
          >
            <option value="openai">{t('settings.ai.format.openai')}</option>
            <option value="anthropic">{t('settings.ai.format.anthropic')}</option>
          </select>
        </label>
        <TextInput
          label={t('settings.ai.endpoint')}
          value={apiEndpoint}
          onChange={setApiEndpoint}
          onBlur={handleBlurEndpoint}
          placeholder={settings.apiFormat === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'}
        />
        <TextInput
          label={`${t('settings.ai.key')} (${settings.apiFormat === 'anthropic' ? t('settings.ai.keyOptional') : t('settings.ai.keyRequired')})`}
          value={apiKey}
          onChange={setApiKey}
          onBlur={handleBlurKey}
          type="password"
          placeholder={settings.apiFormat === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
        />
        <TextInput
          label={t('settings.ai.model')}
          value={apiModel}
          onChange={setApiModel}
          onBlur={handleBlurModel}
          placeholder={settings.apiFormat === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-4o-mini'}
        />
        <div className="space-y-2">
          <button
            onClick={handleTestConnection}
            disabled={isTesting || !apiEndpoint || !apiModel}
            className="flex items-center gap-2 px-3 py-1.5 text-xs bg-primary text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isTesting && (
              <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />
            )}
            {isTesting ? t('settings.ai.testing') : t('settings.ai.testConnection')}
          </button>
          {(!apiEndpoint || !apiModel) && (
            <p className="text-xs text-gray-400">{t('settings.ai.fillFirst')}</p>
          )}
          {testResult && (
            <div className={`px-3 py-2 rounded-lg text-xs whitespace-pre-wrap break-all border-l-2 ${testResult.startsWith('✅') ? 'border-l-success text-gray-700 bg-gray-50' : 'border-l-danger text-danger bg-gray-50'}`}>
              {testResult}
            </div>
          )}
        </div>
      </Section>

      <Section title={t('settings.semantic.title')}>
        <TextInput
          label={t('settings.semantic.embedding')}
          value={embeddingEndpoint}
          onChange={setEmbeddingEndpoint}
          onBlur={handleBlurEmbedding}
          placeholder="http://localhost:8080"
        />
        <TextInput
          label={t('settings.semantic.reranker')}
          value={rerankerEndpoint}
          onChange={setRerankerEndpoint}
          onBlur={handleBlurReranker}
          placeholder="http://localhost:8081"
        />
        <p className="text-xs text-gray-400">{t('settings.semantic.hint')}</p>
      </Section>

      <Section title={t('settings.search.title')}>
        <label className="block">
          <span className="text-sm text-gray-600">{t('settings.search.fuzzyWeight')}: {settings.searchFuzzyWeight}</span>
          <input type="range" min="0" max="1" step="0.1" value={settings.searchFuzzyWeight}
            onChange={(e) => {
              const fuzzy = parseFloat(e.target.value);
              updateSettings({ searchFuzzyWeight: fuzzy, searchSemanticWeight: 1 - fuzzy });
            }}
            className="w-full"
          />
        </label>
        <label className="block">
          <span className="text-sm text-gray-600">{t('settings.search.collapseThreshold')}: {settings.collapseThreshold}</span>
          <input type="range" min="0.7" max="0.95" step="0.05" value={settings.collapseThreshold}
            onChange={(e) => updateSettings({ collapseThreshold: parseFloat(e.target.value) })}
            className="w-full"
          />
        </label>
      </Section>

      <Section title={t('settings.organize.title')}>
        <Toggle label={t('settings.organize.realtimeArchiving')} checked={settings.realtimeArchiving} onChange={(v) => updateSettings({ realtimeArchiving: v })} />
        <Toggle label={t('settings.organize.onlyUseExistingDirectories')} checked={settings.onlyUseExistingDirectories} onChange={(v) => updateSettings({ onlyUseExistingDirectories: v })} />
        <label className="block">
          <span className="text-sm text-gray-600">{t('settings.organize.maxDepth')}: {settings.organizeMaxDepth ?? 3}</span>
          <input
            type="range" min="1" max="3" step="1"
            value={settings.organizeMaxDepth ?? 3}
            onChange={(e) => updateSettings({ organizeMaxDepth: parseInt(e.target.value) as 1 | 2 | 3 })}
            className="w-full"
          />
          <span className="text-xs text-gray-400">{t('settings.organize.maxDepthHint')}</span>
        </label>
      </Section>

      <Section title={t('settings.dedup.title')}>
        <Toggle label={t('settings.dedup.stripUtm')} checked={settings.urlNormStripUtm} onChange={(v) => updateSettings({ urlNormStripUtm: v })} />
        <Toggle label={t('settings.dedup.stripTrailingSlash')} checked={settings.urlNormStripTrailingSlash} onChange={(v) => updateSettings({ urlNormStripTrailingSlash: v })} />
        <Toggle label={t('settings.dedup.stripHash')} checked={settings.urlNormStripHash} onChange={(v) => updateSettings({ urlNormStripHash: v })} />
      </Section>

      <Section title={t('settings.language')}>
        <select
          value={settings.language}
          onChange={(e) => {
            const lang = e.target.value as 'en' | 'zh';
            updateSettings({ language: lang });
            setLocale(lang);
          }}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
        >
          <option value="en">English</option>
          <option value="zh">中文</option>
        </select>
      </Section>

      <Section title={t('settings.index.title')}>
        {stats && (
          <p className="text-sm text-gray-600">
            {t('settings.index.count', { indexed: stats.indexed, total: stats.total })}
          </p>
        )}
        {rebuildProgress && (
          <p className="text-xs text-primary">{rebuildProgress.message}</p>
        )}
        <button
          onClick={handleRebuildIndex}
          disabled={isRebuilding}
          className="px-3 py-1.5 text-xs bg-primary text-white rounded disabled:opacity-50 flex items-center gap-2"
        >
          {isRebuilding && (
            <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />
          )}
          {isRebuilding ? t('settings.index.rebuilding') : t('settings.index.rebuild')}
        </button>
      </Section>

      {/* 构建时间：确认当前跑的是哪一次构建。
          重建 dist/ 后必须回 chrome://extensions 点扩展卡片的 🔄 才会生效。 */}
      <p className="text-[10px] text-gray-300 text-center pt-2">
        build {typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'dev'}
      </p>
    </div>
  );
}
