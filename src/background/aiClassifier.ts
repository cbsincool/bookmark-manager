import type { AppSettings } from '@/shared/types';
import { callCloudAPI } from './apiClient';
import { normalizeDirectoryPath } from '@/shared/directoryNaming';
import { MAX_BATCH_SIZE } from '@/shared/constants';

/**
 * 分批的 AI 归档：把「这条网页该进哪个目录」整个交给模型判断。
 *
 * 为什么不用向量相似度兜底：实测在真实书签上，**相关与不相关内容的余弦相似度
 * 都落在 0.4-0.6**，区分不出来。同一个文件夹里混着显卡扩展坞评测和智能体文档，
 * 而它们的相似度和同主题内容差不多。所以判断只能交给模型——它看标题就能分对，
 * 而 k-means 只能找出「向量团块」，找不出「语义类别」。
 *
 * 分批的理由是成本：一条一次调用，1600 条就是 1600 次。按批给模型
 * 「这批标题 + 当前目录清单」，拿回整批的归属，调用次数降一个数量级。
 */

export interface ClassifyItem {
  readonly id: string;
  readonly title: string;
  readonly url: string;
}

export interface ClassifyOutcome {
  /** id → 目录路径。未归类的 id 不在表里 */
  readonly assignments: ReadonlyMap<string, string>;
  /** 本次新建的目录路径（按首次出现顺序） */
  readonly createdPaths: readonly string[];
  /** 模型是否真的参与了（false = 调用失败，调用方需降级） */
  readonly usedAi: boolean;
  readonly detail?: string;
}

/** 一批最多塞多少条书签——太多模型会漏答，太少调用次数上不去 */
const DEFAULT_BATCH_SIZE = MAX_BATCH_SIZE;

export function buildBatchClassifyPrompt(
  items: readonly ClassifyItem[],
  existingPaths: readonly string[],
  maxDepth: number,
  mustUsePaths: readonly string[] = [],
): string {
  const list = items
    .map((b) => `- [id:${b.id}] "${b.title}" (${b.url})`)
    .join('\n');

  const existing = existingPaths.length > 0
    ? `已经存在的目录（**优先归入这些**，不要另建同义目录）：\n${existingPaths.map((p) => `- ${p}`).join('\n')}\n`
    : '目前还没有任何目录，你需要为这批书签建立目录。\n';

  // 用户勾选的移出目标是**指定目的地**，不是候选。只把它列进「已有目录」不够——
  // 实测勾了「TINY_TARGET」，模型自作主张另建了个「本地服务」。
  const mustUse = mustUsePaths.length > 0
    ? `\n⚠️ 用户明确指定：**所有书签都必须归入下面这几个目录之一**，不要另建新目录：\n${mustUsePaths.map((p) => `- ${p}`).join('\n')}\n`
    : '';

  return `你是书签整理助手。为下面每条书签指定它应该归入的目录。

${existing}${mustUse}
规则：
1. 优先归入上面列出的已有目录；只有当一条书签与所有已有目录都不合适时才新建
2. 新建的目录名必须是一个「完整的词」，像人给文件夹起的名字：
   - 绝对不能包含空格；一个概念需要多个词时拼成一个词或改用中文
   - 不要中英混排（"机器学习 Machine Learning" 这类重复表达不合格）
   - 不要带 "教程/指南/Tutorial/Guide" 之类的描述性后缀
3. 目录路径最多 ${maxDepth} 层，用 "/" 分隔，如 "编程/前端" 或 "工具"
4. 同一批里相关的书签要归到同一个目录，不要为每一条都建新目录
5. 每条书签都必须有归属，不能漏

正例（左边合格，右边是不合格的写法）：
    "飞书"            ← "飞书 Backup Docs"
    "机器学习"         ← "机器学习 Machine Learning"
    "ReactHooks"      ← "React Hooks 教程"
    "MachineLearning" ← "Machine Learning Tutorial"

书签：
${list}

只输出 JSON，不要任何解释：{ "书签id": "目录路径", ... }`;
}

/**
 * 解析模型的归属结果。
 * 路径一律过 `normalizeDirectoryPath`——「禁空格、不中英混排、层级上限」的保证
 * 只在这一个地方实现，模型不遵守也拦得住。
 */
export function parseBatchClassifyResponse(
  raw: string,
  maxDepth: number,
): Record<string, string> {
  try {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const parsed = JSON.parse(fence ? fence[1].trim() : raw.trim());
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    const out: Record<string, string> = {};
    for (const [id, path] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof path !== 'string') continue;
      const normalized = normalizeDirectoryPath(path, maxDepth);
      if (normalized) out[id] = normalized;
    }
    return out;
  } catch {
    return {};
  }
}

/** 把书签切成若干批。顺序由调用方决定——把相似的排在一起，结果更稳 */
export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface ClassifyOptions {
  readonly batchSize?: number;
  readonly maxDepth?: number;
  /** 必须归入这些目录（用户勾选的移出目标），模型不得另建 */
  readonly mustUsePaths?: readonly string[];
  /** 每批完成后的进度回调 */
  readonly onProgress?: (done: number, total: number) => void;
}

/**
 * 分批归档。
 *
 * 关键点是**目录清单在批次之间累积**：第一批新建的目录会成为第二、三批的「已有目录」，
 * 所以整份书签最终收敛到一套目录上，而不是每批各建一套。
 */
export async function classifyBookmarks(
  items: readonly ClassifyItem[],
  existingPaths: readonly string[],
  settings: AppSettings,
  options?: ClassifyOptions,
): Promise<ClassifyOutcome> {
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxDepth = options?.maxDepth ?? 3;

  const assignments = new Map<string, string>();
  const known = new Set<string>(existingPaths);
  const created: string[] = [];
  let usedAi = false;
  let lastDetail = '';

  const batches = chunkItems(items, batchSize);

  for (const [index, batch] of batches.entries()) {
    const prompt = buildBatchClassifyPrompt(batch, [...known], maxDepth, options?.mustUsePaths);
    let parsed: Record<string, string> = {};

    // 模型偶尔会回散文而不是 JSON，重试一次基本就好
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        parsed = parseBatchClassifyResponse(await callCloudAPI(prompt, settings), maxDepth);
        if (Object.keys(parsed).length > 0) break;
        lastDetail = `第 ${index + 1} 批解析不出任何归属`;
      } catch (err) {
        lastDetail = String(err).slice(0, 200);
        console.warn(`[Classify] 第 ${index + 1} 批第 ${attempt} 次失败:`, err);
      }
    }

    for (const item of batch) {
      const path = parsed[item.id];
      if (!path) continue;
      assignments.set(item.id, path);
      if (!known.has(path)) {
        known.add(path);
        created.push(path);
      }
    }

    if (Object.keys(parsed).length > 0) usedAi = true;
    options?.onProgress?.(Math.min((index + 1) * batchSize, items.length), items.length);
  }

  return {
    assignments,
    createdPaths: created,
    usedAi,
    detail: usedAi ? undefined : lastDetail,
  };
}
