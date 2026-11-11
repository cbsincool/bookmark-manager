/**
 * 确定性整理规则。
 *
 * 模型最不稳的地方恰恰是最该确定的地方：B 站永远是视频、京东永远是购物，
 * 没有理由每跑一次整理就重新猜一遍，更不该因为某次猜成「教程/前端」就来回搬。
 * 所以这几类先用规则钉死，模型只负责规则覆盖不到的内容。
 *
 * 优先级（用户确认过）：
 *   视频 / 购物 的平台规则 > 内容主题规则 > 模型
 * 也就是 B 站上的教程视频归「视频/Bilibili」，不归「教程」——平台维度确定、不抖动。
 */

import {
  VIDEO_TOP, SHOPPING_TOP, LINUX_TOP, TUTORIAL_TOP,
  NETWORK_TOP, STORAGE_TOP, VIRTUALIZATION_TOP, GITHUB_TOP, WORK_TOP, RULE_TOP_LEVELS,
} from '@/shared/constants';

// 顶层名由 shared 统一提供，规则层只负责「命中哪一类」
export {
  VIDEO_TOP, SHOPPING_TOP, LINUX_TOP, TUTORIAL_TOP,
  NETWORK_TOP, STORAGE_TOP, VIRTUALIZATION_TOP, GITHUB_TOP, WORK_TOP, RULE_TOP_LEVELS,
};

/**
 * Linux 下不该出现的二级目录名 → 该主题自己的维度词。
 *
 * 模型会把「硬件」「编程」这类通用领域词当成 Linux 的二级（实测 `Linux/硬件` 54 条），
 * 它们和已有的 `Linux/驱动`、`Linux/设备管理` 重复，也让人一眼看不懂。
 */
export const LINUX_SUB_ALIASES: Readonly<Record<string, string>> = {
  硬件: '设备管理',
  编程: '开发',
  网络: '网络配置',
  软件: '包管理',
  开发工具: '开发',
  办公软件: '桌面应用',
  应用程序: '桌面应用',
  工具: '系统管理',
};

/**
 * Linux 下允许出现的二级目录。
 *
 * 这是个**封闭集合**：`办公软件`、`编程`、`硬件` 这类通用领域词不属于 Linux 的维度，
 * 出现就说明模型跑偏了。集合外的名字会被折到最接近的一项，实在没有就进「其他」。
 * 宁可粗一点，也不要在一级目录下看到一眼看不懂的子目录。
 */
export const LINUX_ALLOWED_SUBS: readonly string[] = [
  '内核', '驱动', '设备管理', '系统管理', '网络配置', '网络服务',
  '包管理', '文件系统', 'Shell', '系统服务', '版本控制', '开发',
  '容器', '桌面应用',
];
export const LINUX_SUB_FALLBACK = '其他';

/**
 * 视作「工作」的公网域名后缀。默认空：只靠下面的内网特征识别。
 * 公司用公网域名做办公系统的，把这些后缀加进来即可（如 'example.com'）。
 */
const WORK_DOMAINS: readonly string[] = [];

/** 内网域名：.local / .internal / .corp 这类不会出现在公网 DNS 里 */
const INTRANET_HOST = /^(?:localhost|[\w-]+\.(?:local|internal|intranet|corp|lan|home))$/i;

/** RFC1918 私有网段 */
const PRIVATE_IP =
  /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

export interface RuleAssignment {
  readonly top: string;
  /**
   * 二级目录。
   * - 有值：路径已确定（视频/购物 → 平台），调用方不应再交给模型
   * - 无值：只锁定顶层，二级交给模型（Linux/教程）
   */
  readonly sub?: string;
  /**
   * 路径已**完全确定**，连二级都不该由模型决定（如 GitHub：用户要 185 条平铺在顶层）。
   * 与 `sub` 的区别：`sub` 给的是二级名字，`final` 表示就用顶层本身。
   */
  readonly final?: boolean;
  /** 命中的是哪条规则，便于排查「为什么这条进了视频」 */
  readonly reason: string;
}

