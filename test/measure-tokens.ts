/**
 * 量一次真实调用的 token 用量，据此推算 1600 条书签的总消耗。
 * 直接打网关并读 usage 字段，不用估算。
 *
 * 用法：BM_AI_KEY=xxx npx tsx test/measure-tokens.ts
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildBatchClassifyPrompt } from '../src/background/aiClassifier';
import { DEFAULT_SETTINGS, MAX_BATCH_SIZE } from '../src/shared/constants';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY = process.env.BM_AI_KEY ?? '';
const ENDPOINT = DEFAULT_SETTINGS.apiEndpoint;

interface RealBookmark {
  readonly title: string;
  readonly url: string;
}

async function main(): Promise<number> {
  if (!KEY) {
    console.error('缺少 BM_AI_KEY');
    return 2;
  }

  const items = JSON.parse(
    readFileSync(join(HERE, '_real-bookmarks.json'), 'utf8'),
  ) as RealBookmark[];

  // 用真实的 30 条（一批）构造 prompt
  const batch = items.slice(0, MAX_BATCH_SIZE).map((b, i) => ({
    id: String(i), title: b.title, url: b.url,
  }));

  // 模拟「已积累了一些目录」的中期状态
  const knownPaths = ['智能体平台', 'Hermes', '人工智能开发', 'OCR', '硬件/扩展坞', '开发工具/微信开发'];
  const prompt = buildBatchClassifyPrompt(batch, knownPaths, 3);

  console.log(`批大小 ${MAX_BATCH_SIZE}`);
  console.log(`prompt 字符数 ${prompt.length}`);
  console.log(`书签平均标题长度 ${Math.round(items.reduce((s, b) => s + b.title.length, 0) / items.length)} 字\n`);

  const resp = await fetch(`${ENDPOINT}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: DEFAULT_SETTINGS.apiModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 8192,
      temperature: 0.3,
      thinking: { type: 'disabled' }, // 与扩展一致
    }),
  });

  const json = (await resp.json()) as {
    usage?: Record<string, number>;
    choices?: { message?: { content?: string; reasoning_content?: string } }[];
  };
  const usage = json.usage ?? {};
  const content = json.choices?.[0]?.message?.content ?? '';

  console.log('--- 单批实际用量 ---');
  for (const [k, v] of Object.entries(usage)) {
    if (typeof v === 'number') console.log(`  ${k}: ${v}`);
  }
  console.log(`  响应字符数: ${content.length}`);

  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const perBatch = promptTokens + completionTokens;

  console.log(`\n单批合计 ${perBatch} tokens（输入 ${promptTokens} + 输出 ${completionTokens}）`);

  // 推算 1600 条。注意输入会随「已知目录清单」增长，这里按单批实测值算下限
  const total = 1600;
  const batches = Math.ceil(total / MAX_BATCH_SIZE);
  const naive = perBatch * batches;

  console.log(`\n--- 推算 ${total} 条 ---`);
  console.log(`  批次数 ${batches}`);
  console.log(`  按单批实测值: ${naive.toLocaleString()} tokens`);
  console.log(`  （输入会随已积累目录清单增长，实际略高；输出随批内条目数基本线性）`);

  return 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
