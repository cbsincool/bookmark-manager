import { RERANKER_API_URL } from '@/shared/constants';

/**
 * Rerank candidate texts against a query using tei-bge-reranker HTTP API.
 * Returns scores in the same order as the input texts.
 */
export async function rerank(
  query: string,
  texts: readonly string[],
): Promise<number[]> {
  const resp = await fetch(`${RERANKER_API_URL}/rerank`, {
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