/** 域名后缀 → 平台名。匹配时按「等于或以此结尾」判断，`www.` 之类的子域自然覆盖 */
const VIDEO_PLATFORMS: readonly (readonly [string, string])[] = [
  ['bilibili.com', 'Bilibili'],
  ['b23.tv', 'Bilibili'],
  ['youtube.com', 'YouTube'],
  ['youtu.be', 'YouTube'],
  ['douyin.com', '抖音'],
  ['ixigua.com', '西瓜视频'],
  ['youku.com', '优酷'],
  ['iqiyi.com', '爱奇艺'],
  ['v.qq.com', '腾讯视频'],
  ['vimeo.com', 'Vimeo'],
  ['twitch.tv', 'Twitch'],
  ['netflix.com', 'Netflix'],
  ['dailymotion.com', 'Dailymotion'],
  ['huya.com', '直播'],
  ['douyu.com', '直播'],
];

const SHOPPING_PLATFORMS: readonly (readonly [string, string])[] = [
  ['taobao.com', '淘宝'],
  ['tmall.com', '天猫'],
  ['jd.com', '京东'],
  ['jd.hk', '京东'],
  ['pinduoduo.com', '拼多多'],
  ['yangkeduo.com', '拼多多'],
  ['amazon.com', '亚马逊'],
  ['amazon.cn', '亚马逊'],
  ['amazon.co.jp', '亚马逊'],
  ['amazon.co.uk', '亚马逊'],
  ['amazon.de', '亚马逊'],
  ['ebay.com', 'eBay'],
  ['aliexpress.com', '速卖通'],
  ['1688.com', '1688'],
  ['suning.com', '苏宁'],
  ['vip.com', '唯品会'],
  ['temu.com', 'Temu'],
  ['etsy.com', 'Etsy'],
  ['rakuten.co.jp', '乐天'],
  ['smzdm.com', '什么值得买'],
  ['dangdang.com', '当当'],
  ['kongfz.com', '孔夫子旧书网'],
];

/** Linux 证据：发行版/内核/桌面/命令的官方站与文档站 */
const LINUX_DOMAINS: readonly string[] = [
  'kernel.org', 'linux.org', 'ubuntu.com', 'debian.org', 'centos.org',
  'redhat.com', 'fedoraproject.org', 'archlinux.org', 'gentoo.org',
  'opensuse.org', 'suse.com', 'almalinux.org', 'rockylinux.org',
  'gnome.org', 'kde.org', 'freedesktop.org', 'tldp.org', 'man7.org',
  'linuxfromscratch.org', 'linux.die.net', 'linuxquestions.org',
  'unix.stackexchange.com', 'askubuntu.com',
];

/** 标题/URL 里的 Linux 证据词 */
const LINUX_HINTS =
  /\blinux\b|内核|kernel|ubuntu|debian|centos|redhat|rhel|fedora|archlinux|gentoo|opensuse|grub|systemd|systemctl|apt-get|yum\b|dnf\b/i;

/** 教程证据词。只在标题里找——URL 里 `tutorial` 这种路径太常见，误伤大 */
const TUTORIAL_HINTS = /教程|入门|指南|详解|从零|手把手|保姆级|快速上手|实战课|课程|学习笔记|how\s+to|tutorial|guide|learn\s|course|getting\s+started/i;

/**
 * 用户要求独立成一级目录的三个技术主题。
 *
 * 注意它们**只锁顶层**：`存储` 下面放 RAID/SSD/NAS 还是别的，由模型判断。
 * 不加规则时模型会把存储内容塞进 `硬件/存储` 和 `技术/存储`，
 * 「存储」这个一级目录就永远是空的——实测就是这样。
 */
export const STORAGE_HINTS = /存储|磁盘|硬盘|阵列|\bSAN\b|\bNAS\b|\bRAID\b|\bSSD\b|\bNVMe\b|\bHBA\b|iSCSI|\bLUN\b|对象存储|分布式文件系统/i;
/**
 * 只承载「存储」这个概念、本身不含额外信息量的目录名。
 * 折叠时遇到它们就把末级丢掉：`技术/存储` → `存储`，而不是 `存储/存储`。
 */
export const STORAGE_CONTAINER_NAMES: ReadonlySet<string> = new Set([
  '存储', '存储设备', '存储技术', '存储系统', '磁盘', '磁盘存储',
]);

