import { describe, it, expect } from 'vitest';
import {
  applyRules, rulePath,
  VIDEO_TOP, SHOPPING_TOP, LINUX_TOP, TUTORIAL_TOP,
  NETWORK_TOP, STORAGE_TOP, VIRTUALIZATION_TOP, GITHUB_TOP,
} from '../organizeRules';

const bm = (title: string, url: string) => ({ title, url });

describe('applyRules — 视频', () => {
  it('routes each platform to its own subfolder', () => {
    expect(applyRules(bm('随便看看', 'https://www.bilibili.com/video/BV1'))).toMatchObject({
      top: VIDEO_TOP, sub: 'Bilibili',
    });
    expect(applyRules(bm('x', 'https://youtu.be/abc'))).toMatchObject({ top: VIDEO_TOP, sub: 'YouTube' });
    expect(applyRules(bm('x', 'https://v.qq.com/x/cover/1.html'))).toMatchObject({ top: VIDEO_TOP, sub: '腾讯视频' });
  });

  it('beats the tutorial rule — B 站上的教程视频归视频', () => {
    // 平台归属确定、不会抖动；按内容归会让同一批书签每次落在不同目录
    const r = applyRules(bm('Python 入门教程 手把手', 'https://www.bilibili.com/video/BV1'));
    expect(r?.top).toBe(VIDEO_TOP);
    expect(r?.sub).toBe('Bilibili');
  });

  it('matches subdomains and ignores look-alike domains', () => {
    expect(applyRules(bm('x', 'https://m.bilibili.com/video/1'))?.top).toBe(VIDEO_TOP);
    expect(applyRules(bm('x', 'https://notbilibili.com/video/1'))).toBeNull();
  });
});

describe('applyRules — 购物', () => {
  it('routes each platform to its own subfolder', () => {
    expect(applyRules(bm('商品', 'https://item.taobao.com/item.htm?id=1'))?.sub).toBe('淘宝');
    expect(applyRules(bm('商品', 'https://detail.tmall.com/item.htm?id=1'))?.sub).toBe('天猫');
    expect(applyRules(bm('商品', 'https://item.jd.com/1.html'))?.sub).toBe('京东');
    expect(applyRules(bm('商品', 'https://www.amazon.com/dp/B0'))?.sub).toBe('亚马逊');
  });

  it('keeps Tmall out of Taobao even though both end in .com', () => {
    // 按后缀匹配时最长的先比，`tmall.com` 不能被 `taobao.com` 之类的规则抢走
    expect(applyRules(bm('x', 'https://detail.tmall.com/item.htm?id=1'))?.sub).toBe('天猫');
  });
});

describe('applyRules — Linux', () => {
  it('recognizes official sites', () => {
    expect(applyRules(bm('文档', 'https://www.kernel.org/doc/html/latest/'))?.top).toBe(LINUX_TOP);
    expect(applyRules(bm('x', 'https://ubuntu.com/download'))?.top).toBe(LINUX_TOP);
  });

  it('recognizes content by title even on a neutral domain', () => {
    expect(applyRules(bm('Linux 内核参数调优', 'https://example.com/a'))?.top).toBe(LINUX_TOP);
    expect(applyRules(bm('systemd 服务配置', 'https://example.com/b'))?.top).toBe(LINUX_TOP);
  });

  it('locks only the top level, leaving the subfolder to the model', () => {
    const r = applyRules(bm('Linux 内核参数调优', 'https://example.com/a'));
    expect(r?.sub).toBeUndefined();
    expect(rulePath(r!)).toBeUndefined();
  });
});

describe('applyRules — 教程', () => {
  it('recognizes tutorial titles', () => {
    expect(applyRules(bm('OpenCV 视觉教程', 'https://example.com/a'))?.top).toBe(TUTORIAL_TOP);
    expect(applyRules(bm('Getting Started with Rust', 'https://example.com/b'))?.top).toBe(TUTORIAL_TOP);
  });

  it('does not fire on a plain article title', () => {
    expect(applyRules(bm('HP D2700 盘柜规格', 'https://example.com/hp'))).toBeNull();
  });

  it('does not look for tutorial words in the URL path', () => {
    // `/tutorial/` 这种路径太常见，按 URL 判断会误伤一大片
    expect(applyRules(bm('HP D2700 盘柜规格', 'https://example.com/tutorial/hp'))).toBeNull();
  });
});

describe('applyRules — 优先级与兜底', () => {
  it('lets video and shopping win over Linux and tutorial', () => {
    // 京东上卖的 Linux 教程书 —— 平台优先
    expect(applyRules(bm('Linux 入门教程', 'https://item.jd.com/1.html'))?.top).toBe(SHOPPING_TOP);
  });

  it('returns null for content no rule claims', () => {
    expect(applyRules(bm('HP Smart Array 控制器', 'https://www.hpe.com/us/en/product-catalog/1'))).toBeNull();
  });

  it('ignores malformed URLs', () => {
    expect(applyRules(bm('坏链接', 'not-a-url'))).toBeNull();
  });
});

describe('applyRules — 网络 / 存储 / 虚拟化', () => {
  it('locks storage content to its own top level', () => {
    // 不加规则时模型会把存储塞进「硬件/存储」和「技术/存储」，
    // 「存储」这个一级目录永远是空的
    expect(applyRules(bm('LSI MegaRAID 阵列卡配置', 'https://example.com/a'))?.top).toBe(STORAGE_TOP);
    expect(applyRules(bm('NAS 选型', 'https://example.com/b'))?.top).toBe(STORAGE_TOP);
  });

  it('locks network content to its own top level', () => {
    expect(applyRules(bm('交换机 VLAN 配置', 'https://example.com/c'))?.top).toBe(NETWORK_TOP);
    expect(applyRules(bm('BGP 路由聚合', 'https://example.com/d'))?.top).toBe(NETWORK_TOP);
  });

  it('locks virtualization content to its own top level', () => {
    expect(applyRules(bm('VMware ESXi 安装', 'https://example.com/e'))?.top).toBe(VIRTUALIZATION_TOP);
    expect(applyRules(bm('Kubernetes 集群', 'https://example.com/f'))?.top).toBe(VIRTUALIZATION_TOP);
  });

  it('only locks the top; the subfolder stays with the model', () => {
    expect(applyRules(bm('NAS 选型', 'https://example.com/b'))?.sub).toBeUndefined();
  });

  it('keeps platform rules ahead of topic rules', () => {
    // 京东卖的 NAS 也是购物
    expect(applyRules(bm('NAS 存储', 'https://item.jd.com/1.html'))?.top).toBe(SHOPPING_TOP);
  });

  it('keeps Linux ahead of storage/network', () => {
    expect(applyRules(bm('Linux 磁盘分区', 'https://example.com/g'))?.top).toBe(LINUX_TOP);
  });
});

describe('applyRules — GitHub', () => {
  it('puts every github.com bookmark under the Github top level', () => {
    expect(applyRules(bm('some/repo', 'https://github.com/some/repo'))?.top).toBe(GITHUB_TOP);
    expect(applyRules(bm('Linux 内核源码', 'https://github.com/torvalds/linux'))?.top).toBe(GITHUB_TOP);
    // 路径完全确定：连二级都不交给模型，185 条平铺在顶层
    expect(applyRules(bm('some/repo', 'https://github.com/some/repo'))?.final).toBe(true);
  });

  it('does not hijack look-alike domains', () => {
    expect(applyRules(bm('x', 'https://gist.github.com/abc'))?.top).toBe(GITHUB_TOP);
    expect(applyRules(bm('x', 'https://notgithub.com/a/b'))).toBeNull();
  });
});
