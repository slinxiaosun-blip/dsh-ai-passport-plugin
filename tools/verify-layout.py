#!/usr/bin/env python3
"""验证设备界面的版面几何（不依赖设备、不依赖照片）。

为什么需要它：截图（FAP_SCREENSHOT_V1）要设备在线才能用，而版面错误
（重叠、溢出、行距过窄）恰恰是**可以纯计算验证**的那一类 —— 没必要靠
拍照/截图迭代好几轮。这个脚本把各块屏（主页 / 审批 / 余额 / 系统设置）算一遍：

  · 纵向预算是否放得下
  · 每个元素是否越界、是否互相重叠、字面之间是否留够呼吸间隙
  · 每行文案在**真实字体度量**下是否超宽（字宽从生成的字体 C 产物解析，
    不是估算；字体链里缺字直接报错 —— 真机上那就是方框）
  · 多行文本的行数预算是否装得进给定高度

★ 与 C 代码保持同步的方式：版面常量**直接从 main/app_ui_theme.h 解析**，
  不存在"脚本一份、代码一份"的两套数字。改了头文件，这里自动跟着变。
  （上一版脚本就是和 C 各写一套，结果文案、行高双双漂移。）

用法：python3 tools/verify-layout.py
改版面时先改 app_ui_theme.h 与两个 app_*.c，跑通这里再编译烧录。
"""
from __future__ import annotations

import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
THEME = os.path.join(REPO, 'vendor', 'ai-passport', 'main', 'app_ui_theme.h')
FONTS_DIR = os.path.join(REPO, 'vendor', 'ai-passport', 'main', 'fonts')

# ── 版面常量：从 app_ui_theme.h 解析 ──────────────────────────────────────


def load_theme_macros(path: str) -> dict:
    """按书写顺序求值 #define NAME EXPR（整数表达式），得到版面常量表。

    只求值不含参数、且能用 Python 算出来的宏（颜色、字体指针等求值失败就跳过）。
    这样脚本里的每个坐标都来自 C 代码本身，两边不可能漂移。
    """
    env: dict[str, int] = {}
    src = open(path, encoding='utf8').read()
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    src = re.sub(r'//[^\n]*', '', src)
    for m in re.finditer(r'#define\s+([A-Za-z_]\w*)\s+([^\n]+)', src):
        name, expr = m.group(1), m.group(2).strip()
        if not re.fullmatch(r'[0-9A-Za-z_()\s+\-*/]+', expr):
            continue
        try:
            value = eval(expr, {'__builtins__': {}}, dict(env))   # noqa: S307 —— 受限求值
        except Exception:
            continue
        if isinstance(value, (int, float)):
            env[name] = int(value)
    return env


M = load_theme_macros(THEME)


def macro(name: str) -> int:
    if name not in M:
        raise SystemExit(f'✗ app_ui_theme.h 里找不到可解析的宏 {name}')
    return M[name]


# ── 字体度量：从生成的字体 C 产物解析（真实字宽，不是估算）────────────────


