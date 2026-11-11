# Bookmark Manager

> An AI-powered Chrome extension that organizes, deduplicates and semantically searches your bookmarks.

English | [简体中文](README.zh-CN.md)

Bookmark Manager lives in Chrome's side panel and works on the Bookmarks Bar. It reads your existing folder structure, asks an LLM to place each bookmark where it belongs, finds duplicates with a transparent scoring model, and lets you search by meaning — all with your own model endpoints. There is no backend; everything is stored in the browser's IndexedDB.

## Features

### 📂 Organize

- **AI classification** — the model decides which folder each bookmark belongs in, using your current folders as the starting point.
- **Two modes**
  - *Fit existing structure* (default) — bookmarks that are already in the right place never move, so re-running is safe.
  - *Re-plan structure* — ignore the current tree and generate a new one from scratch.
- **Deterministic rules first** — obvious cases (video sites, shopping sites, GitHub, Linux, company intranet…) are pinned by rules, so repeated runs never flip them around.
- **≤ 3 levels deep**, with a preview of the generated tree before anything is written.
- **Domain clustering** — review which domains will be grouped together before starting.
- **Dead-link scan** (optional) — confirmed 404/410 pages are moved to the `[待删除_失效]` folder.
- **One-click undo** — the last organize run can be rolled back; created folders are removed and bookmarks restored.
- **Progress & report** — per-bookmark progress, plus the actual paths written at the end.

### 🗑 Deduplicate

- Three scenarios: **identical URL**, **identical title**, **manual selection**.
- Quality scoring across three dimensions — URL surface form, content richness, metadata (recency / well-known domain).
- Optional AI evaluation for the close calls; the recommended keeper is marked, and you confirm card by card.
- Deleted bookmarks are recorded and can be restored.

### 🔍 Search

- **Hybrid retrieval** — Fuse.js fuzzy title matching + vector similarity + cross-encoder reranking.
- Results are grouped into *title match*, *fuzzy match* and *semantic match* sections.
- Near-duplicate results collapse into one group; the best-scoring version is shown first.
- Optional folder-path search.

### ⚡ Real-time archiving

New bookmarks are embedded immediately and moved into the best-matching existing folder. If nothing matches well enough, the LLM is asked where the bookmark belongs (reusing existing folders first).

### 🛠 Management

Move a selection of bookmarks between folders, or merge folders, directly from the side panel.

### 🌏 i18n

English and Simplified Chinese UI.

## Requirements

