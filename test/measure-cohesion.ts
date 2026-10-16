/**
 * 量出真实的内聚度数值，用来定 COHESION_SPLIT_MIN 的阈值。
 *
 * 背景：细分判据从「条数」改成「内容杂不杂」后，阈值不能靠猜。
 * 这个脚本直接调本地 tei-bge-m3，用真实标题算出一级簇的大小与内聚度。
 *
 * 用法：npx tsx test/measure-cohesion.ts
 */
import { generateEmbeddingsBatch } from '../src/background/embeddingClient';
import { buildSemanticClusters, computeDirectoryCohesion } from '../src/background/organizeEngine';
import { TOP_LEVEL_DIVISOR, MAX_TOP_CLUSTERS } from '../src/shared/constants';
import type { BookmarkNode } from '../src/shared/types';

/** 与 repro 脚本一致的 40 条，覆盖 8 个主题 */
const TITLES = [
  'Transformer 架构详解', '注意力机制 Attention', '大语言模型微调实践', 'LoRA 低秩适配',
  'RAG 检索增强生成', '向量数据库选型', '提示词工程指南', '多模态模型综述',
  '扩散模型原理', '模型量化与蒸馏', 'PyTorch 入门', 'TensorFlow 教程',
  '神经网络反向传播', '卷积神经网络 CNN', '循环神经网络 RNN', '强化学习基础',
  '特征工程方法', '模型评估指标', '过拟合与正则化', '交叉验证实践',
  'React Hooks 教程', 'Vue 3 组合式 API', 'TypeScript 类型体操', 'Vite 构建优化',
  'CSS Grid 布局', '前端性能优化清单', 'Webpack 配置详解', '浏览器渲染原理',
  'Docker 镜像构建', 'Kubernetes 集群管理', 'CI/CD 流水线设计', 'Nginx 反向代理',
  'Linux 常用命令', 'Git 分支策略', '个人理财入门', '基金定投策略',
  '保险配置指南', '露营装备清单', '咖啡手冲参数', '宠物疫苗时间表',
];

/** 人工标注的主题，用来对照聚类结果 */
const LABELS = [
  ...Array(20).fill('AI/ML'),
  ...Array(8).fill('前端'),
  ...Array(6).fill('运维'),
  ...Array(3).fill('理财'),
  ...Array(3).fill('生活'),
];

async function main(): Promise<void> {
  const vectors = await generateEmbeddingsBatch(TITLES);
  const entries = TITLES.map((title, i) => ({ id: String(i), vector: vectors[i] }));
  const bookmarks: BookmarkNode[] = TITLES.map((title, i) => ({
    id: String(i), title, url: 'https://example.com', path: '',
  }));

  const n = entries.length;
  const k1 = Math.max(2, Math.min(MAX_TOP_CLUSTERS, Math.round(Math.sqrt(n / TOP_LEVEL_DIVISOR))));
  console.log(`n=${n}  k1=${k1}\n`);

  const tops = buildSemanticClusters(entries, bookmarks, k1, { minClusterSize: 1 });

  for (const [i, top] of tops.entries()) {
    const cohesion = computeDirectoryCohesion(
      top.bookmarkIds.map((id) => entries[Number(id)].vector),
    );
    const labelCounts = new Map<string, number>();
    for (const id of top.bookmarkIds) {
      const label = LABELS[Number(id)];
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    const composition = [...labelCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([l, c]) => `${l}×${c}`)
      .join(' ');
    const distinct = labelCounts.size;

    console.log(
      `簇${i}: ${String(top.bookmarkIds.length).padStart(2)} 条  内聚度 ${cohesion.toFixed(3)}  ` +
      `混了 ${distinct} 个主题  [${composition}]`,
    );
  }

  // 纯主题簇的对照：单独算每个真实主题内部的内聚度
  console.log('\n--- 对照：单个主题内部的内聚度 ---');
  for (const label of ['AI/ML', '前端', '运维']) {
    const ids = LABELS.map((l, i) => (l === label ? i : -1)).filter((i) => i >= 0);
    const cohesion = computeDirectoryCohesion(ids.map((i) => entries[i].vector));
    console.log(`  ${label.padEnd(6)} ${String(ids.length).padStart(2)} 条  内聚度 ${cohesion.toFixed(3)}`);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
