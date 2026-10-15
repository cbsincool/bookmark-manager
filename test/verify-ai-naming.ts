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
import { buildClusterNamingPrompt, parseClusterNamingResponse } from '../src/background/apiClient';
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

  const parsed = parseClusterNamingResponse(content);
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
