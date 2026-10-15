import { describe, it, expect } from 'vitest';
import { buildClassificationPrompt, parseClassificationResponse, buildClusterNamingPrompt } from '../apiClient';

describe('buildClassificationPrompt', () => {
  it('builds prompt with bookmark data', () => {
    const bookmarks = [
      { id: '1', title: 'React Hooks Guide', url: 'https://react.dev/hooks', path: '' },
      { id: '2', title: 'PostgreSQL Tuning', url: 'https://pg.dev/tune', path: '' },
    ];
    const existingDirs = ['GitHub', 'Python Docs'];
    const prompt = buildClassificationPrompt(bookmarks, existingDirs);
    expect(prompt).toContain('React Hooks Guide');
    expect(prompt).toContain('PostgreSQL Tuning');
    expect(prompt).toContain('GitHub');
    expect(prompt).toContain('3 levels');
  });
});

describe('parseClassificationResponse', () => {
  it('parses valid JSON response', () => {
    const raw = '```json\n{"Frontend/React": ["1"], "Backend/DB": ["2"]}\n```';
    const result = parseClassificationResponse(raw);
    expect(result).toEqual({ 'Frontend/React': ['1'], 'Backend/DB': ['2'] });
  });

  it('parses raw JSON without code fence', () => {
    const raw = '{"Tools": ["3"]}';
    const result = parseClassificationResponse(raw);
    expect(result).toEqual({ 'Tools': ['3'] });
  });

  it('returns empty object for unparseable response', () => {
    const result = parseClassificationResponse('I cannot do that');
    expect(result).toEqual({});
  });
});

describe('buildClusterNamingPrompt', () => {
  const prompt = buildClusterNamingPrompt([{ clusterId: '0', titles: ['React Hooks 教程'] }], 3);

  it('states the no-space rule', () => {
    expect(prompt).toContain('绝对不能包含空格');
  });

  it('never shows a positive example that itself contains a space', () => {
    // 曾经写的是 `"React Hooks 教程" → "React Hooks"`：规则说禁止空格，
    // 紧接着的正例却带空格，模型收到的是互相打架的指令
    const examples = prompt.matchAll(/^\s+"([^"]+)"\s+←\s+"([^"]+)"/gm);
    const leftSides = [...examples].map((m) => m[1]);

    expect(leftSides.length).toBeGreaterThan(0);
    for (const name of leftSides) {
      expect(name, `正例 "${name}" 含空格`).not.toMatch(/\s/);
    }
  });

  it('does not promise a translation the normalizer cannot deliver', () => {
    // 旧 prompt 承诺 "飞书 Backup Docs" → "文档备份"，但确定性归一化只能得到 "飞书"
    expect(prompt).not.toContain('"文档备份"');
  });
});
