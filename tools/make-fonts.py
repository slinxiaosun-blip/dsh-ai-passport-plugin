#!/usr/bin/env python3
"""生成固件界面用的字体（点阵 ASCII + 中文子集 + 回退链）。

为什么需要它
============
界面要中文，但**中文字形踩过两次坑**，两次都只得到"满屏方框"：

  1. 用 LVGL 内置的 `lv_font_source_han_sans_sc_16_cjk` —— 它的字符集是 LVGL
     示例里随手挑的一批字（"（），盗提陽帯鼻画…"），**不是按应用文案选的**。
     实测本界面渲染的 48 个中文字里它缺 23 个。
  2. 自制子集（144 字形）—— 重新烧录后仍然是方框，原因当时没查出来，
     产物后来又被覆盖，无法复盘。

所以这一版的做法变了：**不再依赖"我觉得应该对"，而是让脚本自己核对**。
脚本会解析生成出来的 C 文件，取出真实的字形码点表，再与界面用到的字符求差集，
缺一个就报错退出。配合 `make-font-subset.py --check` 进静态门禁，
"文案改了但字体没重新生成"会在提交前失败，而不是等到真机上看见方框。

字体结构
========
    bitfont_8 / bitfont_16   ← 点阵 ASCII（Press Start 2P, 1bpp），负责"极客 bit"观感
    app_ui_font_cjk          ← 中文子集（思源黑体, 1bpp），负责中文
    bitfont_16.fallback = &app_ui_font_cjk

ASCII 走点阵字体，其余字符由 LVGL 自动回退到中文字体。
`fallback` 是 LVGL 9 的正式机制，因此**控件上只需指定一个字体**，
不用在业务代码里判断字符属于哪种。

`lv_font_conv` 没有 `--fallback` 选项，所以回退字段由本脚本在生成后补写。

用法：
    python3 tools/make-fonts.py            # 生成 + 校验
    python3 tools/make-fonts.py --check    # 只校验（进静态门禁）
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
MAIN = os.path.join(FIRMWARE, 'main')
OUT_DIR = os.path.join(MAIN, 'fonts')

BIT_FONT = os.path.join(REPO, 'assets', 'fonts', 'PressStart2P-Regular.ttf')
CJK_FONT = os.path.join(REPO, 'assets', 'fonts', 'SourceHanSansSC-Normal.otf')

BIT8_C = os.path.join(OUT_DIR, 'bitfont_8.c')
BIT16_C = os.path.join(OUT_DIR, 'bitfont_16.c')
CJK_C = os.path.join(OUT_DIR, 'app_ui_font_cjk.c')
# 16px 中文：**专供提示行**（底栏 / 按键说明）。20px 一行只放得下约 10 个汉字，
# 提示类文案经常塞不下；16px 每行约 13 个汉字，代价约 (16/20)^2 个字库体积（实测 ~30KB）。
CJK16_C = os.path.join(OUT_DIR, 'app_ui_font_cjk16.c')
CJK8_C = os.path.join(OUT_DIR, 'app_ui_font_cjk_8.c')
XL_C = os.path.join(OUT_DIR, 'app_ui_font_xl.c')

BIT8_NAME = 'app_ui_font_8'
BIT16_NAME = 'app_ui_font_16'
CJK_NAME = 'app_ui_font_cjk'
CJK16_NAME = 'app_ui_font_cjk16'
CJK8_NAME = 'app_ui_font_cjk_8'
XL_NAME = 'app_ui_font_xl'

# 渲染文本的 API。★ 新增渲染路径时必须把函数名加到这里，
# 否则新文案的字不会被收进子集 —— 结果就是又出现方框。
TEXT_CALLS = (
    r'ui_theme_text\s*\(',
    r'ui_pixel_label\s*\(',
    r'ui_pixel_screen_create\s*\(',
    r'lv_label_set_text\s*\(',
    r'lv_label_set_text_fmt\s*\(',
    r'lv_label_set_text_static\s*\(',
    r'make_overlay\s*\(',
    r'app_ui_post_toast\s*\(',
)

# 固定纳入的标点与符号（文案里可能出现，但可能只在拼接处或由主机传来）。
# ★ 交叉验证清单：硬编码"一定会出现在屏幕上"的文案。
#
# 为什么需要它：字形提取逻辑本身出过两次错（先按调用名匹配漏光，后按括号配对又漏掉
# `return` 与格式化串），而**校验脚本用的是同一个提取结果** —— 校验与被校验对象
# 共享同一个 bug，于是报告"覆盖全部字符 ✓"，真机上却是满屏方块。
# 这份清单独立于提取逻辑，因此能抓住提取本身的错误。
#
# 只收**上屏文案**，不收日志文案。新增界面文案时应当同步补进这里。
# ── 状态大字专用字符集 ────────────────────────────────────────────────────
#
# 40px 档**只用于状态大字**。若不限制字符集，它会跟着收到全部 425 个界面用字，
# 体积 748KB（= 整套界面字体的 3 倍），而其中 99% 的字永远不会以 40px 显示。
# 只收真正会出现在状态位的字符，体积降到几十 KB。
#
# ★ 这里必须与 app_ui.c 的 state_style() 文案保持一致。
#   改状态文案时**必须同步这里**，否则新字在 40px 档缺失 ——
#   表现为状态大字变成方块，而其它文案正常（很难联想到是这里的问题）。
XL_STRINGS = ('空闲', '运行中', '待审批', '已完成')

SCREEN_STRINGS = (
    # ── 精简版主界面：只有四个状态词 + 链路状态 ──
    '空闲', '运行中', '待审批', '已完成',
    '没有正在执行的任务', '任务正在执行', '按确定键处理', '任务刚刚结束',
    'AI 通行证', '蓝牙未连接', '等待蓝牙连接',
    '等待授权请求', '长按下键看余额', '长按确定断开',

    # ── 审批覆盖层（两选项）──
    '等待审批', '允许一次', '拒绝',
    '自动休眠', '不休眠', '亮度', '中高', '长按上键设置 下键看余额',
    '上/下选择  确定执行', '已提交，等待结果',
    '%u 秒后自动拒绝', '已超时，按拒绝处理', '发送失败，请重试',
    '确定键返回',

    # ── 余额覆盖层 ──
    'DeepSeek 余额', '充值  %s', '赠送  %s', '今日已用  %s', '暂无明细',

    # ── 语音识别结果卡（docs/06 §2）──
    '识别结果', '单击填入 双击发送 按住重说', '（没有识别到内容）',

    # ── 追问 / 计划评审 / 全文阅读（docs/06 §3/§4）──
    '问题', '计划待审', '计划', '要求修改', '同意执行',
    '其他：',
    '下一题', '跳过此题', '已提交', '已同意执行', '请在电脑输入修改意见',
    '电脑上有待审批请求', '电脑上有待回答的问题', '语音输入', '按住确定说话', '正在录音…',
    '识别中…', '松手结束', '上键清除 长按放弃', '已清除输入内容', '已放弃语音输入', '已录入，可继续选择',
    '单击上键 删除/返回', '单击确认 填入', '长按确认 发送',
    '语音输入已丢弃（问题已结束）', '单击勾选 长按提交', '上/下选择 确定执行', '上/下选择  确定执行',
    '已取消，请到电脑上继续', '已超时，请到电脑上继续', '问题已结束',
    '补充答案已录入', '补充答案已丢弃（问题已结束）', '按住确定说补充', '上/下翻页 确定返回',

    # ── 提示条（app.c 触发）──
    '连接已断开', '语音识别失败',
)

EXTRA_CJK = '　、。！？；：（）【】「」『』《》〈〉—…·•×÷±→←↑↓⇄★☆●○■□▲▼'
EXTRA_CJK += '０１２３４５６７８９％'

# ★ GB2312 一级常用汉字（3755 字）：运行期动态文本的兜底覆盖面。
#
# 为什么需要它：字体子集原本只收**源码字面量**里的字符（约 350 个汉字），
# 那些是界面静态文案，覆盖率 100%。但设备上真正显示的**识别结果**（voice.result
# 的 text）、**任务标题**（task.state 的 title）、**主机错误信息**（voice.error 的
# message）都是运行期动态字符串，字符集是"全部常用汉字"，远超 350 个。
# 任何落在这 350 字之外的汉字，LVGL 找不到字形就渲染成方块（tofu）——
# 这正是"显示的文字不全，有一些方块"的根因。
#
# 修法：把 GB2312 一级汉字（覆盖 99% 日常用字）无条件纳入子集。
# 代价：字体体积从 ~250KB 涨到 ~2.1MB（20px/2bpp），但 factory 分区有 7.9MB，
# 当前固件 1.15MB，加 2MB 字体后仍有 4.5MB+ 余量，完全放得下。
#
# 权衡（与 collect_rendered_chars 的注释同源）：**多收字形只是多占 flash，
# 漏收一个字就是屏幕上出现方块**。因此宁可全收常用字集。
def gb2312_level1_chars() -> set[str]:
    """GB2312 一级汉字（0xB0A1-0xD7F9），3755 个常用字。"""
    chars: set[str] = set()
    for high in range(0xB0, 0xD8):
        for low in range(0xA1, 0xFF):
            try:
                chars.add(bytes([high, low]).decode('gb2312'))
            except UnicodeDecodeError:
                continue
    return chars


COMMON_CJK = gb2312_level1_chars()


def strip_comments(src: str) -> str:
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'//[^\n]*', '', src)


def _call_args(src: str, start: int) -> str:
    """从 `name(` 的 `(` 位置起，按括号配对取出整个实参列表。"""
    depth = 0
    i = start
    while i < len(src):
        if src[i] == '(':
            depth += 1
        elif src[i] == ')':
            depth -= 1
            if depth == 0:
                return src[start + 1:i]
        i += 1
    return ''


def collect_rendered_chars() -> tuple[set[str], set[str]]:
    """返回 (ASCII 字符集, 非 ASCII 字符集)。

    做法：**收集全部字符串字面量**（已去注释），不区分它出现在哪个 API 里。

    ── 为什么不再"按调用名筛选" ──
    这里连续踩了两次坑，代价都是"真机上满屏方块"：

    坑 1：最初写成「调用名后面紧跟引号」的正则，即认为引号紧跟在左括号之后。
          但真实调用是 `ui_theme_text(bar, "AI 通行证", ...)` —— **第一个参数是父对象**，
          引号并不紧跟左括号。于是 app_ui.c 一个字符都没匹配到，收集到的
          "非 ASCII 字符"全部来自 EXTRA_CJK 标点常量（86 个，全是标点）。
          更糟的是**校验脚本用的也是同一个集合**，于是它报告"覆盖全部字符 ✓"
          —— 校验与被校验对象共享同一个 bug，等于没校验。

    坑 2：改成"括号配对取实参"后，直接的渲染调用能收到了，但漏掉
          `return "链路已就绪";` 这类**在函数里返回**的文案，
          以及 `snprintf(buf, ..., "信号%d 包长%d 协议%d", ...)` 这类格式化串。
          结果 `链路`、`信号`、`协议` 仍然缺字。

    结论：任何"按上下文筛选"的方案都会持续漏字，而漏字的后果只有真机能发现。
    因此改为**全量收集字符串字面量** —— 多收几个未使用的字，代价是字体大几 KB；
    漏收一个字，代价是屏幕上出现方块。这个取舍非常明确。

    仍然排除注释：注释里是中文散文（实测 800+ 个不同的字），收进来会让体积暴涨，
    而它们永远不会被渲染。
    """
    ascii_chars = {chr(c) for c in range(0x20, 0x7F)}
    other: set[str] = set(EXTRA_CJK)
    other |= {c for s_ in SCREEN_STRINGS for c in s_}
    # ★ 无条件纳入 GB2312 一级汉字：运行期动态文本（识别结果/任务标题/错误信息）
    #   的字符集远超源码字面量，不收就会显示成方块。见 COMMON_CJK 定义处的说明。
    other |= COMMON_CJK

    files = sorted(glob.glob(os.path.join(MAIN, 'app*.c')))
    for path in files:
        src = strip_comments(open(path, encoding='utf8').read())
        # 这里**刻意不再排除日志文案**。
        #
        # 试过排除（本项目的日志是中文写的，全量收会让字体从 ~120KB 涨到 ~230KB），
        # 做法是按括号配对取 ESP_LOG 的实参再整段删掉。结果它**误伤**了
        #     lv_label_set_text(x, cond ? "再按一次确定：允许" : "再按一次确定：拒绝")
        # 里嵌在实参中的字符串 —— "再" 因此没进字体，那个提示框会显示方块。
        # 这类误伤只有靠"独立硬编码的文案清单"交叉验证才能发现，代价太高。
        #
        # 权衡很清楚：**多收字形只是多占几十 KB flash（8MB 分区随便放），
        # 漏收一个字就是屏幕上出现方块**。因此宁可全收。
        for lit in re.finditer(r'"((?:[^"\\]|\\.)*)"', src):
            for ch in lit.group(1):
                if ch in ('\\', '"') or ord(ch) < 0x20:
                    continue
                if ord(ch) < 0x7F:
                    ascii_chars.add(ch)
                else:
                    other.add(ch)
    return ascii_chars, other


def font_coverage(path: str) -> set[str]:
    """解析生成出来的字体 C 文件，取出**真实**覆盖的字符。

    这是本脚本的核心：不看"我传了哪些参数"，而是读产物。
    lv_font_conv 把每个字形写成 `/* U+4EFB "任" */` 这样的注释，
    直接解析它就能得到权威答案。
    """
    if not os.path.exists(path):
        return set()
    txt = open(path, encoding='utf8', errors='replace').read()
    covered: set[str] = set()
    # 形如：  /* U+4EFB "任" */   或   /* U+0020 " " */
    for m in re.finditer(r'/\*\s*U\+([0-9A-Fa-f]{4,6})\s*(?:"(.*?)")?\s*\*/', txt):
        code = int(m.group(1), 16)
        covered.add(chr(code))
    return covered


def font_line_height(path: str) -> int:
    m = re.search(r'\.line_height\s*=\s*(\d+)', open(path, encoding='utf8', errors='replace').read())
    return int(m.group(1)) if m else 0


def max_glyph_box(path: str) -> tuple[int, int]:
    """返回字体里最大的 (宽, 高) 字形尺寸。"""
    txt = open(path, encoding='utf8', errors='replace').read()
    m = re.search(r'glyph_dsc\[\] = \{(.*?)\n\};', txt, re.S)
    if not m:
        return (0, 0)
    widest = tallest = 0
    for e in re.findall(r'\{[^}]*\}', m.group(1)):
        w = re.search(r'\.box_w\s*=\s*(\d+)', e)
        h = re.search(r'\.box_h\s*=\s*(\d+)', e)
        if w:
            widest = max(widest, int(w.group(1)))
        if h:
            tallest = max(tallest, int(h.group(1)))
    return (widest, tallest)


def visible(chars: set[str]) -> set[str]:
    """可生成字形的字符：排除控制字符，以及引号与反斜杠。

    引号和反斜杠在 C 源码里要转义，lv_font_conv 的 --symbols 也收不了干净，
    而且它们并非界面上的可见字形。build_symbol_string 里已排除，
    校验用的集合必须同步这条规则，否则会报假缺失（实测报过 `"` 和 `\\`）。
    """
    return {c for c in chars if ord(c) >= 0x20 and c not in '"\\'}


def check_glyphs_fit(path: str, label: str) -> bool:
    """★ 字形高度不能超过字体行高。

    这条规则来自一次真实故障：中文标签最初放在 8px 点阵字体里，
    而中文字形约 12x13 —— LVGL 按行高裁剪，超出部分被切掉，
    屏幕上剩下的就是一个个方块。字体本身完全正常（字形、cmap 都对），
    错的是"用多大的字体去装它"。而这类错误**在真机上才看得见**，
    所以在构建期就卡住。
    """
    lh = font_line_height(path)
    w, h = max_glyph_box(path)
    if lh and h > lh:
        print(f'✗ {label}：最大字形高 {h}px > 行高 {lh}px —— 会被裁剪成方块')
        return False
    print(f'✓ {label}：字形 {w}x{h} 可容纳于行高 {lh}px')
    return True


def read_fallback(path: str) -> str | None:
    m = re.search(r'\.fallback\s*=\s*&(\w+)', open(path, encoding='utf8', errors='replace').read())
    return m.group(1) if m else None


def check_no_fallback_cycle(graph: dict[str, str | None]) -> bool:
    """★ 回退链必须是有向无环图。

    这条检查来自一次真实故障：中文字体与点阵字体**互相**回退，形成环。
    LVGL 的 lv_font_get_glyph_dsc 实现是 `while(f) { ...; f = f->fallback; }`，
    遇到环就永久循环，渲染任务再也回不来 —— 实测触发看门狗复位，
    现象是"界面卡住 + taskLVGL 不喂狗"。这类问题从字体数据上完全看不出来，
    只有静态查环才能提前拦住。
    """
    ok = True
    for start in graph:
        seen: list[str] = []
        node: str | None = start
        while node is not None:
            if node in seen:
                cycle = ' → '.join(seen + [node])
                print(f'✗ 字体回退成环：{cycle}（LVGL 会永久循环并卡死渲染）')
                ok = False
                break
            seen.append(node)
            node = graph.get(node)
    if ok:
        print('✓ 字体回退链无环')
    return ok


def build_symbol_string(chars: set[str]) -> str:
    """把字符集拼成 --symbols 参数。

    注意要排除控制字符、引号与反斜杠（它们在 C 源码里需要转义，
    且本来也不是可见字形）。
    """
    safe = sorted(visible(chars))
    return ''.join(safe)


def run_conv(conv: str, args: list[str]) -> None:
    proc = subprocess.run([conv, *args], capture_output=True, text=True, cwd=REPO)
    if proc.returncode != 0:
        sys.stderr.write('✗ lv_font_conv 失败：\n')
        sys.stderr.write(proc.stdout[-2000:] + '\n')
        sys.stderr.write(proc.stderr[-2000:] + '\n')
        raise SystemExit(proc.returncode)


def rename_symbol(path: str, want: str) -> str:
    """把 lv_font_conv 按文件名推导出的符号名改成统一名字。"""
    txt = open(path, encoding='utf8').read()
    m = re.search(r'lv_font_t\s+(&?)(\w+)\s*\(void\)', txt) or re.search(r'const lv_font_t\s+(\w+)\s*=', txt)
    if not m:
        derived = os.path.basename(path).replace('.c', '')
    else:
        derived = m.groups()[-1]
    if derived != want:
        txt = re.sub(rf'\b{re.escape(derived)}\b', want, txt)
        open(path, 'w', encoding='utf8').write(txt)
    return derived


def inject_fallback(path: str, symbol: str, fallback_symbol: str) -> bool:
    """给生成的字体结构体补上 .fallback 字段。

    lv_font_conv 没有 --fallback 选项，但 lv_font_t 有该字段（LVGL 9 的正式机制）。
    在这里补写，控件上就只需指定一个字体，非 ASCII 字符由 LVGL 自动回退。

    两个字体互相引用（16px 点阵 → 中文 → 8px 点阵），因此必须同时补上
    **被引用方的 extern 声明** —— lv_font_conv 每个文件只声明自己，
    不自带声明会得到 "'app_ui_font_cjk' undeclared" 这类编译错误。
    """
    txt = open(path, encoding='utf8').read()

    # 先把缺失的 extern 声明补上（插在 lvgl.h 之后）
    decl = f'extern const lv_font_t {fallback_symbol};'
    if decl not in txt:
        # lv_font_conv 的头部是这样的：
        #     #ifdef LV_LVGL_H_INCLUDE_SIMPLE
        #         #include "lvgl.h"
        #     #else
        #         #include "../../lvgl.h"
        #     #endif
        # 必须插在 **#endif 之后**。插进 #ifdef 分支里会只在
        # LV_LVGL_H_INCLUDE_SIMPLE 定义时才生效 —— 本项目没定义它，
        # 于是声明被跳过，报 "'app_ui_font_cjk' undeclared"。
        m_inc = re.search(r'#endif\s*\n(?=\s*\n?#ifndef)', txt)
        if m_inc:
            txt = (txt[:m_inc.end()]
                   + f'/* 由 tools/make-fonts.py 注入：回退目标 */\n{decl}\n\n'
                   + txt[m_inc.end():])
        else:
            txt = f'#include "lvgl.h"\n\n{decl}\n' + txt

    if '.fallback' in txt:
        open(path, 'w', encoding='utf8').write(txt)
        return True

    # 结构体以 `    .dsc = &font_dsc` 结尾（dsc 是最后一个字段）
    pattern = re.compile(r'(const lv_font_t\s+' + re.escape(symbol) + r'\s*=\s*\{.*?)(\n\};)', re.S)
    m = pattern.search(txt)
    if not m:
        return False
    body, tail = m.group(1), m.group(2)
    # 在 .dsc 那行后面插入 .fallback（保留 C99 指定初始化器的风格）
    if not body.rstrip().endswith(','):
        body = body.rstrip() + ','
    new = f'{body}\n    .fallback = &{fallback_symbol},{tail}'
    txt = txt[:m.start()] + new + txt[m.end():]
    open(path, 'w', encoding='utf8').write(txt)
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='只校验，不生成')
    ap.add_argument('--lv-font-conv', default=None)
    args = ap.parse_args()

    ascii_chars, cjk_chars = collect_rendered_chars()
    print(f'界面需要：ASCII {len(ascii_chars)} 个，非 ASCII {len(cjk_chars)} 个')

    # ★ 兜底断言：界面明明有大量中文，如果只收到寥寥几个，说明提取逻辑坏了。
    #   这条断言正是为了拦住上面那个坑 —— 当时"只收到 86 个（全是标点）"却一路通过。
    han = {c for c in cjk_chars if '\u4e00' <= c <= '\u9fff'}
    if len(han) < 40:
        print(f'✗ 只提取到 {len(han)} 个汉字，明显偏少 —— 字符提取逻辑可能又坏了。', file=sys.stderr)
        return 1
    print(f'  其中汉字 {len(han)} 个')

    if args.check:
        ok = True
        for path, want in ((BIT8_C, ascii_chars), (BIT16_C, ascii_chars),
                           (CJK_C, cjk_chars | ascii_chars), (CJK16_C, cjk_chars | ascii_chars)):
            covered = font_coverage(path)
            if not covered:
                print(f'✗ {os.path.basename(path)} 不存在或没有字形表 —— 请先运行 python3 tools/make-fonts.py')
                ok = False
                continue
            missing = sorted(c for c in visible(want) if c not in covered)
            if missing:
                print(f'✗ {os.path.basename(path)} 缺 {len(missing)} 个字符：{"".join(missing)}')
                ok = False
            else:
                print(f'✓ {os.path.basename(path)} 覆盖全部 {len(want)} 个字符')
        if ok:
            for path, label in ((BIT8_C, 'bitfont_8'), (BIT16_C, 'bitfont_16'),
                            (CJK_C, '中文字体20'), (CJK16_C, '中文提示16'), (XL_C, '状态大字40')):
                if not check_glyphs_fit(path, label):
                    ok = False
        # 状态大字必须覆盖 state_style() 里的四个状态词
        xl_cov = font_coverage(XL_C)
        xl_missing = [c for t in XL_STRINGS for c in t if c not in xl_cov]
        if xl_missing:
            print(f'✗ 状态大字（40px）缺字：{"".join(sorted(set(xl_missing)))}')
            print('  多半是改了 app_ui.c 的状态文案却没同步 XL_STRINGS')
            ok = False
        else:
            print(f'✓ 状态大字（40px）覆盖 {len(XL_STRINGS)} 个状态词')

        # 交叉验证：用硬编码清单核对，独立于提取逻辑
        cjk_cov = font_coverage(CJK_C)
        bad = []
        for text in SCREEN_STRINGS:
            miss = [c for c in text if not c.isascii() and c not in cjk_cov]
            if miss:
                bad.append((text, ''.join(miss)))
        if bad:
            for text, miss in bad:
                print(f'✗ 界面文案缺字：{text!r} → 缺 {miss}')
            ok = False
        else:
            print(f'✓ 交叉验证：{len(SCREEN_STRINGS)} 条界面文案全部覆盖（不依赖提取逻辑）')

        # 中文字体必须自带 ASCII：它们的回退是空的，混排文本全靠自己
        for path, label, want in ((CJK_C, '中文字体20', ascii_chars), (CJK16_C, '中文提示16', ascii_chars)):
            covered = font_coverage(path)
            missing = sorted(c for c in visible(want) if c not in covered)
            if missing:
                print(f'✗ {label} 缺 ASCII 字形 {len(missing)} 个：{"".join(missing)}')
                ok = False
            else:
                print(f'✓ {label} 自带全部 ASCII 字形（混排无需回退）')

        # ★ 回退链必须无环。LVGL 追回退是 while 循环，有环就会永久卡死渲染任务。
        if ok:
            ok = check_no_fallback_cycle({
                BIT8_NAME: None, BIT16_NAME: CJK_NAME, CJK_NAME: None,
            })
        return 0 if ok else 1

    for label, path in (('点阵 ASCII 字体', BIT_FONT), ('中文字体（思源黑体）', CJK_FONT)):
        if not os.path.exists(path):
            print(f'✗ 找不到{label}：{path}', file=sys.stderr)
            return 1

    conv = args.lv_font_conv or shutil.which('lv_font_conv') or '/tmp/node_modules/.bin/lv_font_conv'
    if not os.path.exists(conv):
        print(f'✗ 找不到 lv_font_conv：{conv}', file=sys.stderr)
        print('  安装：npm install --no-save lv_font_conv@1.5.2', file=sys.stderr)
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    ascii_syms = build_symbol_string(ascii_chars)
    # ★ 中文字体**连 ASCII 一起收**，做成自足的字体。
    #
    # 这是为了避免回退环。踩过的坑：最初让"中文字体 --fallback--> 点阵字体"，
    # 而"点阵字体 --fallback--> 中文字体"，两个方向都有边 —— 那是个环。
    # LVGL 的 lv_font_get_glyph_dsc 是 `while(f) f = f->fallback;`，
    # 遇到环就**永久循环**，直接卡死渲染任务（实测触发看门狗复位，
    # 现象是"界面卡住 + taskLVGL 不喂狗"）。
    # 让中文字体自带 ASCII 后，它不需要回退，回退链就只有一层、必然无环。
    cjk_syms = build_symbol_string(cjk_chars | ascii_chars)

    common = ['--bpp', '1', '--size', '16', '--format', 'lvgl', '--no-compress', '--lv-include', 'lvgl.h']

    # ★ 字号选择（真机实测后的结论）：
    #   屏是 240x320，安全区 220x300。16px 中文每行 13 字、笔画仅 1px 宽，
    #   用户反馈"字太小"。20px 每行 11 字，是本屏可读性的下限，故采用 20px。
    #
    # ★ 位深用 2bpp 而不是 1bpp：20px 的汉字在 1bpp 下笔画只有 1-2px，
    #   而汉字横画密集，纯黑白会产生"糊在一起"或"笔画断裂"。
    #   2bpp 有 4 级灰阶，对笔画的连续性改善最明显，代价是体积约 2 倍（仍只有几十 KB）。
    #   ASCII 仍用 1bpp 点阵字体，保留"极客 bit"的硬朗观感。
    print('生成中文字体子集（20px, 2bpp 抗锯齿）…')
    run_conv(conv, ['--bpp', '2', '--size', '20', '--font', CJK_FONT,
                    '--symbols', cjk_syms, '--format', 'lvgl', '--no-compress',
                    '--lv-include', 'lvgl.h', '-o', CJK_C])
    rename_symbol(CJK_C, CJK_NAME)

    # ★ 16px 中文：**提示行专用**。与 20px 同字符集（含 ASCII），同样不需要回退，
    #   回退链仍只有一层、必然无环。只用在"提示/按键说明"这类次要文字上，
    #   正文与标题继续用 20px 保证可读性。
    print('生成中文提示字体（16px, 2bpp）…')
    run_conv(conv, ['--bpp', '2', '--size', '16', '--font', CJK_FONT,
                    '--symbols', cjk_syms, '--format', 'lvgl', '--no-compress',
                    '--lv-include', 'lvgl.h', '-o', CJK16_C])
    rename_symbol(CJK16_C, CJK16_NAME)

    # ★ 超大字号 40px：用于"状态大字"。
    #   设备可能被放在桌角，用户需要隔一两米扫一眼就知道要不要走过去，
    #   20px 的中文在这个距离认不出来。40px 的 1bpp 汉字笔画会糊在一起，
    #   因此这一档用 2bpp（与 20px 中文一致的做法）。
    print('生成超大字号（40px, 2bpp）…')
    xl_syms = build_symbol_string({c for t in XL_STRINGS for c in t})
    run_conv(conv, ['--bpp', '2', '--size', '40', '--font', CJK_FONT,
                    '--symbols', xl_syms, '--format', 'lvgl', '--no-compress',
                    '--lv-include', 'lvgl.h', '-o', XL_C])
    rename_symbol(XL_C, XL_NAME)

    print('生成点阵 ASCII 字体（8px / 16px）…')
    run_conv(conv, ['--bpp', '1', '--size', '16', '--font', BIT_FONT, '-r', '0x20-0x7E',
                    '--format', 'lvgl', '--no-compress', '--lv-include', 'lvgl.h', '-o', BIT16_C])
    rename_symbol(BIT16_C, BIT16_NAME)

    run_conv(conv, ['--bpp', '1', '--size', '8', '--font', BIT_FONT, '-r', '0x20-0x7E',
                    '--format', 'lvgl', '--no-compress', '--lv-include', 'lvgl.h', '-o', BIT8_C])
    rename_symbol(BIT8_C, BIT8_NAME)

    # 回退链（**刻意不成环**）：
    #   点阵 16px --fallback--> 中文     （ASCII 走点阵，其余走中文）
    #   中文     --fallback--> 点阵 8px  （数字、%、/ 等半角符号也走点阵，保持观感）
    # 两条边方向相反，因此不会互相递归。LVGL 的字体回退本身带层级上限，
    # 但把环排除掉更稳妥 —— 一个字体查找死循环会直接卡死渲染线程。
    if not inject_fallback(BIT16_C, BIT16_NAME, CJK_NAME):
        print('✗ 无法给 bitfont_16 注入 .fallback —— 中文不会显示', file=sys.stderr)
        return 1
    print(f'已设置 {BIT16_NAME}.fallback = &{CJK_NAME}')

    # 8px 点阵字体**不再**用于中文（太小，用户已反馈），因此不需要中文回退。
    # 保留它给纯 ASCII 的小号位置（如电量百分比）。
    print(f'{BIT8_NAME} 仅用于纯 ASCII，不设中文回退')


    # ── 自校验：读产物、核对字形覆盖 ──
    ok = True
    for path, label in ((BIT8_C, 'bitfont_8'), (BIT16_C, 'bitfont_16'),
                            (CJK_C, '中文字体20'), (CJK16_C, '中文提示16'), (XL_C, '状态大字40')):
        if not check_glyphs_fit(path, label):
            ok = False

    for path, want, label in ((BIT8_C, ascii_chars, 'bitfont_8'), (BIT16_C, ascii_chars, 'bitfont_16'),
                              (CJK_C, cjk_chars | ascii_chars, '中文字体20'),
                              (CJK16_C, cjk_chars | ascii_chars, '中文提示16'),
                              (XL_C, {c for t in XL_STRINGS for c in t}, '状态大字40')):
        covered = font_coverage(path)
        missing = sorted(c for c in visible(want) if c not in covered)
        size = os.path.getsize(path)
        if missing:
            print(f'✗ {label}：缺 {len(missing)} 个字符 → {"".join(missing)}')
            ok = False
        else:
            print(f'✓ {label}：覆盖全部 {len(want)} 个字符（{size} 字节）')
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
