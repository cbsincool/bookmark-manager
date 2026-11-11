import type { AppSettings } from '@/shared/types';
import { callCloudAPI } from './apiClient';
import { normalizeDirectoryPath, isImportArtifact } from '@/shared/directoryNaming';
import { parseBatchClassifyResponse } from './aiClassifier';
import { MAX_TOP_LEVELS } from '@/shared/constants';

/**
 * 一级目录分类法（taxonomy）。
 *
 * 整理原本把**现有全部目录路径**当候选交给模型（实测 147 个，含
 * `已导入/书签栏/Linux` 这种导入残渣）。模型于是只会在旧结构里挑，
 * 结果是：一级目录越攒越多（该用户 31 个，`硬件`/`服务器硬件`/`电脑硬件`/
 * `计算机硬件`/`Hardware` 五个并存）、导入残渣永远清不掉。
 *
 * 所以先单独做一件事：把现有的一级目录名收敛成一套**不超过 12 个**的分类法。
 * 这一步是一次独立调用——它看的是「全集」，而不是某 30 条书签的批次，
 * 所以能做出全局一致的决定。收敛后的分类法同时充当后续归档的**白名单**：
 * 顶层只能从里面选，旧目录自然被搬空、被清掉。
 */

export interface ExistingTopLevel {
  readonly name: string;
  readonly count: number;
}

export function buildTaxonomyPrompt(
  existing: readonly ExistingTopLevel[],
  maxTopLevels: number = MAX_TOP_LEVELS,
  required: readonly string[] = [],
): string {
  const list = existing
    .filter((item) => !isImportArtifact(item.name))
    .map((item) => `- ${item.name}（${item.count} 条）`)
    .join('\n');

  const requiredBlock = required.length > 0
    ? `\n下面这些一级目录是**必须保留**的（它们由确定性规则产生，不由你决定）：\n${required.map((n) => `- ${n}`).join('\n')}\n`
    : '';

  return `你在为一个浏览器书签库设计**一级目录分类法**。书签总量约 ${existing.reduce((s, i) => s + i.count, 0)} 条。
${requiredBlock}
现有的一级目录（括号里是该目录下的书签数）：
${list}

要求：
1. 输出**不超过 ${maxTopLevels} 个**一级目录名
2. 一级目录是**领域**，不是平台名：
   - 操作系统（Linux / Mac / Windows）、网站（GitHub / Tmall）、厂商（HP / Dell）
     都要作为**二级目录**归到所属领域下面，不要占一级
   - 例：「Linux」→「技术/Linux」；「GitHub」→「编程/GitHub」；「Tmall」→「生活/购物」
3. 必须合并语义重复或从属的目录：
   - 「服务器硬件 / 电脑硬件 / 计算机硬件 / Hardware」→「硬件」
   - 「网络设备」→「网络」
   - 「技术文档 / 技术资讯」→「技术」
4. **必须覆盖所有书签的主题，一条都不能漏**。除了技术类，生活类（旅游、购物、视频、
   兴趣爱好）也要有归处——不要因为「技术书签多」就把它们挤掉或硬塞进技术类
5. **不要同时保留上下位概念**：一级目录之间不能有包含或从属关系。
   - 已有「硬件」就不要再来一个「存储」，存储是硬件的下位
   - 已有「技术」就不要再来一个「编程」「网络」，它们是技术的下位
6. 每个名字必须是一个完整的词：不含空格、不中英混排、不带「教程/指南/资料/汇总」这类后缀
7. 按书签量从大到小排列

只输出 JSON 数组，不要任何解释：["目录1", "目录2", ...]`;
}

