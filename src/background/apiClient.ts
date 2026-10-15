import type { AppSettings } from '@/shared/types';
import { normalizeDirectoryPath } from '@/shared/directoryNaming';

// 目录名收敛算法统一放在 shared/directoryNaming，这里转出以保持既有导入路径可用
export { normalizeDirectoryPath } from '@/shared/directoryNaming';

export function buildClassificationPrompt(
  bookmarks: readonly { id: string; title: string; url: string; path: string; summary?: string }[],
  topLevelCategories: readonly string[],
  options?: { onlyExisting?: boolean; existingPaths?: string[]; depthMode?: 'shallow' | 'deep' },
): string {
  const bookmarkList = bookmarks
    .map((b) => {
      let entry = `- [id:${b.id}] "${b.title}" (${b.url})`;
      if (b.summary) entry += ` — ${b.summary}`;
      return entry;
    })
    .join('\n');

  const categoryList = topLevelCategories.map((c) => `- ${c}`).join('\n');
  const onlyExisting = options?.onlyExisting ?? false;
  const depthMode = options?.depthMode ?? 'shallow';

  let existingPathsSection = '';
  if (onlyExisting && options?.existingPaths?.length) {
    existingPathsSection = `\nExisting directories (MUST use these, do not create new ones):
${options.existingPaths.map((p) => `- ${p}`).join('\n')}`;
  }

  const depthModeInstruction = depthMode === 'shallow'
    ? 'Prefer FEWER levels. Use specific, descriptive folder names at shallow depth. Combine related topics into single folders rather than creating deep hierarchies.'
    : 'Prefer MORE levels to create fine-grained organization. Use generic folder names at higher levels and specific names at deeper levels. Split topics into sub-folders when possible.';

  const categoryRule = onlyExisting
    ? 'You MUST only use existing directories listed above. If a bookmark does not fit any existing directory, put it in "其他/待分类"'
    : `Top-level directory rules:
1. Prefer using one of these existing categories:
${categoryList}
2. If bookmarks clearly share a new theme NOT covered by existing categories, you MAY create a new top-level category (use concise, descriptive name)
3. If a bookmark doesn't fit any category well, put it under "其他" (the fallback category)`;

  return `You are a bookmark organizer. Classify these bookmarks into a directory structure.

Rules:
1. Maximum 3 levels deep
${categoryRule}${existingPathsSection}
2. ${onlyExisting ? '' : depthModeInstruction}
3. Target 5-20 bookmarks per directory
4. Return ONLY a JSON object: { "category/subfolder/...": ["bookmarkId1", "bookmarkId2"] }

Bookmarks to classify:
${bookmarkList}`;
}

export function parseClassificationResponse(raw: string): Record<string, string[]> {
  try {
    console.log('[API] Parsing response, length:', raw.length);
    console.log('[API] Response preview:', raw.slice(0, 500));

    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();
    console.log('[API] Extracted JSON preview:', jsonStr.slice(0, 500));

    const parsed = JSON.parse(jsonStr);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const result = parsed as Record<string, string[]>;
      console.log('[API] Parsed directory count:', Object.keys(result).length);
      return result;
    }
    console.warn('[API] Parsed result is not an object:', typeof parsed);
    return {};
  } catch (err) {
    console.error('[API] Failed to parse response:', err);
    return {};
  }
}

/**
 * Normalize endpoint for OpenAI-compatible format:
 * users may provide a base URL like "http://host/v1"
 * or the full path "http://host/v1/chat/completions".
 */
export function resolveChatEndpoint(endpoint: string): string {
  const url = endpoint.replace(/\/+$/, ''); // strip trailing slashes
  if (url.endsWith('/chat/completions')) return url;
  return `${url}/chat/completions`;
}

/**
 * Normalize endpoint for Anthropic-native format:
 * users may provide a base URL like "https://host/a800"
 * or the full path "https://host/a800/v1/messages".
 */
