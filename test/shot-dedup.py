"""给去重模块截图，用于目视检查布局与配色。

用法：python test/shot-dedup.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

EXT = str(Path(__file__).resolve().parent.parent / "dist")
PROFILE = str(Path(__file__).resolve().parent.parent / "chrome-dedup-profile")
SHOTS = Path(__file__).resolve().parent / "screenshots"
SHOTS.mkdir(exist_ok=True)


def main() -> int:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            headless=False,
            viewport={"width": 400, "height": 900},
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
        page.wait_for_timeout(1200)

        # 造几条重复书签，好让结果区有内容
        page.evaluate(
            """async () => {
                const bar = (await chrome.bookmarks.getTree())[0].children[0].id;
                const f = await chrome.bookmarks.create({ parentId: bar, title: 'SHOT_SEED' });
                const rows = [
                    ['React 官方文档', 'https://react.dev/learn'],
                    ['React 官方文档', 'https://react.dev/reference'],
                    ['React 官方文档', 'https://react.dev/learn?utm_source=x'],
                    ['Docker 入门', 'https://docs.docker.com/get-started/'],
                    ['Docker 入门', 'https://docs.docker.com/get-started'],
                    ['Kubernetes 概念', 'https://kubernetes.io/docs/concepts/'],
                    ['Kubernetes 概念', 'https://kubernetes.io/docs/concepts'],
                ];
                for (const [t, u] of rows) await chrome.bookmarks.create({ parentId: f.id, title: t, url: u });
            }"""
        )
        page.wait_for_timeout(600)

        page.click("button:has-text('🗑')")
        page.wait_for_timeout(600)
        page.screenshot(path=str(SHOTS / "dedup-1-idle.png"), full_page=True)
        print("  已截: dedup-1-idle.png")

        # 扫描
        page.click("button:has-text('开始扫描'), button:has-text('Start Scan')")
        page.wait_for_timeout(6000)
        page.screenshot(path=str(SHOTS / "dedup-2-results.png"), full_page=True)
        print("  已截: dedup-2-results.png")

        # 手动选择模式
        page.click("button:has-text('手动选择模式'), button:has-text('Manual')")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(SHOTS / "dedup-3-manual.png"), full_page=True)
        print("  已截: dedup-3-manual.png")

        ctx.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
