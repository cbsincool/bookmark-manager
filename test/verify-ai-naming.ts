/**
 * 单独验证 AI 命名链路：用**真实的** buildClusterNamingPrompt / parseClusterNamingResponse
 * 打真实网关，检查模型产出的目录名是否符合规则。
 *
 * 之所以单独跑这一步：端到端脚本里 AI 命名的失败会静默降级成关键词命名，
 * 从 `directoryTree` 上看不出到底走没走模型。
 *
 * 用法（凭证只走环境变量，不落盘）：
 *   BM_AI_KEY=xxx BM_AI_MODEL=deepseek-v4.1-flash npx vite-node test/verify-ai-naming.ts
 */
import {
  buildClusterNamingPrompt,
  buildHierarchicalNamingPrompt,
  parseClusterNamingResponse,
} from '../src/background/apiClient';
import { normalizeDirectoryPath } from '../src/shared/directoryNaming';

const ENDPOINT = process.env.BM_AI_ENDPOINT ?? 'https://ai-gateway-inside.haplat.net/devops/v1';
const KEY = process.env.BM_AI_KEY ?? '';
const MODEL = process.env.BM_AI_MODEL ?? 'deepseek-v4.1-flash';
const FORMAT = process.env.BM_AI_FORMAT ?? 'openai';

/** 覆盖中英混排、纯英文多词、中文带英文注解、通用词后缀等真实形态 */
const CLUSTERS = [
  {
    clusterId: '0',
    titles: ['React Hooks 教程', 'React 状态管理指南', 'React Router 入门', 'React 性能优化实践'],
  },
  {
    clusterId: '1',
    titles: ['Kubernetes 集群管理', 'Docker Compose 编排', '容器网络详解', 'Helm Chart 实践'],
  },
  {
    clusterId: '2',
    titles: ['Machine Learning Tutorial', 'Deep Learning Guide', 'PyTorch 入门', 'Neural Network Basics'],
  },
  { clusterId: '3', titles: ['飞书 使用手册', '飞书 文档备份方案', '飞书 机器人开发'] },
  { clusterId: '4', titles: ['个人理财笔记', '基金定投入门', '保险配置指南'] },
];

const USER_CATEGORIES = ['技术文档', '工作相关', '学习资料'];

/** 溢出目录的命名输入：与所有骨架目录都不相似的书签，被二次聚类成组后单独命名 */
const OVERFLOW_CLUSTERS = [
  { clusterId: '0', titles: ['露营装备清单', '帐篷选购指南', '户外电源对比'] },
  { clusterId: '1', titles: ['咖啡豆烘焙笔记', '手冲参数记录', '意式浓缩萃取'] },
  { clusterId: '2', titles: ['宠物疫苗时间表', '猫粮成分分析'] },
];

interface ChatResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: string } }[];
}

interface Scenario {
  readonly label: string;
  readonly clusters: readonly { readonly clusterId: string; readonly titles: readonly string[] }[];
  readonly maxDepth: number;
  readonly categories?: readonly string[];
}

const SCENARIOS: readonly Scenario[] = [
  {
    label: '骨架命名（maxDepth=3，带用户已有目录）',
    clusters: CLUSTERS,
    maxDepth: 3,
    categories: USER_CATEGORIES,
  },
  {
    label: '溢出目录命名（maxDepth=1，平级目录）',
    clusters: OVERFLOW_CLUSTERS,
    maxDepth: 1,
  },
];

