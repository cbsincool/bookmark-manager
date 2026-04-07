import { describe, it, expect } from 'vitest';
import { findExactUrlDuplicates, findSameTitleDuplicates, scoreL1 } from '../dedupEngine';
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