const NETWORK_HINTS = /网络|交换机|路由器|防火墙|\bVLAN\b|\bTCP\b|\bUDP\b|\bBGP\b|\bOSPF\b|抓包|\bDNS\b|负载均衡|网关|网卡|光纤|以太网/i;
const VIRTUALIZATION_HINTS = /虚拟化|虚拟机|\bVMware\b|\bESXi\b|vSphere|\bKVM\b|\bXen\b|容器|\bDocker\b|Kubernetes|\bK8s\b|OpenStack|Hypervisor/i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function matchesDomain(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function matchPlatform(
  host: string,
  table: readonly (readonly [string, string])[],
): string | undefined {
  // 长的先匹配：`v.qq.com` 不能被更短的规则抢走；同长时顺序无所谓
  for (const [suffix, name] of [...table].sort((a, b) => b[0].length - a[0].length)) {
    if (matchesDomain(host, suffix)) return name;
  }
  return undefined;
}

/**
 * 给一条书签套规则。返回 null 表示规则不认领，交给模型。
 *
 * 顺序即优先级：视频 → 购物 → Linux → 教程。
 */
export function applyRules(bookmark: { title: string; url: string }): RuleAssignment | null {
  const host = hostOf(bookmark.url);
  if (!host) return null;

  const video = matchPlatform(host, VIDEO_PLATFORMS);
  if (video) return { top: VIDEO_TOP, sub: video, reason: `${host} 是视频平台` };

  const shopping = matchPlatform(host, SHOPPING_PLATFORMS);
  if (shopping) return { top: SHOPPING_TOP, sub: shopping, reason: `${host} 是购物平台` };

  // 用户点名要保留的站点：GitHub 的书签全部聚在顶层 `Github`，
  // 即使某条 repo 的标题像 Linux/教程，也不拆开——它首先是一个 GitHub 仓库。
  if (matchesDomain(host, 'github.com')) {
    return { top: GITHUB_TOP, final: true, reason: 'github.com 归入 Github' };
  }

  // 公司内网/办公系统：它们不是「技术」，混在系统运维里会让人以为是自己搭的服务。
  // 默认识别内网域名（.local/.internal/.corp…）与私有网段；如需把公司公网域名
  // 也归入「工作」，把后缀加进 WORK_DOMAINS 即可。
  const workHost = WORK_DOMAINS.find((suffix) => matchesDomain(host, suffix));
  if (workHost || INTRANET_HOST.test(host) || PRIVATE_IP.test(host)) {
    return { top: WORK_TOP, final: true, reason: `${host} 是公司内网` };
  }

  const linuxHost = LINUX_DOMAINS.find((suffix) => matchesDomain(host, suffix));
  if (linuxHost || LINUX_HINTS.test(`${bookmark.title} ${bookmark.url}`)) {
    return { top: LINUX_TOP, reason: linuxHost ? `${host} 是 Linux 站点` : '标题/URL 含 Linux 特征词' };
  }

  // 网络 / 存储 / 虚拟化只锁顶层。顺序上存储先于网络：一块网卡的文档
  // 往往同时含「网络」和「网卡」，而它更该落在存储/硬件语境里。
  const text = `${bookmark.title} ${bookmark.url}`;
  if (STORAGE_HINTS.test(text)) return { top: STORAGE_TOP, reason: '标题/URL 含存储特征词' };
  if (NETWORK_HINTS.test(text)) return { top: NETWORK_TOP, reason: '标题/URL 含网络特征词' };
  if (VIRTUALIZATION_HINTS.test(text)) {
    return { top: VIRTUALIZATION_TOP, reason: '标题/URL 含虚拟化特征词' };
  }

  if (TUTORIAL_HINTS.test(bookmark.title)) {
    return { top: TUTORIAL_TOP, reason: '标题是教程类' };
  }

  return null;
}

/** 规则命中的路径（二级已知时）或锁定的顶层名 */
export function rulePath(assignment: RuleAssignment): string | undefined {
  return assignment.sub ? `${assignment.top}/${assignment.sub}` : undefined;
}
