#!/usr/bin/env python3
"""生成固件界面用的中文字体子集（可复现）。

为什么需要它：LVGL 内置的 `lv_font_source_han_sans_sc_16_cjk` **不是**按应用文案选的
——它的字符集是 LVGL 示例里随手挑的一批字（"（），盗提陽帯鼻画…"）。实测本应用
界面渲染的 48 个中文字里有 23 个不在其中，于是那些位置显示成方框。

上游文档给了两条路：
  A. 用内置子集 → 必须改文案去回避缺字，限制表达；
  B. 从授权允许的字体生成**恰好覆盖所需字形**的子集 → 体积最小、完全可控。
本脚本实现 B。

用法：
    python3 tools/make-font-subset.py                  # 生成 + 校验
    python3 tools/make-font-subset.py --check          # 只校验，不生成

字形集从源码里**自动提取**，不手工维护 —— 手工列表一定会随文案改动而漂移，
而漂移的后果正是"又出现方框"，且要到真机上才发现。
"""
from __future__ import annotations

import argparse
import glob
import os
import re
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIRMWARE = os.path.join(REPO, 'vendor', 'ai-passport')
SRC_DIR = os.path.join(FIRMWARE, 'main')
FONT_SRC = os.path.join(REPO, 'assets', 'fonts', 'SourceHanSansSC-Normal.otf')
OUT_DIR = os.path.join(SRC_DIR, 'fonts')
OUT_C = os.path.join(OUT_DIR, 'app_ui_font_16.c')
FONT_NAME = 'app_ui_font_16'

# 界面上渲染文本的 API。新增渲染路径时要把函数名加到这里，
# 否则新文案的字不会被收进子集 —— 结果是又出现方框。
TEXT_CALLS = (
    r'ui_pixel_screen_create\s*\(',
    r'ui_pixel_label\s*\(',
    r'lv_label_set_text\s*\(',
    r'lv_label_set_text_fmt\s*\(',
    r'lv_label_set_text_static\s*\(',
)

# 除源码里出现的字符外，固定纳入的字符：
#   · ASCII 可打印区（指标、版本号、路径、工具名）
#   · 全角标点与常用符号（文案里会出现，但可能只在拼接处）
EXTRA = ''.join(chr(c) for c in range(0x20, 0x7F))
EXTRA += '　、。！？；：（）【】「」『』《》〈〉—…·•·×÷±→←↑↓⇄★☆●○■□▲▼'
EXTRA += '０１２３４５６７８９'


def strip_comments(src: str) -> str:
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    src = re.sub(r'//[^\n]*', '', src)
    return src


def collect_chars() -> tuple[set[str], list[str]]:
    """从 *字符串字面量* 里收集需要渲染的字符。

    只取字面量，不取注释 —— 注释里全是中文散文，收进来会让子集体积暴涨
    （实测注释有 800 多个不同的字，而界面只用 48 个）。
    """
    chars: set[str] = set(EXTRA)
    files = sorted(glob.glob(os.path.join(SRC_DIR, 'app*.c')) + glob.glob(os.path.join(SRC_DIR, 'app*.h')))
    # ASCII 先全量纳入，避免 ASCII 文案随代码变动而缺字
    for path in files:
        src = strip_comments(open(path, encoding='utf8').read())
        for call in TEXT_CALLS:
            for m in re.finditer(call + r'\s*"((?:[^"\\]|\\.)*)"', src):
                for ch in m.group(1):
                    if ch not in ('\\', '"'):
                        chars.add(ch)
    # 去掉控制字符
    chars = {c for c in chars if ord(c) >= 0x20}
    return chars, files


