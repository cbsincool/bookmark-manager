import { describe, it, expect } from 'vitest';
import { normalizeDirectoryPath, parseClusterNamingResponse } from '../apiClient';
import { normalizeSegment, suggestDirectoryName, visualLength } from '@/shared/directoryNaming';

describe('normalizeDirectoryPath', () => {
  it('keeps a clean Chinese name unchanged', () => {
    expect(normalizeDirectoryPath('文档备份')).toBe('文档备份');
  });

  it('keeps a single-word Latin name unchanged', () => {
    expect(normalizeDirectoryPath('React')).toBe('React');
    expect(normalizeDirectoryPath('GCP')).toBe('GCP');
  });

  it('does not rewrite a name that never had a space', () => {
    // "Node.js" / "C++" 这类专有写法不能被拼接规则改写
    expect(normalizeDirectoryPath('Node.js')).toBe('Node.js');
    expect(normalizeDirectoryPath('C++')).toBe('C++');
  });

  it('collapses a CJK-leading name with a Latin annotation to the CJK side', () => {
    // 中文是主题，英文只是注解
    expect(normalizeDirectoryPath('飞书 Backup Docs')).toBe('飞书');
    expect(normalizeDirectoryPath('机器学习 Machine Learning')).toBe('机器学习');
    expect(normalizeDirectoryPath('容器编排 Container Orchestration')).toBe('容器编排');
  });

  it('joins a multi-word Latin name into one word instead of dropping words', () => {
    // 取首词会得到毫无意义的 "Machine"，所以拼接
    expect(normalizeDirectoryPath('Machine Learning')).toBe('MachineLearning');
    expect(normalizeDirectoryPath('React Hooks')).toBe('ReactHooks');
  });

  it('strips descriptive suffixes before collapsing', () => {
    expect(normalizeDirectoryPath('React Hooks 教程')).toBe('ReactHooks');
    expect(normalizeDirectoryPath('Machine Learning Tutorial')).toBe('MachineLearning');
    expect(normalizeDirectoryPath('Kubernetes Guide')).toBe('Kubernetes');
    expect(normalizeDirectoryPath('Docker 入门')).toBe('Docker');
  });

  it('keeps the original when the whole segment is a generic word', () => {
    expect(normalizeDirectoryPath('教程')).toBe('教程');
  });

  it('collapses a mixed CJK/Latin name even when it has no space', () => {
    // 模型经常直接吐出 "飞书Docs" 这种没有空格的混排
    expect(normalizeDirectoryPath('飞书Docs')).toBe('飞书');
    expect(normalizeDirectoryPath('云原生K8s')).toBe('云原生');
    // 拉丁打头的混排保留拉丁侧
    expect(normalizeDirectoryPath('Vue文档')).toBe('Vue');
    expect(normalizeDirectoryPath('Node.js文档')).toBe('Node.js');
  });

  it('keeps a leading dot that is part of the name', () => {
    expect(normalizeDirectoryPath('.NET')).toBe('.NET');
    expect(normalizeDirectoryPath('...')).toBe('');
  });

  it('trims whitespace and edge punctuation from each segment', () => {
    expect(normalizeDirectoryPath('  编程 / 前端  ')).toBe('编程/前端');
    expect(normalizeDirectoryPath('工具/效率/')).toBe('工具/效率');
  });

  it('drops segments that normalize to empty', () => {
    expect(normalizeDirectoryPath('编程//前端')).toBe('编程/前端');
    expect(normalizeDirectoryPath('///')).toBe('');
  });

  it('caps an over-long CJK segment', () => {
    const long = '这是一个非常非常非常冗长的目录名称超出限制';
    expect(normalizeDirectoryPath(long).length).toBe(16);
  });

  it('keeps a Latin name that fits within the visual budget', () => {
    // 视觉宽度上限是 32（汉字算 2 列），19 个拉丁字符远未超限，
    // 所以完整保留而不是被截成 "WebDevelopment"
    expect(normalizeDirectoryPath('Web Development Tools')).toBe('WebDevelopmentTools');
  });

  it('caps an over-long Latin segment on a word boundary', () => {
    // 不能切出 "UnsupervisedMachineLearnin" 这种半截词
    expect(normalizeDirectoryPath('Unsupervised Machine Learning Algorithms'))
      .toBe('UnsupervisedMachineLearning');
  });

  it('never leaves whitespace in any segment', () => {
    const inputs = [
      '飞书 Backup Docs', '机器学习 Machine Learning', 'React Hooks 教程',
      'Machine Learning Tutorial', 'Web Development Tools', 'Google Cloud Platform',
      '  编程 / 前端  ', '工具 效率', 'A B C D E F', '文档 备份',
      'Kubernetes 集群 管理', 'Node.js 教程', 'front end development guide',
    ];
    for (const input of inputs) {
      const out = normalizeDirectoryPath(input);
      expect(out, `input=${input}`).not.toMatch(/\s/);
      for (const segment of out.split('/')) {
        expect(segment, `input=${input}`).not.toMatch(/\s/);
      }
    }
  });
});

