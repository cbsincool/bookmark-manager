# 书签管理器

> 一个 AI 驱动的 Chrome 扩展：整理、去重你的收藏夹，并支持语义搜索。

[English](README.md) | 简体中文

书签管理器常驻在 Chrome 侧边栏，作用于「书签栏」。它会读取你现有的目录结构，让大模型把每条书签放进该去的位置；用一套透明的评分模型找重复；还能按语义而不是关键词搜索。所有模型端点都由你自己提供，没有后端服务，数据只存在浏览器的 IndexedDB 里。

## 功能

### 📂 整理

- **AI 归类** —— 由模型决定每条书签应该放进哪个目录，并以你现有的目录为起点。
- **两种模式**
  - *按现有目录归位*（默认）—— 已经归对的书签不会被搬动，可以反复整理。
  - *重新规划目录结构* —— 忽略现有结构，重新生成目录树。
- **确定性规则优先** —— 视频站、购物站、GitHub、Linux、公司内网等明显情况由规则钉死，不会每次运行都换个位置。
- **最多 3 层目录**，执行前先预览生成的目录树。
- **域名聚类** —— 开始前先确认哪些域名会被归到一起。
- **失效链接扫描**（可选）—— 确认返回 404/410 的页面移到 `[待删除_失效]`。
- **一键撤销** —— 可以还原最近一次整理：删掉新建的目录，把书签放回原位。
- **进度与报告** —— 逐条进度，结束后列出实际写入的目录。

### 🗑 去重

- 三种场景：**URL 完全相同**、**标题完全相同**、**手动勾选**。
- 三维质量评分：URL 表层形态、内容丰度、元数据（时间 / 知名域名）。
- 拿不准时可以让 AI 参与评估；系统标出推荐保留项，逐组确认后执行。
- 删除的书签会留档，可以恢复。

### 🔍 搜索

- **混合检索** —— Fuse.js 标题模糊匹配 + 向量相似度 + 交叉编码器重排序。
- 结果按 *标题命中*、*模糊命中*、*语义相关* 分区展示。
- 相近结果折叠成一组，优先展示得分最高的版本。
- 支持按目录路径搜索。

### ⚡ 实时归档

新增书签立即生成向量，移动到最匹配的现有目录；匹配度不够时再交给大模型判断，优先复用已有目录。

### 🛠 目录管理

在侧边栏里批量移动书签、合并目录。

### 🌏 多语言

中英文界面。

## 环境要求

