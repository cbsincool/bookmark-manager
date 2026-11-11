import { DEFAULT_RERANKER_ENDPOINT } from '@/shared/constants';

/**
 * Rerank candidate texts against a query using a TEI (bge-reranker compatible)
 * HTTP API. Returns scores in the same order as the input texts.
 * `endpoint` comes from AppSettings.rerankerEndpoint.
 */
export async function rerank(
  query: string,
  texts: readonly string[],
  endpoint: string = DEFAULT_RERANKER_ENDPOINT,
): Promise<number[]> {
  const base = (endpoint.trim() || DEFAULT_RERANKER_ENDPOINT).replace(/\/+$/, '');
  const resp = await fetch(`${base}/rerank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, texts }),
  });

  if (!resp.ok) {
    throw new Error(`Reranker API error: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json() as { index: number; score: number }[];
  // TEI rerank returns results sorted by score, with original index
  // Reconstruct scores array in original order
  const scores = new Array<number>(texts.length).fill(0);
  for (const item of data) {
    scores[item.index] = item.score;
  }
  return scores;
}
