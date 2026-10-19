/**
 * 诊断：为什么模型会返回空响应。看 finish_reason 和 usage——是被 max_tokens
 * 截断了（reasoning 吃掉预算），还是模型真的什么都没输出。
 *
 * 用法：BM_AI_KEY=xxx npx tsx test/diagnose-empty-response.ts [批大小]
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildBatchClassifyPrompt } from '../src/background/aiClassifier';
import { DEFAULT_SETTINGS } from '../src/shared/constants';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY = process.env.BM_AI_KEY ?? '';

interface RealBookmark {
  readonly title: string;
  readonly url: string;
}

async function main(): Promise<number> {
  if (!KEY) {
    console.error('缺少 BM_AI_KEY');
    return 2;
  }

  const size = Number(process.argv[2] ?? 30);
  const items = JSON.parse(
    readFileSync(join(HERE, '_real-bookmarks.json'), 'utf8'),
  ) as RealBookmark[];

  const batch = items.slice(0, size).map((b, i) => ({
    id: String(i), title: b.title, url: b.url,
  }));
  const prompt = buildBatchClassifyPrompt(batch, ['智能体平台', 'Hermes'], 3);

  console.log(`批大小 ${size}，prompt ${prompt.length} 字符\n`);

  for (let i = 1; i <= 6; i++) {
    const resp = await fetch(`${DEFAULT_SETTINGS.apiEndpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: DEFAULT_SETTINGS.apiModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8192,
        temperature: 0.3,
      }),
    });
    const json = (await resp.json()) as {
      choices?: { finish_reason?: string; message?: { content?: string; reasoning_content?: string } }[];
      usage?: Record<string, number>;
    };
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? '';
    const reasoning = choice?.message?.reasoning_content ?? '';
    const usage = json.usage ?? {};

    console.log(
      `第 ${i} 次: finish=${choice?.finish_reason} ` +
      `content=${content.length}字符 reasoning=${reasoning.length}字符 ` +
      `completion_tokens=${usage.completion_tokens} ` +
      `reasoning_tokens=${(usage as Record<string, unknown>).completion_tokens_details
        ? JSON.stringify((usage as unknown as { completion_tokens_details: unknown }).completion_tokens_details)
        : '?'}`,
    );
  }

  return 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
