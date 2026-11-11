import { GENERIC_NAME_WORDS, UNCLASSIFIED_DIR } from './constants';

/**
 * 目录名收敛：把 AI 或关键词提取产出的「空格拼接词」收敛成一个完整概念的词。
 *
 * 设计约束（用户明确要求）：
 *   - 结果**永不含空白字符**
 *   - 结果**永不同时含汉字与拉丁字母**，唯一例外是「单字中文打头 + 拉丁」
 *     （`云 Native` → `云Native`）——那个汉字丢掉就没意义了
 *   - 已是一个词的名称（"Node.js"、"C++"、"GCP"、".NET"）**原样保留**
 */

/**
 * 单个片段的视觉宽度上限：汉字计 2、其余计 1，即等价于
 * 「16 个汉字」或「32 个拉丁字符」。用视觉宽度而不是字符数，
 * 是为了不把 "WebDevelopmentTools" 这类完整英文名无谓截断。
 */
export const MAX_VISUAL_LENGTH = 32;

/**
 * 不可见字符：零宽空格/连接符、双向文本控制符、软连字符等。
 *
 * 它们**不在 JS `\s` 的匹配范围内**，所以会整串穿过所有基于空白的清洗。
 * 危害在于看不出来——`"React​Hooks"` 和 `"ReactHooks"` 渲染出来一模一样，
 * 用户只会觉得「这个名字怎么改都不对」，排查时几乎不可能想到。
 */
export const INVISIBLE_CHARS = new RegExp(
  '[' +
  [
    '\u00AD', // 软连字符
    '\u180E', // 蒙古文元音分隔符
    '\u200B-\u200F', // 零宽空格 / 零宽非连接符 / 零宽连接符 / LRM / RLM
    '\u202A-\u202E', // 双向文本嵌入与覆盖
    '\u2060-\u2064', // 词连接符 / 不可见运算符
    '\u2066-\u2069', // 双向文本隔离
    '\uFEFF', // 字节序标记
  ].join('') +
  ']',
  'g',
);

/**
 * 片段首尾的装饰性标点。
 * 前导的 "." 是例外——".NET" 里的点是名称的一部分，只有连续的点且后面不是字母时才算垃圾。
 */
const LEADING_JUNK = /^[\s/\\|·、,，:：;；!！?？\-—_]+|^\.+(?![A-Za-z])/;
const TRAILING_JUNK = /[\s/\\|·、,，.。:：;；!！?？\-—_]+$/;

function trimEdgeJunk(raw: string): string {
  // 先去不可见字符：它们会让下面的 `\s` 判定和 `trim()` 全部失准
  let s = raw.replace(INVISIBLE_CHARS, '').replace(/\s+/g, ' ').trim();
  let previous: string;
  do {
    previous = s;
    s = s.replace(LEADING_JUNK, '').replace(TRAILING_JUNK, '').trim();
  } while (s !== previous);
  return s;
}

/** CJK 统一表意文字区（目录名以中英文为主，够用） */
const CJK_RUN = /[一-鿿]+/g;
/** 非全局版本——`.test()` 不能和有状态的 `g` 正则混用 */
const HAS_CJK = /[一-鿿]/;
const STARTS_CJK = /^[一-鿿]/;

