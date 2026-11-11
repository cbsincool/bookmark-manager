import React, { useState, useEffect, useSyncExternalStore } from 'react';
import { NavBar, type Tab } from './components/common/NavBar';
import { SearchPanel } from './components/SearchPanel';
import { SettingsPage } from './components/SettingsPage';
import { DedupReport } from './components/DedupReport';
import { OrganizeWizard } from './components/OrganizeWizard';
import { t, setLocale, subscribeLocale, getLocale } from './i18n';

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('search');

  // 订阅语言：setLocale 只改模块变量、不触发重渲染，所以设置里选了中文之后
  // 界面要等下一次渲染才变（首次打开则一直停在英文）。这个 hook 把语言
  // 变成一份外部 store，变更时整棵树跟着重渲染。
  useSyncExternalStore(subscribeLocale, getLocale);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (resp) => {
      if (resp?.success && resp.data?.language) {
        setLocale(resp.data.language);
      }
    });
  }, []);

  return (
    <div className="flex flex-col h-screen">
      <header className="topbar">
        <div className="brand-mark pop-in">{t('app.seal')}</div>
        <div className="min-w-0 flex-1">
          <h1 className="app-title truncate">{t('app.title')}</h1>
          <p className="app-kicker">Bookmark Index</p>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        {activeTab === 'search' && <SearchPanel />}
        {activeTab === 'organize' && <OrganizeWizard />}
        {activeTab === 'dedup' && <DedupReport />}
        {activeTab === 'settings' && <SettingsPage />}
      </main>

      <NavBar activeTab={activeTab} onTabChange={setActiveTab} />
    </div>
  );
}