def font_covered(path: str) -> set[int]:
    """读取已生成字体 C 文件里覆盖的码点（用于校验）。"""
    if not os.path.exists(path):
        return set()
    txt = open(path, encoding='utf8', errors='replace').read()
    return {int(m.group(1), 16) for m in re.finditer(r'U\+([0-9A-Fa-f]{4,6})', txt)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='只校验，不生成')
    ap.add_argument('--font', default=FONT_SRC, help='源字体 OTF/TTF')
    ap.add_argument('--lv-font-conv', default=None, help='lv_font_conv 可执行文件路径')
    args = ap.parse_args()

    chars, files = collect_chars()
    print(f'扫描 {len(files)} 个源文件，界面需要 {len(chars)} 个字符')

    if args.check:
        covered = font_covered(OUT_C)
        if not covered:
            print('✗ 生成的字体文件不存在，先运行不带 --check 的生成')
            return 1
        missing = sorted(c for c in chars if ord(c) not in covered)
        if missing:
            print(f'✗ 有 {len(missing)} 个字符不在字体里：{"".join(missing)}')
            print('  说明文案改了但没重新生成字体。运行：python3 tools/make-font-subset.py')
            return 1
        print(f'✓ 字体覆盖全部 {len(chars)} 个字符')
        return 0

    if not os.path.exists(args.font):
        print(f'✗ 找不到源字体：{args.font}', file=sys.stderr)
        print('  思源黑体是 SIL OFL 授权、允许再分发的字体，可从', file=sys.stderr)
        print('  https://github.com/adobe-fonts/source-han-sans/releases 获取。', file=sys.stderr)
        return 1

    conv = args.lv_font_conv
    if not conv:
        conv = shutil.which('lv_font_conv') or '/tmp/node_modules/.bin/lv_font_conv'
    if not os.path.exists(conv):
        print(f'✗ 找不到 lv_font_conv：{conv}', file=sys.stderr)
        print('  安装：npm install --no-save lv_font_conv@1.5.2', file=sys.stderr)
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    symbols = ''.join(sorted(chars))
    # 用 --symbols 精确列出（不用 --range，避免把整个 CJK 区打进来）
    cmd = [
        conv,
        '--bpp', '4',
        '--size', '16',
        '--font', args.font,
        '--symbols', symbols,
        '--format', 'lvgl',
        '--no-compress',
        '--force-fast-kern-format',
        '--lv-include', 'lvgl.h',
        '-o', OUT_C,
    ]
    print('运行 lv_font_conv …')
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=REPO)
    if proc.returncode != 0:
        print('✗ lv_font_conv 失败：', file=sys.stderr)
        print(proc.stdout[-2000:], file=sys.stderr)
        print(proc.stderr[-2000:], file=sys.stderr)
        return proc.returncode

    # lv_font_conv 没有 --name：它按输出文件名推导符号名。这里统一重命名成
    # FONT_NAME，使代码里的引用不依赖输出文件名（改路径不会悄悄断掉引用）。
    txt = open(OUT_C, encoding='utf8').read()
    derived = re.search(r'lv_font_t\s+(\w+)\s*\(void\)', txt)
    if derived and derived.group(1) != FONT_NAME:
        old = derived.group(1)
        txt = re.sub(rf'\b{re.escape(old)}\b', FONT_NAME, txt)
        open(OUT_C, 'w', encoding='utf8').write(txt)
        print(f'已将符号 {old} 重命名为 {FONT_NAME}')

    size = os.path.getsize(OUT_C)
    print(f'✓ 已生成 {os.path.relpath(OUT_C, REPO)}（{size} 字节）')

    covered = font_covered(OUT_C)
    missing = sorted(c for c in chars if ord(c) not in covered)
    if missing:
        print(f'✗ 生成后仍有 {len(missing)} 个字符缺失：{"".join(missing)}', file=sys.stderr)
        return 1
    print(f'✓ 校验通过：覆盖全部 {len(chars)} 个字符')
    print()
    print('注意：字体 C 文件在 main/fonts/ 下，已由 main/CMakeLists.txt 的 SRCS 收录；')
    print('      界面需用 APP_UI_FONT 宏引用它（见 main/app_ui.h）。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