/** 拉丁词切分：保留 "Node.js" / "C++" / "Web3" 这类写法 */
const LATIN_TOKEN = /[A-Z][a-z0-9+#.]*|[a-z0-9+#.]+/g;

const GENERIC_WORD_SET = new Set<string>(GENERIC_NAME_WORDS);

/**
 * 品牌大小写表。模型常写出 "Github"、"Javascript" 这类错误拼写，
 * 拼成一个词之后更显眼，这里纠回官方写法。
 */
const BRAND_CASING: Readonly<Record<string, string>> = {
  github: 'GitHub', gitlab: 'GitLab', javascript: 'JavaScript', typescript: 'TypeScript',
  node: 'Node.js', nodejs: 'Node.js', npm: 'npm',
  postgresql: 'PostgreSQL', postgres: 'PostgreSQL', mysql: 'MySQL', mongodb: 'MongoDB',
  ios: 'iOS', macos: 'macOS', linux: 'Linux', docker: 'Docker', kubernetes: 'Kubernetes',
  react: 'React', vue: 'Vue', webgl: 'WebGL', web3: 'Web3', openai: 'OpenAI',
  css: 'CSS', html: 'HTML', api: 'API', sql: 'SQL', ai: 'AI', ui: 'UI', ux: 'UX',
};

/** 汉字计 2、其余计 1 */
export function visualLength(s: string): number {
  let width = 0;
  for (const ch of s) width += HAS_CJK.test(ch) ? 2 : 1;
  return width;
}

function applyBrandCasing(token: string): string {
  return BRAND_CASING[token.toLowerCase()] ?? token;
}

/**
 * 超长片段的截断。中文按字截；英文按词边界截
 * （"WebDevelopmentToolsAdvanced" → "WebDevelopmentTools"），避免切出半截词。
 */
function capSegment(s: string): string {
  if (visualLength(s) <= MAX_VISUAL_LENGTH) return s;

  if (STARTS_CJK.test(s)) {
    let out = '';
    let width = 0;
    for (const ch of s) {
      const w = HAS_CJK.test(ch) ? 2 : 1;
      if (width + w > MAX_VISUAL_LENGTH) break;
      out += ch;
      width += w;
    }
    return out;
  }

  const parts = s.match(LATIN_TOKEN) ?? [];
  let out = '';
  for (const part of parts) {
    if (visualLength(out + part) > MAX_VISUAL_LENGTH) break;
    out += part;
  }
  return out || s.slice(0, MAX_VISUAL_LENGTH);
}

/** 剥掉通用/描述性词；整串都是通用词时只留第一个（"Tutorial Guide" → "Tutorial"） */
function dropGenericWords(tokens: readonly string[]): readonly string[] {
  const kept = tokens.filter((t) => !GENERIC_WORD_SET.has(t.toLowerCase()));
  return kept.length > 0 ? kept : tokens.slice(0, 1);
}

/** 大小写不敏感、保序去重（"React React Hooks" → React + Hooks） */
function dedupeTokens(tokens: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return tokens.filter((t) => {
    const key = t.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 多个英文词拼成一个词："Machine Learning" → "MachineLearning" */
function joinLatinTokens(tokens: readonly string[]): string {
  return tokens.map(applyBrandCasing).join('');
}

/**
 * 清洗单个目录名片段，**保证结果不含任何空白**。
 *
 * 之所以拼接而不是取首个词：首个词往往只是修饰语
 * （"Machine Learning" 取首词得到毫无意义的 "Machine"），拼接能保住完整语义。
 */
export function normalizeSegment(raw: string): string {
  const base = trimEdgeJunk(raw.normalize('NFKC'));
  if (!base) return '';

  // 已经是一个词：纠正品牌拼写，并把中英混排收敛到一侧
  if (!/\s/.test(base)) {
    if (!HAS_CJK.test(base)) return capSegment(applyBrandCasing(base));

    const latin = base.replace(/[^A-Za-z0-9+#.]+/g, '');
    if (!latin) return capSegment(base);

    // 中文打头且中文部分够长 → 中文是主题（"飞书Docs" → "飞书"）；
    // 否则拉丁侧才是主题（"Vue文档" → "Vue"）
    const head = STARTS_CJK.test(base) ? base.match(CJK_RUN)?.[0] ?? '' : '';
    return capSegment(head.length >= 2 ? head : applyBrandCasing(latin));
  }

  const tokens = base.split(' ').filter(Boolean);
  const cjk = (base.match(CJK_RUN) ?? []).join('');
  const latinTokens = tokens.filter((t) => !HAS_CJK.test(t));

  // 被空格拆开的中文（"文档 备份"）——直接拼回去，一个词都不丢
  if (latinTokens.length === 0) {
    return capSegment(cjk || base.replace(/\s+/g, ''));
  }

  const joinedLatin = joinLatinTokens(dedupeTokens(dropGenericWords(latinTokens)));

  // 中文打头：中文是主题，拉丁只是注解（"飞书 Backup Docs" → "飞书"）
  if (STARTS_CJK.test(base)) {
    const head = base.match(CJK_RUN)?.[0] ?? '';
    if (head.length >= 2) return capSegment(head);
    // 单字中文打头（"云 Native"）——两边都要，不能丢掉那个字。
    // 这是本模块「不中英混排」保证的唯一例外，见文件头注释
    return capSegment(head + joinedLatin);
  }

  // 拉丁打头：丢掉尾部中文（"React Hooks 教程" → "ReactHooks"）
  return capSegment(joinedLatin);
}

/**
 * 清洗整条目录路径，丢弃清洗后为空的片段与连续重复段。
 *
 * `maxDepth` 用于强制层级上限：模型并不总会遵守 prompt 里的深度约束
 * （实测让它给 1 层的溢出目录命名时，偶尔会回 "户外/露营" 这种两层路径）。
 * 超限时**保留前几层**——模型把更泛的概念放在前面，截前缀比截后缀更接近原意。
 */
export function normalizeDirectoryPath(path: string, maxDepth?: number): string {
  const segments = path.split('/').map(normalizeSegment).filter(Boolean);
  const deduped = segments.filter((s, i) => i === 0 || s !== segments[i - 1]);
  return (maxDepth ? deduped.slice(0, maxDepth) : deduped).join('/');
}

const NAME_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'this', 'that', 'these', 'those',
  '的', '了', '是', '在', '和', '有', '我', '他', '她', '它',
]);

/**
 * AI 不可用时的降级命名：从书签标题里取高频关键词，再走同一条收敛流水线。
 * 复用 `normalizeSegment` 而不是另写一套规则——「禁空格」只有一个实现。
 */
export function suggestDirectoryName(titles: readonly string[]): string {
  const wordFreq = new Map<string, number>();

  for (const title of titles) {
    // 也按 "/" 切分：否则 "React/Hooks 教程" 会整个成为一个词，产出的名字里带
    // 斜杠，写进 directoryTree 的 key 后会被当成两级目录。
    // 不可见字符同理——"React​Hooks" 不切开会粘成一个词，
    // 清洗后得到小写的 "Reacthooks"
    const words = title
      .toLowerCase()
      .split(/[\s\-_:\\/]+/)
      .flatMap((chunk) => chunk.split(INVISIBLE_CHARS));

    for (const word of words) {
      if (word.length < 2) continue;
      if (NAME_STOP_WORDS.has(word) || GENERIC_WORD_SET.has(word)) continue;
      if (!/^[a-zA-Z一-鿿]/.test(word)) continue;
      wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
    }
  }

  // 频率相同时取更长的词——长词通常更具体（"Kubernetes" 优于 "k8s"）
  const ranked = Array.from(wordFreq.entries()).sort(
    (a, b) => b[1] - a[1] || b[0].length - a[0].length,
  );

  if (ranked.length === 0) return UNCLASSIFIED_DIR;

  // 只取最高频的那一个词。取多个词会把同义词拼在一起
  // （"Kubernetes" + "k8s" → "KubernetesK8s"），而它们是同义还是互补无法确定；
  // 单个词永远干净。丰富的目录名由 AI 命名负责，这里是 AI 不可用时的降级。
  // 关键词来自小写化后的标题，这里补回首字母大写（品牌词由 normalizeSegment 纠正）
  const word = ranked[0][0];
  return normalizeSegment(word.charAt(0).toUpperCase() + word.slice(1)) || UNCLASSIFIED_DIR;
}

/**
 * 导入书签时 Chrome 造出来的容器目录。
 *
 * 它们不是用户的知识分类，却会一直留在一级目录里（实测 `已导入` 下面还套着
 * `已导入/书签栏/Linux`），整理时又被当成合法候选反复复用。
 */
const IMPORT_ARTIFACT_NAMES = new Set([
  '已导入', '导入', '导入的书签', '书签栏', '其他书签', '移动设备书签',
  'imported', 'imported bookmarks', 'bookmarks bar', 'bookmarks toolbar',
  'other bookmarks', 'mobile bookmarks', 'favorites', '收藏夹',
]);

export function isImportArtifact(name: string): boolean {
  return IMPORT_ARTIFACT_NAMES.has(name.trim().toLowerCase());
}

/**
 * 把一组目录名里语义相近的合并掉（没有 AI 时的降级）。
 *
 * 规则：名字互相包含时保留较短的那个（`服务器硬件`/`电脑硬件`/`计算机硬件` → `硬件`，
 * `网络设备` → `网络`）。只做字面判断，不猜语义——需要真正的语义合并时走
 * `ORGANIZE_SUGGEST_TAXONOMY` 让模型来做。
 */
export function mergeNearDuplicateNames(names: readonly string[]): string[] {
  const unique = Array.from(
    new Set(
      names
        .map((name) => name.trim())
        .filter((name) => name.length > 0 && !isImportArtifact(name)),
    ),
  );

  // 按长度决定谁被合并（短的是更一般的概念），但**输出保持输入顺序**——
  // 调用方传进来时已按书签量降序排好，用户看到的顺序应该跟那个一致
  const kept = new Set<string>();
  for (const name of [...unique].sort((a, b) => a.length - b.length)) {
    const lower = name.toLowerCase();
    const covered = [...kept].some((existing) => {
      const base = existing.toLowerCase();
      return lower === base || lower.includes(base) || base.includes(lower);
    });
    if (!covered) kept.add(name);
  }

  return unique.filter((name) => kept.has(name));
}