| Component | Purpose | Notes |
|-----------|---------|-------|
| Chrome 116+ | Side Panel API | Manifest V3 |
| LLM endpoint | Classification, naming, AI scoring | OpenAI-compatible (`/chat/completions`) or Anthropic (`/v1/messages`). Any hosted API, Ollama, vLLM, one-api… works |
| TEI embedding service | Vectors for search / organize / real-time archiving | [Text Embeddings Inference](https://github.com/huggingface/text-embeddings-inference) serving `BAAI/bge-m3` (1024-dim) |
| TEI reranker service | Search reranking | TEI serving `BAAI/bge-reranker-v2-m3` |

Semantic features degrade gracefully: if the embedding service is unreachable, organize falls back to AI-only classification and semantic search returns nothing, but fuzzy search still works.

<details>
<summary>Example: running the two TEI services with Docker</summary>

```bash
# Embeddings — must expose POST /embed and produce 1024-dim vectors
docker run --rm -p 8080:80 \
  ghcr.io/huggingface/text-embeddings-inference:cpu-latest \
  --model-id BAAI/bge-m3 --max-client-batch-size 32

# Reranker — must expose POST /rerank
docker run --rm -p 8081:80 \
  ghcr.io/huggingface/text-embeddings-inference:cpu-latest \
  --model-id BAAI/bge-reranker-v2-m3
```

Use a GPU image (`-gpu`) and mount a model cache volume if you plan to index thousands of bookmarks.
</details>

## Install

```bash
npm install
npm run build
```

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select the `dist/` folder.
3. Click the extension icon to open the side panel.

> Chrome caches extension code. After rebuilding, click the ↻ button on the extension card before testing again.

For development with hot reload:

```bash
npm run dev
```

Then load the `dist/` folder once; Vite keeps it updated.

## Configuration

Open the **Settings** tab in the side panel.

| Setting | Description |
|---------|-------------|
| API format | `OpenAI-compatible` or `Anthropic native` |
| API endpoint | e.g. `https://api.openai.com/v1`, `https://api.anthropic.com`, or your own gateway |
| API key | Stored in the extension's local IndexedDB; never sent anywhere except the endpoint above |
| Model | e.g. `gpt-4o-mini`, `claude-sonnet-5-5`, or any model your gateway serves |
| Embedding endpoint | TEI `/embed` service, default `http://localhost:8080` |
| Reranker endpoint | TEI `/rerank` service, default `http://localhost:8081` |
| Search weights | Fuzzy vs. semantic balance |
| Collapse threshold | How similar two results must be to be folded together |
| Max folder depth | 1–3 levels for AI organize |
| Real-time archiving | Toggle automatic classification of new bookmarks |
| URL normalization | Strip UTM parameters, trailing slashes, `#hash` before dedup |
| Language | English / 中文 |
| Index | Rebuild or clear the vector index |

The **Test Connection** button verifies the LLM endpoint/key/model before you run a long job.

## How it works

```
┌────────────────────────────┐        ┌──────────────────────────┐
│ Side panel (React 18)      │        │ Background service worker│
│  Search / Organize /       │◀──────▶│  bookmark sync           │
│  Dedup / Settings          │  msgs  │  search · dedup · organize│
└────────────────────────────┘        └───────┬──────────────────┘
                                              │
                   ┌──────────────────────────┼───────────────────────┐
                   ▼                          ▼                       ▼
            chrome.bookmarks            IndexedDB                Your endpoints
            (Bookmarks Bar)      vectors · cache · settings   LLM · TEI embed · rerank
```

- **Vectors** are generated on your machine through the TEI service you configure; the index lives in IndexedDB.
- **Organize** builds a folder skeleton, batches bookmarks to the LLM for placement, then folds overflow topics into their own folders. Rules pin domains that must never move (GitHub stays under `Github`, video sites under `视频`, …).
- **Dedup** normalizes URLs, groups candidates, scores them, and asks the LLM only when content-based judgment is needed.
- **Search** embeds the query, takes the top semantic candidates, reranks them, then merges the fuzzy and title-match signals into sections.

Source layout:

```
src/
  background/     service worker: bookmark sync, search, dedup, organize, taxonomy, rules
    __tests__/    unit tests (Vitest)
  sidepanel/      React UI: panels, hooks, zustand stores, i18n
  shared/         types, constants, IndexedDB wrapper, URL utils, vector math
  _locales/       extension name & description
test/             dev harnesses (Playwright / Chrome DevTools scripts) + WebdriverIO e2e spec
```

## Privacy

- No telemetry, no analytics, no server of ours. The extension talks only to the endpoints you configure.
- Bookmarks stay in `chrome.bookmarks`; derived data (vectors, summaries, settings) stays in the extension's IndexedDB.
- Only bookmark **titles and URLs** are sent to the LLM for classification. For fine-grained dedup, the extension may fetch the bookmarked page itself to extract a short text summary, and that summary is sent to the LLM.
- The dead-link scan issues a 1-byte `GET` to the bookmarked URL.
- API keys are stored locally in IndexedDB and can be replaced at any time in Settings.

## Development

```bash
npm run dev        # Vite dev server for the extension
npm run build      # tsc + vite build → dist/
npm test           # Vitest unit tests (192 tests)
npm run test:ui    # Vitest UI
npm run test:e2e   # WebdriverIO end-to-end specs (needs a local Chrome + built dist/)
```

Requirements: Node.js 20+.

TypeScript, React 18, Vite 5, Zustand, Tailwind CSS 4, `idb`, Fuse.js, `@crxjs/vite-plugin`.

## Limitations

- Organizing and indexing operate on the **Bookmarks Bar** folder tree.
- The LLM is a hard dependency for AI organize/dedup. Without a valid endpoint + key those tabs will explain what is missing rather than do a partial job.
- The embedding model must produce **1024-dimensional** vectors (bge-m3). Other dimensions require changing `EMBEDDING_DIM` and rebuilding the index.
- Very large libraries (several thousand bookmarks) mean many LLM calls; batch size and concurrency are tuned conservatively to avoid rate limits.

## License

[MIT](LICENSE)
