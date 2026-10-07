#!/usr/bin/env python3
"""从 AI Passport 抓取屏幕截图（FAP_SCREENSHOT_V1 协议）。

为什么需要它：设备没有网络、没有调试器，界面问题（中文字形、布局溢出、颜色）
只能靠"看见屏幕"判断。没有它就只能盲改 + 听用户口头描述，效率极低。

用法：
    python3 tools/screenshot.py                    # 自动找串口 → /tmp/fap-screen.png
    python3 tools/screenshot.py -o shot.png
    python3 tools/screenshot.py -p /dev/cu.usbmodem2201
    python3 tools/screenshot.py --both             # 两种字节序都导出，用于判断颜色异常

协议：
    主机 → "FAP_SCREENSHOT_V1\\n"
    设备 → "FAP_SCREENSHOT_V1 <宽> <高> RGB565LE <字节数>\\n" + 紧排像素

★ 两个必须踩过才知道的坑（都已在代码里规避）：
  1) **必须用 raw 模式打开串口**。用 pyserial 默认的规范模式时，主机侧的写入
     在实测中无法稳定送达设备（设备侧一个字节都收不到），而设备明明在正常运行。
     改为 os.open + termios 原始模式 + select 后一切正常。
  2) **不要把 DTR/RTS 置为有效**。在这块板子上那会复位设备，命令正好落进启动
     日志洪峰里被丢掉，现象与"设备没收到命令"无法区分。
"""
from __future__ import annotations

import argparse
import glob
import os
import re
import select
import sys
import termios
import time

CMD = b"FAP_SCREENSHOT_V1\n"
HEADER_RE = re.compile(rb"FAP_SCREENSHOT_V1\s+(\d+)\s+(\d+)\s+RGB565LE\s+(\d+)")

try:
    from PIL import Image
except ImportError:
    sys.exit("需要 Pillow：python3 -m pip install Pillow")


def find_port() -> str:
    for pattern in ("/dev/cu.usbmodem*", "/dev/cu.wchusbserial*", "/dev/cu.usbserial*"):
        hits = sorted(glob.glob(pattern))
        if hits:
            return hits[0]
    sys.exit("找不到串口。确认设备已开机并用数据线连上电脑。")


def open_raw(path: str) -> int:
    """以原始模式打开串口，不做任何行处理、不回显、不碰 DTR/RTS。"""
    fd = os.open(path, os.O_RDWR | os.O_NONBLOCK | os.O_NOCTTY)
    a = termios.tcgetattr(fd)
    a[0] &= ~(termios.IGNBRK | termios.BRKINT | termios.PARMRK | termios.ISTRIP |
              termios.INLCR | termios.IGNCR | termios.ICRNL | termios.IXON)
    a[1] &= ~termios.OPOST
    a[2] &= ~(termios.CSIZE | termios.PARENB)
    a[2] |= termios.CS8
    a[3] &= ~(termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG | termios.IEXTEN)
    a[4] = termios.B115200
    a[5] = termios.B115200
    a[6][termios.VMIN] = 0
    a[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, a)
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd


def drain(fd: int, seconds: float) -> bytes:
    out = bytearray()
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if not r:
            continue
        try:
            chunk = os.read(fd, 65536)
        except BlockingIOError:
            continue
        if chunk:
            out += chunk
    return bytes(out)


def read_exact(fd: int, count: int, timeout_s: float = 25.0) -> bytes:
    """精确读满 count 字节。

    设备在发像素前会静默所有日志，所以这里读到的应当正好是像素。
    仍严格按长度读：错一个字节整幅图就偏了，宁可报错也不要输出错位的图。
    """
    buf = bytearray()
    end = time.time() + timeout_s
    while len(buf) < count and time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.5)
        if not r:
            continue
        try:
            chunk = os.read(fd, min(65536, count - len(buf)))
        except BlockingIOError:
            continue
        if chunk:
            buf += chunk
    if len(buf) != count:
        raise TimeoutError(f"只收到 {len(buf)} / {count} 字节像素")
    return bytes(buf)


def decode_rgb565(data: bytes, width: int, height: int, swap: bool) -> "Image.Image":
    img = Image.new("RGB", (width, height))
    px = img.load()
    i = 0
    for y in range(height):
        for x in range(width):
            lo, hi = data[i], data[i + 1]
            i += 2
            if swap:
                lo, hi = hi, lo
            v = (hi << 8) | lo
            r, g, b = (v >> 11) & 0x1F, (v >> 5) & 0x3F, v & 0x1F
            # 5/6/5 → 8 位：位复制把小值域拉伸到满量程（比简单左移更准）
            px[x, y] = ((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2))
    return img


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-p", "--port", default=None)
    ap.add_argument("-o", "--output", default="/tmp/fap-screen.png")
    ap.add_argument("--both", action="store_true",
                    help="同时导出两种字节序（-le / -swapped），用于判断颜色异常")
    ap.add_argument("--settle", type=float, default=1.2, help="发送前的等待秒数")
    args = ap.parse_args()

    port = args.port or find_port()
    print(f"串口: {port}")
    fd = open_raw(port)
    try:
        time.sleep(args.settle)
        drain(fd, 0.3)

        os.write(fd, CMD)
        print("已发送命令，等待应答…")

        # 在日志流里找应答头行
        header = bytearray()
        end = time.time() + 12
        m = None
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.5)
            if r:
                try:
                    header += os.read(fd, 65536)
                except BlockingIOError:
                    pass
            m = HEADER_RE.search(bytes(header))
            if m:
                break
        if not m:
            sys.exit("未收到应答头。用 `--settle 3` 再试；若仍失败，先确认设备在运行"
                     "（串口应能看到启动日志）。")

        width, height, size = (int(g) for g in m.groups())
        print(f"应答: {width}x{height} RGB565LE {size} 字节")

        data = read_exact(fd, size)
        print(f"已收到 {len(data)} 字节像素")
    finally:
        os.close(fd)

    if args.both:
        for swap, suffix in ((False, "-le"), (True, "-swapped")):
            out = args.output.replace(".png", f"{suffix}.png")
            decode_rgb565(data, width, height, swap).save(out)
            print(f"已保存: {out}")
    else:
        decode_rgb565(data, width, height, False).save(args.output)
        print(f"已保存: {args.output}（颜色异常时用 --both 对比字节序）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