class Font:
    def __init__(self, path: str):
        src = open(path, encoding='utf8', errors='replace').read()
        m = re.search(r'\.line_height\s*=\s*(\d+)', src)
        if not m:
            raise SystemExit(f'✗ {path}: 找不到 line_height')
        self.line_h = int(m.group(1))

        gm = re.search(r'glyph_dsc\[\]\s*=\s*\{(.*?)\n\};', src, re.S)
        if not gm:
            raise SystemExit(f'✗ {path}: 找不到 glyph_dsc')
        # LVGL 的 adv_w 单位是 1/16 像素
        self.adv = [int(a) / 16 for a in re.findall(r'\.adv_w\s*=\s*(\d+)', gm.group(1))]

        # cmap：FORMAT0_TINY 连续区间；SPARSE_TINY 用 unicode_list 查偏移表
        lists: dict[str, list[int]] = {}
        for lm in re.finditer(r'const\s+uint16_t\s+(\w+)\[\]\s*=\s*\{(.*?)\};', src, re.S):
            lists[lm.group(1)] = [int(x, 0) for x in re.findall(r'0x[0-9a-fA-F]+|\d+', lm.group(2))]
        self.cmap: list[tuple[int, int, int, list[int] | None]] = []
        cm = re.search(r'cmaps\[\]\s*=\s*\{(.*?)\n\};', src, re.S)
        if not cm:
            raise SystemExit(f'✗ {path}: 找不到 cmaps')
        for entry in re.findall(r'\{(.*?)\}', cm.group(1), re.S):
            kv = dict(re.findall(r'\.(range_start|range_length|glyph_id_start)\s*=\s*(\d+)', entry))
            ul = re.search(r'\.unicode_list\s*=\s*(\w+|NULL)', entry)
            if not kv or not ul:
                continue
            self.cmap.append((
                int(kv.get('range_start', 0)), int(kv.get('range_length', 0)),
                int(kv.get('glyph_id_start', 0)),
                lists.get(ul.group(1)) if ul.group(1) != 'NULL' else None,
            ))

        fm = re.search(r'\.fallback\s*=\s*&(\w+)', src)
        self.fallback_name = fm.group(1) if fm else None
        self.fallback: 'Font | None' = None

    def glyph_id(self, cp: int) -> int | None:
        for start, length, gid_start, ulist in self.cmap:
            if not (start <= cp < start + length):
                continue
            if ulist is None:
                return gid_start + (cp - start)
            ofs = cp - start
            return gid_start + ulist.index(ofs) if ofs in ulist else None
        return None

    def advance(self, cp: int) -> float | None:
        gid = self.glyph_id(cp)
        if gid is not None and gid < len(self.adv):
            return self.adv[gid]
        return self.fallback.advance(cp) if self.fallback else None


def load_fonts() -> dict[str, Font]:
    """按生成物里的 .fallback 链把字体接起来，并按符号名登记。"""
    fonts: dict[str, Font] = {}
    by_file = {}
    for fn in ('bitfont_8.c', 'bitfont_16.c', 'app_ui_font_cjk.c', 'app_ui_font_cjk16.c',
               'app_ui_font_xl.c'):
        f = Font(os.path.join(FONTS_DIR, fn))
        by_file[fn] = f
    # 符号名：与 app_ui_theme.h 的 UI_FONT_* 指向一致
    name_of = {
        'bitfont_8.c': 'app_ui_font_8',
        'bitfont_16.c': 'app_ui_font_16',
        'app_ui_font_cjk.c': 'app_ui_font_cjk',
        'app_ui_font_cjk16.c': 'app_ui_font_cjk16',
        'app_ui_font_xl.c': 'app_ui_font_xl',
    }
    for fn, f in by_file.items():
        fonts[name_of[fn]] = f
    for f in fonts.values():
        if f.fallback_name:
            f.fallback = fonts.get(f.fallback_name)
    return fonts


FONTS = load_fonts()
F_CJK = FONTS['app_ui_font_cjk']
F_XL = FONTS['app_ui_font_xl']
# 覆盖层底栏提示在固件里用 16px 中文（make_overlay 的 hint，UI_FONT_CJK16）
F_CJK16 = FONTS['app_ui_font_cjk16']


def text_width(s: str, font: Font, strict: bool = True) -> float:
    """按真实字形步进算文本宽度；缺字直接报错（真机上就是方框）。

    strict=False 用于**主机下发**的文案（工具名/原因/标题）：它出现在运行期，
    字体子集按 C 字面量生成，覆盖率由 make-fonts.py 另行保证，这里只估宽度。
    """
    w = 0.0
    for ch in s:
        adv = font.advance(ord(ch))
        if adv is None:
            if strict:
                raise SystemExit(f'✗ 字体链里缺字形 U+{ord(ch):04X}（"{ch}"），真机上会显示方框')
            adv = 20 if ord(ch) > 0x7F else 10   # 保守估宽（中文 20 / ASCII 10）
        w += adv
    return w


def wrap_lines(s: str, font: Font, width: float, strict: bool = True) -> int:
    """按真实字宽模拟折行（任意处可断，取最少行数的保守下界）。"""
    lines, cur = 1, 0.0
    for ch in s:
        adv = font.advance(ord(ch))
        if adv is None:
            if strict:
                raise SystemExit(f'✗ 字体链里缺字形 U+{ord(ch):04X}（"{ch}"），真机上会显示方框')
            adv = 20 if ord(ch) > 0x7F else 10
        if cur + adv > width:
            lines += 1
            cur = adv
        else:
            cur += adv
    return lines


