import json
import pathlib
import sys

for f in ['src/sidepanel/i18n/zh.json', 'src/sidepanel/i18n/en.json']:
    try:
        d = json.loads(pathlib.Path(f).read_text(encoding='utf-8'))
    except Exception as exc:  # noqa: BLE001
        print(f'{f} -> JSON 解析失败: {exc}')
        sys.exit(1)
    print(f'{f} -> OK, {len(d)} keys')

# 中英 key 必须一一对应
zh = set(json.loads(pathlib.Path('src/sidepanel/i18n/zh.json').read_text(encoding='utf-8')))
en = set(json.loads(pathlib.Path('src/sidepanel/i18n/en.json').read_text(encoding='utf-8')))
only_zh = sorted(zh - en)
only_en = sorted(en - zh)
print('仅 zh 有:', only_zh or '(无)')
print('仅 en 有:', only_en or '(无)')
sys.exit(0 if not only_zh and not only_en else 1)
