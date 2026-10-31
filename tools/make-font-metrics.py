#!/usr/bin/env python3
"""从 lv_font_conv 生成的 C 字库里导出排版用的度量表。

浏览器端要预先把 md 折好行，折行宽度必须和真机完全一致，否则会出现
「浏览器算得下、设备画出去」的溢出。所以这里严格复刻 LVGL 的算法：

  1. cmap 查找（lv_font_fmt_txt.c: get_glyph_dsc_id）
     · FORMAT0_TINY : gid = glyph_id_start + (cp - range_start)
     · SPARSE_TINY  : unicode_list 里存的是 **相对码点** rcp = cp - range_start，
                      gid = glyph_id_start + 该值在 unicode_list 中的下标
     · *_FULL 类同理，多一层 glyph_id_ofs_list 偏移

  2. 字距（get_kern_value，按 class 压缩）
     value = class_pair_values[(lc-1) * right_class_cnt + (rc-1)]
     lc/rc 为 0 表示该字不参与字距

  3. 推进宽度（lv_font_get_glyph_dsc_fmt_txt）
     kv    = (kvalue * kern_scale) >> 4
     adv_w = gdsc.adv_w + kv
     adv_w = (adv_w + 8) >> 4        ← 注意：**逐字取整到整像素**

输出 JSON（紧凑数组，省体积）：
  {
    "size": 14, "bpp": 4, "line_height": 17, "base_line": 4,
    "kern": {"ln": 45, "rn": 38, "lc": [...], "rc": [...], "v": [...]} | null,
    "glyphs": { "<cp>": [gid, adv_w, box_w, box_h, ofs_x, ofs_y] }
  }

adv_w 是 1/16 px 的原始值；浏览器按上面第 3 步自己算整像素推进即可。
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIRMWARE = os.path.join(ROOT, "vendor", "ai-passport")
FONT_DIR = os.path.join(FIRMWARE, "main", "fonts")
OUT_DIR = os.path.join(ROOT, "tools", "npack", "metrics")

# (字库文件, 输出文件)
FONTS = [
    ("app_ui_font_note14.c", "metrics14.json"),   # 正文 14px / 4bpp
    ("app_ui_font_note20.c", "metrics20.json"),   # 标题 20px / 2bpp（全量）
    ("bitfont_8.c", "metrics8.json"),             # 代码块 8px / 1bpp 等宽
]

GLYPH_RE = re.compile(
    r"\{\.bitmap_index = \d+, \.adv_w = (-?\d+), \.box_w = (\d+), "
    r"\.box_h = (\d+), \.ofs_x = (-?\d+), \.ofs_y = (-?\d+)\}"
)


def _slice_array(src: str, name: str) -> str:
    """取 `name[] = { ... };` 的花括号内内容（允许 `= {` 换行）。"""
    m = re.search(re.escape(name) + r"\s*\[\s*\]\s*=\s*\{", src)
    if not m:
        sys.exit(f"找不到数组 {name}")
    body = src[m.end():]
    return body[: body.index("};")]


def parse_glyphs(src: str):
    """返回 [(adv_w, box_w, box_h, ofs_x, ofs_y), ...]，下标即 glyph id。"""
    body = _slice_array(src, "glyph_dsc")
    out = []
    for m in GLYPH_RE.finditer(body):
        adv, bw, bh, ox, oy = (int(g) for g in m.groups())
        out.append((adv, bw, bh, ox, oy))
    return out


def parse_cmaps(src: str):
    body = _slice_array(src, "cmaps")
    maps = []
    for b in re.findall(r"\{([^{}]+)\}", body, re.S):
        if "range_start" not in b:
            continue
        maps.append(
            {
                "start": int(re.search(r"\.range_start = (\d+)", b).group(1)),
                "len": int(re.search(r"\.range_length = (\d+)", b).group(1)),
                "gid0": int(re.search(r"\.glyph_id_start = (\d+)", b).group(1)),
                "ul": re.search(r"\.unicode_list = (\w+|NULL)", b).group(1),
                "ofs": re.search(r"\.glyph_id_ofs_list = (\w+|NULL)", b).group(1),
                "n": int(re.search(r"\.list_length = (\d+)", b).group(1)),
                "type": re.search(r"\.type = LV_FONT_FMT_TXT_CMAP_(\w+)", b).group(1),
            }
        )
    return maps


def parse_u16_list(src: str, name: str):
    body = _slice_array(src, name)
    return [int(x, 16) for x in re.findall(r"0x([0-9A-Fa-f]+)", body)]


def parse_u8_list(src: str, name: str):
    body = _slice_array(src, name)
    return [int(x) for x in re.findall(r"\b(\d+)\b", body)]


def parse_i8_list(src: str, name: str):
    body = _slice_array(src, name)
    return [int(x) for x in re.findall(r"(-?\d+)", body)]


def build_cmap_table(src: str, cmaps):
    """返回 {码点: glyph id}。

    *_FULL 类型里 `glyph_id_ofs_list` 的 0 表示**该码点没有字形**
    （LVGL 的判定：ofs==0 且不是 range_start 的首字 → 跳过）。
    """
    table = {}
    for c in cmaps:
        typ, start, gid0 = c["type"], c["start"], c["gid0"]
        if typ == "FORMAT0_TINY":
            for i in range(c["len"]):
                table[start + i] = gid0 + i
        elif typ == "SPARSE_TINY":
            ul = parse_u16_list(src, c["ul"])
            if len(ul) != c["n"]:
                sys.exit(f"  ! {c['ul']} 长度 {len(ul)} != list_length {c['n']}")
            for i, rcp in enumerate(ul):
                table[start + rcp] = gid0 + i
        elif typ == "FORMAT0_FULL":
            ofs = parse_u8_list(src, c["ofs"])
            for i in range(c["len"]):
                g = ofs[i]
                if g == 0 and i != 0:
                    continue
                table[start + i] = gid0 + g
        elif typ == "SPARSE_FULL":
            ul = parse_u16_list(src, c["ul"])
            ofs = parse_u8_list(src, c["ofs"])
            for i, rcp in enumerate(ul):
                g = ofs[i]
                if g == 0:
                    continue
                table[start + rcp] = gid0 + g
        else:
            sys.exit(f"未知 cmap 类型 {typ}")
    return table


def parse_kern(src: str):
    m = re.search(r"kern_scale = (\d+)", src)
    kern_scale = int(m.group(1)) if m else 16
    kc = re.search(r"lv_font_fmt_txt_kern_classes_t kern_classes\s*=\s*\{", src)
    if not kc:
        # 只有 kern_pair 模式或完全没有字距
        return None, kern_scale
    block = src[kc.end():]
    block = block[: block.index("};")]
    ln = int(re.search(r"\.left_class_cnt\s*=\s*(\d+)", block).group(1))
    rn = int(re.search(r"\.right_class_cnt\s*=\s*(\d+)", block).group(1))
    return (
        {
            "ln": ln,
            "rn": rn,
            "lc": parse_u8_list(src, "kern_left_class_mapping"),
            "rc": parse_u8_list(src, "kern_right_class_mapping"),
            "v": parse_i8_list(src, "kern_class_values"),
        },
        kern_scale,
    )


def build(font_file: str, out_file: str, verbose=True):
    path = os.path.join(FONT_DIR, font_file)
    if not os.path.exists(path):
        print(f"跳过 {font_file}（不存在）")
        return None
    src = open(path, encoding="utf-8").read()
    glyphs = parse_glyphs(src)
    cmaps = parse_cmaps(src)
    kern, kern_scale = parse_kern(src)
    line_height = int(re.search(r"\.line_height = (\d+)", src).group(1))
    base_line = int(re.search(r"\.base_line = (-?\d+)", src).group(1))
    bpp = int(re.search(r"\.bpp = (\d+)", src).group(1))
    size = int(re.search(r"Size: (\d+) px", src).group(1))

    table = build_cmap_table(src, cmaps)

    out = {}
    missing = 0
    for cp, gid in sorted(table.items()):
        if gid >= len(glyphs):
            missing += 1
            continue
        adv, bw, bh, ox, oy = glyphs[gid]
        out[str(cp)] = [gid, adv, bw, bh, ox, oy]
    if missing:
        sys.exit(f"{font_file}: {missing} 个字形越界（glyph_dsc 只有 {len(glyphs)} 项）")

    # 一致性检查：映射到的字形应覆盖 glyph_dsc 里除 .notdef 外的全部条目
    used = {v[0] for v in out.values()}
    unreached = [g for g in range(1, len(glyphs)) if g not in used]
    if unreached:
        print(f"  ! 有 {len(unreached)} 个字形未被 cmap 引用，前几个 gid={unreached[:5]}")

    if kern and "kern_scale" not in ("",):
        pass

    os.makedirs(OUT_DIR, exist_ok=True)
    dst = os.path.join(OUT_DIR, out_file)
    payload = {
        "size": size,
        "bpp": bpp,
        "line_height": line_height,
        "base_line": base_line,
        "kern_scale": kern_scale,
        "kern": kern,
        "glyphs": out,
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(
        f"{font_file}: {len(out)} 码点 / {len(glyphs)} 字形, "
        f"line_height={line_height}, base_line={base_line}, bpp={bpp}, "
        f"kern={'class' if kern else 'none'} -> {dst} "
        f"({os.path.getsize(dst) / 1024:.0f} KB)"
    )

    if verbose:
        def px(cp, nxt=0):
            g = out.get(str(cp))
            if not g:
                return None
            kv = 0
            if kern:
                lc = kern["lc"][g[0]]
                rc = kern["rc"][out[str(nxt)][0]] if nxt and str(nxt) in out else 0
                if lc > 0 and rc > 0:
                    kv = (kern["v"][(lc - 1) * kern["rn"] + (rc - 1)] * kern_scale) >> 4
            return (g[1] + kv + 8) >> 4

        for ch, nxt in (("中", "文"), ("文", "字"), ("A", "V"), ("V", "A"), (" ", "中"), ("一", "。")):
            print(f"    {ch!r}->{nxt!r}: {px(ord(ch), ord(nxt))} px")
    return payload


if __name__ == "__main__":
    args = sys.argv[1:]
    for src, dst in FONTS:
        build(src, dst)
