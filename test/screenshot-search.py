"""聚焦截图：搜索分层（标题优先 + 语义折叠）。"""
from __future__ import annotations

import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = str(ROOT / "dist")
PROFILE = str(ROOT / "chrome-shot-profile")

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


def main() -> None:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            headless=False,
            args=[
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )

        ext_id = None
        for _ in range(40):
            if ctx.service_workers:
                ext_id = ctx.service_workers[0].url.split("/")[2]
                break
            time.sleep(0.5)
        if not ext_id:
            print("无法获取扩展 ID")
            ctx.close()
            return

        page = ctx.new_page()
        page.goto(f"chrome-extension://{ext_id}/src/sidepanel/index.html")
        page.wait_for_timeout(1500)

        page.evaluate(
            """async (items) => {
                const root = await chrome.bookmarks.create({ title: 'SHOT_SEED' });
                for (const [title, url] of items) {
                    await chrome.bookmarks.create({ parentId: root.id, title, url });
                }
            }""",
            SEED,
        )
        page.wait_for_timeout(1000)

        page.evaluate(
            """async () => await new Promise((res) => chrome.runtime.sendMessage(
                { type: 'REBUILD_INDEX' }, (r) => res(r)))"""
        )
        page.wait_for_timeout(1500)

        page.fill("input[type='text']", "React 状态管理")
        page.wait_for_timeout(7000)

        out = ROOT / "test" / "screenshots" / "search-tiering.png"
        page.screenshot(path=str(out), full_page=True)
        print(f"截图: {out}")
        print(page.inner_text("body")[:700])

        ctx.close()


if __name__ == "__main__":
    main()
