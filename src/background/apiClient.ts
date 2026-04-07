import type { AppSettings } from '@/shared/types';

export function buildClassificationPrompt(
  bookmarks: readonly { id: string; title: string; url: string; path: string; summary?: string }[],
  existingDirs: readonly string[],
): string {
  const bookmarkList = bookmarks
    .map((b) => {
      let entry = `- [id:${b.id}] "${b.title}" (${b.url})`;
      if (b.summary) entry += ` — ${b.summary}`;
      return entry;
    })
    .join('\n');

  const dirList = existingDirs.length > 0
    ? `\nExisting top-level directories (reuse when appropriate):\n${existingDirs.map((d) => `- ${d}`).join('\n')}`
    : '';

  return `You are a bookmark organizer. Classify these bookmarks into a directory structure.

Rules:
1. Maximum 3 levels deep
2. Prefer specific, bottom-level semantic names (e.g., "React Hooks" over "Frontend Technology")
3. Target 5-20 bookmarks per directory
4. Reuse existing directories when the bookmark fits
5. Return ONLY a JSON object: { "directory/path": ["bookmarkId1", "bookmarkId2"] }
${dirList}

Bookmarks to classify:
${bookmarkList}`;
}

export function parseClassificationResponse(raw: string): Record<string, string[]> {
  try {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string[]>;
    }
    return {};
  } catch {
    return {};
  }
}

export async function callCloudAPI(
  prompt: string,
  settings: Pick<AppSettings, 'apiEndpoint' | 'apiKey' | 'apiModel'>,
): Promise<string> {
  const response = await fetch(settings.apiEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.apiModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? '';
}

export async function testConnection(
  settings: Pick<AppSettings, 'apiEndpoint' | 'apiKey' | 'apiModel'>,
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
