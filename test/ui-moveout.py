"""在真实浏览器里走一遍整理向导 UI，复现「移出到目标不生效」。

与 repro-organize-execute.py 的区别：那个是在消息层复刻向导的逻辑，
这个**点真实的按钮**——向导的调用路径与复刻不一致的话，只有这种测法能发现。

用法：BM_AI_KEY=xxx python test/ui-moveout.py
"""
from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

EXT = str(Path(__file__).resolve().parent.parent / "dist")
PROFILE = str(Path(__file__).resolve().parent.parent / "chrome-ui-profile")

AI_KEY = os.environ.get("BM_AI_KEY", "")
AI_MODEL = os.environ.get("BM_AI_MODEL", "")
MODE = sys.argv[1] if len(sys.argv) > 1 else "fit"
# 书签条数：用户报告的场景是 2 条。这个数字很关键——
# 曾经有个「少于 4 条就直接全部丢进未分类」的门槛放在函数开头，
# 我之前的测试数据一直是 5 条和 40 条，永远撞不到它。
SEED_COUNT = int(sys.argv[2]) if len(sys.argv) > 2 else 5


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


def main() -> int:
    if not AI_KEY:
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
        print(f"扩展 {ext_id}")

        panel = ctx.new_page()
        panel.goto(f"chrome-extension://{ext_id}/src/sidepanel/index.html")
        panel.wait_for_timeout(1500)

        overrides = {"realtimeArchiving": False, "apiKey": AI_KEY}
        if AI_MODEL:
            overrides["apiModel"] = AI_MODEL
        send(panel, {"type": "UPDATE_SETTINGS", "settings": overrides}, 30_000)

        # 造数据：127.0.0.1 有 5 条，localhost 是空的
        seeded = panel.evaluate(
            """async ([limit]) => {
                const bar = (await chrome.bookmarks.getTree())[0].children[0].id;
                const src = await chrome.bookmarks.create({ parentId: bar, title: '127.0.0.1' });
                const dst = await chrome.bookmarks.create({ parentId: bar, title: 'localhost' });
                for (const [title, url] of [
                    ['本地开发服务器配置', 'http://127.0.0.1:3000/docs'],
                    ['本地 API 调试记录', 'http://127.0.0.1:8080/api'],
                    ['前端热更新说明', 'http://127.0.0.1:5173/guide'],
                    ['本地数据库连接', 'http://127.0.0.1:5432/notes'],
                    ['开发环境搭建', 'http://127.0.0.1:3000/setup'],
                ].slice(0, limit)) {
                    await chrome.bookmarks.create({ parentId: src.id, title, url });
                }
                return { bar, src: src.id, dst: dst.id };
            }""",
            [SEED_COUNT],
        )
        print(f"已建：「127.0.0.1」5 条 / 空目录「localhost」\n")

        def dump(label: str) -> str:
            text = panel.inner_text("body")
            print(f"--- {label} ---\n{text[:700]}\n")
            return text

        # ---- 走 UI ----
        # 侧边栏有标签页（🔍 搜索 / 📂 整理 / 🗑 去重 / ⚙️ 设置），先切到整理
        panel.click("button:has-text('📂')")
        panel.wait_for_timeout(800)
        panel.click("button:has-text('开始整理')")
        panel.wait_for_timeout(1500)
        dump("① 范围选择")

        if MODE == 'replan':
            panel.click("text=Re-plan the folder structure")
            panel.wait_for_timeout(400)

        # 选「127.0.0.1」这个文件夹（它出现在「整理指定文件夹」列表里）
        panel.click("button:has-text('127.0.0.1')")
        panel.wait_for_timeout(1500)
        dump("② 一级目录配置（文件夹范围）")

        # 勾上「允许移出」——用 checkbox 而不是文案，界面语言默认是英文
        panel.locator("input[type=checkbox]").first.check()
        panel.wait_for_timeout(600)
        dump("③ 展开移出目标")

        # 勾选 localhost
        panel.click("label:has-text('localhost')")
        panel.wait_for_timeout(400)

        panel.click("button:has-text('Next'), button:has-text('下一步')")
        print("等待 AI 分类…")
        for _ in range(120):
            panel.wait_for_timeout(2000)
            body = panel.inner_text("body")
            if "预览" in body or "执行" in body:
                break
        dump("④ 预览")

        exec_btn = (panel.query_selector("button:has-text('Execute')")
                    or panel.query_selector("button:has-text('执行')"))
        if not exec_btn:
            print("!! 没找到执行按钮，停在预览之前了")
            panel.screenshot(path=str(Path(__file__).parent / "screenshots" / "ui-stuck.png"), full_page=True)
            ctx.close()
            return 1

        exec_btn.click()
        panel.wait_for_timeout(8000)
        dump("⑤ 执行结果")

        after = panel.evaluate(
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
        print("执行后的书签栏结构:")
        for row in after:
            print(f"    {row['path']}  书签 {row['bookmarks']}")

        panel.evaluate(
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
