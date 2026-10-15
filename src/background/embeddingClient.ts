import { EMBEDDING_API_URL, EMBEDDING_MAX_BATCH } from '@/shared/constants';

/** 空文本会被 TEI 以 400 拒绝，并连带整批失败，故用占位符保持批次对齐。 */
const EMPTY_TEXT_PLACEHOLDER = '(untitled)';

function sanitize(text: string): string {
  return text.trim().length > 0 ? text : EMPTY_TEXT_PLACEHOLDER;
}

async function embedChunk(texts: readonly string[]): Promise<Float32Array[]> {
  const resp = await fetch(`${EMBEDDING_API_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: texts }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(
      `Embedding API error: ${resp.status} ${resp.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
    );
  }

  const data = await resp.json() as number[][];
  return data.map((vec) => new Float32Array(vec));
}

/**
 * Generate a single embedding vector via tei-bge-m3 HTTP API.
 * No API key required.
 */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  const [vector] = await embedChunk([sanitize(text)]);
  if (!vector) throw new Error('Embedding API returned no vector');
  return vector;
}

/**
 * Generate embeddings for a batch of texts.
 *
 * The server caps a single request at EMBEDDING_MAX_BATCH inputs and answers 422
 * beyond that, so chunking happens here rather than at every call site.
 * Returned vectors are positionally aligned with the input texts.
 */
export async function generateEmbeddingsBatch(texts: readonly string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const safe = texts.map(sanitize);
  const out: Float32Array[] = [];

  for (let i = 0; i < safe.length; i += EMBEDDING_MAX_BATCH) {
    const chunk = safe.slice(i, i + EMBEDDING_MAX_BATCH);
    out.push(...await embedChunk(chunk));
  }

  return out;
}
