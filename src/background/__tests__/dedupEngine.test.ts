import { describe, it, expect } from 'vitest';
import { findExactUrlDuplicates, findSameTitleDuplicates, scoreL1, scoreL2Content } from '../dedupEngine';
import { NEUTRAL_SCORE } from '@/shared/constants';
import type { BookmarkNode } from '@/shared/types';

const makeBookmark = (id: string, title: string, url: string): BookmarkNode => ({
  id, title, url, path: '',
});

describe('findExactUrlDuplicates', () => {
  it('groups bookmarks with same normalized URL', () => {
    const bookmarks = [
      makeBookmark('1', 'React', 'https://react.dev/'),
      makeBookmark('2', 'React', 'https://react.dev'),
      makeBookmark('3', 'Vue', 'https://vuejs.org'),
    ];
    const opts = { stripUtm: true, stripTrailingSlash: true, stripHash: true };
    const groups = findExactUrlDuplicates(bookmarks, opts);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(['1', '2']);
  });

  it('returns empty when no duplicates', () => {
    const bookmarks = [
      makeBookmark('1', 'A', 'https://a.com'),
      makeBookmark('2', 'B', 'https://b.com'),
    ];
    const opts = { stripUtm: true, stripTrailingSlash: true, stripHash: true };
    expect(findExactUrlDuplicates(bookmarks, opts)).toHaveLength(0);
  });
});

describe('findSameTitleDuplicates', () => {
  it('groups bookmarks with same title but different URLs', () => {
    const bookmarks = [
      makeBookmark('1', 'Python Tutorial', 'https://docs.python.org'),
      makeBookmark('2', 'Python Tutorial', 'https://some-blog.com/python'),
      makeBookmark('3', 'Java Guide', 'https://java.com'),
    ];
    const groups = findSameTitleDuplicates(bookmarks);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('Python Tutorial');
  });
});

describe('scoreL1', () => {
  it('scores HTTPS higher than HTTP', () => {
    const https = scoreL1('https://example.com/guide');
    const http = scoreL1('http://example.com/guide');
    expect(https).toBeGreaterThan(http);
  });

  it('scores well-known domains higher', () => {
    const known = scoreL1('https://github.com/user/repo');
    const unknown = scoreL1('https://random-blog-123.com/post');
    expect(known).toBeGreaterThan(unknown);
  });

  it('penalizes long URLs', () => {
    const short = scoreL1('https://example.com/page');
    const long = scoreL1('https://example.com/' + 'a'.repeat(200));
    expect(short).toBeGreaterThan(long);
  });
});

describe('scoreL2Content', () => {
  it('stays neutral when no summary is cached', () => {
    // 扫描时不发网络请求，没有缓存的条目必须既不奖也不罚，
    // 否则等于凭空给整库书签加了一个偏移
    expect(scoreL2Content(undefined)).toBe(NEUTRAL_SCORE);
  });

  it('scores a page that was fetched but yielded nothing very low', () => {
    // 抓过却拿不到内容：登录墙 / 空壳页
    expect(scoreL2Content('')).toBeLessThan(NEUTRAL_SCORE);
    expect(scoreL2Content('   ')).toBeLessThan(NEUTRAL_SCORE);
  });

  it('ranks a substantial page above a thin one', () => {
    const thin = scoreL2Content('很短的一句话');
    const rich = scoreL2Content('正文内容。'.repeat(120));
    expect(rich).toBeGreaterThan(thin);
    expect(rich).toBeGreaterThan(NEUTRAL_SCORE);
  });
});
