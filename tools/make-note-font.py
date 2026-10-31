#!/usr/bin/env python3
"""生成笔记阅读器正文用的 14px / 4bpp 中文字库。

为什么单独造：

  · 字号固定 14px（安全区 220px → 每行 15 汉字），比界面用的 20px 小，
    但信息密度从 11 字/行提到 15 字/行，一页 13 行 ≈ 195 字。
  · 位深必须 4bpp：真机实测 14px 用 2bpp 时笔画糊成一团、整体发黑
    （横画密集处灰阶不够），4bpp 才恢复到"自然"的观感。
  · 字符集必须**全量**：界面字体只收源码字面量 + GB2312 一级，
    但笔记是用户自己的内容，任何没收录的字都会渲染成方块。
    这里收 GB2312 全集（一级 3755 + 二级 3008 = 6763）+ ASCII
    + 常用标点/数学符号，覆盖现代汉语日常用字。

产物：main/fonts/app_ui_font_note14.c，符号名 app_ui_font_note14。
"""
import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
FIRMWARE = os.path.join(REPO, "vendor", "ai-passport")
OUT = os.path.join(FIRMWARE, "main", "fonts", "app_ui_font_note14.c")
CJK_FONT = os.path.join(REPO, "assets", "fonts", "SourceHanSansSC-Normal.otf")
SYMBOL = "app_ui_font_note14"

SIZE = 14
BPP = 4


def gb2312_chars() -> set[str]:
    """GB2312 全字符集。

    注意要从 0xA1 起算，而不是 0xB0：
      0xA1–0xA9 是**符号区**，中文引号 “ ” ‘ ’、破折号 ——、省略号 ……、
      书名号 《》、全角空格 　 都在这里。只取 0xB0 以后会全部漏掉，
      而这些恰恰是中文笔记里最高频的标点。
      0xB0–0xF7 是汉字区（一级 3755 + 二级 3008）。
    """
    chars = set()
    for high in range(0xA1, 0xF8):
        for low in range(0xA1, 0xFF):
            try:
                chars.add(bytes([high, low]).decode("gb2312"))
            except UnicodeDecodeError:
                continue
    return chars


ASCII = {chr(c) for c in range(0x20, 0x7F)}

# GB2312 之外、笔记里高频出现的符号（排版/强调/序号/箭头）
EXTRA = (
    "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"
    "≈≠≤≥∞∝∈∉⊂⊃∪∩∴∵∠⊥∥√∑∏∫∮"
    "°′″℃℉€￥$％＃＠＆＊＋－／＜＝＞［］｛｝＼｜～"
    "✓✔✗✘⚠←→↔⇒⇔⌈⌉⌊⌋∙‧"
)

# ★ GB2312 里那几个"长得像但不是同一个字"的坑：
#   GB2312 0xA1A4 解出来是 ・(U+30FB 片假名中点)，而键盘打出来的是 ·(U+00B7)；
#   0xA1AA 是 ―(U+2015 横杠)，而中文破折号是 —(U+2014)；
#   省略号同  …(U+2026) 没问题，但 ‥(U+2025) 不在表里。
# 只收 GB2312 会出现「排版时按缺字处理、按全宽占位」的错行，
# 所以这些变体必须**两套都收**。
TYPO_VARIANTS = "·—–‥‧∙・―•‣⁃∶〜～"


def build_symbols() -> str:
    """返回 `--symbols` 字符串（**不含 ASCII**）。

    ASCII 走 `--range 0x20-0x7E`：引号、反斜杠放进 --symbols 会被
    shell / lv_font_conv 的参数解析吃掉，用码点区间最稳。
    """
    chars = gb2312_chars() | set(EXTRA) | set(TYPO_VARIANTS) | ASCII
    # 只去掉控制字符；全角空格 　(U+3000) 要保留，中文缩进要用
    chars = {c for c in chars if ord(c) >= 0x20 and c not in "\x7f"}
    return "".join(sorted(chars - ASCII))


def find_conv() -> str:
    for p in (
        shutil.which("lv_font_conv"),
        os.path.join(HERE, "node_modules", ".bin", "lv_font_conv"),
        os.path.join(REPO, "node_modules", ".bin", "lv_font_conv"),
        "/tmp/node_modules/.bin/lv_font_conv",
    ):
        if p and os.path.exists(p):
            return p
    sys.exit("找不到 lv_font_conv，先 npm install --no-save lv_font_conv@1.5.2")


def main() -> int:
    global SIZE, BPP
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", type=int, default=SIZE)
    ap.add_argument("--bpp", type=int, default=BPP)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--symbol", default=SYMBOL)
    args = ap.parse_args()

    SIZE, BPP = args.size, args.bpp
    out_path, symbol = args.out, args.symbol

    if not os.path.exists(CJK_FONT):
        sys.exit(f"缺字体源文件 {CJK_FONT}")
    syms = build_symbols()
    print(f"字符集 {len(syms)} 字（GB2312 全集 + ASCII + 标点），{SIZE}px / {BPP}bpp …")
    conv = find_conv()
    cmd = [
        conv, "--bpp", str(BPP), "--size", str(SIZE), "--font", CJK_FONT,
        "-r", "0x20-0x7E",
        "--symbols", syms, "--format", "lvgl", "--no-compress",
        "--lv-include", "lvgl.h", "-o", out_path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stdout + r.stderr)
        sys.exit("lv_font_conv 失败")

    src = open(out_path, encoding="utf-8").read()
    if f"const lv_font_t {symbol} " not in src and f"lv_font_t {symbol} " not in src:
        # 按文件名推导的符号名可能需要改名
        import re
        m = re.search(r"(?:const )?lv_font_t (\w+) = \{", src)
        if not m:
            sys.exit("产物里找不到 lv_font_t 定义")
        old = m.group(1)
        if old != symbol:
            src = src.replace(old, symbol)
            open(out_path, "w", encoding="utf-8").write(src)
            print(f"符号名 {old} -> {symbol}")

    kb = os.path.getsize(out_path) / 1024
    print(f"✓ {out_path}  ({kb:.0f} KB 源码)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
