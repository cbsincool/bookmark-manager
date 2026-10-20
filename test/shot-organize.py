"""给整理向导截图，确认本地化与配色。用法：python test/shot-organize.py"""
from __future__ import annotations
import sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

EXT = str(Path(__file__).resolve().parent.parent / "dist")
PROFILE = str(Path(__file__).resolve().parent.parent / "chrome-org-profile")
SHOTS = Path(__file__).resolve().parent / "screenshots"
SHOTS.mkdir(exist_ok=True)

def main() -> int:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=PROFILE, headless=False,
            viewport={"width": 400, "height": 1000},
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
            print("FATAL: 扩展未加载"); ctx.close(); return 2

        page = ctx.new_page()
        page.goto(f"chrome-extension://{ext_id}/src/sidepanel/index.html")
        page.wait_for_timeout(1200)
        page.evaluate("""async () => {
            const bar = (await chrome.bookmarks.getTree())[0].children[0].id;
            const f = await chrome.bookmarks.create({ parentId: bar, title: 'SAMPLE' });
            for (const [t,u] of [['React 文档','https://react.dev/learn'],['Docker 入门','https://docs.docker.com/']])
                await chrome.bookmarks.create({ parentId: f.id, title: t, url: u });
        }""")
        page.click("button:has-text('📂')")
        page.wait_for_timeout(600)
        page.screenshot(path=str(SHOTS / "organize-1-idle.png"))
        print("  已截: organize-1-idle.png")

        page.click("button:has-text('Start Organizing'), button:has-text('开始整理')")
        page.wait_for_timeout(1800)
        page.screenshot(path=str(SHOTS / "organize-2-scope.png"))
        print("  已截: organize-2-scope.png")
        ctx.close()
    return 0

if __name__ == "__main__":
    sys.exit(main())
