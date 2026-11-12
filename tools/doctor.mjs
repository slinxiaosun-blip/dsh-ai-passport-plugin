#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { resolveDshHome } from './install-plugin-to-dsh.mjs'

export const PARTIAL_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const MODEL_MIN_BYTES = 200 * 1024 * 1024
export const DEFAULT_PROFILE = 'desktop'

export const REQUIRED_DEPENDENCIES = [
  '@deepseek-ai/dsh-web-app',
  '@stoprocent/noble',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  'dsh-ai-passport',
]

export const REQUIRED_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  'dsh-ai-passport',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
]

const PROFILE_MODULES = [
  '@deepseek-ai/dsh-web-app',
  '@stoprocent/noble',
  'dsh-ai-passport',
]

function usage(stream = process.stdout) {
  stream.write(`Usage: npm run doctor -- [options]

Read-only health checks for FoloToy AI Passport + DeepSeek Harness.

Options:
  --dsh-home PATH   DSH home (default: $DSH_HOME or ~/.dsh)
  --profile NAME    Profile to inspect (default: desktop)
  --all-profiles    Inspect every profile under <DSH_HOME>/profiles
  --json            Print machine-readable JSON
  -h, --help        Show this help

Statuses: PASS, WARN, FAIL, SKIP
Exit codes: 0 = no FAIL, 1 = any FAIL, 2 = invalid arguments

This command is strictly read-only. It never writes files, installs packages,
changes Bluetooth pairing, or flashes firmware.
`)
}

export function parseArgs(argv, env = process.env, homedir = os.homedir()) {
  const options = {
    dshHome: resolveDshHome(env, homedir),
    profile: DEFAULT_PROFILE,
    allProfiles: false,
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dsh-home') options.dshHome = argv[++i]
    else if (arg === '--profile') options.profile = argv[++i]
    else if (arg === '--all-profiles') options.allProfiles = true
    else if (arg === '--json') options.json = true
    else if (arg === '-h' || arg === '--help') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!options.dshHome) throw new Error('--dsh-home requires a path')
  if (!options.profile) throw new Error('--profile requires a name')
  options.dshHome = path.resolve(options.dshHome)
  return options
}

function fileInfo(target, fsImpl = fs) {
  try {
    return fsImpl.statSync(target)
  } catch {
    return null
  }
}

function readJson(target, fsImpl = fs) {
  return JSON.parse(fsImpl.readFileSync(target, 'utf8'))
}

