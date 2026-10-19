"""离线分析用户真实书签：只读 Chrome 的 Bookmarks 文件，不动任何东西。

用途：把真实的书签标题喂给分层聚类，看它到底怎么分、分得对不对——
不需要在用户的浏览器里执行任何操作。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

BOOKMARKS = Path(
    r"C:\Users\Windows\AppData\Local\Google\Chrome\User Data\Profile 12\Bookmarks"
)


def walk(node: dict, path: str, out: list[dict]) -> None:
    for child in node.get("children", []):
        title = child.get("name", "")
        if child.get("type") == "url":
            out.append({"title": title, "url": child.get("url", ""), "path": path})
        else:
            walk(child, f"{path}/{title}" if path else title, out)


def main() -> int:
    data = json.loads(BOOKMARKS.read_text(encoding="utf-8"))
    roots = data.get("roots", {})

    all_bm: list[dict] = []
    for key in ("bookmark_bar", "other", "synced"):
        node = roots.get(key)
        if node:
            walk(node, node.get("name", key), all_bm)

    print(f"书签总数: {len(all_bm)}\n")

    # 书签栏下的一级目录 + 各自直属书签数
    bar = roots.get("bookmark_bar", {})
    print("书签栏下的一级目录:")
    for child in bar.get("children", []):
        if child.get("type") == "url":
            continue
        sub: list[dict] = []
        walk(child, child.get("name", ""), sub)
        direct = sum(1 for c in child.get("children", []) if c.get("type") == "url")
        print(f"  {child.get('name'):<28} 共 {len(sub):>4} 条（直属 {direct}）")

    # 直属书签栏的书签
    loose = [c for c in bar.get("children", []) if c.get("type") == "url"]
    print(f"\n散在书签栏根下的书签: {len(loose)} 条")

    # 标题里带通用词的比例——这直接影响聚类质量
    generic = ["教程", "入门", "指南", "文档", "官网", "首页", "手册", "速查", "笔记"]
    hit = [b for b in all_bm if any(g in b["title"] for g in generic)]
    print(f"标题含通用词（教程/入门/文档…）: {len(hit)} 条（{len(hit) / max(len(all_bm), 1):.0%}）")

    # 域名分布 top 10
    from collections import Counter

    domains = Counter()
    for b in all_bm:
        url = b["url"]
        if "://" in url:
            host = url.split("://", 1)[1].split("/", 1)[0]
            domains[host] += 1
    print("\n域名 top 10:")
    for host, n in domains.most_common(10):
        print(f"  {n:>4}  {host}")

    out = Path(__file__).resolve().parent / "_real-bookmarks.json"
    out.write_text(json.dumps(all_bm, ensure_ascii=False), encoding="utf-8")
    print(f"\n已导出 {len(all_bm)} 条到 {out.name}（供后续离线聚类分析）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
