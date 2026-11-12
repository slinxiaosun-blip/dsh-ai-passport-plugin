import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  inspectCredentials,
  inspectProfile,
  main,
  parseArgs,
  resolveProfilePackage,
  runDoctor,
  scanPartials,
  summarizeChecks,
} from './doctor.mjs'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-'))
}

function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`)
}

function makeProfile(home, name) {
  const profileDir = path.join(home, 'profiles', name)
  writeJson(path.join(profileDir, 'package.json'), {
    dependencies: {
      '@deepseek-ai/dsh-web-app': '0.2.2-rc.1',
      '@stoprocent/noble': '2.8.0',
      '@deepseek-ai/dsh-experimental-voice-input-bundle': '0.2.2-rc.1',
      'dsh-ai-passport': 'link:../../plugin',
    },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          'dsh-ai-passport',
          '@deepseek-ai/dsh-experimental-voice-input-bundle',
        ],
      },
    },
  })
  writeJson(path.join(profileDir, 'node_modules', 'dsh-ai-passport', 'package.json'), {
    name: 'dsh-ai-passport',
    version: '1.4.0',
  })
  return profileDir
}

test('parseArgs resolves DSH_HOME and defaults to desktop', () => {
  const options = parseArgs([], { DSH_HOME: '/tmp/custom-dsh' }, '/home/user')
  assert.equal(options.dshHome, path.resolve('/tmp/custom-dsh'))
  assert.equal(options.profile, 'desktop')
  assert.equal(options.allProfiles, false)
})

test('scanPartials handles age threshold, recursion, and symlink exclusion', () => {
  const root = tempDir()
  const nested = path.join(root, 'nested')
  const outside = tempDir()
  fs.mkdirSync(nested)
  fs.writeFileSync(path.join(nested, 'old.part'), Buffer.alloc(2048))
  fs.writeFileSync(path.join(root, 'fresh.part'), Buffer.alloc(3072))
  fs.writeFileSync(path.join(root, 'keep.txt'), 'keep')
  fs.writeFileSync(path.join(outside, 'outside.part'), Buffer.alloc(4096))
  fs.symlinkSync(path.join(outside, 'outside.part'), path.join(root, 'linked.part'))

  const now = Date.UTC(2026, 10, 12, 12, 0, 0)
  const old = new Date(now - 3 * 24 * 60 * 60 * 1000)
  const fresh = new Date(now - 10 * 60 * 1000)
  fs.utimesSync(path.join(nested, 'old.part'), old, old)
  fs.utimesSync(path.join(root, 'fresh.part'), fresh, fresh)

  const result = scanPartials(root, { now })
  assert.deepEqual(result.stale.map((file) => file.relativePath), ['nested/old.part'])
  assert.deepEqual(result.recent.map((file) => file.relativePath), ['fresh.part'])
  assert.equal(result.files.length, 2)

  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

test('inspectProfile reports dependencies, bundles, and plugin version', () => {
  const home = tempDir()
  const profileDir = makeProfile(home, 'desktop')
  const result = inspectProfile(profileDir)
  assert.equal(result.error, null)
  assert.equal(result.pluginVersion, '1.4.0')
  assert.deepEqual(result.missingDependencies, [])
  assert.deepEqual(result.missingBundles, [])
  fs.rmSync(home, { recursive: true, force: true })
})

test('resolveProfilePackage reports resolver errors without throwing', () => {
  const resolved = resolveProfilePackage('/tmp/profile', 'ok', {
    resolver: () => '/tmp/profile/node_modules/ok/index.js',
  })
  assert.equal(resolved.error, null)
  const missing = resolveProfilePackage('/tmp/profile', 'missing', {
    resolver: () => { throw new Error('Cannot find module missing') },
  })
  assert.match(missing.error, /Cannot find module/)
})

test('inspectCredentials uses stat and access only', () => {
  const root = tempDir()
  const credentials = path.join(root, '.credentials.yaml')
  fs.writeFileSync(credentials, 'secret')
  fs.chmodSync(credentials, 0o600)
  let readCalled = false
  const fsImpl = {
    constants: fs.constants,
    statSync: fs.statSync,
    accessSync: fs.accessSync,
    readFileSync: () => {
      readCalled = true
      throw new Error('credentials must not be read')
    },
    openSync: () => {
      readCalled = true
      throw new Error('credentials must not be opened')
    },
  }
  const result = inspectCredentials(credentials, { fsImpl })
  assert.equal(result.status, 'PASS')
  assert.match(result.detail, /mode 600/)
  assert.equal(readCalled, false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('runDoctor supports all profiles and aggregates non-fatal statuses', () => {
  const home = tempDir()
  makeProfile(home, 'desktop')
  makeProfile(home, 'web')
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'fixture')
  const checks = runDoctor({
    dshHome: home,
    profile: 'desktop',
    allProfiles: true,
  }, {
    now: Date.UTC(2026, 10, 12, 12, 0, 0),
    resolvePackage: (name) => `/fixture/node_modules/${name}/index.js`,
  })
  assert.ok(checks.some((item) => item.scope === 'desktop' && item.name === 'profile'))
  assert.ok(checks.some((item) => item.scope === 'web' && item.name === 'module resolution'))
  assert.ok(checks.some((item) => item.scope === 'dsh-home' && item.name === 'SenseVoice files'))
  const summary = summarizeChecks(checks)
  assert.equal(summary.exitCode, 0)
  assert.ok((summary.counts.WARN ?? 0) > 0)
  fs.rmSync(home, { recursive: true, force: true })
})

test('summarizeChecks returns 1 only for FAIL', () => {
  assert.equal(summarizeChecks([
    { status: 'PASS' },
    { status: 'WARN' },
    { status: 'SKIP' },
  ]).exitCode, 0)
  assert.equal(summarizeChecks([
    { status: 'PASS' },
    { status: 'FAIL' },
  ]).exitCode, 1)
})

test('main prints table and JSON with documented exit codes', () => {
  const home = tempDir()
  makeProfile(home, 'desktop')
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'fixture')
  const resolvePackage = (name) => `/fixture/node_modules/${name}/index.js`

  let table = ''
  const tableExit = main(['--dsh-home', home], {
    stdout: { write: (value) => { table += value } },
    now: Date.UTC(2026, 10, 12, 12, 0, 0),
    resolvePackage,
  })
  assert.equal(tableExit, 0)
  assert.match(table, /PASS\s+desktop\s+profile/)
  assert.match(table, /Summary:/)

  let json = ''
  const jsonExit = main(['--dsh-home', home, '--json'], {
    stdout: { write: (value) => { json += value } },
    now: Date.UTC(2026, 10, 12, 12, 0, 0),
    resolvePackage,
  })
  const payload = JSON.parse(json)
  assert.equal(jsonExit, 0)
  assert.equal(payload.summary.exitCode, 0)
  assert.ok(payload.checks.some((item) => item.name === 'module resolution'))

  let invalid = ''
  assert.equal(main(['--unknown'], { stdout: { write: (value) => { invalid += value } } }), 2)
  assert.match(invalid, /Unknown option/)
  fs.rmSync(home, { recursive: true, force: true })
})
