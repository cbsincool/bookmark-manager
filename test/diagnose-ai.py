"""在真实 Chrome 中复现 AI 连接失败（诊断用）。"""
from __future__ import annotations

import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

EXT = str(Path(__file__).resolve().parent.parent / "dist")
PROFILE = str(Path(__file__).resolve().parent.parent / "chrome-realchrome-profile")


def main() -> int:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            headless=False,
            channel="chrome",  # 真实安装的 Chrome，而非 Playwright 自带 Chromium
            args=[
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )

        ext_id = None
        for _ in range(30):
            if ctx.service_workers:
                ext_id = ctx.service_workers[0].url.split("/")[2]
                break
            time.sleep(0.5)

        if not ext_id:
            print("结果: 真实 Chrome 拒绝加载扩展（137+ 已移除 --load-extension）")
            ctx.close()
            return 3

        print(f"扩展已加载: {ext_id}")

        page = ctx.new_page()
        page.goto(f"chrome-extension://{ext_id}/src/sidepanel/index.html")
        page.wait_for_timeout(1500)

        # 直接在扩展页面里 fetch，绕开扩展自身逻辑，看浏览器层的真实错误
        probe = page.evaluate(
            """async () => {
                const out = {};
                const urls = [
                    'https://api.openai.com/v1/chat/completions',
                    'https://api.openai.com/v1/models',
                ];
                for (const u of urls) {
                    try {
                        const r = await fetch(u, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ model: 'x', messages: [] }),
                        });
                        out[u] = 'HTTP ' + r.status;
                    } catch (e) {
                        out[u] = 'THREW: ' + String(e);
                    }
                }
                return out;
            }"""
        )
        print("\n扩展页面内 fetch 结果:")
        for u, r in probe.items():
            print(f"  {u}\n    → {r}")

        # 再走扩展自身的测试连接
        res = page.evaluate(
            """async () => await new Promise((res) => chrome.runtime.sendMessage(
                { type: 'TEST_AI_CONNECTION' }, (r) => res(r)))"""
        )
        print(f"\nTEST_AI_CONNECTION: {res}")

        ctx.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