# ── 版面模型（坐标全部来自 app_ui_theme.h 的宏）───────────────────────────
#
# y 一律是**安全区绝对坐标**（已含容器偏移：状态条/状态主体/底栏/覆盖层）。

from typing import NamedTuple


class El(NamedTuple):
    name: str
    font: Font
    x: int
    y: int
    w: int
    h: int
    text: str
    lines: int          # 0 = 纯色块；1 = 单行；>1 = 多行预算
    host: bool = False  # 主机下发文案：宽度/折行只估算，不做缺字强校验


UI_W = macro('UI_W')
UI_H = macro('UI_H')
UI_PAD = macro('UI_PAD')
LINE_H_CJK = macro('UI_LINE_H_CJK')
LINE_SPACE = macro('UI_TEXT_LINE_SPACE')
PITCH = macro('UI_TEXT_PITCH_CJK')

SB_Y = macro('UI_STATUSBAR_Y')
BODY_Y = macro('UI_BODY_Y')
FOOT_Y = macro('UI_FOOTER_Y')


def centered_y(container_h: int, line_h: int) -> int:
    return (container_h - line_h) // 2


HOME = [
    El('状态条·应用名', F_CJK, UI_PAD + 16, SB_Y + centered_y(macro('UI_STATUSBAR_H'), LINE_H_CJK),
       UI_W - (UI_PAD + 16), LINE_H_CJK, 'AI 通行证 · 已连接', 1),
    El('状态条·应用名2', F_CJK, UI_PAD + 16, SB_Y + centered_y(macro('UI_STATUSBAR_H'), LINE_H_CJK),
       UI_W - (UI_PAD + 16), LINE_H_CJK, 'AI 通行证 · 待连接', 1),
    El('状态大字', F_XL, 0, BODY_Y + macro('UI_STATE_TEXT_Y'),
       UI_W, macro('UI_LINE_H_XL'), '运行中', 1),
    El('状态提示', F_CJK, UI_PAD, BODY_Y + macro('UI_STATE_HINT_Y'),
       UI_W - UI_PAD * 2, macro('UI_STATE_HINT_H'), '没有正在执行的任务', macro('UI_STATE_HINT_LINES')),
    El('状态提示·主机', F_CJK, UI_PAD, BODY_Y + macro('UI_STATE_HINT_Y'),
       UI_W - UI_PAD * 2, macro('UI_STATE_HINT_H'), '执行质量检查并生成报告', macro('UI_STATE_HINT_LINES'), True),
    El('底栏·行1', F_CJK, 0, FOOT_Y + macro('UI_FOOTER_LINE1_Y'), UI_W, LINE_H_CJK, '长按下键看余额', 1),
    El('底栏·行2', F_CJK, 0, FOOT_Y + macro('UI_FOOTER_LINE2_Y'), UI_W, LINE_H_CJK, '长按确定断开', 1),
]

HOME_WAITING = [
    El('底栏·等待授权', F_CJK, 0, FOOT_Y + centered_y(macro('UI_FOOTER_H'), LINE_H_CJK),
       UI_W, LINE_H_CJK, '等待授权请求', 1),
]