export function listProfiles(dshHome, { fsImpl = fs } = {}) {
  const profilesDir = path.join(dshHome, 'profiles')
  try {
    return fsImpl.readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

export function scanPartials(modelRoot, {
  now = Date.now(),
  maxAgeMs = PARTIAL_MAX_AGE_MS,
  fsImpl = fs,
} = {}) {
  const root = path.resolve(modelRoot)
  const files = []
  const rootInfo = fileInfo(root, fsImpl)
  if (!rootInfo?.isDirectory()) {
    return { root, exists: false, files, stale: [], recent: [] }
  }

  const walk = (directory) => {
    for (const entry of fsImpl.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile() && entry.name.endsWith('.part')) {
        const info = fsImpl.statSync(fullPath)
        files.push({
          path: fullPath,
          relativePath: path.relative(root, fullPath),
          size: info.size,
          mtimeMs: info.mtimeMs,
        })
      }
    }
  }

  walk(root)
  const stale = files.filter((file) => now - file.mtimeMs >= maxAgeMs)
  const recent = files.filter((file) => now - file.mtimeMs < maxAgeMs)
  return { root, exists: true, files, stale, recent }
}

export function inspectProfile(profileDir, { fsImpl = fs } = {}) {
  const packagePath = path.join(profileDir, 'package.json')
  const packageInfo = fileInfo(packagePath, fsImpl)
  if (!packageInfo?.isFile()) {
    return {
      profileDir,
      packagePath,
      error: `missing ${packagePath}`,
      profile: null,
      missingDependencies: REQUIRED_DEPENDENCIES,
      missingBundles: REQUIRED_BUNDLES,
      pluginVersion: null,
    }
  }

  let profile
  try {
    profile = readJson(packagePath, fsImpl)
  } catch (error) {
    return {
      profileDir,
      packagePath,
      error: `invalid package.json: ${error.message}`,
      profile: null,
      missingDependencies: REQUIRED_DEPENDENCIES,
      missingBundles: REQUIRED_BUNDLES,
      pluginVersion: null,
    }
  }

  const dependencies = profile.dependencies ?? {}
  const bundles = profile.dsh?.profile?.bundles ?? []
  let pluginVersion = null
  try {
    pluginVersion = readJson(path.join(profileDir, 'node_modules', 'dsh-ai-passport', 'package.json'), fsImpl).version ?? null
  } catch {}

  return {
    profileDir,
    packagePath,
    error: null,
    profile,
    missingDependencies: REQUIRED_DEPENDENCIES.filter((name) => !dependencies[name]),
    missingBundles: REQUIRED_BUNDLES.filter((name) => !bundles.includes(name)),
    pluginVersion,
  }
}

export function resolveProfilePackage(profileDir, packageName, { resolver } = {}) {
  try {
    const resolve = resolver ?? createRequire(path.join(profileDir, 'package.json')).resolve
    return { name: packageName, resolved: resolve(packageName), error: null }
  } catch (error) {
    return { name: packageName, resolved: null, error: error.message }
  }
}

export function inspectCredentials(credentials, { fsImpl = fs } = {}) {
  const info = fileInfo(credentials, fsImpl)
  if (!info?.isFile()) return { status: 'WARN', detail: `missing ${credentials}` }
  const permissions = (info.mode & 0o777).toString(8).padStart(3, '0')
  try {
    const access = fsImpl.accessSync ?? fs.accessSync
    access(credentials, (fsImpl.constants ?? fs.constants).R_OK)
    return {
      status: 'PASS',
      detail: `${info.size} bytes, mode ${permissions}; contents not read`,
    }
  } catch {
    return {
      status: 'WARN',
      detail: `${info.size} bytes, mode ${permissions}; not readable`,
    }
  }
}

export function inspectSenseVoice(modelRoot, {
  now = Date.now(),
  fsImpl = fs,
} = {}) {
  const model = fileInfo(path.join(modelRoot, 'sensevoice-onnx', 'model.int8.onnx'), fsImpl)
  const tokens = fileInfo(path.join(modelRoot, 'sensevoice-onnx', 'tokens.txt'), fsImpl)
  const vad = fileInfo(path.join(modelRoot, 'silero', 'silero_vad.onnx'), fsImpl)
  const ready = Boolean(
    model?.isFile()
    && model.size >= MODEL_MIN_BYTES
    && tokens?.isFile()
    && vad?.isFile()
  )
  return {
    model,
    tokens,
    vad,
    ready,
    partials: scanPartials(modelRoot, { now, fsImpl }),
  }
}

function profileChecks(profile, options) {
  const profileDir = path.join(options.dshHome, 'profiles', profile)
  const inspected = inspectProfile(profileDir, { fsImpl: options.fsImpl })
  const checks = []
  checks.push({
    scope: profile,
    name: 'profile',
    status: inspected.profile ? 'PASS' : 'FAIL',
    detail: inspected.error ?? profileDir,
  })
  if (inspected.profile) {
    checks.push({
      scope: profile,
      name: 'dependencies',
      status: inspected.missingDependencies.length ? 'FAIL' : 'PASS',
      detail: inspected.missingDependencies.length
        ? `missing: ${inspected.missingDependencies.join(', ')}`
        : 'all required dependencies are declared',
    })
    checks.push({
      scope: profile,
      name: 'bundles',
      status: inspected.missingBundles.length ? 'FAIL' : 'PASS',
      detail: inspected.missingBundles.length
        ? `missing: ${inspected.missingBundles.join(', ')}`
        : 'all required bundles are registered',
    })
  }
  checks.push({
    scope: profile,
    name: 'plugin',
    status: inspected.pluginVersion ? 'PASS' : 'FAIL',
    detail: inspected.pluginVersion ?? 'dsh-ai-passport is not installed in this profile',
  })
  const unresolved = PROFILE_MODULES
    .map((name) => resolveProfilePackage(profileDir, name, {
      resolver: options.resolvePackage,
    }))
    .filter((item) => item.error)
  checks.push({
    scope: profile,
    name: 'module resolution',
    status: unresolved.length ? 'FAIL' : 'PASS',
    detail: unresolved.length
      ? `unresolved: ${unresolved.map((item) => item.name).join(', ')}`
      : 'web-app, noble, and plugin resolve from this profile',
  })
  return checks
}

export function runDoctor(options, {
  fsImpl = fs,
  now = Date.now(),
  resolvePackage,
} = {}) {
  const profiles = options.allProfiles ? listProfiles(options.dshHome, { fsImpl }) : [options.profile]
  const checks = []
  if (!profiles.length) {
    checks.push({
      scope: 'doctor',
      name: 'profiles',
      status: 'FAIL',
      detail: `no profiles found under ${path.join(options.dshHome, 'profiles')}`,
    })
  }
  for (const profile of profiles) {
    checks.push(...profileChecks(profile, {
      dshHome: options.dshHome,
      fsImpl,
      resolvePackage,
    }))
  }

  const credentials = inspectCredentials(path.join(options.dshHome, '.credentials.yaml'), { fsImpl })
  checks.push({ scope: 'dsh-home', name: 'credentials', ...credentials })

  const modelRoot = path.join(options.dshHome, 'speech-to-text', 'sensevoice', 'models')
  const model = inspectSenseVoice(modelRoot, { now, fsImpl })
  checks.push({
    scope: 'dsh-home',
    name: 'SenseVoice files',
    status: model.ready ? 'PASS' : 'WARN',
    detail: model.ready
      ? 'model, tokens, and VAD are present'
      : 'model, tokens, or VAD is missing or incomplete',
  })
  checks.push({
    scope: 'dsh-home',
    name: 'model partials',
    status: model.partials.stale.length ? 'WARN' : 'PASS',
    detail: model.partials.files.length
      ? `${model.partials.stale.length} stale (>24h), ${model.partials.recent.length} recent (<24h)`
      : 'no .part files',
  })
  return checks
}

export function summarizeChecks(checks) {
  const counts = checks.reduce((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1
    return result
  }, {})
  return {
    counts,
    exitCode: (counts.FAIL ?? 0) > 0 ? 1 : 0,
  }
}

function printTable(checks, stream = process.stdout) {
  const scopeWidth = Math.max(...checks.map((item) => item.scope.length), 5)
  const nameWidth = Math.max(...checks.map((item) => item.name.length), 8)
  for (const check of checks) {
    stream.write(`${check.status.padEnd(4)}  ${check.scope.padEnd(scopeWidth)}  ${check.name.padEnd(nameWidth)}  ${check.detail}\n`)
  }
}

export function main(argv = process.argv.slice(2), {
  env = process.env,
  homedir = os.homedir(),
  fsImpl = fs,
  now = Date.now(),
  resolvePackage,
  stdout = process.stdout,
} = {}) {
  let options
  try {
    options = parseArgs(argv, env, homedir)
  } catch (error) {
    stdout.write(`${error.message}\n`)
    usage(stdout)
    return 2
  }
  if (options.help) {
    usage(stdout)
    return 0
  }

  const checks = runDoctor(options, { fsImpl, now, resolvePackage })
  const summary = summarizeChecks(checks)
  if (options.json) {
    stdout.write(`${JSON.stringify({ dshHome: options.dshHome, checks, summary }, null, 2)}\n`)
  } else {
    printTable(checks, stdout)
    stdout.write(`\nSummary: ${summary.counts.PASS ?? 0} PASS, ${summary.counts.WARN ?? 0} WARN, ${summary.counts.FAIL ?? 0} FAIL, ${summary.counts.SKIP ?? 0} SKIP\n`)
  }
  return summary.exitCode
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  process.exitCode = main()
}
