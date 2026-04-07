import { LOW_INFO_TITLES } from './constants';

export interface NormalizeOptions {
  readonly stripUtm: boolean;
  readonly stripTrailingSlash: boolean;
  readonly stripHash: boolean;
}

export function normalizeUrl(url: string, opts: NormalizeOptions): string {
  let result = url;

  if (opts.stripHash) {
    const hashIdx = result.indexOf('#');
    if (hashIdx !== -1) {
      result = result.slice(0, hashIdx);
    }
  }

  if (opts.stripUtm) {
    try {
      const urlObj = new URL(result);
      const keysToDelete: string[] = [];
      urlObj.searchParams.forEach((_, key) => {
        if (key.startsWith('utm_')) keysToDelete.push(key);
      });
      keysToDelete.forEach((k) => urlObj.searchParams.delete(k));
      result = urlObj.toString();
    } catch {
      // not a valid URL (e.g. missing protocol), try regex fallback
      result = result.replace(/[?&]utm_[a-z_]+=[^&#]*/g, '');
      result = result.replace(/\?&/, '?').replace(/\?$/, '');
    }
  }

  if (opts.stripTrailingSlash && result.endsWith('/')) {
    result = result.slice(0, -1);
  }

  return result;
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    const match = url.match(/^(?:https?:\/\/)?([^/]+)/);
    return match?.[1] ?? url;
  }
}

export function isLowInfoTitle(title: string): boolean {
  if (title.length < 5) return true;
  const lower = title.toLowerCase().trim();
  return LOW_INFO_TITLES.some((t) => lower === t);
}
