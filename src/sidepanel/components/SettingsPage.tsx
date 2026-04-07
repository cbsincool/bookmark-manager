import React, { useState } from 'react';
import { useSettings, useIndexStats } from '../hooks/useSettings';
import { setLocale } from '../i18n';
import { t } from '../i18n';

export function SettingsPage() {
  const { settings, updateSettings, isLoading } = useSettings();
  const { stats, refresh: refreshStats } = useIndexStats();
  const [testResult, setTestResult] = useState<string | null>(null);

  if (isLoading) {
    return <div className="p-4 text-gray-400">Loading...</div>;
  }

  const handleTestConnection = async () => {
    setTestResult(null);
    try {
      const result = await fetch(settings.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: settings.apiModel,
          messages: [{ role: 'user', content: 'Say OK' }],
          max_tokens: 5,
        }),
      });
      setTestResult(result.ok ? '✅ Connected' : `❌ ${result.status}`);
    } catch (err) {
      setTestResult(`❌ ${err}`);
    }
  };

  const handleRebuildIndex = async () => {
    await chrome.runtime.sendMessage({ type: 'REBUILD_INDEX' });
    refreshStats();
  };

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      {children}
    </div>
  );

  const Toggle = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) => (
    <label className="flex items-center justify-between">
      <span className="text-sm text-gray-600">{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4 text-primary rounded" />
    </label>
  );

  const Input = ({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; type?: string }) => (
    <label className="block">
      <span className="text-sm text-gray-600">{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} className="w-full mt-1 px-3 py-2 text-sm border border-gray-200 rounded-lg" />
    </label>
  );

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-base font-semibold text-gray-800">{t('settings.title')}</h2>

      <Section title={t('settings.ai.title')}>
        <Input label={t('settings.ai.endpoint')} value={settings.apiEndpoint} onChange={(v) => updateSettings({ apiEndpoint: v })} />
        <Input label={t('settings.ai.key')} value={settings.apiKey} onChange={(v) => updateSettings({ apiKey: v })} type="password" />
        <Input label={t('settings.ai.model')} value={settings.apiModel} onChange={(v) => updateSettings({ apiModel: v })} />
        <button onClick={handleTestConnection} className="px-3 py-1.5 text-xs bg-primary text-white rounded">
          {t('settings.ai.testConnection')}
        </button>
        {testResult && <p className="text-xs">{testResult}</p>}
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
        <Toggle label={t('settings.organize.contentEnhancement')} checked={settings.contentEnhancement} onChange={(v) => updateSettings({ contentEnhancement: v })} />
        <Toggle label={t('settings.organize.realtimeArchiving')} checked={settings.realtimeArchiving} onChange={(v) => updateSettings({ realtimeArchiving: v })} />
        <Input label={t('settings.organize.domainMinCount')} value={String(settings.domainClusterMinCount)} onChange={(v) => updateSettings({ domainClusterMinCount: parseInt(v) || 3 })} />
      </Section>

      <Section title={t('settings.dedup.title')}>
        <Toggle label={t('settings.dedup.l3Enabled')} checked={settings.l3Enabled} onChange={(v) => updateSettings({ l3Enabled: v })} />
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
        <div className="flex gap-2">
          <button onClick={handleRebuildIndex} className="px-3 py-1.5 text-xs bg-primary text-white rounded">
            {t('settings.index.rebuild')}
          </button>
        </div>
      </Section>
    </div>
  );
}
