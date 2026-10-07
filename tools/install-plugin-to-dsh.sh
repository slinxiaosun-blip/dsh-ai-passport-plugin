#!/usr/bin/env bash
# 旧入口保留：实现已移到 tools/install-plugin-to-dsh.mjs（macOS / Windows 同一份实现），
# 这里只做转调。为什么用链接装而不是 `pnpm add file:...`：pnpm 会**拷贝**一份到
# node_modules，"磁盘上的源码"与"宿主实际加载的目录"变成两份，改源码以为生效、
# 实际跑旧拷贝 —— 这个坑真实发生过。链接让两者永远是同一份代码。
#
# 用法：./tools/install-plugin-to-dsh.sh [profile ...]   默认 desktop
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "${REPO_ROOT}/tools/install-plugin-to-dsh.mjs" "$@"
