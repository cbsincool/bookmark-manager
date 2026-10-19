"""
书签管理器扩展 — 部署验证脚本（Playwright）

流程：
  1. 加载 dist/ 扩展
  2. 在扩展上下文中注入受控测试书签
  3. 逐项驱动 background 消息 API，断言返回
  4. 渲染 4 个 Tab，收集 console 错误

用法：python test/verify-deploy.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

EXTENSION_PATH = str(Path(__file__).resolve().parent.parent / "dist")
# 可用 BM_VERIFY_PROFILE 指定 profile 目录：旧的 profile 若被上次异常退出弄坏，
# Chrome 会在启动瞬间退出（TargetClosedError），换一个空目录即可
PROFILE_DIR = os.environ.get("BM_VERIFY_PROFILE") or str(
    Path(__file__).resolve().parent.parent / "chrome-verify-profile"
)

# AI 网关配置。凭证只走环境变量，不写进任何文件；未设置 BM_AI_KEY 时跳过 AI 相关断言。
# 端点/模型/格式默认留空 = 用扩展自带的默认值——这样测的就是用户开箱拿到的那套配置，
# 而不是我们手工指定的。要测别的模型再用环境变量覆盖。
AI_ENDPOINT = os.environ.get("BM_AI_ENDPOINT", "")
AI_KEY = os.environ.get("BM_AI_KEY", "")
AI_MODEL = os.environ.get("BM_AI_MODEL", "")
AI_FORMAT = os.environ.get("BM_AI_FORMAT", "")

# 受控测试数据集：覆盖去重三场景 + 门户页 + 多域名
SEED_BOOKMARKS = [
    ("React Hooks 完全指南", "https://react.dev/reference/react/useState"),
    ("React Hooks 完全指南", "https://react.dev/reference/react/useEffect"),   # 同标题不同 URL
    ("React 官网", "https://react.dev/"),
    ("React 官网", "https://react.dev/"),                                      # 完全相同 URL
    ("Vite 构建工具", "https://vitejs.dev/guide/"),
    ("Vite 构建工具", "https://vitejs.dev/guide/?utm_source=news"),            # 仅 utm 参数不同
    ("TypeScript 手册", "https://www.typescriptlang.org/docs/handbook/intro.html"),
    ("TypeScript 手册", "https://www.typescriptlang.org/docs/handbook/intro.html"),
    ("Rust 程序设计语言", "https://doc.rust-lang.org/book/"),
    ("Rust 程序设计语言", "https://doc.rust-lang.org/book/"),
    ("MDN Web 文档", "https://developer.mozilla.org/zh-CN/"),
    ("Python 官方文档", "https://docs.python.org/3/"),
    ("无标题", "https://example.com/some/page"),
    ("首页", "https://example.com/"),
    # --- 以下为「无重复」填充数据，用于把总量推过嵌入服务 32 条的单请求上限 ---
    ("Node.js 文档", "https://nodejs.org/docs/latest/api/"),
    ("Docker 文档", "https://docs.docker.com/get-started/"),
    ("Kubernetes 概念", "https://kubernetes.io/docs/concepts/"),
    ("Git 手册", "https://git-scm.com/doc"),
    ("Python PEP8", "https://peps.python.org/pep-0008/"),
    ("Go 语言规范", "https://go.dev/ref/spec"),
    ("Java 教程", "https://docs.oracle.com/javase/tutorial/"),
    ("Spring Boot 指南", "https://spring.io/guides"),
    ("PostgreSQL 手册", "https://www.postgresql.org/docs/"),
    ("Redis 文档", "https://redis.io/docs/"),
    ("Nginx 文档", "https://nginx.org/en/docs/"),
    ("Linux 内核文档", "https://www.kernel.org/doc/html/latest/"),
    ("Vue 3 文档", "https://vuejs.org/guide/introduction.html"),
    ("Svelte 教程", "https://svelte.dev/tutorial"),
    ("Angular 指南", "https://angular.dev/guide/"),
    ("Next.js 文档", "https://nextjs.org/docs"),
    ("Tailwind CSS", "https://tailwindcss.com/docs"),
    ("Webpack 文档", "https://webpack.js.org/concepts/"),
    ("Rollup 文档", "https://rollupjs.org/guide/en/"),
    ("ESLint 规则", "https://eslint.org/docs/latest/rules/"),
    ("Prettier 选项", "https://prettier.io/docs/en/options.html"),
    ("Vitest 指南", "https://vitest.dev/guide/"),
    ("Playwright 文档", "https://playwright.dev/docs/intro"),
    ("Jest 文档", "https://jestjs.io/docs/getting-started"),
    ("GraphQL 规范", "https://graphql.org/learn/"),
    ("gRPC 文档", "https://grpc.io/docs/"),
]

RESULTS: list[dict] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append({"name": name, "ok": ok, "detail": detail})
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))


def send(page, msg: dict, timeout: int = 120_000):
    """在扩展页面上下文里调用 chrome.runtime.sendMessage 并等待回调。"""
    return page.evaluate(
        """async ([msg, timeout]) => {
            return await new Promise((resolve) => {
                const timer = setTimeout(
                    () => resolve({ success: false, error: 'client-timeout' }), timeout);
                try {
                    chrome.runtime.sendMessage(msg, (resp) => {
                        clearTimeout(timer);
                        if (chrome.runtime.lastError) {
                            resolve({ success: false, error: String(chrome.runtime.lastError.message) });
                        } else {
                            resolve(resp ?? { success: false, error: 'empty-response' });
                        }
                    });
                } catch (e) {
                    clearTimeout(timer);
                    resolve({ success: false, error: String(e) });
                }
            });
        }""",
        [msg, timeout],
    )


def main() -> int:
    console_errors: list[str] = []
    console_all: list[str] = []

    def attach_worker(worker) -> None:
        """尽力而为地收集 service worker 的 console。

        ⚠️ 已知无效：实测（Chromium 1161 + 当前 Playwright）`worker.on("console")`
        收不到 MV3 扩展 service worker 的任何输出——挂载成功、事件却从不触发。
        换 CDP 也不行：`new_cdp_session()` 只接受 Page/Frame，而 Playwright 的
        CDPSession 不支持指定 sessionId，没法挂到 SW target 上。

        后果：**后台的报错在这个脚本里是隐形的**。曾经因此漏掉一个真实 bug——
        AI 命名因请求体缺 max_tokens 而静默退回关键词命名，端到端一路全绿。
        排查后台问题时请直接看 chrome://extensions 的 service worker 控制台。
        产品侧的对策是 `OrganizeStats.warning`：降级不再无声。
        """
        worker.on("console", lambda m: (
            console_all.append(f"[sw/{m.type}] {m.text}"),
            console_errors.append(f"[sw] {m.text}") if m.type == "error" else None,
        ))

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=PROFILE_DIR,
            headless=False,
            args=[
                f"--disable-extensions-except={EXTENSION_PATH}",
                f"--load-extension={EXTENSION_PATH}",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )

        # 必须在扩展启动前就注册：MV3 的 service worker 会反复启停，
        # 等拿到 ext_id 再遍历 context.service_workers 只能抓到当时的快照，
        # 之后重启的 worker 一条日志都收不到
        context.on("serviceworker", attach_worker)

        # ---- 解析扩展 ID ----
        ext_id = None
        for _ in range(40):
            workers = context.service_workers
            if workers:
                for worker in workers:
                    attach_worker(worker)
                ext_id = workers[0].url.split("/")[2]
                break
            time.sleep(0.5)
        if not ext_id:
            print("FATAL: 无法获取扩展 ID（service worker 未启动）")
            context.close()
            return 2
        print(f"扩展 ID: {ext_id}\n")

        panel = context.new_page()
        panel.on("console", lambda m: (
            console_all.append(f"[panel/{m.type}] {m.text}"),
            console_errors.append(m.text) if m.type == "error" else None,
        ))
        panel.on("pageerror", lambda e: console_errors.append(f"[pageerror] {e}"))

        panel.goto(f"chrome-extension://{ext_id}/src/sidepanel/index.html")
        panel.wait_for_timeout(1500)

        print("=" * 64)
        print("① 基础连通性")
        print("=" * 64)

        r = send(panel, {"type": "PING"}, 15_000)
        record("PING (background 存活)", r.get("success") is True, str(r.get("error", "")))

        r = send(panel, {"type": "GET_SETTINGS"}, 15_000)
        settings = r.get("data") or {}
        record("GET_SETTINGS", r.get("success") is True,
               f"apiFormat={settings.get('apiFormat')} model={settings.get('apiModel')}")

        # 出厂硬编码的一级目录不该出现：它们不在用户收藏夹里，却会在向导的
        # 「一级目录配置」里显示成已有目录（用户实测反馈过这个困惑）
        injected = [c for c in (settings.get("topLevelCategories") or [])
                    if c in ("技术文档", "兴趣爱好", "工作相关", "学习资料", "生活实用", "其他")]
        record("设置里不注入出厂默认的一级目录", not injected,
               f"topLevelCategories={settings.get('topLevelCategories')}")

        # ---- 注入测试书签 ----
        print("\n" + "=" * 64)
        print("② 注入受控测试书签")
        print("=" * 64)

        seeded = panel.evaluate(
            """async (items) => {
                const root = await chrome.bookmarks.create({ title: 'VERIFY_SEED' });
                const ids = [];
                for (const [title, url] of items) {
                    const bm = await chrome.bookmarks.create({ parentId: root.id, title, url });
                    ids.push(bm.id);
                }
                return { folderId: root.id, ids };
            }""",
            SEED_BOOKMARKS,
        )
        print(f"  已创建 {len(seeded['ids'])} 条书签于 VERIFY_SEED (id={seeded['folderId']})")

        r = send(panel, {"type": "GET_ALL_BOOKMARKS"}, 60_000)
        all_bm = r.get("data") or []
        record("GET_ALL_BOOKMARKS", r.get("success") is True and len(all_bm) >= len(SEED_BOOKMARKS),
               f"返回 {len(all_bm) if isinstance(all_bm, list) else '?'} 条")

        r = send(panel, {"type": "GET_FOLDER_STRUCTURE"}, 30_000)
        record("GET_FOLDER_STRUCTURE", r.get("success") is True)

        # ---- 向量服务（本次修复点）----
        print("\n" + "=" * 64)
        print("③ 向量嵌入服务 (tei-bge-m3 :8080)")
        print("=" * 64)

        # 注意：Float32Array 经 Playwright 序列化会丢失 length，故在页面内取值
        r = panel.evaluate(
            """async () => {
                const r = await new Promise((res) => chrome.runtime.sendMessage(
                    { type: 'GENERATE_EMBEDDING', text: 'react hooks 状态管理' },
                    (resp) => res(resp)));
                if (!r || !r.success) return { ok: false, dim: 0, err: String(r && r.error) };
                const d = r.data;
                return { ok: true, dim: (d && typeof d.length === 'number') ? d.length : -1, err: '' };
            }"""
        )
        record("GENERATE_EMBEDDING", r["ok"] and r["dim"] == 1024,
               f"维度={r['dim']} err={r['err']}")

        r = panel.evaluate(
            """async () => {
                const r = await new Promise((res) => chrome.runtime.sendMessage(
                    { type: 'GENERATE_EMBEDDINGS_BATCH', texts: ['react', 'vite', 'rust'] },
                    (resp) => res(resp)));
                if (!r || !r.success) return { ok: false, n: 0, dim: 0, err: String(r && r.error) };
                const arr = r.data;
                return {
                    ok: true,
                    n: Array.isArray(arr) ? arr.length : -1,
                    dim: (arr && arr[0] && typeof arr[0].length === 'number') ? arr[0].length : -1,
                    err: '',
                };
            }"""
        )
        record("GENERATE_EMBEDDINGS_BATCH", r["ok"] and r["n"] == 3 and r["dim"] == 1024,
               f"返回 {r['n']} 条 维度={r['dim']} err={r['err']}")

        # 回归：服务端单请求上限 32，超过必须由客户端分片，否则 422
        r = panel.evaluate(
            """async () => {
                const texts = Array.from({length: 50}, (_, i) => 'bookmark sample ' + i);
                const r = await new Promise((res) => chrome.runtime.sendMessage(
                    { type: 'GENERATE_EMBEDDINGS_BATCH', texts }, (resp) => res(resp)));
                if (!r || !r.success) return { ok: false, n: 0, dim: 0, err: String(r && r.error) };
                return { ok: true, n: r.data.length, dim: r.data[0].length, err: '' };
            }"""
        )
        record("批量嵌入 50 条（超 32 上限，须分片）",
               r["ok"] and r["n"] == 50 and r["dim"] == 1024,
               f"返回 {r['n']} 条 维度={r['dim']} err={r['err'][:120]}")

        # 空字符串会让 TEI 返回 400 并连带整批失败，须由客户端兜底
        r = panel.evaluate(
            """async () => {
                const r = await new Promise((res) => chrome.runtime.sendMessage(
                    { type: 'GENERATE_EMBEDDINGS_BATCH', texts: ['ok', '', '   ', 'fine'] },
                    (resp) => res(resp)));
                if (!r || !r.success) return { ok: false, n: 0, err: String(r && r.error) };
                return { ok: true, n: r.data.length, err: '' };
            }"""
        )
        record("批量嵌入含空字符串（须兜底）", r["ok"] and r["n"] == 4,
               f"返回 {r['n']} 条 err={r['err'][:120]}")

        # ---- 索引构建（语义搜索前提）----
        print("\n" + "=" * 64)
        print("④ 向量索引重建")
        print("=" * 64)

        r = send(panel, {"type": "REBUILD_INDEX"}, 300_000)
        record("REBUILD_INDEX", r.get("success") is True, f"err={str(r.get('error', ''))[:160]}")

        r = send(panel, {"type": "GET_INDEX_STATS"}, 30_000)
        stats = r.get("data") or {}
        record("GET_INDEX_STATS", r.get("success") is True,
               json.dumps(stats, ensure_ascii=False)[:160])

        # ---- 搜索（含 reranker）----
        print("\n" + "=" * 64)
        print("⑤ 搜索（模糊 + 语义 + reranker :8081）")
        print("=" * 64)

        def search(query: str) -> tuple[bool, str]:
            """返回 (是否成功, 摘要)。SEARCH 返回 {bookmarks, semanticScores, settings}。"""
            resp = send(panel, {"type": "SEARCH", "query": query}, 180_000)
            if resp.get("success") is not True:
                return False, f"err={str(resp.get('error', ''))[:140]}"
            data = resp.get("data") or {}
            if not isinstance(data, dict):
                return False, f"非预期返回类型: {type(data).__name__}"
            sem = data.get("semanticScores") or []
            total_bm = len(data.get("bookmarks") or [])
            if not sem:
                return False, f"语义候选 0 条（书签库 {total_bm} 条）"
            top = sem[0]
            return True, (f"语义候选 {len(sem)} 条 / 书签库 {total_bm} 条；"
                          f"top1 id={top.get('id')} semantic={top.get('semanticScore', 0):.3f} "
                          f"rerank={top.get('rerankScore', 0):.3f}")

        ok, detail = search("react hooks")
        record("SEARCH 语义检索 (react hooks)", ok, detail)

        ok, detail = search("Rust 编程语言")
        record("SEARCH 意图检索 (Rust 编程语言)", ok, detail)

        # ---- 去重 ----
        print("\n" + "=" * 64)
        print("⑥ 去重扫描 (L1+L3)")
        print("=" * 64)

        r = send(panel, {"type": "DEDUP_SCAN"}, 240_000)
        groups = r.get("data")
        gcount = len(groups) if isinstance(groups, list) else -1
        record("DEDUP_SCAN", r.get("success") is True and gcount > 0,
               f"{gcount} 个重复组 err={str(r.get('error', ''))[:140]}")
        if isinstance(groups, list):
            for g in groups[:4]:
                items = g.get("bookmarks") or g.get("items") or []
                keep = g.get("keepId") or g.get("recommendedId") or "?"
                print(f"         组: {len(items)} 条, 建议保留={keep} — "
                      f"{(items[0].get('title', '?') if items else '?')[:35]}")

        # ---- 整理 ----
        print("\n" + "=" * 64)
        print("⑦ 整理模块")
        print("=" * 64)

        r = send(panel, {"type": "ORGANIZE_DOMAIN_CLUSTER"}, 60_000)
        clusters = r.get("data")
        ccount = len(clusters) if isinstance(clusters, list) else 0
        with_portal = [c for c in clusters if isinstance(c, dict) and c.get("hasPortal")] if isinstance(clusters, list) else []
        record("ORGANIZE_DOMAIN_CLUSTER", r.get("success") is True and ccount > 0,
               f"{ccount} 个域名簇，其中 {len(with_portal)} 个含门户页 err={r.get('error', '')}")
        if with_portal:
            print(f"         含门户页的域名: {', '.join(c['domain'] for c in with_portal[:5])}")

        r = send(panel, {"type": "ORGANIZE_CONNECTIVITY_CHECK",
                         "bookmarkIds": seeded["ids"][:5]}, 120_000)
        record("ORGANIZE_CONNECTIVITY_CHECK", r.get("success") is True,
               f"err={r.get('error', '')}")


        # ---- 整理流水线：骨架 → 归位 → 溢出 ----
        # 本次改动的验收点：目录名必须不含空格、不中英混排；
        # 每条书签必须恰好归属一次（Σ目录成员 + 未分类 == 总数）。
        #
        # 本段刻意排在 ⑧ 注入 AI 配置**之前**：此时没有可用模型，命名走
        # suggestDirectoryName 的关键词降级路径，stats.warning 应为 ai-unavailable。
        # ⑧b 用同一份数据、同一条流水线再跑一次，那次才走真实模型，可直接对照。
        print("\n" + "=" * 64)
        print("⑦b 整理流水线（无可用 AI → 关键词降级命名）")
        print("=" * 64)

        send(panel, {"type": "CLEAR_ALL_CLASSIFIED_MARKS"}, 30_000)

        r = send(panel, {"type": "ORGANIZE_AI_CLASSIFY_START",
                         "bookmarkIds": seeded["ids"], "scope": "global"}, 60_000)
        task_id = (r.get("data") or {}).get("taskId") if r.get("success") else None

        if not task_id:
            record("整理流水线：启动", False, f"err={r.get('error', '')}")
        else:
            proposal = None
            for _ in range(180):
                panel.wait_for_timeout(2000)
                poll = send(panel, {"type": "ORGANIZE_AI_CLASSIFY_POLL", "taskId": task_id}, 60_000)
                task = poll.get("data") or {}
                if task.get("status") == "completed":
                    proposal = task.get("result") or {}
                    break
                if task.get("status") == "failed":
                    record("整理流水线：完成", False, f"err={str(task.get('error', ''))[:160]}")
                    break

            if proposal is None:
                record("整理流水线：完成", False, "轮询超时")
            else:
                tree = proposal.get("directoryTree") or {}
                stats = proposal.get("stats") or {}
                paths = list(tree.keys())

                spaced = [p for p in paths
                          if any(re.search(r"\s", seg) for seg in p.split("/"))]
                mixed = [p for p in paths
                         if any(re.search(r"[一-鿿]", seg) and re.search(r"[A-Za-z]", seg)
                                for seg in p.split("/"))]
                record("整理流水线：目录名不含空格", not spaced,
                       f"{len(paths)} 个目录: {', '.join(paths[:10])}"
                       + (f"，违规: {spaced[:5]}" if spaced else ""))
                record("整理流水线：目录名不中英混排", not mixed,
                       f"违规: {mixed[:5]}" if mixed else "")

                # 「未分类」桶本身就是 stats.unassigned 那批，不能再算进成员，否则重复计数
                member_ids = [i for p, ids in tree.items()
                              if p not in ("未分类", "Unclassified") for i in ids]
                unassigned = stats.get("unassigned", 0)
                record("整理流水线：每条书签恰好归属一次",
                       len(member_ids) == len(set(member_ids))
                       and len(member_ids) + unassigned == stats.get("total"),
                       f"成员 {len(member_ids)}（去重后 {len(set(member_ids))}）"
                       f" + 未分类 {unassigned} vs 总数 {stats.get('total')}")
                record("整理流水线：未配置模型时确实走了降级命名",
                       stats.get("warning") == "ai-unavailable",
                       f"warning={stats.get('warning')}")
                record("整理流水线：产出统计与阶段标注",
                       "skeletonCount" in stats and "overflowDirectories" in stats
                       and isinstance(proposal.get("skeletonPaths"), list),
                       f"骨架 {stats.get('skeletonCount')} / 归位 {stats.get('assigned')} / "
                       f"溢出新建 {stats.get('overflowDirectories')} / "
                       f"未分类 {unassigned} / warning={stats.get('warning')}")
                print(f"         目录: {', '.join(paths[:10])}")
        # ---- AI（依赖外部 LLM 网关）----
        print("\n" + "=" * 64)
        print("⑧ AI 能力（依赖外部 LLM 网关）")
        print("=" * 64)

        # 记录原设置，脚本结束前还原
        prev_settings = send(panel, {"type": "GET_SETTINGS"}, 30_000).get("data") or {}

        if AI_KEY:
            overrides = {"apiKey": AI_KEY}
            if AI_ENDPOINT:
                overrides["apiEndpoint"] = AI_ENDPOINT
            if AI_MODEL:
                overrides["apiModel"] = AI_MODEL
            if AI_FORMAT:
                overrides["apiFormat"] = AI_FORMAT
            send(panel, {"type": "UPDATE_SETTINGS", "settings": overrides}, 30_000)

            effective = send(panel, {"type": "GET_SETTINGS"}, 30_000).get("data") or {}
            print(f"  已注入凭证；生效配置: model={effective.get('apiModel')} "
                  f"@ {effective.get('apiEndpoint')} ({effective.get('apiFormat')})")

        r = send(panel, {"type": "TEST_AI_CONNECTION"}, 60_000)
        ai = r.get("data") or {}
        ai_ok = r.get("success") is True and bool(ai.get("ok"))
        record("TEST_AI_CONNECTION", ai_ok,
               f"ok={ai.get('ok')} | {str(ai.get('message', '')).replace(chr(10), ' ')[:150]}")

        # 网关会下架模型（deepseek-v4-flash-0731 就已被下架并回 400）。
        # 未覆盖模型名时，这条断言测的就是扩展自带的默认模型是否还能用。
        if AI_KEY and not AI_MODEL:
            record("默认模型可用（未被网关下架）", ai_ok,
                   f"model={effective.get('apiModel')}")

        r = send(panel, {"type": "ORGANIZE_SEMANTIC_CLUSTER",
                         "bookmarkIds": seeded["ids"][:6]}, 120_000)
        clusters = r.get("data")
        record("ORGANIZE_SEMANTIC_CLUSTER", r.get("success") is True,
               f"err={str(r.get('error', ''))[:160]}")

        # ---- AI 命名链路（真实模型）----
        # 与 ⑦b 同一份数据、同一条流水线，区别只在于这次 AI 可用：
        # ⑦b 走关键词降级命名，这里走模型命名，可直接对照。
        if AI_KEY:
            print("\n" + "=" * 64)
            print("⑧b 整理流水线（真实模型命名，与 ⑦b 同数据同流程）")
            print("=" * 64)

            send(panel, {"type": "CLEAR_ALL_CLASSIFIED_MARKS"}, 30_000)
            r = send(panel, {"type": "ORGANIZE_AI_CLASSIFY_START",
                             "bookmarkIds": seeded["ids"], "scope": "global"}, 60_000)
            ai_task_id = (r.get("data") or {}).get("taskId") if r.get("success") else None
            ai_proposal = None

            if not ai_task_id:
                record("AI 命名：启动", False, f"err={r.get('error', '')}")
            else:
                for _ in range(300):
                    panel.wait_for_timeout(2000)
                    poll = send(panel, {"type": "ORGANIZE_AI_CLASSIFY_POLL",
                                        "taskId": ai_task_id}, 60_000)
                    task = poll.get("data") or {}
                    if task.get("status") == "completed":
                        ai_proposal = task.get("result") or {}
                        break
                    if task.get("status") == "failed":
                        record("AI 命名：流水线完成", False, str(task.get("error"))[:160])
                        break

            if ai_proposal is None:
                if ai_task_id:
                    record("AI 命名：流水线完成", False, "轮询超时")
            else:
                tree = ai_proposal.get("directoryTree") or {}
                stats = ai_proposal.get("stats") or {}
                paths = list(tree.keys())
                spaced = [p for p in paths
                          if any(re.search(r"\s", s) for s in p.split("/"))]
                mixed = [p for p in paths
                         if any(re.search(r"[一-鿿]", s) and re.search(r"[A-Za-z]", s)
                                for s in p.split("/"))]
                members = [i for ids in tree.values() for i in ids]

                record("AI 命名：确实走了模型（未降级成关键词）",
                       stats.get("warning") not in ("ai-unavailable", "ai-naming-failed"),
                       f"warning={stats.get('warning')} | "
                       f"原因={str(stats.get('warningDetail'))[:200]}")
                record("AI 命名：目录名不含空格", not spaced,
                       f"{len(paths)} 个目录: {', '.join(paths[:10])}"
                       + (f"，违规: {spaced[:5]}" if spaced else ""))
                record("AI 命名：目录名不中英混排", not mixed,
                       f"违规: {mixed[:5]}" if mixed else "")
                record("AI 命名：每条书签恰好归属一次",
                       len(members) == len(set(members))
                       and len(members) + stats.get("unassigned", 0) == stats.get("total"),
                       f"成员 {len(members)} + 未分类 {stats.get('unassigned')} "
                       f"vs 总数 {stats.get('total')}")
                print(f"         模型产出的目录: {', '.join(paths[:12])}")
        else:
            print("\n（跳过 ⑧b AI 命名链路：未设置 BM_AI_KEY）")

        # ---- UI 渲染 ----
        # ---- 实时归档（本次修复点）----
        print("\n" + "=" * 64)
        print("⑨ 实时归档（向量写入路径一致性）")
        print("=" * 64)

        stats_before = (send(panel, {"type": "GET_INDEX_STATS"}, 30_000).get("data") or {}).get("indexed", 0)

        created_id = panel.evaluate(
            """async ([parentId]) => {
                const node = await chrome.bookmarks.create({
                    parentId,
                    title: 'Kubernetes 集群运维指南',
                    url: 'https://kubernetes.io/docs/concepts/overview/',
                });
                return node.id;
            }""",
            [seeded["folderId"]],
        )
        panel.wait_for_timeout(10_000)  # 等待 onCreated → handleNewBookmark 完成

        stats_after = (send(panel, {"type": "GET_INDEX_STATS"}, 30_000).get("data") or {}).get("indexed", 0)
        record("实时归档写入向量索引", stats_after > stats_before,
               f"indexed {stats_before} → {stats_after}")

        # 维度不一致会让点积越界产生 NaN，进而污染整个排序
        resp = send(panel, {"type": "SEARCH", "query": "容器编排"}, 180_000)
        sem = (resp.get("data") or {}).get("semanticScores") or []
        bad = [
            s for s in sem
            if not isinstance(s.get("semanticScore"), (int, float))
            or s["semanticScore"] != s["semanticScore"]  # NaN
        ]
        record("搜索无 NaN 污染（向量维度一致）", len(sem) > 0 and not bad,
               f"{len(sem)} 条候选中 {len(bad)} 条异常")

        # ---- UI 渲染 ----
        print("\n" + "=" * 64)
        print("⑩ UI 渲染（4 个 Tab）")
        print("=" * 64)

        for label in ["🔍", "📂", "🗑", "⚙️"]:
            try:
                panel.click(f"button:has-text('{label}')", timeout=5000)
                panel.wait_for_timeout(700)
                body = panel.inner_text("body")
                has_raw_key = ".search." in body or ".organize." in body or ".dedup." in body
                record(f"Tab {label} 渲染", not has_raw_key,
                       "存在未翻译 i18n key" if has_raw_key else "OK")
            except Exception as e:  # noqa: BLE001
                record(f"Tab {label} 渲染", False, str(e)[:100])

        # ---- 搜索分层 UI（标题优先 + 语义折叠）----
        print("\n" + "=" * 64)
        print("⑪ 搜索分层 UI")
        print("=" * 64)

        def ui_search(q: str) -> str:
            panel.click("button:has-text('🔍')")
            panel.wait_for_timeout(400)
            panel.fill("input[type='text']", q)
            panel.wait_for_timeout(6500)
            return panel.inner_text("body")

        # 1) 标题字面命中：应出现「标题匹配」区，且结果精准
        body = ui_search("React")
        title_hdr = any(h in body for h in ("标题匹配", "Title matches"))
        record("搜索分层：字面查询出现「标题匹配」区", title_hdr, "")
        if title_hdr:
            before_sem = body.split("语义相关")[0].split("Semantically related")[0]
            record("搜索分层：标题区只收标题含关键字的条目",
                   before_sem.count("React") >= 1 and "Rust 程序设计语言" not in before_sem,
                   "（Rust 不应出现在 React 的标题区）")

        # 2) 语义意图查询（无字面命中）：应出现「语义相关」区
        raw = send(panel, {"type": "SEARCH", "query": "容器编排"}, 180_000)
        sem_list = (raw.get("data") or {}).get("semanticScores", [])
        top_sem = max((s.get("semanticScore", 0) for s in sem_list), default=0)
        top_rr = max((s.get("rerankScore", 0) for s in sem_list), default=0)
        body = ui_search("容器编排")
        semantic_hdr = any(h in body for h in ("语义相关", "Semantically related"))
        record("搜索分层：语义意图查询出现「语义相关」区", semantic_hdr,
               f"最高余弦={top_sem:.3f} 最高 rerank={top_rr:.4f}（门槛 0.55 / 0.05）")

        panel.fill("input[type='text']", "")
        panel.wait_for_timeout(300)

        # ---- 执行阶段：prune 只能删「本次搬空的」目录 ----
        # 原实现从书签栏递归删除任何空目录，跑一次整理就会把用户自己留的空文件夹
        # （「稍后阅读」这类占位目录）一并删掉，哪怕一条书签都没移动。
        print("\n" + "=" * 64)
        print("⑩ 执行阶段（只清理本次搬空的目录）")
        print("=" * 64)

        bar_id = panel.evaluate(
            """async () => (await chrome.bookmarks.getTree())[0].children[0].id"""
        )
        # 用户自己留的空目录：整理后必须还在
        placeholder_id = panel.evaluate(
            """async ([parentId]) =>
                (await chrome.bookmarks.create({parentId, title: '占位_空目录'})).id""",
            [bar_id],
        )
        # 会被搬空的目录：整理后必须被删掉
        temp_id = panel.evaluate(
            """async ([parentId]) =>
                (await chrome.bookmarks.create({parentId, title: '临时_待搬空'})).id""",
            [bar_id],
        )
        exec_ids = seeded["ids"][:2]
        panel.evaluate(
            """async ([ids, parentId]) => {
                for (const id of ids) { await chrome.bookmarks.move(id, { parentId }); }
            }""",
            [exec_ids, temp_id],
        )
        panel.wait_for_timeout(500)

        exec_resp = send(panel, {"type": "ORGANIZE_EXECUTE",
                                 "directoryTree": {"执行测试目录": exec_ids},
                                 "rootId": bar_id}, 120_000)
        record("执行阶段：ORGANIZE_EXECUTE 成功", exec_resp.get("success") is True,
               f"{exec_resp.get('data')} err={exec_resp.get('error', '')}")

        survived = panel.evaluate(
            """async ([id]) =>
                (await chrome.bookmarks.get(id).catch(() => [])).length > 0""",
            [placeholder_id],
        )
        record("执行阶段：不删用户自己的空目录", survived is True,
               "「占位_空目录」应原样保留" if not survived else "")

        removed = panel.evaluate(
            """async ([id]) =>
                (await chrome.bookmarks.get(id).catch(() => [])).length === 0""",
            [temp_id],
        )
        record("执行阶段：删掉本次搬空的目录", removed is True,
               "「临时_待搬空」应被清理" if not removed else "")

        # 清理这一段的产物（书签由末尾统一删除，这里只删目录）
        panel.evaluate(
            """async ([ids]) => {
                for (const id of ids) {
                    try { await chrome.bookmarks.removeTree(id); } catch (e) {}
                }
            }""",
            [[placeholder_id, temp_id]],
        )

        panel.screenshot(path=str(Path(__file__).parent / "screenshots" / "verify-final.png"),
                         full_page=True)

        # ---- 重复整理与同级同义目录合并 ----
        print("\n" + "=" * 64)
        print("⑪ 重复整理安全 + 同义目录合并")
        print("=" * 64)

        bar_id = panel.evaluate(
            """async () => (await chrome.bookmarks.getTree())[0].children[0].id"""
        )

        # 同级同义目录：本该是一回事
        merge_ids = panel.evaluate(
            """async ([barId]) => {
                const a = await chrome.bookmarks.create({ parentId: barId, title: '工作' });
                const b = await chrome.bookmarks.create({ parentId: barId, title: '工作相关' });
                const ids = [];
                for (const [parentId, title, url] of [
                    [a.id, '季度汇报模板', 'https://example.com/report'],
                    [a.id, '项目排期表', 'https://example.com/schedule'],
                    [b.id, '周会纪要规范', 'https://example.com/meeting'],
                    [b.id, '需求评审流程', 'https://example.com/review'],
                ]) {
                    const bm = await chrome.bookmarks.create({ parentId, title, url });
                    ids.push(bm.id);
                }
                return { a: a.id, b: b.id, ids };
            }""",
            [bar_id],
        )

        r = send(panel, {"type": "ORGANIZE_AI_CLASSIFY_START", "bookmarkIds": [],
                         "scope": "folder", "folderId": merge_ids["a"],
                         "mode": "fit"}, 60_000)
        merge_task = (r.get("data") or {}).get("taskId") if r.get("success") else None
        merged_names: list[str] = []
        merge_proposal = None

        if not merge_task:
            record("同义目录合并：启动", False, f"err={r.get('error', '')}")
        else:
            for _ in range(180):
                panel.wait_for_timeout(2000)
                poll = send(panel, {"type": "ORGANIZE_AI_CLASSIFY_POLL",
                                    "taskId": merge_task}, 60_000)
                task = poll.get("data") or {}
                if task.get("status") == "completed":
                    merge_proposal = task.get("result") or {}
                    merged_names = list(merge_proposal.get("mergedFolderNames") or [])
                    break
                if task.get("status") == "failed":
                    record("同义目录合并：完成", False, str(task.get("error"))[:160])
                    break

        record("同义目录合并：「工作相关」被识别为同级同义目录",
               sorted(merged_names) == ["工作", "工作相关"],
               f"mergedFolderNames={merged_names}")
        if merge_proposal:
            merged_members = {i for ids in (merge_proposal.get("directoryTree") or {}).values() for i in ids}
            record("同义目录合并：两个目录的书签一起参与整理",
                   set(merge_ids["ids"]).issubset(merged_members),
                   f"参与 {len(merged_members)} 条")

        # 归档标记已取消：连续两次全局整理，第二次不该是空的
        first_total = None
        second_total = None

        for label in ("第一次", "第二次"):
            start = send(panel, {"type": "ORGANIZE_AI_CLASSIFY_START",
                                 "bookmarkIds": [], "scope": "global", "mode": "fit"}, 60_000)
            tid = (start.get("data") or {}).get("taskId") if start.get("success") else None
            if not tid:
                record(f"重复整理：{label}启动", False, f"err={start.get('error', '')}")
                continue
            for _ in range(240):
                panel.wait_for_timeout(2000)
                poll = send(panel, {"type": "ORGANIZE_AI_CLASSIFY_POLL", "taskId": tid}, 60_000)
                task = poll.get("data") or {}
                if task.get("status") == "completed":
                    total_now = (task.get("result") or {}).get("stats", {}).get("total")
                    if label == "第一次":
                        first_total = total_now
                    else:
                        second_total = total_now
                    break
                if task.get("status") == "failed":
                    record(f"重复整理：{label}完成", False, str(task.get("error"))[:160])
                    break

        record("重复整理：第二次不再空转（归档标记已取消）",
               bool(second_total) and second_total == first_total,
               f"第一次 total={first_total}，第二次 total={second_total}")

        # 清理这一段产物（书签由末尾统一删，这里删目录）
        panel.evaluate(
            """async ([ids]) => {
                for (const id of ids) {
                    try { await chrome.bookmarks.removeTree(id); } catch (e) {}
                }
            }""",
            [[merge_ids["a"], merge_ids["b"]]],
        )

        # ---- 整理范围必须被尊重（域名聚类 + AI 合流的前提）----
        # 曾经完全忽略 bookmarkIds：global 范围一律处理全部书签，于是向导里已经
        # 按域名分好组的那部分又被 AI 重新分类，两棵树覆盖同一批书签、执行时互相抢，
        # 域名目录可能最终是空的
        print("\n" + "=" * 64)
        print("⑫ 整理范围（bookmarkIds 必须被尊重）")
        print("=" * 64)

        subset = seeded["ids"][:7]
        start = send(panel, {"type": "ORGANIZE_AI_CLASSIFY_START", "bookmarkIds": subset,
                             "scope": "global", "mode": "fit"}, 60_000)
        subset_task = (start.get("data") or {}).get("taskId") if start.get("success") else None
        subset_tree = None

        if not subset_task:
            record("整理范围：启动", False, f"err={start.get('error', '')}")
        else:
            for _ in range(240):
                panel.wait_for_timeout(2000)
                task = (send(panel, {"type": "ORGANIZE_AI_CLASSIFY_POLL",
                                     "taskId": subset_task}, 60_000).get("data") or {})
                if task.get("status") == "completed":
                    subset_tree = (task.get("result") or {}).get("directoryTree") or {}
                    break
                if task.get("status") == "failed":
                    record("整理范围：完成", False, str(task.get("error"))[:160])
                    break

        if subset_tree is not None:
            produced = {i for ids in subset_tree.values() for i in ids}
            outside = produced - set(subset)
            record("整理范围：只处理传入的书签，不越界", not outside,
                   f"传入 {len(subset)} 条，产出 {len(produced)} 条"
                   + (f"，越界 {len(outside)} 条" if outside else ""))
            record("整理范围：传入的书签一条不漏",
                   set(subset).issubset(produced),
                   f"缺失 {len(set(subset) - produced)} 条")

        # ---- 文件夹整理必须待在文件夹内部 ----
        # 此前骨架取自整个书签栏、新目录建在书签栏顶层——「整理指定文件夹」
        # 实际是把书签打散到全局，和按钮上写的完全不是一回事
        print("\n" + "=" * 64)
        print("⑬ 文件夹整理（不越界）")
        print("=" * 64)

        seed_folder = seeded["folderId"]
        bar_before = panel.evaluate(
            """async ([bar]) => (await chrome.bookmarks.getChildren(bar)).map((c) => c.title).sort()""",
            [bar_id],
        )

        start = send(panel, {"type": "ORGANIZE_AI_CLASSIFY_START", "bookmarkIds": [],
                             "scope": "folder", "folderId": seed_folder,
                             "mode": "replan", "allowMoveOut": False}, 60_000)
        folder_task = (start.get("data") or {}).get("taskId") if start.get("success") else None
        folder_tree = None

        if not folder_task:
            record("文件夹整理：启动", False, f"err={start.get('error', '')}")
        else:
            for _ in range(240):
                panel.wait_for_timeout(2000)
                task = (send(panel, {"type": "ORGANIZE_AI_CLASSIFY_POLL",
                                     "taskId": folder_task}, 60_000).get("data") or {})
                if task.get("status") == "completed":
                    folder_tree = (task.get("result") or {}).get("directoryTree") or {}
                    break
                if task.get("status") == "failed":
                    record("文件夹整理：完成", False, str(task.get("error"))[:160])
                    break

        if folder_tree is not None:
            exec_resp = send(panel, {"type": "ORGANIZE_EXECUTE",
                                     "directoryTree": folder_tree,
                                     "rootId": seed_folder}, 300_000)
            record("文件夹整理：执行成功", exec_resp.get("success") is True,
                   f"{exec_resp.get('data')} err={exec_resp.get('error', '')}")

            inside = panel.evaluate(
                """async ([id]) => {
                    const sub = (await chrome.bookmarks.getChildren(id)).filter((c) => !c.url);
                    const direct = (await chrome.bookmarks.getChildren(id)).filter((c) => c.url);
                    return { subFolders: sub.length, directBookmarks: direct.length };
                }""",
                [seed_folder],
            )
            record("文件夹整理：新目录建在该文件夹内部",
                   inside["subFolders"] > 0 and inside["directBookmarks"] == 0,
                   f"子目录 {inside['subFolders']} 个，直属书签 {inside['directBookmarks']} 条")

            bar_after = panel.evaluate(
                """async ([bar]) => (await chrome.bookmarks.getChildren(bar)).map((c) => c.title).sort()""",
                [bar_id],
            )
            record("文件夹整理：没有往书签栏顶层建目录",
                   bar_after == bar_before,
                   f"之前 {bar_before} → 之后 {bar_after}")

        # ---- 小样本也必须走完整流程 ----
        # 曾经有个「书签少于 4 条就直接全部丢进未分类」的门槛放在 processAIClassify
        # 开头，于是 fit 模式下 2 条书签的文件夹整理后永远是「0 骨架目录 / 2 未分类」。
        # 那个门槛只对「聚类」有意义，fit 模式的骨架来自现有目录、与样本量无关。
        print("\n" + "=" * 64)
        print("⑭ 小样本（< 4 条书签）")
        print("=" * 64)

        # 复刻用户的实际操作：2 条书签的文件夹 + 勾一个空的移出目标
        tiny = panel.evaluate(
            """async () => {
                const bar = (await chrome.bookmarks.getTree())[0].children[0].id;
                const f = await chrome.bookmarks.create({ parentId: bar, title: 'TINY_SEED' });
                const target = await chrome.bookmarks.create({ parentId: bar, title: 'TINY_TARGET' });
                const ids = [];
                for (const [t, u] of [['本地服务 A', 'http://127.0.0.1:3000/a'],
                                      ['本地服务 B', 'http://127.0.0.1:8080/b']]) {
                    const bm = await chrome.bookmarks.create({ parentId: f.id, title: t, url: u });
                    ids.push(bm.id);
                }
                return { folder: f.id, target: target.id, ids };
            }"""
        )

        start = send(panel, {"type": "ORGANIZE_AI_CLASSIFY_START", "bookmarkIds": [],
                             "scope": "folder", "folderId": tiny["folder"],
                             "mode": "fit", "allowMoveOut": True,
                             "moveOutTargets": ["TINY_TARGET"]}, 60_000)
        tiny_task = (start.get("data") or {}).get("taskId") if start.get("success") else None
        tiny_result = None

        if not tiny_task:
            record("小样本：启动", False, f"err={start.get('error', '')}")
        else:
            for _ in range(240):
                panel.wait_for_timeout(2000)
                task = (send(panel, {"type": "ORGANIZE_AI_CLASSIFY_POLL",
                                     "taskId": tiny_task}, 60_000).get("data") or {})
                if task.get("status") == "completed":
                    tiny_result = task.get("result") or {}
                    break
                if task.get("status") == "failed":
                    record("小样本：完成", False, str(task.get("error"))[:160])
                    break

        if tiny_result is not None:
            tiny_stats = tiny_result.get("stats") or {}
            tiny_tree = tiny_result.get("directoryTree") or {}
            record("小样本：勾了移出目标就照常走完整流程（不再被「少于 4 条」拦住）",
                   tiny_stats.get("skeletonCount", 0) > 0 and "TINY_TARGET" in tiny_tree,
                   f"目录 {list(tiny_tree.keys())}，骨架 {tiny_stats.get('skeletonCount')}，"
                   f"未分类 {tiny_stats.get('unassigned')}")

        try:
            panel.evaluate("""async ([ids]) => {
                for (const id of ids) { try { await chrome.bookmarks.removeTree(id); } catch (e) {} }
            }""", [tiny["folder"], tiny["target"]])
        except Exception:  # noqa: BLE001
            pass

        # ---- 还原 AI 设置（凭证不留在 profile 里）----
        if AI_KEY and prev_settings:
            send(panel, {"type": "UPDATE_SETTINGS", "settings": {
                "apiEndpoint": prev_settings.get("apiEndpoint", ""),
                "apiKey": prev_settings.get("apiKey", ""),
                "apiModel": prev_settings.get("apiModel", ""),
                "apiFormat": prev_settings.get("apiFormat", "openai"),
            }}, 30_000)

        # ---- 清理 ----
        # 连同 ⑨/⑩ 段临时创建的书签与目录一起删掉，否则每跑一次 profile 就多留一些，
        # 下次运行时数据规模会漂移
        try:
            panel.evaluate("""async (ids) => {
                for (const id of ids) { try { await chrome.bookmarks.remove(id); } catch (e) {} }
            }""", [*seeded["ids"], *([created_id] if created_id else [])])
        except Exception:  # noqa: BLE001
            pass

        # ⑩ 段让 ORGANIZE_EXECUTE 建的目录：书签删完后按标题兜底清理
        try:
            panel.evaluate("""async ([parentId, title]) => {
                const children = await chrome.bookmarks.getChildren(parentId).catch(() => []);
                for (const c of children) {
                    if (!c.url && c.title === title) {
                        try { await chrome.bookmarks.removeTree(c.id); } catch (e) {}
                    }
                }
            }""", [bar_id, "执行测试目录"])
        except Exception:  # noqa: BLE001
            pass

        context.close()

    # ---- 汇总 ----
    print("\n" + "=" * 64)
    print("验证汇总")
    print("=" * 64)
    passed = sum(1 for r in RESULTS if r["ok"])
    total = len(RESULTS)
    for r in RESULTS:
        print(f"  {'✓' if r['ok'] else '✗'} {r['name']}")
    print(f"\n通过 {passed}/{total}")

    real_errors = [e for e in console_errors if "favicon" not in e.lower()]
    print(f"\nConsole 错误: {len(real_errors)}")
    for e in real_errors[:15]:
        print(f"  - {e[:200]}")

    out = Path(__file__).parent / "verify-report.json"
    out.write_text(json.dumps(
        {"results": RESULTS, "consoleErrors": real_errors, "consoleAll": console_all[-300:]},
        ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n报告: {out}")

    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