| 组件 | 用途 | 说明 |
|------|------|------|
| Chrome 116+ | Side Panel API | Manifest V3 |
| 大模型端点 | 分类、命名、AI 评分 | 兼容 OpenAI（`/chat/completions`）或 Anthropic（`/v1/messages`）。官方 API、Ollama、vLLM、one-api 均可 |
| TEI 嵌入服务 | 搜索 / 整理 / 实时归档所用的向量 | [Text Embeddings Inference](https://github.com/huggingface/text-embeddings-inference) 加载 `BAAI/bge-m3`（1024 维） |
| TEI 重排序服务 | 搜索结果重排 | TEI 加载 `BAAI/bge-reranker-v2-m3` |

语义功能可以降级：嵌入服务不可用时，整理退化为纯 AI 分类，语义搜索没有结果，但模糊搜索照常可用。

<details>
<summary>示例：用 Docker 起两个 TEI 服务</summary>

```bash
# 嵌入服务 —— 需提供 POST /embed，输出 1024 维向量
docker run --rm -p 8080:80 \
  ghcr.io/huggingface/text-embeddings-inference:cpu-latest \
  --model-id BAAI/bge-m3 --max-client-batch-size 32

# 重排序服务 —— 需提供 POST /rerank
docker run --rm -p 8081:80 \
  ghcr.io/huggingface/text-embeddings-inference:cpu-latest \
  --model-id BAAI/bge-reranker-v2-m3
```

书签量上千时建议换 GPU 镜像（`-gpu`），并挂载模型缓存目录。
</details>

## 安装

```bash
npm install
npm run build
```

1. 打开 `chrome://extensions`，开启**开发者模式**。
2. 点**加载已解压的扩展程序**，选择 `dist/` 目录。
3. 点击工具栏图标打开侧边栏。

> Chrome 会缓存扩展代码。重新构建后，先点扩展卡片上的 ↻ 按钮，再测试。

开发时用热更新：

```bash
npm run dev
```

同样加载一次 `dist/` 目录，之后 Vite 会自动更新。

## 配置

打开侧边栏的**设置**页。

| 设置项 | 说明 |
|--------|------|
| API 格式 | `OpenAI 兼容` 或 `Anthropic 原生` |
| API 端点 | 如 `https://api.openai.com/v1`、`https://api.anthropic.com`，或你自己的网关 |
| API 密钥 | 存在扩展本地 IndexedDB，只会发往上面填的端点 |
| 模型名称 | 如 `gpt-4o-mini`、`claude-sonnet-5-5`，或网关提供的任意模型 |
| 嵌入服务地址 | TEI `/embed` 服务，默认 `http://localhost:8080` |
| 重排序服务地址 | TEI `/rerank` 服务，默认 `http://localhost:8081` |
| 搜索权重 | 模糊匹配与语义搜索的配比 |
| 相似折叠阈值 | 两条结果多相似才会被折叠成一组 |
| 目录最大层级 | AI 整理的目录深度，1–3 层 |
| 实时归档 | 是否自动归类新增书签 |
| URL 归一化 | 去重前是否去除 UTM 参数、尾部斜杠、`#hash` |
| 语言 | English / 中文 |
| 索引 | 重建或清除向量索引 |

跑长任务前，先用**测试连接**确认端点、密钥、模型都通。

## 工作原理

```
┌────────────────────────────┐        ┌──────────────────────────┐
│ 侧边栏（React 18）          │        │ 后台 Service Worker      │
│  搜索 / 整理 / 去重 / 设置  │◀──────▶│  书签同步                 │
│                            │  消息   │  搜索 · 去重 · 整理       │
└────────────────────────────┘        └───────┬──────────────────┘
                                              │
                   ┌──────────────────────────┼───────────────────────┐
                   ▼                          ▼                       ▼
            chrome.bookmarks            IndexedDB                你自己配的端点
            （书签栏）           向量 · 缓存 · 设置        大模型 · TEI 嵌入 · 重排
```

- **向量**通过你配置的 TEI 服务在本机生成，索引存在 IndexedDB。
- **整理**先搭出目录骨架，再分批把书签交给大模型归位，装不下的溢出主题单独建目录。规则钉死的站点（GitHub 固定进 `Github`、视频站进 `视频`……）不会被模型改来改去。
- **去重**先归一化 URL、分组、打分，只有需要判断内容质量时才调用大模型。
- **搜索**把查询转向量，取语义 top-N 后重排序，再与模糊匹配、标题命中合并分区展示。

源码结构：

```
src/
  background/     Service Worker：书签同步、搜索、去重、整理、分类法、规则
    __tests__/    单元测试（Vitest）
  sidepanel/      React 界面：面板、hooks、zustand store、i18n
  shared/         类型、常量、IndexedDB 封装、URL 工具、向量计算
  _locales/       扩展名称与描述
test/             开发调试脚本（Playwright / CDP）与 WebdriverIO e2e 用例
```

## 隐私

- 没有埋点、没有统计、没有我们的服务器。扩展只与你配置的端点通信。
- 书签本体保留在 `chrome.bookmarks`，派生数据（向量、摘要、设置）留在扩展的 IndexedDB。
- 归类时只把书签的**标题和 URL** 发给大模型。精细去重时，扩展可能自行抓取该书签页面以提取一段简短摘要，这份摘要也会发给大模型。
- 失效链接扫描会对书签 URL 发起一个只取 1 字节的 `GET` 请求。
- API 密钥保存在本地 IndexedDB，随时可以在设置页替换。

## 开发

```bash
npm run dev        # 扩展的 Vite 开发服务器
npm run build      # tsc + vite build → dist/
npm test           # Vitest 单元测试
npm run test:ui    # Vitest UI
npm run test:e2e   # WebdriverIO 端到端用例（需要本地 Chrome 与已构建的 dist/）
```

Node.js 20+。技术栈：TypeScript、React 18、Vite 5、Zustand、Tailwind CSS 4、`idb`、Fuse.js、`@crxjs/vite-plugin`。

## 已知限制

- 整理与索引作用于**书签栏**下的目录树。
- AI 整理/去重强依赖大模型。端点或密钥无效时，页面会明确提示缺什么，而不是做半套。
- 嵌入模型必须输出 **1024 维**向量（bge-m3）。换用其他维度需要修改 `EMBEDDING_DIM` 并重建索引。
- 书签量很大（数千条）意味着大量模型调用；批大小与并发都调得比较保守，避免被限流。

## 欢迎使用，多提意见和 PR

谢谢你愿意试用！用得顺手或者不顺手，都欢迎说一声。

- **遇到问题或者觉得别扭？** 直接开 [issue](https://github.com/cbsincool/bookmark-manager/issues)，附上截图和几条示例书签，定位会快很多。
- **想改点什么？** 欢迎 PR。改动尽量聚焦，跟现有代码风格保持一致；能写单测的地方请带上测试。
- **最想要的反馈**：拿你自己的收藏夹跑一遍，说说整理和去重的实际效果。这两块强依赖真实书签库的结构，你的数据比任何造出来的样本都有用。

如果觉得好用，点个 ⭐ 能让更多人看到它。

## 许可证

[MIT](LICENSE)
