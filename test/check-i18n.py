"""i18n 健康检查。

三项：
  1. zh/en 两个 JSON 都能解析
  2. 两个文件的 key 一一对应（缺一个都会让界面出现裸 key）
  3. 组件里没有「未走 t() 的中文文案」

第 3 项是补出来的：端到端只断言「有没有出现裸 i18n key」，抓不到硬编码文案。
默认语言是 en，所以硬编码中文会直接表现为中英混杂——这个坑踩过一次
（设置页 6 处、整理向导 37 处），靠人工复核才发现。

允许的例外（脚本会自动跳过）：
  - 注释行
  - 目录名等「数据」而非文案：`[待删除_失效]`、`'其他'`
  - 语言选项自身的标签：`>中文<`

用法：python test/check-i18n.py
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

I18N = pathlib.Path('src/sidepanel/i18n')
UI = pathlib.Path('src/sidepanel')

CJK = re.compile(r'[一-鿿]')

# 这些是数据不是文案：目录名约定、兜底目录名
DATA_ALLOWLIST = ('[待删除_失效]', "'其他'", '"其他"')


def check_json() -> tuple[set[str], set[str]]:
    zh = json.loads((I18N / 'zh.json').read_text(encoding='utf-8'))
    en = json.loads((I18N / 'en.json').read_text(encoding='utf-8'))
    print(f'{I18N / "zh.json"} -> OK, {len(zh)} keys')
    print(f'{I18N / "en.json"} -> OK, {len(en)} keys')
    return set(zh), set(en)


def check_parity(zh: set[str], en: set[str]) -> bool:
    only_zh = sorted(zh - en)
    only_en = sorted(en - zh)
    print('仅 zh 有:', only_zh or '(无)')
    print('仅 en 有:', only_en or '(无)')
    return not only_zh and not only_en


def check_hardcoded() -> list[tuple[str, int, str]]:
    """找出组件里没走 t() 的中文文案"""
    hits: list[tuple[str, int, str]] = []
    for path in sorted(UI.rglob('*.tsx')):
        in_block_comment = False
        for lineno, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
            stripped = line.strip()
            # 跨行注释：{/* … */} 与 /* … */ 都要整段跳过
            if in_block_comment:
                if '*/' in line:
                    in_block_comment = False
                continue
            if stripped.startswith(('/*', '{/*')) and '*/' not in stripped:
                in_block_comment = True
                continue
            if stripped.startswith(('//', '*', '/*', '{/*')):
                continue
            if not CJK.search(line):
                continue
            if "t('" in line or 't("' in line:
                continue
            if any(a in line for a in DATA_ALLOWLIST):
                continue
            if '>中文<' in line:
                continue
            hits.append((str(path.relative_to(UI)), lineno, stripped[:90]))
    return hits


def main() -> int:
    zh, en = check_json()
    ok = check_parity(zh, en)

    hits = check_hardcoded()
    if hits:
        print(f'\n⚠️  未走 i18n 的中文文案 {len(hits)} 处（默认语言是 en，会中英混杂）:')
        for rel, lineno, text in hits:
            print(f'   {rel}:{lineno}  {text}')
    else:
        print('\n✓ 组件里没有未走 i18n 的中文文案')

    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
