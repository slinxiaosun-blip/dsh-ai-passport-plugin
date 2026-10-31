#!/usr/bin/env python3
"""生成 demo 用的 14px 中文字体子集。

只收 demo_notes.c 里出现过的非 ASCII 字符 + 可打印 ASCII。
正式产品会把整库字符并进来重新生成；这里先把「14px 能不能看清」验证掉。
"""
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(REPO, "vendor", "ai-passport", "main", "demo_notes.c")
FONT = os.path.join(REPO, "assets", "fonts", "SourceHanSansSC-Normal.otf")
OUT = os.path.join(REPO, "vendor", "ai-passport", "main", "fonts", "app_ui_font_cjk14.c")

text = open(SRC, encoding="utf-8").read()
chars = {chr(c) for c in range(0x20, 0x7F)}
chars |= {ch for ch in text if ord(ch) >= 0x80}
# 去掉控制字符与换行
chars = {ch for ch in chars if ch not in "\r\n\t"}
symbols = "".join(sorted(chars, key=ord))

cmd = [
    "npx", "--yes", "lv_font_conv",
    "--font", FONT,
    "--symbols", symbols,
    "--size", "14",
    "--bpp", "4",
    "--format", "lvgl",
    "--no-compress",
    "--lv-font-name", "app_ui_font_cjk14",
    "--lv-include", "lvgl.h",
    "-o", OUT,
]
print(f"字形数：{len(symbols)}")
subprocess.run(cmd, check=True)

src = open(OUT, encoding="utf-8").read()
if "app_ui_font_cjk14" not in src:
    sys.exit("生成失败：找不到 app_ui_font_cjk14")
m = re.search(r"\.line_height = (\d+)", src)
print(f"输出：{OUT}")
print(f"line_height：{m.group(1) if m else 'unknown'}")