/** 模型返回的 JSON 数组 → 干净的分类法列表（去空、去重、限长） */
export function parseTaxonomyResponse(raw: string, maxTopLevels: number = MAX_TOP_LEVELS): string[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced ? fenced[1] : raw).trim();

  // 模型偶尔会回成 {"categories": [...]}
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const obj = text.match(/\{[\s\S]*\}/);
    const arr = text.match(/\[[\s\S]*\]/);
    if (!arr) return [];
    try {
      parsed = JSON.parse(arr[0]);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
  }

  const candidates = Array.isArray(parsed)
    ? parsed
    : (parsed as { categories?: unknown })?.categories;

  if (!Array.isArray(candidates)) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    if (typeof item !== 'string') continue;
    const name = normalizeDirectoryPath(item.trim());
    if (!name) continue;
    if (isImportArtifact(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= maxTopLevels) break;
  }
  return out;
}

export async function suggestTaxonomy(
  existing: readonly ExistingTopLevel[],
  settings: AppSettings,
  required: readonly string[] = [],
): Promise<{ names: string[]; usedAi: boolean; detail?: string }> {
  if (!settings.apiEndpoint || (settings.apiFormat !== 'anthropic' && !settings.apiKey)) {
    return { names: [...required], usedAi: false, detail: '未配置可用的模型' };
  }

  try {
    const raw = await callCloudAPI(buildTaxonomyPrompt(existing, MAX_TOP_LEVELS, required), settings, 120_000, {
      disableThinking: true,
    });
    const parsed = parseTaxonomyResponse(raw);
    // 规则类目始终保留：白名单一旦不包含它们，视频/购物/教程的归属会被兜底逻辑顶掉
    const names = [
      ...required,
      ...parsed.filter((n) => !required.some((r) => r.toLowerCase() === n.toLowerCase())),
    ];
    if (names.length === 0) {
      return { names: [], usedAi: false, detail: `分类法解析不出（返回 ${raw.length} 字符）` };
    }
    return { names, usedAi: parsed.length > 0, detail: parsed.length > 0 ? undefined : '模型输出不可用，仅保留规则类目' };
  } catch (err) {
    return { names: [...required], usedAi: false, detail: String(err) };
  }
}

/**
 * 「其它」的二次处理。
 *
 * 第一轮没能归类的书签不该直接留给用户——它们之间往往还有共同主题
 * （比如一批没被规则命中的工具站）。这里再问一次，允许它**新建顶层目录**
 * （最多 4 个），因为这个阶段的目的就是把「其它」拆清楚。
 */
export async function refineFallback(
  items: readonly { id: string; title: string; url: string }[],
  existingTops: readonly string[],
  settings: AppSettings,
  maxDepth = 3,
): Promise<Record<string, string>> {
  if (items.length === 0) return {};
  if (!settings.apiEndpoint || (settings.apiFormat !== 'anthropic' && !settings.apiKey)) return {};

  const list = items.map((b) => `- [id:${b.id}] "${b.title}" (${b.url})`).join('\n');
  const prompt = `下面这批书签**没能归入现有的一级目录**。请为它们找到共同主题。

已有的一级目录：
${existingTops.map((n) => `- ${n}`).join('\n')}

要求：
1. 能归入已有目录的，直接给出已有的路径
2. 确实存在共同主题、且现有目录都装不下的，可以新建顶层目录——**最多 4 个**
3. 找不到合适归属的，**不要硬塞**，输出 "其它" 即可
4. 每个名字是一个完整的词：不含空格、不中英混排
5. 路径最多 ${maxDepth} 层

书签：
${list}

只输出 JSON，不要任何解释：{ "书签id": "目录路径", ... }`;

  try {
    const raw = await callCloudAPI(prompt, settings, 180_000, { disableThinking: true });
    return parseBatchClassifyResponse(raw, maxDepth);
  } catch (err) {
    console.warn('[Taxonomy] refineFallback failed:', err);
    return {};
  }
}

/**
 * 定向重试：只把「顶层不在分类法里」的那批书签再问一次。
 *
 * 主分类的提示词已经写了顶层白名单，但模型仍会自作主张写出「编程/Python」这种
 * 分类法里没有的顶层。此前的兜底是直接丢进「未分类」——实测一次就丢了 97 条
 * Python 书签，全都本该进「技术」。重试一次的成本只有几条书签一次调用，
 * 比让用户去「未分类」里手工捡回来便宜得多。
 */
