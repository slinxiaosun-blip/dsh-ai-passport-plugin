#!/usr/bin/env bash
# ============================================================================
# 环境准备：ESP-IDF 5.5.3 + 构建工具 + 上游必需的 5 个 skill
# ============================================================================
# 用法：
#   ./tools/setup-env.sh            # 检查并按需安装
#   ./tools/setup-env.sh --check    # 只检查，不改动任何东西
#
# 设计约束（来自上游 docs/development/engineering/environment-setup.zh_CN.md）：
#   - ESP-IDF 必须装在仓库**之外**，且路径不含空格；
#   - 只在 `idf.py --version` 恰好输出 v5.5.3 时复用已有安装，其他版本并行安装、不覆盖；
#   - 不修改用户的 shell 启动文件、全局 git 配置或包管理器配置。
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
IDF_ROOT="${AI_PASSPORT_IDF_ROOT:-${HOME}/esp/esp-idf-v5.5.3}"
EXPECTED_IDF_VERSION="v5.5.3"
# 上游文档记录的 tag commit。注意：上游曾就地更新过 v5.5.3 这个 tag，
# 因此这里把它作为"参考值"打印出来供人工核对，而不作为硬性失败条件——
# 真正的判定标准是 `idf.py --version` 的输出。
REFERENCE_IDF_COMMIT="b31fcc7a314a44ad992b58f589f7d1d8a4fadff6"
CHECK_ONLY=0

for arg in "$@"; do
    case "${arg}" in
        --check) CHECK_ONLY=1 ;;
        -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
        *) echo "未知参数：${arg}" >&2; exit 2 ;;
    esac
done

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

missing_required=0

step "1/4 检查构建工具"
for tool in git python3 cmake ninja; do
    if command -v "${tool}" >/dev/null 2>&1; then
        pass "${tool} $("${tool}" --version 2>&1 | head -1)"
    else
        fail "缺少 ${tool}"
        missing_required=1
        if [[ "${tool}" == "cmake" || "${tool}" == "ninja" ]]; then
            echo "      修复：brew install ${tool}"
        fi
    fi
done
# ccache 是可选的加速器，缺了只影响编译速度
if command -v ccache >/dev/null 2>&1; then
    pass "ccache $(ccache --version | head -1)"
else
    warn "没有 ccache（可选，仅影响重复编译速度）：brew install ccache"
fi

step "2/4 检查 ESP-IDF ${EXPECTED_IDF_VERSION}"
if [[ -d "${IDF_ROOT}/.git" ]]; then
    actual_commit="$(git -C "${IDF_ROOT}" rev-parse HEAD 2>/dev/null || echo unknown)"
    pass "已存在 ${IDF_ROOT}"
    echo "      HEAD: ${actual_commit}"
    if [[ "${actual_commit}" != "${REFERENCE_IDF_COMMIT}" ]]; then
        warn "与上游文档记录的 v5.5.3 commit 不同（${REFERENCE_IDF_COMMIT}）"
        echo "      上游曾就地更新该 tag；以 \`idf.py --version\` 的输出为准。"
    fi
else
    fail "未安装：${IDF_ROOT}"
    missing_required=1
    echo "      修复："
    echo "        mkdir -p \"\$(dirname '${IDF_ROOT}')\""
    echo "        git clone --depth 1 --branch v5.5.3 --recurse-submodules --shallow-submodules \\"
    echo "          https://github.com/espressif/esp-idf.git '${IDF_ROOT}'"
    echo "        '${IDF_ROOT}/install.sh' esp32c3"
fi

step "3/4 验证 ESP-IDF 版本（需要先 export）"
if [[ -f "${IDF_ROOT}/export.sh" ]]; then
    # 在子 shell 里 source，避免污染当前 shell 的环境
    idf_version="$(bash -c "source '${IDF_ROOT}/export.sh' >/dev/null 2>&1 && idf.py --version 2>/dev/null" || true)"
    if [[ "${idf_version}" == *"ESP-IDF ${EXPECTED_IDF_VERSION}"* ]]; then
        pass "idf.py --version → ${idf_version}"
    elif [[ -z "${idf_version}" ]]; then
        fail "无法运行 idf.py（工具链可能尚未安装）"
        echo "      修复：'${IDF_ROOT}/install.sh' esp32c3"
        missing_required=1
    else
        fail "版本不符：期望 ${EXPECTED_IDF_VERSION}，实际 ${idf_version}"
        missing_required=1
    fi
fi

step "4/4 检查上游必需的 5 个 skill"
# 上游 AGENTS.md 要求：passport-develop / passport-setup / passport-build /
# passport-device-test / passport-debug 必须可用。
SKILL_NAMES=(passport-develop passport-setup passport-build passport-device-test passport-debug)
found_any=0
for name in "${SKILL_NAMES[@]}"; do
    if [[ -d "${REPO_ROOT}/vendor/ai-passport/skills/${name}" ]]; then
        pass "${name}（仓库内源文件存在）"
        found_any=1
    else
        warn "${name} 在仓库内找不到源文件"
    fi
done
if [[ "${found_any}" == "1" ]]; then
    echo "      安装到当前 AI 工具："
    echo "        python3 vendor/ai-passport/tools/install_passport_skills.py --help"
fi

step "结论"
if [[ "${missing_required}" == "1" ]]; then
    fail "环境尚未就绪，请按上面的修复建议处理后重跑"
    exit 1
fi
if [[ "${CHECK_ONLY}" == "1" ]]; then
    pass "环境检查通过（--check 模式未做任何改动）"
    exit 0
fi
pass "环境就绪。构建固件："
echo "      source '${IDF_ROOT}/export.sh'"
echo "      cd vendor/ai-passport && ./tools/validate.sh --firmware"
