import { describe, it, expect } from 'vitest';
import { suggestFolderName } from '../organizeEngine';

describe('suggestFolderName', () => {
  it('names a folder after the site, not one of its sections', () => {
    // 原实现只剥 www/docs/blog/api/dev 五个前缀，实测建出来的目录名是
    // Zhuanlan.zhihu / Mp.weixin.qq / Wenku.baidu 这种「分区名」，不是站点名
    expect(suggestFolderName('zhuanlan.zhihu.com')).toBe('Zhihu');
    expect(suggestFolderName('wenku.baidu.com')).toBe('Baidu');
    expect(suggestFolderName('baijiahao.baidu.com')).toBe('Baidu');
    expect(suggestFolderName('cloud.tencent.com')).toBe('Tencent');
    expect(suggestFolderName('en.wikipedia.org')).toBe('Wikipedia');
    expect(suggestFolderName('docs.microsoft.com')).toBe('Microsoft');
  });

  it('handles two-part public suffixes', () => {
    // `blog.sina.com.cn` 曾收敛成 `Sina.com.cn`——后缀切错一位，名字整个错位
    expect(suggestFolderName('blog.sina.com.cn')).toBe('Sina');
    expect(suggestFolderName('detail.zol.com.cn')).toBe('Zol');
    expect(suggestFolderName('www.bbc.co.uk')).toBe('Bbc');
  });

  it('treats hosting suffixes as public suffixes', () => {
    // 否则 foo.github.io 和 bar.github.io 都会被叫 Github，两个不相干的站点被合并
    expect(suggestFolderName('foo.github.io')).toBe('Foo');
    expect(suggestFolderName('bar.github.io')).toBe('Bar');
    expect(suggestFolderName('myblog.netlify.app')).toBe('Myblog');
  });

  it('keeps plain domains and IPs intact', () => {
    expect(suggestFolderName('github.com')).toBe('Github');
    expect(suggestFolderName('juejin.cn')).toBe('Juejin');
    expect(suggestFolderName('localhost')).toBe('Localhost');
    expect(suggestFolderName('192.168.1.10')).toBe('192.168.1.10');
  });

  it('never strips the name down past the registrable domain', () => {
    // 全是通用前缀时也要留住最后一段，不能剥成空
    expect(suggestFolderName('www.163.com')).toBe('163');
    expect(suggestFolderName('blog.51cto.com')).toBe('51cto');
  });

  it('converges subdomains of one site onto a single name', () => {
    // 这正是想要的：它们本来就是一个站，本该进同一个目录
    expect(suggestFolderName('blog.csdn.net')).toBe(suggestFolderName('www.csdn.net'));
    expect(suggestFolderName('tech.watchstor.com')).toBe(suggestFolderName('www.watchstor.com'));
  });
});
