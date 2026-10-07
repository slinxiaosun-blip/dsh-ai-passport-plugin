# Windows 入口：把插件装进 DSH profile。实现见 tools/install-plugin-to-dsh.mjs
# （macOS / Windows 同一份实现），这里只做转调。
#
# 用法（PowerShell）：
#   powershell -ExecutionPolicy Bypass -File tools\install-plugin-to-dsh.ps1
#   powershell -ExecutionPolicy Bypass -File tools\install-plugin-to-dsh.ps1 web desktop
$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error '找不到 node。请先安装 Node.js >= 20 并确保其在 PATH 中。'
    exit 1
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
node (Join-Path $RepoRoot 'tools\install-plugin-to-dsh.mjs') @args
exit $LASTEXITCODE
