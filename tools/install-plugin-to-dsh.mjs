#!/usr/bin/env node
/**
 * 把插件以**源码即生效代码**的方式装进 DSH 的某个 profile（macOS / Windows 通用）。
 *
 * 为什么必须是链接而不是 `pnpm add file:...`：pnpm 会**拷贝**一份到 node_modules，
 * 于是"磁盘上的源码"与"宿主实际加载的目录"变成两份。改了源码却以为生效、实际跑的
 * 是旧拷贝 —— 这个坑真实发生过，让三轮排查建立在错误前提上。
 *
 * 链接策略按平台自动选择（也可用 --copy 强制）：
 *   - macOS / Linux → 符号链接（ln -s 等价物）
 *   - Windows       → 目录 junction（**无需**管理员权限或开发者模式）
 *     junction 也失败（机器策略禁止）→ 降级为复制，并写 .dsh-passport-install.json
 *     标记 copy 模式，每次安装时提醒"改源码需重装"。
 *
 * DSH profile 目录 = <dshHome>/profiles/<name>，dshHome 默认 ~/.dsh
 * （与 DSH 宿主自身的解析规则一致：OS home + .dsh），可用环境变量 DSH_HOME 覆盖。
 *
 * 用法：
 *   node tools/install-plugin-to-dsh.mjs [profile ...]   # 默认 desktop
 *   node tools/install-plugin-to-dsh.mjs --copy web      # 强制复制模式
 *   DSH_HOME=~/my-dsh node tools/install-plugin-to-dsh.mjs
 *
 * 旧入口 tools/install-plugin-to-dsh.sh / .ps1 保留，均转调本文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PLUGIN_SRC = path.join(REPO_ROOT, 'packages', 'dsh-ai-passport')
const INSTALL_MARKER = '.dsh-passport-install.json'

/** copy 模式只带走运行所需内容；node_modules 在 profile 层，audio 是联调产物。 */
const COPY_ENTRIES = ['package.json', 'lib', 'cordis.patch.yml', 'README.md']

/** 解析 DSH 家目录：DSH_HOME 优先，否则 OS home + .dsh（win/mac 同一规则）。 */
export function resolveDshHome(env = process.env, homedir = os.homedir()) {
  const raw = env.DSH_HOME
  return raw ? path.resolve(raw) : path.join(homedir, '.dsh')
}

/**
 * 平台 → 链接类型。Windows 用 junction：目录联接由普通用户直接创建，
 * 而 symlink 在 Windows 上默认要求管理员或开发者模式。
 */
export function linkModeFor(platform = process.platform) {
  return platform === 'win32' ? 'junction' : 'dir'
}

/**
 * 装一个 profile。返回 { profile, mode, target } 或 { profile, skipped, reason }。
 *
 * 依赖全部可注入（symlink/copy/logger），以便单元测试覆盖 Windows 分支
 * 而不依赖真机权限模型。
 */
export function installProfile(options) {
  const {
    pluginSrc = PLUGIN_SRC,
    dshHome,
    profile,
    platform = process.platform,
    forceCopy = false,
    logger = () => {},
    symlink = fs.symlinkSync,
    copy = defaultCopy,
    writeMarker = defaultWriteMarker,
  } = options

  const dir = path.join(dshHome, 'profiles', profile)
  if (!fs.existsSync(dir)) {
    return { profile, skipped: true, reason: `profile 不存在：${dir}` }
  }
  if (!fs.existsSync(path.join(pluginSrc, 'package.json'))) {
    throw new Error(`找不到插件源码：${pluginSrc}`)
  }

  const nodeModules = path.join(dir, 'node_modules')
  fs.mkdirSync(nodeModules, { recursive: true })
  const target = path.join(nodeModules, 'dsh-ai-passport')

  // 先清掉旧安装（符号链接 / junction / 复制目录都走这里）。
  // fs.rmSync 对链接只删链接本身、不动源码目录，安全。
  fs.rmSync(target, { recursive: true, force: true })

  let mode
  if (forceCopy) {
    mode = 'copy'
  } else {
    const linkType = linkModeFor(platform)
    try {
      // Windows：'junction'；POSIX：'dir'。两者都只在目录上合法。
      symlink(pluginSrc, target, linkType)
      mode = linkType === 'junction' ? 'junction' : 'symlink'
    } catch (error) {
      if (platform !== 'win32') throw error
      logger(`   ⚠ junction 创建失败（${error.code ?? error.message}），降级为复制`)
      mode = 'copy'
    }
  }

  if (mode === 'copy') {
    copy(pluginSrc, target)
    writeMarker(target, { mode, source: pluginSrc, installedAt: new Date().toISOString() })
    logger('   ⚠ copy 模式：改源码**不会**生效，改完需重跑本命令')
  }

  // noble 是原生模块，装在 profile 层（被 hoist），插件目录里不需要。
  const noble = path.join(nodeModules, '@stoprocent', 'noble')
  if (!fs.existsSync(noble)) {
    logger('   ⚠ 未找到 @stoprocent/noble —— 在 profile 目录执行 pnpm install（win32-x64 走预编译）')
  }

  return { profile, mode, target }
}

function defaultCopy(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of COPY_ENTRIES) {
    const from = path.join(src, entry)
    if (!fs.existsSync(from)) continue
    fs.cpSync(from, path.join(dest, entry), {
      recursive: true,
      filter: (p) => !/[\\/](node_modules|__pycache__)([\\/]|$)/.test(p) && !p.endsWith('.DS_Store'),
    })
  }
}

function defaultWriteMarker(target, info) {
  fs.writeFileSync(path.join(target, INSTALL_MARKER), `${JSON.stringify(info, null, 2)}\n`)
}

function usage() {
  console.log(`用法：node tools/install-plugin-to-dsh.mjs [选项] [profile ...]   默认 desktop

选项：
  --copy      强制复制模式（不建链接；改源码后需重装）
  -h, --help  显示本帮助

环境变量：
  DSH_HOME    DSH 家目录（默认 ~/.dsh，Windows 即 %USERPROFILE%\\.dsh）`)
}

function main(argv) {
  const profiles = []
  let forceCopy = false
  for (const arg of argv) {
    if (arg === '--copy') forceCopy = true
    else if (arg === '-h' || arg === '--help') { usage(); return 0 }
    else if (arg.startsWith('-')) { console.error(`未知参数：${arg}`); usage(); return 2 }
    else profiles.push(arg)
  }
  if (profiles.length === 0) profiles.push('desktop')

  if (!fs.existsSync(path.join(PLUGIN_SRC, 'package.json'))) {
    console.error(`找不到插件源码：${PLUGIN_SRC}`)
    return 1
  }

  const dshHome = resolveDshHome()
  console.log(`DSH 家目录：${dshHome}（平台：${process.platform}）`)

  let installed = 0
  for (const profile of profiles) {
    console.log(`== profile: ${profile}`)
    const result = installProfile({ dshHome, profile, forceCopy, logger: (m) => console.log(m) })
    if (result.skipped) {
      console.log(`   跳过：${result.reason}`)
      continue
    }
    installed += 1
    const label = { junction: '已链接（junction）', symlink: '已链接（symlink）', copy: '已复制' }[result.mode]
    console.log(`   ${label} node_modules/dsh-ai-passport -> ${PLUGIN_SRC}`)
    console.log('   完成。改源码后**无需再同步**；宿主侧改动仍需重启 DSH 生效。')
  }

  if (installed === 0) {
    console.error('没有任何 profile 被安装。确认 DSH 客户端已初始化（或用 DSH_HOME 指向正确目录）。')
    return 1
  }
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)))
}
