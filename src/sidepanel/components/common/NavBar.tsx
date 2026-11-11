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
    <nav className="bottom-nav">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onTabChange(tab.key)}
          data-active={activeTab === tab.key}
          className="nav-item"
        >
          <span className="nav-icon">{tab.icon}</span>
          <span className="nav-label">{t(tab.labelKey)}</span>
        </button>
      ))}
    </nav>
  );
}
