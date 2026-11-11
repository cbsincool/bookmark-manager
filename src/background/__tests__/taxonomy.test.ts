import { describe, it, expect } from 'vitest';
import { buildTaxonomyPrompt, parseTaxonomyResponse, reclassifyIntoAllowlist } from '../taxonomy';
import { mergeNearDuplicateNames, isImportArtifact } from '@/shared/directoryNaming';

describe('parseTaxonomyResponse', () => {
  it('parses a plain JSON array', () => {
    expect(parseTaxonomyResponse('["技术", "硬件", "AI"]')).toEqual(['技术', '硬件', 'AI']);
  });

  it('parses a fenced array', () => {
    expect(parseTaxonomyResponse('```json\n["技术", "硬件"]\n```')).toEqual(['技术', '硬件']);
  });

  it('accepts a wrapped object shape the model sometimes returns', () => {
    expect(parseTaxonomyResponse('{"categories": ["技术", "硬件"]}')).toEqual(['技术', '硬件']);
  });

  it('drops import artifacts, duplicates and empty entries', () => {
    // 「已导入 / 书签栏」是 Chrome 导入时造的容器，不是知识分类
    const names = parseTaxonomyResponse('["已导入", "书签栏", "技术", "技术", "", "  硬件 "]');
    expect(names).toEqual(['技术', '硬件']);
  });

  it('normalizes names through the same pipeline as directory paths', () => {
    // 禁空格、去描述性后缀的规则只在一个地方实现
    expect(parseTaxonomyResponse('["React Hooks 教程", "技术"]')).toEqual(['ReactHooks', '技术']);
  });

  it('caps the number of top-level categories', () => {
    const many = JSON.stringify([
      'AI', 'Linux', '硬件', '网络', '存储', '编程', '工具', '教程',
      '数学', '旅游', '视频', '购物', '办公', '安全', '数据库',
    ]);
    expect(parseTaxonomyResponse(many, 12)).toHaveLength(12);
  });

  it('returns empty for unparseable output', () => {
    expect(parseTaxonomyResponse('I cannot do that')).toEqual([]);
  });

  it('is case-insensitively deduplicated', () => {
    expect(parseTaxonomyResponse('["AI", "ai"]')).toEqual(['AI']);
  });
});

describe('buildTaxonomyPrompt', () => {
  it('lists existing folders with counts and excludes import artifacts', () => {
    const prompt = buildTaxonomyPrompt([
      { name: '硬件', count: 308 },
      { name: '已导入', count: 131 },
    ]);
    expect(prompt).toContain('硬件（308 条）');
    expect(prompt).not.toContain('已导入（131 条）');
  });

  it('tells the model to merge near-duplicates', () => {
    const prompt = buildTaxonomyPrompt([{ name: '硬件', count: 1 }]);
    expect(prompt).toContain('服务器硬件');
    expect(prompt).toContain('不超过');
  });
});

describe('mergeNearDuplicateNames', () => {
  it('merges names that contain one another, keeping the shorter one', () => {
    // 「服务器硬件 / 电脑硬件 / 计算机硬件」都包含「硬件」
    const merged = mergeNearDuplicateNames(['硬件', '服务器硬件', '电脑硬件', '计算机硬件', '网络', '网络设备']);
    expect(merged).toEqual(['硬件', '网络']);
  });

  it('drops import artifacts', () => {
    expect(mergeNearDuplicateNames(['已导入', '技术'])).toEqual(['技术']);
  });

  it('keeps unrelated names', () => {
    expect(mergeNearDuplicateNames(['AI', 'Linux', '旅游'])).toEqual(['AI', 'Linux', '旅游']);
  });

  it('is empty for an empty input', () => {
    expect(mergeNearDuplicateNames([])).toEqual([]);
  });
});

describe('isImportArtifact', () => {
  it('recognizes Chinese and English import containers', () => {
    expect(isImportArtifact('已导入')).toBe(true);
    expect(isImportArtifact('Bookmarks Bar')).toBe(true);
    expect(isImportArtifact('硬件')).toBe(false);
  });
});

describe('reclassifyIntoAllowlist', () => {
  it('does nothing when no model is configured', async () => {
    // 没配模型时不能假装重试——调用方会据此把书签留在未分类
    const settings = {
      apiEndpoint: '', apiKey: '', apiModel: '', apiFormat: 'openai',
      searchFuzzyWeight: 0.4, searchSemanticWeight: 0.6, collapseThreshold: 0.85,
      realtimeArchiving: true, onlyUseExistingDirectories: false, organizeMaxDepth: 3,
      urlNormStripUtm: true, urlNormStripTrailingSlash: true, urlNormStripHash: true,
      language: 'zh', topLevelCategories: [],
    } as const;
    const out = await reclassifyIntoAllowlist(
      [{ id: '1', title: 't', url: 'https://a.com' }],
      ['技术'],
      settings as never,
    );
    expect(out).toEqual({});
  });

  it('is a no-op for an empty retry set', async () => {
    const out = await reclassifyIntoAllowlist([], ['技术'], {} as never);
    expect(out).toEqual({});
  });
});
