import React, { useState, useEffect } from 'react';
import { NavBar, type Tab } from './components/common/NavBar';
import { SearchPanel } from './components/SearchPanel';
import { SettingsPage } from './components/SettingsPage';
import { DedupReport } from './components/DedupReport';
import { OrganizeWizard } from './components/OrganizeWizard';
import { t, setLocale } from './i18n';

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('search');

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (resp) => {
      if (resp?.success && resp.data?.language) {
        setLocale(resp.data.language);
      }
    });
  }, []);

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="bg-white px-4 py-3 border-b border-gray-200">
        <h1 className="text-lg font-bold text-gray-800">{t('app.title')}</h1>
      </header>

      <NavBar activeTab={activeTab} onTabChange={setActiveTab} />

      <main className="flex-1 overflow-y-auto">
        {activeTab === 'search' && <SearchPanel />}
        {activeTab === 'organize' && <OrganizeWizard />}
        {activeTab === 'dedup' && <DedupReport />}
        {activeTab === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
