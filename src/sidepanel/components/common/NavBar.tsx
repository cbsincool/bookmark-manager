import React from 'react';
import { t } from '../../i18n';

export type Tab = 'search' | 'organize' | 'dedup' | 'settings';

interface NavBarProps {
  readonly activeTab: Tab;
  readonly onTabChange: (tab: Tab) => void;
}

const tabs: { key: Tab; labelKey: string; icon: string }[] = [
  { key: 'search', labelKey: 'nav.search', icon: '🔍' },
  { key: 'organize', labelKey: 'nav.organize', icon: '📂' },
  { key: 'dedup', labelKey: 'nav.dedup', icon: '🗑' },
  { key: 'settings', labelKey: 'nav.settings', icon: '⚙️' },
];

export function NavBar({ activeTab, onTabChange }: NavBarProps) {
  return (
    <nav className="flex border-b border-gray-200 bg-white">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onTabChange(tab.key)}
          className={`flex-1 py-3 text-sm font-medium text-center transition-colors ${
            activeTab === tab.key
              ? 'text-primary border-b-2 border-primary'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <span className="block text-lg">{tab.icon}</span>
          <span>{t(tab.labelKey)}</span>
        </button>
      ))}
    </nav>
  );
}
