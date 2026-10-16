"""复现：整理只建目录、不移动书签。

场景贴近用户实际——书签全部集中在一个「人工智能」文件夹里，跑整理看执行阶段
到底移动了多少条、失败在哪。

用法：
  BM_AI_KEY=xxx python test/repro-organize-execute.py [mode]
  mode: fit（默认）| replan
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

EXT = str(Path(__file__).resolve().parent.parent / "dist")
PROFILE = str(Path(__file__).resolve().parent.parent / "chrome-repro-profile")

AI_ENDPOINT = os.environ.get("BM_AI_ENDPOINT", "")
AI_KEY = os.environ.get("BM_AI_KEY", "")
AI_MODEL = os.environ.get("BM_AI_MODEL", "")
AI_FORMAT = os.environ.get("BM_AI_FORMAT", "")

MODE = sys.argv[1] if len(sys.argv) > 1 else "fit"

# 域名模式用：5 个域名各 6 条，模拟「按域名建目录」
DOMAIN_SEEDS = [
    (f"{name} {i}", f"https://{host}/doc/{i}")
    for host, name in [
        ("react.dev", "React 文档"),
        ("vuejs.org", "Vue 文档"),
        ("kubernetes.io", "K8s 文档"),
        ("docker.com", "Docker 文档"),
        ("pytorch.org", "PyTorch 文档"),
    ]
    for i in range(6)
]

# 40 条，覆盖若干主题，模拟真实收藏夹
SEEDS = [
    ("Transformer 架构详解", "https://example.com/transformer"),
    ("注意力机制 Attention", "https://example.com/attention"),
    ("大语言模型微调实践", "https://example.com/finetune"),
    ("LoRA 低秩适配", "https://example.com/lora"),
    ("RAG 检索增强生成", "https://example.com/rag"),
    ("向量数据库选型", "https://example.com/vectordb"),
    ("提示词工程指南", "https://example.com/prompt"),
    ("多模态模型综述", "https://example.com/multimodal"),
    ("扩散模型原理", "https://example.com/diffusion"),
    ("模型量化与蒸馏", "https://example.com/quantize"),
    ("PyTorch 入门", "https://example.com/pytorch"),
    ("TensorFlow 教程", "https://example.com/tensorflow"),
    ("神经网络反向传播", "https://example.com/backprop"),
    ("卷积神经网络 CNN", "https://example.com/cnn"),
    ("循环神经网络 RNN", "https://example.com/rnn"),
    ("强化学习基础", "https://example.com/rl"),
    ("特征工程方法", "https://example.com/features"),
    ("模型评估指标", "https://example.com/metrics"),
    ("过拟合与正则化", "https://example.com/overfit"),
    ("交叉验证实践", "https://example.com/cv"),
    ("React Hooks 教程", "https://react.dev/hooks"),
    ("Vue 3 组合式 API", "https://vuejs.org/composition"),
    ("TypeScript 类型体操", "https://example.com/ts-types"),
    ("Vite 构建优化", "https://example.com/vite"),
    ("CSS Grid 布局", "https://example.com/grid"),
    ("前端性能优化清单", "https://example.com/perf"),
    ("Webpack 配置详解", "https://example.com/webpack"),
    ("浏览器渲染原理", "https://example.com/rendering"),
    ("Docker 镜像构建", "https://example.com/docker"),
    ("Kubernetes 集群管理", "https://example.com/k8s"),
    ("CI/CD 流水线设计", "https://example.com/cicd"),
    ("Nginx 反向代理", "https://example.com/nginx"),
    ("Linux 常用命令", "https://example.com/linux"),
    ("Git 分支策略", "https://example.com/git"),
    ("个人理财入门", "https://example.com/finance"),
    ("基金定投策略", "https://example.com/fund"),
    ("保险配置指南", "https://example.com/insurance"),
    ("露营装备清单", "https://example.com/camping"),
    ("咖啡手冲参数", "https://example.com/coffee"),
    ("宠物疫苗时间表", "https://example.com/pet"),
]


def send(page, msg: dict, timeout: int = 120_000):
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


def run_domain(page, seeded) -> int:
    """复现「按域名建目录」这条链路，严格照向导 handleDomainNext 的逻辑构造目录树。

    只选前两个域名，其余交给 AI —— 这才是真实用法（全选会跳过 AI 那一段，
    测不到两者合流时的问题）。
    """
    resp = send(page, {"type": "ORGANIZE_DOMAIN_CLUSTER"}, 120_000)
    clusters = resp.get("data") or []
    print(f"域名簇 {len(clusters)} 个:")
    for c in clusters:
        print(f"    {c['domain']}  {c['count']} 条  → 目录名 {c['suggestedFolderName']!r}")

    selected = clusters[:2]
    print(f"\n模拟用户只勾选前 {len(selected)} 个域名，其余交给 AI")

    domain_tree: dict[str, list[str]] = {}
    claimed: set[str] = set()
    for c in selected:
        name = c["suggestedFolderName"]
        domain_tree[name] = [*domain_tree.get(name, []), *c["bookmarkIds"]]
        claimed.update(c["bookmarkIds"])

    all_ids = set(seeded["ids"])
    remaining = sorted(all_ids - claimed)
    print(f"域名树: {[(k, len(v)) for k, v in domain_tree.items()]}")
    print(f"域名覆盖 {len(claimed)} 条，交给 AI {len(remaining)} 条")

    # 照 handleDomainNext 的做法：AI 分类剩余书签，再把两棵树合并
    if remaining and AI_KEY:
        start = send(page, {"type": "ORGANIZE_AI_CLASSIFY_START", "bookmarkIds": remaining,
                            "scope": "global", "mode": "fit"}, 60_000)
        tid = (start.get("data") or {}).get("taskId") if start.get("success") else None
        if not tid:
            print("AI 分类启动失败:", start.get("error"))
            return 1
        ai_tree = {}
        for _ in range(240):
            page.wait_for_timeout(2000)
            task = (send(page, {"type": "ORGANIZE_AI_CLASSIFY_POLL", "taskId": tid}, 60_000)
                    .get("data") or {})
            if task.get("status") == "completed":
                ai_tree = (task.get("result") or {}).get("directoryTree") or {}
                break
            if task.get("status") == "failed":
                print("AI 分类失败:", task.get("error"))
                return 1
        print(f"AI 产出 {len(ai_tree)} 个目录: {[(k, len(v)) for k, v in ai_tree.items()]}")

        merged = {k: list(v) for k, v in domain_tree.items()}
        for path, ids in ai_tree.items():
            merged[path] = [*merged.get(path, []), *ids]
        tree = merged
    else:
        tree = domain_tree

    print(f"\n最终目录树: {[(k, len(v)) for k, v in tree.items()]}")

    exec_resp = send(page, {"type": "ORGANIZE_EXECUTE",
                            "directoryTree": tree, "rootId": seeded["bar"]}, 300_000)
    print(f"\n执行返回: success={exec_resp.get('success')} data={exec_resp.get('data')} "
          f"err={exec_resp.get('error')}")

    after = page.evaluate(
        """async ([bar]) => {
            const out = [];
            const walk = async (id, path) => {
                for (const c of await chrome.bookmarks.getChildren(id)) {
                    if (c.url) continue;
                    const p = path ? path + '/' + c.title : c.title;
                    const kids = await chrome.bookmarks.getChildren(c.id);
                    out.push({ path: p, bookmarks: kids.filter(k => k.url).length });
                    await walk(c.id, p);
                }
            };
            await walk(bar, '');
            return out;
        }""",
        [seeded["bar"]],
    )
    print("\n执行后的书签栏结构:")
    for row in after:
        print(f"    {row['path']}  书签 {row['bookmarks']}")

    page.evaluate(
        """async ([bar]) => {
            for (const c of await chrome.bookmarks.getChildren(bar)) {
                try { await chrome.bookmarks.removeTree(c.id); } catch (e) {}
            }
        }""",
        [seeded["bar"]],
    )
    return 0


def main() -> int:
    # 域名模式不调 AI，不需要凭证
    if not AI_KEY and MODE != "domain":
        print("缺少 BM_AI_KEY")
        return 2

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            headless=False,
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}",
                  "--no-first-run", "--no-default-browser-check"],
        )

        ext_id = None
        for _ in range(40):
            if ctx.service_workers:
                ext_id = ctx.service_workers[0].url.split("/")[2]
                break
            time.sleep(0.5)
        if not ext_id:
            print("FATAL: 扩展未加载")
            ctx.close()
            return 2

        page = ctx.new_page()
        page.goto(f"chrome-extension://{ext_id}/src/sidepanel/index.html")
        page.wait_for_timeout(1500)

        # 配置 AI
        # 先关掉实时归档：否则每注入一条书签都会触发 onCreated → handleNewBookmark
        # → 调 AI 建目录并移动，把场景搅乱（实测会凭空多出三十来个空目录）
        overrides: dict = {"realtimeArchiving": False}
        if AI_KEY:
            overrides["apiKey"] = AI_KEY
        for key, val in [("apiEndpoint", AI_ENDPOINT), ("apiModel", AI_MODEL), ("apiFormat", AI_FORMAT)]:
            if val:
                overrides[key] = val
        send(page, {"type": "UPDATE_SETTINGS", "settings": overrides}, 30_000)

        # 造数据：书签全部塞进书签栏下的「人工智能」
        seeded = page.evaluate(
            """async (items) => {
                const bar = (await chrome.bookmarks.getTree())[0].children[0].id;
                const folder = await chrome.bookmarks.create({ parentId: bar, title: '人工智能' });
                const ids = [];
                for (const [title, url] of items) {
                    const bm = await chrome.bookmarks.create({ parentId: folder.id, title, url });
                    ids.push(bm.id);
                }
                return { bar, folder: folder.id, ids };
            }""",
            DOMAIN_SEEDS if MODE == "domain" else SEEDS,
        )
        print(f"已在「人工智能」下创建 {len(seeded['ids'])} 条书签\n")

        # 建索引
        send(page, {"type": "REBUILD_INDEX"}, 600_000)

        if MODE == "domain":
            return run_domain(page, seeded)

        # 整理
        start = send(page, {"type": "ORGANIZE_AI_CLASSIFY_START", "bookmarkIds": [],
                            "scope": "global", "mode": MODE}, 60_000)
        task_id = (start.get("data") or {}).get("taskId") if start.get("success") else None
        if not task_id:
            print("启动失败:", start.get("error"))
            ctx.close()
            return 1

        proposal = None
        for _ in range(240):
            page.wait_for_timeout(2000)
            task = (send(page, {"type": "ORGANIZE_AI_CLASSIFY_POLL", "taskId": task_id}, 60_000)
                    .get("data") or {})
            if task.get("status") == "completed":
                proposal = task.get("result") or {}
                break
            if task.get("status") == "failed":
                print("分类失败:", task.get("error"))
                ctx.close()
                return 1

        if proposal is None:
            print("分类超时")
            ctx.close()
            return 1

        tree = proposal.get("directoryTree") or {}
        stats = proposal.get("stats") or {}
        print(f"模式 = {MODE}")
        print(f"提案: {len(tree)} 个目录, warning={stats.get('warning')}, "
              f"detail={str(stats.get('warningDetail'))[:120]}")
        for path, ids in list(tree.items())[:12]:
            print(f"    {path}  ({len(ids)} 条)")

        # 执行
        exec_resp = send(page, {"type": "ORGANIZE_EXECUTE",
                                "directoryTree": tree, "rootId": seeded["bar"]}, 600_000)
        print(f"\n执行返回: success={exec_resp.get('success')} data={exec_resp.get('data')} "
              f"err={exec_resp.get('error')}")

        # 执行后实际结构
        after = page.evaluate(
            """async ([bar]) => {
                const out = [];
                const walk = async (id, path) => {
                    for (const c of await chrome.bookmarks.getChildren(id)) {
                        if (c.url) continue;
                        const p = path ? path + '/' + c.title : c.title;
                        const kids = await chrome.bookmarks.getChildren(c.id);
                        out.push({ path: p, bookmarks: kids.filter(k => k.url).length,
                                   folders: kids.filter(k => !k.url).length });
                        await walk(c.id, p);
                    }
                };
                await walk(bar, '');
                return out;
            }""",
            [seeded["bar"]],
        )
        print("\n执行后的书签栏结构:")
        for row in after:
            print(f"    {row['path']}  书签 {row['bookmarks']}  子目录 {row['folders']}")

        still = page.evaluate(
            """async ([id]) => (await chrome.bookmarks.getChildren(id).catch(() => [])).filter(c => c.url).length""",
            [seeded["folder"]],
        )
        print(f"\n「人工智能」里还剩 {still} 条书签（原本 {len(seeded['ids'])} 条）")

        # 清理
        page.evaluate(
            """async ([bar]) => {
                for (const c of await chrome.bookmarks.getChildren(bar)) {
                    try { await chrome.bookmarks.removeTree(c.id); } catch (e) {}
                }
            }""",
            [seeded["bar"]],
        )
        ctx.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