APPROVAL_FOOT_Y = UI_H - macro('OV_FOOT_H')
# 审批页 2026-10-06 二改后只剩：标题 + 一行摘要 + 两个选项 + 底栏
# （倒计时条/倒计时文字/原因多行区已删除，见 app_ui_theme.h 审批页规格注释）。
APPROVAL = [
    El('审批·标题', F_CJK, UI_PAD, centered_y(macro('OV_TITLE_H'), LINE_H_CJK),
       UI_W - UI_PAD * 2, LINE_H_CJK, '等待审批', 1),
    El('审批·摘要', F_CJK, UI_PAD, macro('OV_APPR_TOOL_Y'),
       UI_W - UI_PAD * 2, LINE_H_CJK, '写入仓库目录', 1, True),
    El('审批·选项1', F_CJK, UI_PAD, macro('OV_APPR_OPTS_Y'),
       UI_W - UI_PAD * 2, macro('OV_APPR_OPT_H'), '运行一次', 1),
    El('审批·选项2', F_CJK, UI_PAD,
       macro('OV_APPR_OPTS_Y') + macro('OV_APPR_OPT_H') + macro('OV_APPR_OPT_GAP'),
       UI_W - UI_PAD * 2, macro('OV_APPR_OPT_H'), '拒绝', 1),
    El('审批·底栏·选择', F_CJK16, UI_PAD, APPROVAL_FOOT_Y,
       UI_W - UI_PAD * 2, macro('OV_FOOT_H'), '上/下选择  确定执行', 1),
    El('审批·底栏·失败', F_CJK16, UI_PAD, APPROVAL_FOOT_Y,
       UI_W - UI_PAD * 2, macro('OV_FOOT_H'), '发送失败，请重试', 1),
]

BALANCE = [
    El('余额·标题', F_CJK, UI_PAD, centered_y(macro('OV_TITLE_H'), LINE_H_CJK),
       UI_W - UI_PAD * 2, LINE_H_CJK, 'DeepSeek 余额', 1),
    El('余额·币种总额', F_CJK, UI_PAD, macro('OV_BAL_TOTAL_Y'),
       UI_W - UI_PAD * 2, LINE_H_CJK, 'CNY 128.50', 1, True),
    El('余额·明细', F_CJK, UI_PAD, macro('OV_BAL_LINES_Y'),
       UI_W - UI_PAD * 2, macro('OV_BAL_LINES_H'), '今日已用  12.30', macro('OV_BAL_LINES'), True),
    El('余额·底栏', F_CJK16, UI_PAD, APPROVAL_FOOT_Y,
       UI_W - UI_PAD * 2, macro('OV_FOOT_H'), '确定键返回', 1),
]

TOAST = [
    El('提示条·文本', F_CJK, UI_PAD + 10, BODY_Y + 16 + macro('UI_TOAST_TEXT_Y'),
       UI_W - UI_PAD * 2 - 20, macro('UI_TOAST_TEXT_H'), '已提交，等待主机确认', macro('UI_TOAST_TEXT_LINES'), True),
]

# 系统设置页：4 个档位行 + 配对行（两行：状态 + 主机名）+ 底栏提示。
# 配对行两行是 2026-10-07 修复"已配对没显示全"后的规格（app_ui_theme.h OV_SET_PAIR_H）。
SET_ROWS_Y = macro('OV_SET_ROWS_Y')
SET_ROW_PITCH = macro('OV_Q_ROW_H') + macro('OV_Q_ROW_GAP')
SET_PAIR_Y = SET_ROWS_Y + 4 * SET_ROW_PITCH
SET_TEXT_X = UI_PAD + 12
SET_TEXT_W = UI_W - UI_PAD * 2 - 20
SETTINGS = [
    El('设置·标题', F_CJK, UI_PAD, centered_y(macro('OV_TITLE_H'), LINE_H_CJK),
       UI_W - UI_PAD * 2, LINE_H_CJK, '系统设置', 1),
    El('设置·熄屏', F_CJK, SET_TEXT_X, SET_ROWS_Y, SET_TEXT_W, LINE_H_CJK, '熄屏：常亮', 1),
    El('设置·亮度', F_CJK, SET_TEXT_X, SET_ROWS_Y + SET_ROW_PITCH, SET_TEXT_W, LINE_H_CJK, '亮度：100%', 1),
    El('设置·休眠', F_CJK, SET_TEXT_X, SET_ROWS_Y + 2 * SET_ROW_PITCH, SET_TEXT_W, LINE_H_CJK, '自动休眠：不休眠', 1),
    El('设置·音量', F_CJK, SET_TEXT_X, SET_ROWS_Y + 3 * SET_ROW_PITCH, SET_TEXT_W, LINE_H_CJK, '提示音量：中', 1),
    El('配对·状态', F_CJK, SET_TEXT_X, SET_PAIR_Y, SET_TEXT_W, LINE_H_CJK, '配对：已配对', 1),
    El('配对·主机名', F_CJK, SET_TEXT_X, SET_PAIR_Y + PITCH, SET_TEXT_W, LINE_H_CJK, 'MacBook-Pro', 1, True),
    El('设置·底栏', F_CJK16, UI_PAD, APPROVAL_FOOT_Y,
       UI_W - UI_PAD * 2, macro('OV_FOOT_H'), '上/下选择 单击切换 长按退出', 1),
]

