"""诊断：搜索分层门槛是否把语义结果全部滤掉。"""
from __future__ import annotations

import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = str(ROOT / "dist")
PROFILE = str(ROOT / "chrome-diag-profile")

SEED = [
    ("React Hooks 完全指南", "https://react.dev/reference/react/useState"),
    ("React 官方文档", "https://react.dev/"),
    ("Vite 构建工具", "https://vitejs.dev/guide/"),
    ("TypeScript 手册", "https://www.typescriptlang.org/docs/handbook/intro.html"),
    ("Rust 程序设计语言", "https://doc.rust-lang.org/book/"),
    ("MDN Web 文档", "https://developer.mozilla.org/zh-CN/"),
    ("Python 官方文档", "https://docs.python.org/3/"),
    ("前端性能优化指南", "https://web.dev/performance/"),
    ("组件化设计模式", "https://patterns.dev/"),
    ("状态管理方案对比", "https://redux.js.org/"),
]

QUERIES = ["React", "如何管理应用状态", "前端性能", "浏览器兼容性"]


def main() -> None:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=PROFILE, headless=False,
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}",
                  "--no-first-run", "--no-default-browser-check"],
        )
        ext_id = None
        for _ in range(40):
            if ctx.service_workers:
                ext_id = ctx.service_workers[0].url.split("/")[2]
                break
            time.sleep(0.5)

        page = ctx.new_page()
        page.goto(f"chrome-extension://{ext_id}/src/sidepanel/index.html")
        page.wait_for_timeout(1500)

        page.evaluate(
            """async (items) => {
                const root = await chrome.bookmarks.create({ title: 'DIAG_SEED' });
                for (const [t, u] of items) await chrome.bookmarks.create({ parentId: root.id, title: t, url: u });
            }""", SEED)
        page.wait_for_timeout(800)
        page.evaluate("""async () => await new Promise((r) =>
            chrome.runtime.sendMessage({ type: 'REBUILD_INDEX' }, (x) => r(x)))""")
        page.wait_for_timeout(1500)

        for q in QUERIES:
            raw = page.evaluate(
                """async (q) => {
                    const r = await new Promise((res) => chrome.runtime.sendMessage(
                        { type: 'SEARCH', query: q }, (x) => res(x)));
                    if (!r || !r.success) return [];
                    return (r.data.semanticScores || [])
                        .map((s) => ({ id: s.id, sem: s.semanticScore, rr: s.rerankScore }))
                        .sort((a, b) => b.sem - a.sem);
                }""", q)

            page.fill("input[type='text']", q)
            page.wait_for_timeout(6500)
            body = page.inner_text("body")

            def has(*names: str) -> bool:
                return any(n in body for n in names)

            print(f"\n查询: {q!r}")
            print(f"  UI 分区 → 标题={has('Title matches','标题匹配')} "
                  f"模糊={has('Fuzzy matches','模糊匹配')} "
                  f"语义={has('Semantically related','语义相关')}")
            print(f"  语义原始分 (sem / rerank) 前 5:")
            for s in raw[:5]:
                eff = s["sem"] * 0.4 + s["rr"] * 0.6
                print(f"    sem={s['sem']:.3f} rerank={s['rr']:.4f} → 加权={eff:.3f}")

        ctx.close()


if __name__ == "__main__":
    main()
