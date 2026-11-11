import en from './en.json';
import zh from './zh.json';

const messages: Record<string, Record<string, string>> = { en, zh };

let currentLocale = 'en';

/**
 * 语言变更的订阅者。
 *
 * `setLocale` 改的是模块变量，本身**不会**让 React 重渲染——设置里选中文、
 * 首次打开界面仍是英文，要切一次标签才变过来。把变更广播出去，
 * 由 `useSyncExternalStore` 驱动整棵树重渲染，语言才会立刻生效。
 */
const listeners = new Set<() => void>();

export function setLocale(locale: string): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  for (const listener of listeners) listener();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLocale(): string {
  return currentLocale;
}

export function t(key: string, params?: Record<string, string | number>): string {
  const msg = messages[currentLocale]?.[key] ?? messages['en']?.[key] ?? key;
  if (!params) return msg;
  return Object.entries(params).reduce(
    (result, [k, v]) => result.replace(`{${k}}`, String(v)),
    msg,
  );
}