async function callModel(prompt: string): Promise<string> {
  const resp = await fetch(`${ENDPOINT}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 8192,
      temperature: 0.3,
    }),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }

  const json = (await resp.json()) as ChatResponse;
  return json.choices?.[0]?.message?.content ?? '';
}

/** 返回该场景下的违规数 */
function reportScenario(scenario: Scenario, content: string): number {
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  let raw: Record<string, string> = {};
  try {
    raw = JSON.parse(fence ? fence[1].trim() : content.trim());
  } catch {
    console.log('  !! 模型输出不是合法 JSON');
  }

  // 传 maxDepth，测的是代码实际产出的结果——溢出命名会强制截断到 1 层，
  // 只看模型原始输出会把「模型越界但代码拦住了」误报成失败
  const parsed = parseClusterNamingResponse(content, scenario.maxDepth);
  let violations = 0;
  let missing = 0;

  for (const cluster of scenario.clusters) {
    const modelSaid = raw[cluster.clusterId];
    const final = parsed[cluster.clusterId];

    if (!final) {
      missing++;
      console.log(`  [${cluster.clusterId}] !! 未命名（模型原样: ${JSON.stringify(modelSaid)}）`);
      continue;
    }

    const segments = final.split('/');
    const problems: string[] = [];
    if (segments.some((s) => /\s/.test(s))) problems.push('含空格');
    if (segments.some((s) => /[一-鿿]/.test(s) && /[A-Za-z]/.test(s))) problems.push('中英混排');
    if (segments.length > scenario.maxDepth) problems.push(`超过 ${scenario.maxDepth} 层`);
    if (normalizeDirectoryPath(final) !== final) problems.push('非幂等');

    if (problems.length > 0) violations++;
    console.log(
      `  [${cluster.clusterId}] ${JSON.stringify(modelSaid)} → ${JSON.stringify(final)}` +
        (problems.length > 0 ? `   ← ${problems.join('、')}` : ''),
    );
  }

  console.log(`  命名覆盖 ${scenario.clusters.length - missing}/${scenario.clusters.length}，违规 ${violations}`);
  return violations + missing;
}

/**
 * 分层命名的输入：大类 + 子类。
 * 关键契约是「子类只输出最后一段」——父路径由代码拼，模型不该重复大类名。
 */
const HIERARCHICAL = [
  {
    groupId: '0',
    titles: ['Transformer 架构详解', '注意力机制', '大语言模型微调'],
    children: [
      { id: '0.0', titles: ['Transformer 架构详解', '注意力机制 Attention', '位置编码'] },
      { id: '0.1', titles: ['大语言模型微调实践', 'LoRA 低秩适配', '提示词工程指南'] },
    ],
  },
  {
    groupId: '1',
    titles: ['React Hooks 教程', 'Vue 3 组合式 API'],
    children: [
      { id: '1.0', titles: ['React Hooks 教程', 'React 状态管理'] },
      { id: '1.1', titles: ['Vue 3 组合式 API', 'Vite 构建优化'] },
    ],
  },
  {
    groupId: '2',
    titles: ['个人理财入门', '基金定投策略'],
    children: [],
  },
];

async function checkHierarchical(): Promise<number> {
  console.log('='.repeat(64));
  console.log('分层命名（大类 + 子类，子类只出最后一段）');
  console.log('='.repeat(64));

  const prompt = buildHierarchicalNamingPrompt(HIERARCHICAL, ['技术文档', '学习资料']);
  const started = Date.now();
  const content = await callModel(prompt);
  console.log(`耗时 ${Date.now() - started}ms`);
  console.log('--- 模型原始输出 ---');
  console.log(content || '(空)');

  const parsed = parseClusterNamingResponse(content);
  let problems = 0;

  console.log('--- 逐项核对 ---');
  for (const group of HIERARCHICAL) {
    const top = parsed[group.groupId];
    if (!top) {
      problems++;
      console.log(`  [大类 ${group.groupId}] !! 未命名`);
    } else {
      const bad = /\s/.test(top) || (/[一-鿿]/.test(top) && /[A-Za-z]/.test(top));
      if (bad) problems++;
      console.log(`  [大类 ${group.groupId}] ${JSON.stringify(top)}${bad ? '   ← 违规' : ''}`);
    }

    for (const child of group.children) {
      const name = parsed[child.id];
      if (!name) {
        problems++;
        console.log(`    [子类 ${child.id}] !! 未命名`);
        continue;
      }
      const issues: string[] = [];
      if (/\s/.test(name)) issues.push('含空格');
      if (/[一-鿿]/.test(name) && /[A-Za-z]/.test(name)) issues.push('中英混排');
      // 子类不该重复大类名（父路径由代码拼）
      if (top && name.startsWith(top + '/')) issues.push('重复了父路径');
      if (name.includes('/')) issues.push('含斜杠');
      if (issues.length > 0) problems++;
      console.log(`    [子类 ${child.id}] ${JSON.stringify(name)}${issues.length ? '   ← ' + issues.join('、') : ''}`);
    }
  }

  console.log(problems === 0 ? '\n结果: 分层命名通过' : `\n结果: ${problems} 项不通过`);
  return problems;
}

async function main(): Promise<number> {
  if (!KEY) {
    console.error('缺少 BM_AI_KEY');
    return 2;
  }

  console.log(`端点  ${ENDPOINT}  (${FORMAT})`);
  console.log(`模型  ${MODEL}\n`);

  let failures = 0;

  for (const scenario of SCENARIOS) {
    console.log('='.repeat(64));
    console.log(scenario.label);
    console.log('='.repeat(64));

    const prompt = buildClusterNamingPrompt(scenario.clusters, scenario.maxDepth, scenario.categories);
    const started = Date.now();

    let content: string;
    try {
      content = await callModel(prompt);
    } catch (err) {
      console.error(`  请求失败: ${err instanceof Error ? err.message : String(err)}`);
      failures += scenario.clusters.length;
      continue;
    }

    console.log(`耗时 ${Date.now() - started}ms`);
    console.log('--- 模型原始输出 ---');
    console.log(content || '(空)');
    console.log('--- 逐簇核对 ---');
    failures += reportScenario(scenario, content);
    console.log('');
  }

  failures += await checkHierarchical();

  console.log('='.repeat(64));
  console.log(failures === 0 ? '结果: 全部通过' : `结果: ${failures} 项不通过`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('异常:', err);
    process.exit(1);
  },
);