export async function reclassifyIntoAllowlist(
  items: readonly { id: string; title: string; url: string }[],
  allowed: readonly string[],
  settings: AppSettings,
  maxDepth = 3,
): Promise<Record<string, string>> {
  if (items.length === 0 || allowed.length === 0) return {};
  if (!settings.apiEndpoint || (settings.apiFormat !== 'anthropic' && !settings.apiKey)) return {};

  const list = items.map((b) => `- [id:${b.id}] "${b.title}" (${b.url})`).join('\n');
  const prompt = `为下面每条书签指定归属目录。

**顶层目录只能从下面这个列表里原样选一个，一个字都不能改**：
${allowed.map((name) => `- ${name}`).join('\n')}

可以在这之下加一级子目录（例如 "${allowed[0]}/子主题"），最多 ${maxDepth} 层。
输出路径必须以列表中的某个名字开头。

书签：
${list}

只输出 JSON，不要任何解释：{ "书签id": "目录路径", ... }`;

  try {
    const raw = await callCloudAPI(prompt, settings, 180_000, { disableThinking: true });
    return parseBatchClassifyResponse(raw, maxDepth);
  } catch (err) {
    console.warn('[Taxonomy] reclassify failed:', err);
    return {};
  }
}

/**
 * 给「直接落在一级目录下」的书签补二级目录。
 *
 * 模型经常只给顶层不给二级（实测 `教程` 有 94/167 条、`图像处理` 97/103 条
 * 直接躺在顶层），而「单条目录合并」又会把零星子目录并回父目录，
 * 两个因素叠加的结果就是「整理完还是一堆没分类的书签」。这里单独补一轮。
 *
 * 优先复用该顶层下已有的子目录，避免再造一套近义目录。
 */
export async function splitBareAssignments(
  items: readonly { id: string; title: string; url: string }[],
  top: string,
  existingSubs: readonly string[],
  settings: AppSettings,
  maxDepth = 3,
  batchSize = 30,
): Promise<Record<string, string>> {
  if (items.length === 0) return {};
  if (!settings.apiEndpoint || (settings.apiFormat !== 'anthropic' && !settings.apiKey)) return {};

  const subsBlock = existingSubs.length > 0
    ? `已有的二级目录（**优先归入这些**）：\n${existingSubs.map((s) => `- ${s}`).join('\n')}\n`
    : '';

  const out: Record<string, string> = {};
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const list = batch.map((b) => `- [id:${b.id}] "${b.title}" (${b.url})`).join('\n');
    const prompt = `下面这些书签都归在「${top}」下，但还缺二级目录。请为每条指定二级目录。

${subsBlock}
要求：
1. 路径必须写成 "${top}/子目录" 的形式，不能只写 "${top}"
2. 子目录名要具体、是「${top}」这个主题**特有**的维度：
   - 不要用「编程」「硬件」「网络」这种通用领域词（那是别的顶层的事）
   - 不要带「教程/指南/资料」之类的后缀，不要含空格、不要中英混排
3. 同一批里同类书签用同一个子目录，不要为每条都建新目录
   **每个顶层下总共不超过 8 个二级目录**：宁可粗一点，也不要一个网页一个目录
4. 最多 ${maxDepth} 层

书签：
${list}

只输出 JSON，不要任何解释：{ "书签id": "目录路径", ... }`;

    try {
      const raw = await callCloudAPI(prompt, settings, 180_000, { disableThinking: true });
      const parsed = parseBatchClassifyResponse(raw, maxDepth);
      for (const [id, path] of Object.entries(parsed)) {
        if (path.startsWith(`${top}/`)) out[id] = path;
      }
    } catch (err) {
      console.warn(`[Taxonomy] splitBareAssignments(${top}) failed:`, err);
    }
  }
  return out;
}
