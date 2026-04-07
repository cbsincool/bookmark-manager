import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';
import { EMBEDDING_MODEL } from '@/shared/constants';

let extractor: FeatureExtractionPipeline | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', EMBEDDING_MODEL, {
      quantized: true,
    });
  }
  return extractor;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

async function generateEmbeddingsBatch(texts: readonly string[]): Promise<number[][]> {
  const ext = await getExtractor();
  const results: number[][] = [];
  for (const text of texts) {
    const output = await ext(text, { pooling: 'mean', normalize: true });
    results.push(Array.from(output.data as Float32Array));
  }
  return results;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GENERATE_EMBEDDING') {
    generateEmbedding(message.text)
      .then((vector) => sendResponse({ success: true, data: vector }))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }

  if (message.type === 'GENERATE_EMBEDDINGS_BATCH') {
    generateEmbeddingsBatch(message.texts)
      .then((vectors) => sendResponse({ success: true, data: vectors }))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }

  if (message.type === 'PING') {
    sendResponse({ success: true, data: 'PONG' });
    return true;
  }
});
