#!/usr/bin/env bash
# 把插件以**符号链接**方式装进 DSH 的某个 profile。
#
# 为什么必须是符号链接：用 `pnpm add file:...` 安装时 pnpm 会**拷贝**一份到
# node_modules，于是源码目录与"宿主实际加载的目录"变成两份。改了源码却以为
# 生效、实际跑的是旧拷贝 —— 这个坑真实发生过，让三轮排查建立在错误前提上。
# 符号链接让"磁盘上的源码"就是"被加载的代码"，结构上杜绝这种偏差。
#
# 用法：./tools/install-plugin-to-dsh.sh [profile ...]   默认 desktop
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_SRC="${REPO_ROOT}/packages/dsh-ai-passport"
PROFILES=("$@")
[[ ${#PROFILES[@]} -eq 0 ]] && PROFILES=(desktop)

[[ -f "${PLUGIN_SRC}/package.json" ]] || { echo "找不到插件源码：${PLUGIN_SRC}" >&2; exit 1; }

for profile in "${PROFILES[@]}"; do
    dir="${HOME}/.dsh/profiles/${profile}"
    [[ -d "${dir}" ]] || { echo "跳过不存在的 profile：${profile}" >&2; continue; }
    echo "== profile: ${profile}"
    mkdir -p "${dir}/node_modules"
    rm -rf "${dir}/node_modules/dsh-ai-passport"
    ln -s "${PLUGIN_SRC}" "${dir}/node_modules/dsh-ai-passport"
    echo "   已链接 node_modules/dsh-ai-passport -> ${PLUGIN_SRC}"

    # noble 是原生模块，必须装在 profile 层（被 hoist），插件目录里不需要。
    if [[ ! -d "${dir}/node_modules/@stoprocent/noble" ]]; then
        echo "   ⚠ 未找到 @stoprocent/noble —— 在 ${dir} 执行：pnpm install"
    fi
    echo "   完成。改源码后**无需再同步**；宿主侧改动仍需重启 DSH 生效。"
done