export function resolveMessagesEndpoint(endpoint: string): string {
  const url = endpoint.replace(/\/+$/, '');
  if (url.endsWith('/messages')) return url;
  // A base URL that already carries the version segment (e.g. ".../devops/v1")
  // must not get a second /v1 appended.
  if (url.endsWith('/v1')) return `${url}/messages`;
  return `${url}/v1/messages`;
}

export async function callCloudAPI(
  prompt: string,
  settings: Pick<AppSettings, 'apiEndpoint' | 'apiKey' | 'apiModel' | 'apiFormat'>,
  timeoutMs: number = 300000, // 5 minutes default timeout for large prompts
): Promise<string> {
  const format = settings.apiFormat ?? 'openai';
  const isAnthropic = format === 'anthropic';
  const url = isAnthropic
    ? resolveMessagesEndpoint(settings.apiEndpoint)
    : resolveChatEndpoint(settings.apiEndpoint);

  console.log('[API] Calling:', url, 'format:', format);
  console.log('[API] Model:', settings.apiModel);
  console.log('[API] Prompt length:', prompt.length);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (settings.apiKey) {
    if (isAnthropic) {
      headers['x-api-key'] = settings.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${settings.apiKey}`;
    }
  } else if (!isAnthropic) {
    headers['Authorization'] = 'Bearer no-key';
  }

  const body = isAnthropic
    ? JSON.stringify({
        model: settings.apiModel,
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
      })
    : JSON.stringify({
        model: settings.apiModel,
        // 必须显式带上：推理模型（如 deepseek-v4.1-flash）会先输出 reasoning_content，
        // 不设上限时服务端的默认额度可能被推理吃光，content 变成空串，
        // 调用方拿到空字符串后只能静默退回降级路径
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      });

  console.log('[API] Request body length:', body.length);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timer);
    console.log('[API] Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error('[API] Error response:', errorText);
      throw new Error(`API error: ${response.status} ${response.statusText} - ${errorText.slice(0, 200)}`);
    }

    const data = await response.json();
    // Anthropic format: { content: [{ type: 'text', text: '...' }] }
    // OpenAI format: { choices: [{ message: { content: '...' } }] }
    const content = isAnthropic
      ? (data.content?.[0]?.text ?? '')
      : (data.choices?.[0]?.message?.content ?? '');
    console.log('[API] Response content length:', content.length);
    return content;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof DOMException && err.name === 'AbortError') {
      console.error('[API] Request timed out after', timeoutMs, 'ms');
      throw new Error(`API request timed out after ${Math.round(timeoutMs / 1000)}s. Consider reducing batch size or using a faster model.`);
    }
    console.error('[API] Fetch failed:', err);
    throw err;
  }
}

export async function testConnection(
  settings: Pick<AppSettings, 'apiEndpoint' | 'apiKey' | 'apiModel' | 'apiFormat'>,
): Promise<boolean> {
  try {
    const result = await callCloudAPI('Respond with just "OK".', settings);
    return result.length > 0;
  } catch {
    return false;
  }
}

export function buildQualityPrompt(
  items: readonly { title: string; url: string; summary?: string }[],
): string {
  const itemList = items
    .map((item, i) => {
      let entry = `${i + 1}. "${item.title}" (${item.url})`;
      if (item.summary) entry += ` — ${item.summary}`;
      return entry;
    })
    .join('\n');

  return `Rate each webpage's quality on a scale of 0-100 based on:
- Authority: Is the source authoritative and trustworthy?
- Timeliness: Is the content likely up-to-date?
- Depth: Does the content provide substantial information?

Return ONLY a JSON array of objects: [{"index": 1, "score": 85, "reason": "brief explanation"}, ...]

Webpages:
${itemList}`;
}

export function parseQualityResponse(raw: string): { index: number; score: number; reason: string }[] {
  try {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Build prompt for Phase 1: classify bookmarks into top-level categories only
 */
/**
 * Check if a title has low information (generic, unclear for classification)
 */
export function isLowInfoTitle(title: string): boolean {
  const lowInfoPatterns = [
    // Generic English titles
    /^home$/i, /^index$/i, /^untitled$/i, /^document$/i, /^page$/i,
    /^welcome$/i, /^login$/i, /^sign in$/i, /^register$/i,
    /^about$/i, /^contact$/i, /^help$/i, /^faq$/i,
    /^new$/i, /^edit$/i, /^delete$/i, /^submit$/i,
    /^click here$/i, /^read more$/i, /^learn more$/i,
    // Generic Chinese titles
    /^首页$/, /^主页$/, /^无标题$/, /^文档$/, /^欢迎$/,
    /^登录$/, /^注册$/, /^关于$/, /^联系$/, /^帮助$/,
    /^新建$/, /^编辑$/, /^删除$/, /^提交$/,
    /^点击这里$/, /^了解更多$/, /^查看更多$/,
    // Very short titles (less than 2 meaningful characters)
    /^.{0,2}$/,
  ];

  const normalizedTitle = title.trim();
  if (!normalizedTitle) return true;

  for (const pattern of lowInfoPatterns) {
    if (pattern.test(normalizedTitle)) {
      return true;
    }
  }

  // Check if title is mostly numbers or special characters
  const meaningfulChars = normalizedTitle.replace(/[\d\s\-\_\.\|\:\\\/\(\)\[\]]/g, '');
  if (meaningfulChars.length < 2) return true;

  return false;
}

export function buildPhase1Prompt(
  bookmarks: readonly { id: string; title: string }[],
  topLevelCategories: readonly string[],
): string {
  // Only use title, no URL - makes prompt shorter
  const bookmarkList = bookmarks
    .map((b) => `- [id:${b.id}] "${b.title}"`)
    .join('\n');

  const categoryList = topLevelCategories.map((c) => `- ${c}`).join('\n');

  return `Classify these bookmarks into ONE of these top-level categories:

${categoryList}

Rules:
1. Each bookmark goes into exactly ONE category based on its title
2. Return ONLY a JSON object: { "category": ["bookmarkId1", "bookmarkId2"] }
3. If title is unclear or generic, put in "未分类" category

Bookmarks (only titles):
${bookmarkList}`;
}

/**
 * Build prompt for Phase 2: subdivide bookmarks within one category
 */
export function buildPhase2Prompt(
  bookmarks: readonly { id: string; title: string }[],
  parentCategory: string,
): string {
  // Only use title, no URL
  const bookmarkList = bookmarks
    .map((b) => `- [id:${b.id}] "${b.title}"`)
    .join('\n');

  return `Subdivide these bookmarks under "${parentCategory}" into specific sub-folders.

Rules:
1. Create meaningful sub-folder names (2-5 sub-folders) based on titles
2. Maximum 2 levels deep: "${parentCategory}/subfolder"
3. Target 5-20 bookmarks per sub-folder
4. Return ONLY a JSON object: { "${parentCategory}/subfolder": ["bookmarkId1", ...] }
5. If title is generic, keep in parent folder "${parentCategory}"

Bookmarks in "${parentCategory}" (only titles):
${bookmarkList}`;
}

export function buildRefinePrompt(
  path: string,
  bookmarks: readonly { id: string; title: string; url: string }[],
): string {
  const list = bookmarks
    .map((b) => `- [id:${b.id}] "${b.title}" (${b.url})`)
    .join('\n');

  return `The folder "${path}" has low cohesion — its bookmarks cover too many unrelated topics.
Split these bookmarks into 2-5 more specific sub-folders under "${path}".

Rules:
1. Use specific, semantic sub-folder names (e.g. "React Hooks" not "Frontend")
2. Every bookmark must end up in exactly one sub-folder
3. Return ONLY a JSON object: { "sub-folder name": ["bookmarkId1", ...] }

Bookmarks to split:
${list}`;
}

export function parseRefineResponse(
  raw: string,
  parentPath: string,
): Record<string, string[]> {
  try {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();
    const parsed = JSON.parse(jsonStr) as Record<string, string[]>;
    // Prefix sub-folder names with parent path
    const result: Record<string, string[]> = {};
    for (const [sub, ids] of Object.entries(parsed)) {
      result[`${parentPath}/${sub}`] = ids;
    }
    return result;
  } catch {
    return {};
  }
}

export function buildFineDedupPrompt(
  items: readonly { id: string; title: string; url: string; summary: string }[],
): string {
  const list = items
    .map((item, i) => `${i + 1}. [id:${item.id}] "${item.title}"\n   URL: ${item.url}\n   摘要: ${item.summary || '(无摘要)'}`)
    .join('\n\n');

  return `以下书签可能存在内容重复，请分析每个书签的摘要，判断哪些书签描述了相同或高度相似的主题，并推荐保留质量更高的那个。

评判标准：
1. 内容是否描述同一主题或提供相同信息
2. 内容深度（详细的优于简略的）
3. 来源权威性（官方文档优于第三方）
4. 时效性（较新的内容优先）

请返回 JSON 格式：
{
  "groups": [
    {
      "reason": "重复原因说明",
      "keepId": "推荐保留的书签ID",
      "deleteIds": ["建议删除的书签ID列表"]
    }
  ],
  "standalone": ["不与任何其他书签重复的ID列表"]
}

书签列表：
${list}`;
}

export interface FineDedupGroup {
  reason: string;
  keepId: string;
  deleteIds: string[];
}

export interface FineDedupAiResult {
  groups: FineDedupGroup[];
  standalone: string[];
}

export function parseFineDedupResponse(raw: string): FineDedupAiResult {
  try {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();
    const parsed = JSON.parse(jsonStr) as FineDedupAiResult;
    if (parsed && Array.isArray(parsed.groups)) {
      return parsed;
    }
    return { groups: [], standalone: [] };
  } catch {
    return { groups: [], standalone: [] };
  }
}

/**
 * Build prompt for cluster naming: given cluster titles, output directory paths (max 3 levels).
 */
export function buildClusterNamingPrompt(
  clusters: readonly { clusterId: string; titles: readonly string[] }[],
  maxDepth: number,
  userCategories?: readonly string[],
): string {
  const clusterList = clusters
    .map((c) => {
      const sample = c.titles.slice(0, 8).map((t) => `  - ${t}`).join('\n');
      return `[cluster:${c.clusterId}] (${c.titles.length} bookmarks)\n${sample}`;
    })
    .join('\n\n');

  const categoryHint = userCategories && userCategories.length > 0
    ? `\n用户已有的一级目录（优先复用，无需强制）：${userCategories.join('、')}\n`
    : '';

  return `你是书签整理助手。根据每个语义聚类中的书签标题，为每个聚类分配一个合适的目录路径（最多 ${maxDepth} 层，用 "/" 分隔）。
${categoryHint}
目录命名规则（最重要，务必遵守）：
- 每个目录名必须是「一个完整的词」，读起来像人给文件夹起的名字
- 绝对不能包含空格。一个概念需要多个词才能表达时，拼成一个词或改用中文
- 不要中英混排（"机器学习 Machine Learning" 这类重复表达一律不合格）
- 不要带 "教程/指南/Tutorial/Guide/Notes" 之类的描述性后缀

正例（左边合格，右边是不合格的写法）：
    "飞书"            ← "飞书 Backup Docs"
    "机器学习"         ← "机器学习 Machine Learning"
    "ReactHooks"      ← "React Hooks 教程"
    "MachineLearning" ← "Machine Learning Tutorial"
    "容器编排"         ← "容器编排 Container Orchestration"
    "GCP"             ← "Google Cloud Platform"
    "WebDevelopmentTools" ← "Web Development Tools"
其他不合格写法："前端 Framework"、"文档 备份"、"工具 效率"

- 每段不超过 16 个汉字或 32 个字符；专有名词（React、Docker、GCP）保留原拼写

其他要求：
1. 目录路径最多 ${maxDepth} 层，如 "编程/前端/ReactHooks" 或 "工具/效率"
2. 相关聚类应共享父目录（如多个编程相关聚类都用 "编程/..."）
3. 优先复用用户已有目录作为一级目录，内容确实不符合时才新建
4. 只输出 JSON，不要任何解释：{ "clusterId": "目录路径", ... }

聚类列表：
${clusterList}`;
}

/** 分层命名的输入：一个大类 + 它的子类 */
export interface HierarchicalNamingInput {
  readonly groupId: string;
  readonly titles: readonly string[];
  readonly children: readonly { readonly id: string; readonly titles: readonly string[] }[];
}

/**
 * 两层聚类的命名 prompt。
 *
 * 关键约束：**子类只输出最后一段**，父路径由调用方拼接。这样层级结构由代码决定，
 * 不依赖模型理解「这几个子类属于同一个大类」——它只要给每段起个名字就行。
 */
export function buildHierarchicalNamingPrompt(
  groups: readonly HierarchicalNamingInput[],
  userCategories?: readonly string[],
): string {
  const rendered = groups
    .map((g) => {
      const head = g.titles.slice(0, 8).map((t) => `    - ${t}`).join('\n');
      const kids = g.children
        .map((c) => {
          const lines = c.titles.slice(0, 8).map((t) => `      - ${t}`).join('\n');
          return `  [子类 ${c.id}] (${c.titles.length} 条)\n${lines}`;
        })
        .join('\n');
      return `[大类 ${g.groupId}] (${g.titles.length} 条)\n${head}${kids ? '\n' + kids : ''}`;
    })
    .join('\n\n');

  const categoryHint =
    userCategories && userCategories.length > 0
      ? `\n用户已有的一级目录（优先复用，无需强制）：${userCategories.join('、')}\n`
      : '';

  return `你是书签整理助手。下面是两层结构的语义聚类：每个「大类」下可能有若干「子类」。
为每个大类、每个子类各起一个名字。
${categoryHint}
命名规则（最重要，务必遵守）：
- 每个名字必须是「一个完整的词」，读起来像人给文件夹起的名字
- 绝对不能包含空格；一个概念需要多个词时，拼成一个词或改用中文
- 不要中英混排（"机器学习 Machine Learning" 这类重复表达一律不合格）
- 不要带 "教程/指南/Tutorial/Guide/Notes" 之类的描述性后缀

**大类名**：一级目录名
**子类名**：只输出**最后一段**，不要含 "/"。程序会把它拼到所属大类后面，
    所以不要重复大类名（大类叫"人工智能"时，子类写"机器学习"而不是"人工智能/机器学习"）

正例（左边合格，右边是不合格的写法）：
    "人工智能"  ← "AI 人工智能"
    "机器学习"  ← "Machine Learning 教程"
    "容器编排"  ← "K8s 容器编排"
    "ReactHooks" ← "React Hooks 教程"

只输出 JSON，不要任何解释：{ "0": "大类名", "0.0": "子类名", "0.1": "子类名", "1": "大类名", ... }

聚类：
${rendered}`;
}

export interface ClusterNamingResult {
  [clusterId: string]: string;
}

export function parseClusterNamingResponse(raw: string, maxDepth?: number): ClusterNamingResult {
  try {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const out: ClusterNamingResult = {};
      for (const [clusterId, path] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof path !== 'string') continue;
        const normalized = normalizeDirectoryPath(path, maxDepth);
        if (normalized) out[clusterId] = normalized;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}
