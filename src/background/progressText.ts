/**
 * 后台进度文案。
 *
 * 这些串是**用户可见**的（向导的加载态直接显示它们），但它们在 service worker 里，
 * 拿不到侧边栏的 i18n 模块。此前它们是硬编码中文，英文界面下会中英混杂——
 * 而 `test/check-i18n.py` 只扫 `src/sidepanel`，扫不到这里。
 *
 * 只覆盖真正会显示给用户的几句，不做通用 i18n 框架。
 */

type Locale = 'en' | 'zh';

const MESSAGES: Record<string, Record<Locale, string>> = {
  preparing: {
    zh: '正在准备…',
    en: 'Preparing…',
  },
  fetchingVectors: {
    zh: '获取向量中 ({done}/{total})',
    en: 'Loading vectors ({done}/{total})',
  },
  generatingVectors: {
    zh: '生成向量中 ({done}/{total})',
    en: 'Generating vectors ({done}/{total})',
  },
  classifying: {
    zh: 'AI 归档中',
    en: 'Classifying…',
  },
  classifyingCount: {
    zh: 'AI 归档中 ({done}/{total})',
    en: 'Classifying ({done}/{total})',
  },
  checkingLinks: {
    zh: '检测失效链接 ({done}/{total})',
    en: 'Checking dead links ({done}/{total})',
  },
  splittingBare: {
    zh: '补二级目录：{top}（{count} 条）',
    en: 'Filing {count} loose bookmarks under "{top}"',
  },
  refiningFallback: {
    zh: '二次处理「其它」({count} 条)',
    en: 'Refining "Other" ({count} items)',
  },
  undoNone: {
    zh: '没有可撤销的整理记录',
    en: 'Nothing to undo',
  },
};

export function progressText(
  locale: string | undefined,
  key: keyof typeof MESSAGES,
  params?: Record<string, string | number>,
): string {
  const entry = MESSAGES[key];
  if (!entry) return key;
  const template = entry[locale === 'en' ? 'en' : 'zh'];
  if (!params) return template;
  return Object.entries(params).reduce(
    (text, [k, v]) => text.split(`{${k}}`).join(String(v)),
    template,
  );
}
