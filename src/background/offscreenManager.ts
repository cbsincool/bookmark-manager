const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

let creating: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });

  if (existingContexts.length > 0) return;

  if (creating) {
    await creating;
    return;
  }

  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'Run Transformers.js embedding model',
  });

  await creating;
  creating = null;
}

export async function sendToOffscreen(message: { type: string; [key: string]: unknown }): Promise<unknown> {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage(message);
}
