import en from './en.json';
import zh from './zh.json';

const messages: Record<string, Record<string, string>> = { en, zh };

let currentLocale = 'en';

export function setLocale(locale: string): void {
  currentLocale = locale;
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
