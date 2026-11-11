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
  /**
   * 这条书签**当前**所在的目录路径（相对骨架根，没有则为空）。
   *
   * 带上它是为了让「重复整理」稳定：模型看不到书签现在在哪，就只能凭标题重新猜一次，
   * 同一份书签两次整理会得到不同结果。实测在有两棵近义目录（`存储` 与 `存储设备`）
   * 的收藏夹里，第二次整理把 34% 的书签在两棵之间来回搬——而界面上写的是
   * 「归得对的书签不会被搬动」。
   */
  readonly currentPath?: string;
  /**
   * 规则锁定的顶层（Linux / 教程）。给了它，模型只能决定二级目录，
   * 不能再把「Linux 内核文档」挪到「技术/操作系统」去。
   */
  readonly lockedTop?: string;
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
  userCategories: readonly string[] = [],
): string {
  const list = items
    .map((b) => {
      const here = b.currentPath ? ` [现在位于: ${b.currentPath}]` : '';
      const locked = b.lockedTop ? ` [必须归入: ${b.lockedTop}]` : '';
      return `- [id:${b.id}] "${b.title}" (${b.url})${here}${locked}`;
    })
    .join('\n');

  const existing = existingPaths.length > 0
    ? `已经存在的目录（**优先归入这些**，不要另建同义目录）：\n${existingPaths.map((p) => `- ${p}`).join('\n')}\n`
    : '目前还没有任何目录，你需要为这批书签建立目录。\n';

  // 用户确认过的一级目录分类法。这不只是「偏好」——顶层只能从里面选。
  // 以前它只是句软提示，模型照样沿用历史遗留的 31 个一级目录，
  // 于是「一级目录太多」永远治不好。
  const preferred = userCategories.length > 0
    ? `\n**顶层目录只能从下面这些名字里选**（这是用户确认过的分类法，不得新建或改写顶层目录名）：\n${userCategories.map((p) => `- ${p}`).join('\n')}\n` +
      `需要更细的划分时，在它下面建二级目录，例如 "${userCategories[0]}/子主题"。\n`
    : '';

  // 用户勾选的移出目标是**目的地白名单**，不是「所有书签都要去的地方」。
  // 早先这里写的是「所有书签都必须归入下面这几个目录之一」，与调用方的意图正好相反：
  // 照做的话整个文件夹会被倒进某一个目标目录。措辞必须说清「只有确实更匹配的才移出去」。
  const mustUse = mustUsePaths.length > 0
    ? `\n⚠️ 这批书签来自一个指定文件夹，**允许**移出到下面这些目录（仅限这些，不要另建）：\n${mustUsePaths.map((p) => `- ${p}`).join('\n')}\n` +
      `只有确实与其中某个目录明显更匹配的书签才移过去；其余书签仍归入上面「已经存在的目录」中属于该文件夹内部的结构。\n`
    : '';

  return `你是书签整理助手。为下面每条书签指定它应该归入的目录。

${existing}${preferred}${mustUse}
规则：
1. 优先归入上面列出的已有目录；只有当一条书签与所有已有目录都不合适时才新建
   （但**顶层**永远不能新建，见上）。
   **宁可归得宽，也不要硬塞**：与某个子目录只是勉强相关时，归入更宽的一级目录，
   不要塞进那个子目录——放错位置比放在上级更糟，用户还得先把它捞出来。
2. **保持稳定**：如果一条书签标注了「现在位于」，而那个目录已经适合它，
   就把它归回**原来那个目录**，不要因为别的目录看起来也沾边就换过去。
   已有目录里存在多个近义目录（如「存储」与「存储设备」）时，选它原来所在的那个。
3. 不要让目录过碎：同一个主题下**少于 3 条**的内容不要单独建目录，
   并到上级或就近的目录里；一个目录只装一条书签基本没有意义。
   **同一个父目录下不要出现近义子目录**（如「存储」与「存储设备」、「SSD」与「固态硬盘」）——
   已有近义目录时只选其中一个，否则内容会被劈成两半、来回搬。
4. 新建的目录名必须是一个「完整的词」，像人给文件夹起的名字：
   - 绝对不能包含空格；一个概念需要多个词时拼成一个词或改用中文
   - 不要中英混排（"机器学习 Machine Learning" 这类重复表达不合格）
   - 不要带 "教程/指南/Tutorial/Guide" 之类的描述性后缀
5. 目录路径最多 ${maxDepth} 层，用 "/" 分隔，如 "编程/前端" 或 "工具"
6. 同一批里相关的书签要归到同一个目录，不要为每一条都建新目录
7. 每条书签都必须有归属，不能漏
8. 标了「必须归入: X」的书签，路径必须以 "X/" 开头（或正好是 "X"），
   你只决定它下面的二级目录，不能把它挪到别的顶层去。
   二级目录必须是**这个主题特有的维度**，不要用通用领域词：
   - Linux 下用「内核 / 驱动 / 发行版 / Shell / 包管理 / 文件系统 / 系统服务」，
     不要用「编程」「硬件」「网络」——那是别的顶层的事
   - 教程 下按知识领域分（Python / OpenCV / 英语学习…）
   - 存储 / 网络 / 虚拟化 按各自的技术维度分
   **并且尽量给出二级目录**：只写顶层等于没分类

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
  /** 允许移出的目的地（用户勾选的移出目标），模型不得另建 */
  readonly mustUsePaths?: readonly string[];
  /** 用户偏好的顶层目录名，新建顶层目录时优先复用 */
  readonly userCategories?: readonly string[];
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
  const failures: string[] = [];

  /**
   * 归档一批。失败时**对半拆开再试**。
   *
   * 推理模型有个间歇性毛病：有时把 `max_tokens` 全花在「思考」上，`content` 返回空串
   * （实测约每几批一次）。整批失败意味着那批书签全部落进「未分类」——用户看到的是
   * 「除了域名目录，其它全在未分类」。重试一次常常还不够，但**批越小需要的推理越少**，
   * 所以拆半是有效的兜底。
   */
  async function classifyBatch(
    batch: readonly ClassifyItem[],
    depth = 0,
  ): Promise<Record<string, string>> {
    const prompt = buildBatchClassifyPrompt(
      batch,
      [...known],
      maxDepth,
      options?.mustUsePaths,
      options?.userCategories,
    );

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // 第一次关掉推理；它是非标准参数，万一服务商不认，第二次不带它重试
        const raw = await callCloudAPI(prompt, settings, 300_000, {
          disableThinking: attempt === 1,
        });
        const parsed = parseBatchClassifyResponse(raw, maxDepth);
        if (Object.keys(parsed).length > 0) return parsed;

        failures.push(
          `批(${batch.length} 条)解析不出归属（返回 ${raw.length} 字符）` +
            (raw.trim() ? `: ${raw.trim().slice(0, 120)}` : '：模型返回了空响应'),
        );
      } catch (err) {
        failures.push(`批(${batch.length} 条): ${String(err).slice(0, 160)}`);
        console.warn('[Classify] 请求失败:', err);
      }
    }

    if (batch.length > 1 && depth < 3) {
      const mid = Math.ceil(batch.length / 2);
      const [left, right] = await Promise.all([
        classifyBatch(batch.slice(0, mid), depth + 1),
        classifyBatch(batch.slice(mid), depth + 1),
      ]);
      return { ...left, ...right };
    }

    return {};
  }

  const batches = chunkItems(items, batchSize);

  for (const [index, batch] of batches.entries()) {
    const parsed = await classifyBatch(batch);

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
    // 只要有一批失败就带出来——那一批的书签会整批落进「未分类」，
    // 而 usedAi 仍然是 true（其他批成功了），不报出来就完全看不见
    detail: failures.length > 0 ? failures.join(' | ') : undefined,
  };
}