SCREENS = [
    ('主页', HOME),
    ('主页·等待授权态', HOME_WAITING),
    ('审批页', APPROVAL),
    ('余额页', BALANCE),
    ('系统设置页', SETTINGS),
    ('提示条（浮层）', TOAST),
]

# 字面之间的最小呼吸间隙（px）。行框 0 间隙时 20px 中文会糊成一坨，
# 这正是"文字挤在一起"的直接成因。
MIN_GAP = 3


def check_screen(name: str, elements: list[El]) -> bool:
    ok = True
    print(f'\n═══ {name} ═══')

    for e in elements:
        if e.x < 0 or e.y < 0 or e.x + e.w > UI_W or e.y + e.h > UI_H:
            print(f'  ✗ {e.name} 越界：x={e.x}..{e.x + e.w}, y={e.y}..{e.y + e.h}（安全区 {UI_W}×{UI_H}）')
            ok = False
        if not e.text:
            continue
        strict = not e.host
        tw = text_width(e.text, e.font, strict)
        if e.lines <= 1:
            if tw > e.w:
                print(f'  ✗ {e.name} 超宽：{tw:.0f}px / {e.w}px  "{e.text}"')
                ok = False
            else:
                print(f'  ✓ {e.name:<14} {tw:>5.0f}px / {e.w}px  "{e.text}"')
        else:
            # 多行：按真实字宽模拟折行，检查行数预算是否装得进 h
            need = wrap_lines(e.text, e.font, e.w, strict)
            budget = (e.h + LINE_SPACE) // PITCH
            if need > budget:
                print(f'  ✗ {e.name} 折行超出：{need} 行 / 预算 {budget} 行  "{e.text}"')
                ok = False
            else:
                print(f'  ✓ {e.name:<14} {need} 行 / 预算 {budget} 行（h={e.h}）  "{e.text}"')

    # 两两重叠 / 拥挤检查（同一屏内会同时出现的元素）
    for i in range(len(elements)):
        a = elements[i]
        for j in range(i + 1, len(elements)):
            b = elements[j]
            if not (a.x < b.x + b.w and b.x < a.x + a.w):
                continue
            same_slot = a.name.split('·')[0] == b.name.split('·')[0] and a.y == b.y
            if same_slot:
                continue    # 同一位置的文案变体（如底栏提示的不同状态）
            gap_v = max(a.y - (b.y + b.h), b.y - (a.y + a.h))
            if gap_v < 0:
                print(f'  ✗ 重叠：{a.name} 与 {b.name}（纵向相交 {-gap_v}px）')
                ok = False
            elif gap_v < MIN_GAP:
                print(f'  ✗ 拥挤：{a.name} 与 {b.name} 仅隔 {gap_v}px（要求 ≥{MIN_GAP}px）')
                ok = False
    return ok


def main() -> int:
    print(f'屏幕安全区 {UI_W}×{UI_H}（常量直接解析自 app_ui_theme.h）')
    print(f'字体行高：CJK {F_CJK.line_h}px / XL {F_XL.line_h}px，多行行距 {LINE_SPACE}px')

    print('\n═══ 纵向预算（主页）═══')
    for label, y, h in (
        ('状态条', macro('UI_STATUSBAR_Y'), macro('UI_STATUSBAR_H')),
        ('状态主体', macro('UI_BODY_Y'), macro('UI_BODY_H')),
        ('底栏', macro('UI_FOOTER_Y'), macro('UI_FOOTER_H')),
    ):
        print(f'  {label:<6} y={y:>3} .. {y + h:>3}  高 {h:>3}px')

    ok = True
    for name, elements in SCREENS:
        ok = check_screen(name, elements) and ok

    print('\n结论:', '✓ 版面规格可用' if ok else '✗ 需要调整规格')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
