"""给设置页截图，目视检查布局与配色。用法：python test/shot-settings.py"""
from __future__ import annotations

import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

EXT = str(Path(__file__).resolve().parent.parent / "dist")
PROFILE = str(Path(__file__).resolve().parent.parent / "chrome-settings-profile")
SHOTS = Path(__file__).resolve().parent / "screenshots"
SHOTS.mkdir(exist_ok=True)


def main() -> int:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            headless=False,
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
            print("FATAL: 扩展未加载")
            ctx.close()
            return 2

        page = ctx.new_page()
        page.goto(f"chrome-extension://{ext_id}/src/sidepanel/index.html")
        page.wait_for_timeout(1200)
        page.click("button:has-text('⚙')")
        page.wait_for_timeout(800)
        page.screenshot(path=str(SHOTS / "settings.png"), full_page=True)
        print("  已截: settings.png")

        # 页面在 overflow-y-auto 容器里，full_page 展不开，滚动再截一张
        page.evaluate("() => { const el = document.querySelector('.overflow-y-auto'); if (el) el.scrollTop = el.scrollHeight; }")
        page.wait_for_timeout(500)
        page.screenshot(path=str(SHOTS / "settings-bottom.png"))
        print("  已截: settings-bottom.png")
        ctx.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
