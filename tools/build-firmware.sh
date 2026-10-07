#!/usr/bin/env bash
# ============================================================================
# 构建固件并产出可从 0x0 刷写的合并镜像
# ============================================================================
# 用法：
#   ./tools/build-firmware.sh            # 静态检查 + 固件构建
#   ./tools/build-firmware.sh --static   # 只跑静态检查（秒级）
#   ./tools/build-firmware.sh --ccache   # 启用 ccache 加速重复编译
#
# 产物：vendor/ai-passport/build/FoloToy-AI-Passport-full.bin
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
IDF_ROOT="${AI_PASSPORT_IDF_ROOT:-${HOME}/esp/esp-idf-v5.5.3}"
FIRMWARE_DIR="${REPO_ROOT}/vendor/ai-passport"
MODE="firmware"
USE_CCACHE=0

for arg in "$@"; do
    case "${arg}" in
        --static) MODE="static" ;;
        --firmware) MODE="firmware" ;;
        --ccache) USE_CCACHE=1 ;;
        -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
        *) echo "未知参数：${arg}" >&2; exit 2 ;;
    esac
done

if [[ ! -d "${FIRMWARE_DIR}" ]]; then
    echo "找不到固件目录：${FIRMWARE_DIR}" >&2
    echo "先执行：git clone --depth 1 https://gitee.com/FoloToy/ai-passport.git vendor/ai-passport" >&2
    exit 1
fi

# 静态检查不需要 ESP-IDF，先跑，快速失败
echo "== 静态检查 =="
(cd "${FIRMWARE_DIR}" && ./tools/validate.sh --static)

if [[ "${MODE}" == "static" ]]; then
    echo
    echo "静态检查通过（未构建固件）。完整构建：$0"
    exit 0
fi

if [[ ! -f "${IDF_ROOT}/export.sh" ]]; then
    echo "找不到 ESP-IDF：${IDF_ROOT}" >&2
    echo "先执行：./tools/setup-env.sh --check 查看修复建议" >&2
    exit 1
fi

echo
echo "== 固件构建（ESP-IDF 5.5.3）=="
if [[ "${USE_CCACHE}" == "1" ]]; then
    echo "（已启用 ccache）"
    export IDF_CCACHE_ENABLE=1
fi

# 在子 shell 里 source，避免污染调用者的环境
(
    # shellcheck disable=SC1091
    source "${IDF_ROOT}/export.sh" >/dev/null 2>&1
    actual="$(idf.py --version 2>/dev/null || true)"
    if [[ "${actual}" != *"ESP-IDF v5.5.3"* ]]; then
        echo "ESP-IDF 版本不符：期望 v5.5.3，实际 '${actual}'" >&2
        echo "不要用其他版本覆盖构建；另行安装 v5.5.3 后用 AI_PASSPORT_IDF_ROOT 指向它。" >&2
        exit 1
    fi
    cd "${FIRMWARE_DIR}"
    ./tools/validate.sh --firmware
)

MERGED="${FIRMWARE_DIR}/build/FoloToy-AI-Passport-full.bin"
echo
if [[ -f "${MERGED}" ]]; then
    echo "== 完成 =="
    echo "合并镜像：${MERGED}"
    echo "大小：$(du -h "${MERGED}" | cut -f1)"
    echo "SHA-256：$(shasum -a 256 "${MERGED}" | awk '{print $1}')"
    echo
    echo "刷写到 0x0："
    echo "  esptool.py -p /dev/cu.usbserial-XXXX write_flash 0x0 '${MERGED}'"
    echo
    echo "注意：烧录需要用户明确授权；检测到设备不等于获得授权。"
else
    echo "构建结束但没找到合并镜像：${MERGED}" >&2
    exit 1
fi