describe('parseClusterNamingResponse', () => {
  it('normalizes every path in a JSON code fence', () => {
    const raw = '```json\n{"c1": "飞书 Backup Docs", "c2": "编程/React Hooks 教程"}\n```';
    expect(parseClusterNamingResponse(raw)).toEqual({
      c1: '飞书',
      c2: '编程/ReactHooks',
    });
  });

  it('drops entries whose path normalizes to empty', () => {
    expect(parseClusterNamingResponse('{"c1": "///"}')).toEqual({});
  });

  it('returns an empty object for malformed input', () => {
    expect(parseClusterNamingResponse('not json')).toEqual({});
  });
});

describe('suggestDirectoryName', () => {
  it('returns a single token, never a space-joined phrase', () => {
    const name = suggestDirectoryName(['React Hooks 教程', 'React Hooks 实战', 'React 状态管理']);
    expect(name).not.toMatch(/\s/);
    expect(name).toBe('React');
  });

  it('ignores generic descriptive words', () => {
    expect(suggestDirectoryName(['Docker Tutorial', 'Docker Guide'])).toBe('Docker');
  });

  it('prefers the longer word when frequencies tie', () => {
    expect(suggestDirectoryName(['Kubernetes 与 k8s', 'Kubernetes 与 k8s'])).toBe('Kubernetes');
  });

  it('falls back to 未分类 when nothing usable is found', () => {
    expect(suggestDirectoryName(['的 了', '教程'])).toBe('未分类');
  });

  it('never produces a name containing a path separator', () => {
    // 产出的名字会写进 directoryTree 的 key，带 "/" 会被拆成两级目录
    for (const titles of [['React/Hooks 教程'], ['A/B 文档', 'A/B 入门'], ['C++/Rust 对比']]) {
      const name = suggestDirectoryName(titles);
      expect(name, JSON.stringify(titles)).not.toContain('/');
    }
  });
});

describe('visualLength', () => {
  it('counts a CJK character as two columns', () => {
    expect(visualLength('编程')).toBe(4);
    expect(visualLength('React')).toBe(5);
  });
});

describe('normalizeSegment invariants', () => {
  const corpus = [
    'React Hooks 教程', '机器学习 Machine Learning', 'Web Development Tools',
    '飞书 Backup Docs', '文档 备份', '教程', 'Tutorial Guide',
    'AI 与 ML', 'Rust vs Go', '云原生 Kubernetes', 'K8s 集群',
    '3D 建模', 'C# 教程', 'Node Guide', 'Node.js 教程', 'C++ 编程',
    '前端 Framework React Hooks', '文档 备份 资料', '--React--', '...',
    'Web Development Tools Advanced Complete Guide', 'a b', '   ', '///',
  ];

  it('is idempotent', () => {
    for (const input of corpus) {
      const once = normalizeSegment(input);
      expect(normalizeSegment(once), `input=${input}`).toBe(once);
    }
  });

  it('never contains whitespace', () => {
    for (const input of corpus) {
      expect(normalizeSegment(input), `input=${input}`).not.toMatch(/\s/);
    }
  });

  it('never mixes CJK and Latin in one segment', () => {
    for (const input of corpus) {
      const out = normalizeSegment(input);
      const mixed = /[一-鿿]/.test(out) && /[A-Za-z]/.test(out);
      expect(mixed, `input=${input} → ${out}`).toBe(false);
    }
  });

  it('keeps only one word when every word is generic', () => {
    // 全剥光后回退成整串会得到 "TutorialGuide"
    expect(normalizeSegment('Tutorial Guide')).toBe('Tutorial');
  });

  it('drops the Latin annotation when the head is CJK', () => {
    expect(normalizeSegment('前端 Framework React Hooks')).toBe('前端');
    expect(normalizeSegment('云原生 Kubernetes')).toBe('云原生');
  });

  it('joins all CJK runs when the whole name is CJK split by spaces', () => {
    expect(normalizeSegment('文档 备份 资料')).toBe('文档备份资料');
  });
});
