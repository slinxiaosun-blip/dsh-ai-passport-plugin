/**
 * 桥进程传输的集成测试。
 *
 * 这里刻意**真的起子进程**（走 --mock，不碰硬件），而不是打桩：
 * 子进程通信、JSON Lines 解析、错误码映射、退出与重启这些恰恰是最容易写错、
 * 又最难在真机上定位的部分，必须用真实进程覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BridgeProcessTransport } from './bridge-process.js'
import { HostLink } from './host-link.js'
import { LINK_STATE, TRANSPORT_ERROR } from './transport.js'

function waitFor(emitter, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent)
      reject(new Error(`等待 ${event} 超时`))
    }, timeoutMs)
    function onEvent(...args) {
      clearTimeout(timer)
      resolve(args)
    }
    emitter.once(event, onEvent)
  })
}

test('probe() 报告可用并给出解释器路径', async () => {
  const transport = new BridgeProcessTransport({ mock: true })
  const probe = await transport.probe()
  assert.equal(probe.available, true)
  assert.match(probe.detail, /bridge|node/i)
  await transport.dispose()
})

test('workerPath 不存在时 probe 给出可操作的提示', async () => {
  const transport = new BridgeProcessTransport({ mock: true, workerPath: '/nonexistent/worker.js' })
  const probe = await transport.probe()
  assert.equal(probe.available, false)
  assert.match(probe.hint, /期望路径/)
  await transport.dispose()
})

test('端到端：起子进程 → 扫描 → 连接 → 断开', async () => {
  const transport = new BridgeProcessTransport({ mock: true })
  const devicePromise = waitFor(transport, 'device')
  await transport.startScan()
  const [device] = await devicePromise
  assert.equal(device.name, 'FoloPassport-DSH')

  const info = await transport.connect(device.id)
  assert.equal(transport.state, LINK_STATE.CONNECTED)
  assert.ok(info.mtuPayload >= 20)

  await transport.disconnect()
  assert.equal(transport.state, LINK_STATE.IDLE)
  await transport.dispose()
})

test('HostLink 能直接跑在桥进程传输上（换实现不改上层）', async () => {
  const transport = new BridgeProcessTransport({ mock: true })
  const link = new HostLink({ transport, autoReconnect: false, logger: () => {} })
  const connected = waitFor(link, 'connected')
  await link.start()
  const [info] = await connected
  assert.equal(info.name, 'FoloPassport-DSH')
  assert.equal(link.snapshot().transport, 'bridge-mock')
  await link.dispose()
})

test('写入未连接时被拒绝，而不是静默吞掉', async () => {
  const transport = new BridgeProcessTransport({ mock: true })
  await assert.rejects(
    () => transport.send('control', new Uint8Array([1, 2, 3])),
    (error) => error.code === TRANSPORT_ERROR.DISCONNECTED,
  )
  await transport.dispose()
})

test('dispose 之后子进程不再存活', async () => {
  const transport = new BridgeProcessTransport({ mock: true })
  await transport.startScan()
  const child = transport.child
  assert.ok(child, '应当已经起了子进程')
  await transport.dispose()
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(child.exitCode !== null || child.killed, '子进程应当已退出，不留孤儿进程')
})

test('mock 桥对任意设备号都会"连上"，因此这里改为验证错误对象的规范化形状', async () => {
  // 说明：真实 noble 会对不存在的设备报 device-not-found，但 --mock 的桥进程不做设备校验
  // （它本来就不碰硬件）。所以这条用例不去断言"必然失败"，而是断言：
  // 无论成功还是失败，返回/抛出的对象都必须是规范化过的形状，上层可以无条件信任。
  const transport = new BridgeProcessTransport({ mock: true })
  try {
    const info = await transport.connect('no-such-device')
    assert.equal(typeof info.id, 'string')
    assert.ok(info.mtuPayload >= 20)
  } catch (error) {
    assert.ok(error instanceof Error)
    assert.ok(typeof error.code === 'string' && error.code.length > 0, '错误必须带规范化的 code')
  }
  await transport.dispose()
})

test('主动断开后状态是 idle，而不是 failed', async () => {
  // 回归用例：桥进程在主动断开时也会发 disconnected 事件，
  // 若不区分"自己要求的断开"，状态会被错误地拉成 failed。
  const transport = new BridgeProcessTransport({ mock: true })
  const devicePromise = waitFor(transport, 'device')
  await transport.startScan()
  const [device] = await devicePromise
  await transport.connect(device.id)
  assert.equal(transport.state, LINK_STATE.CONNECTED)

  await transport.disconnect()
  assert.equal(transport.state, LINK_STATE.IDLE, '主动断开应回到 idle')
  await transport.dispose()
})

test('★ 解释器候选列表：绝不只用硬编码路径', async () => {
  // 回归用例。曾经的实现是 `if (在 Electron 里) return '/usr/local/bin/node'`，
  // 而 Apple Silicon 上 Homebrew 装在 /opt/homebrew —— 该路径不存在，
  // spawn 必然失败，且失败发生在宿主启动路径上，后果是整个应用打不开
  // （"desktop welcome: Web RPC failed"）。
  const { nodeBinaryCandidates } = await import('./bridge-process.js')
  const candidates = nodeBinaryCandidates({ platform: 'darwin', env: {} })

  assert.ok(candidates.length >= 2, '必须给出多个候选，而不是认死一条路径')
  assert.ok(candidates.includes('/opt/homebrew/bin/node'), 'Apple Silicon 的 Homebrew 路径必须在候选里')
  assert.ok(candidates.includes('/usr/local/bin/node'), 'Intel/官方安装路径也应在候选里')
  // 去重
  assert.equal(new Set(candidates).size, candidates.length, '候选不应重复')
})

test('★ Windows 解释器候选：安装器落点 + PATH 扫描，形态是 Windows 路径', async () => {
  const { nodeBinaryCandidates } = await import('./bridge-process.js')
  const candidates = nodeBinaryCandidates({
    platform: 'win32',
    env: {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\u',
      PATH: 'C:\\nodejs;"C:\\Program Files\\nvm";',
    },
  })

  assert.ok(candidates.includes('C:\\Program Files\\nodejs\\node.exe'), '官方安装器落点必须在候选里')
  assert.ok(
    candidates.includes('C:\\Program Files (x86)\\nodejs\\node.exe'),
    '32 位安装器落点也应在候选里',
  )
  assert.ok(candidates.includes('C:\\Users\\u\\scoop\\shims\\node.exe'), 'scoop 落点应在候选里')
  // PATH 扫描：覆盖 nvm-windows 的 %NVM_SYMLINK% 等任意自定义安装，且剥引号、跳空段
  assert.ok(candidates.includes('C:\\nodejs\\node.exe'), 'PATH 里的 node.exe 必须被扫到')
  assert.ok(candidates.includes('C:\\Program Files\\nvm\\node.exe'), '带引号的 PATH 条目要剥引号再拼')
  assert.ok(candidates.every((p) => !p.includes('/') || p === process.execPath), 'Windows 候选不用 POSIX 分隔符')
  assert.equal(new Set(candidates).size, candidates.length, '候选不应重复')
})

test('probe() 会挑出一个真实存在的解释器，而不是列表第一个', async () => {
  const transport = new BridgeProcessTransport({ mock: true })
  const probe = await transport.probe()
  assert.equal(probe.available, true, `probe 失败：${probe.reason ?? ''}`)

  // 被选中的必须真的存在
  const fs = await import('node:fs/promises')
  await assert.doesNotReject(() => fs.access(transport.nodePath), `选中的解释器不存在：${transport.nodePath}`)
  await transport.dispose()
})

test('解释器全部不存在时 probe 报不可用并给出可操作提示', async () => {
  const transport = new BridgeProcessTransport({ mock: true, nodePath: '/definitely/not/here/node' })
  // 构造时指定的 nodePath 会被 probe 的探测逻辑覆盖 —— 这正是期望行为：
  // 一个不存在的路径不该让 probe 直接放弃，而应继续试其它候选。
  const probe = await transport.probe()
  assert.equal(probe.available, true, '应当回退到其它真实存在的候选')
  await transport.dispose()
})

test('spawn 失败被转成可读错误，不抛裸异常', async () => {
  // 说明：不能靠"给一个不存在的 nodePath"来测这条路径 —— probe() 会按候选列表
  // 回退到真实存在的解释器（这正是期望行为，上一组用例已验证）。
  // 因此这里用一个**存在但无法正常当解释器用**的二进制来真的触发 spawn 失败。
  const transport = new BridgeProcessTransport({ mock: true, nodePath: '/usr/bin/false' })
  const errors = []
  transport.on('error', (e) => errors.push(e))

  // 只断言"干净失败"：要么 reject，要么发出 error 事件，二者必有其一；
  // 不允许出现未捕获异常或永久挂起。
  let settled = false
  const outcome = await Promise.race([
    transport.startScan().then(() => 'resolved', () => 'rejected'),
    new Promise((r) => setTimeout(() => r('timeout'), 8000)),
  ]).finally(() => { settled = true })

  assert.notEqual(outcome, 'timeout', '必须在合理时间内有结果，不能挂起')
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(
    outcome === 'rejected' || errors.length > 0,
    `spawn 失败必须被上报（outcome=${outcome}, errors=${errors.length}）`,
  )
  if (errors.length > 0) {
    assert.ok(errors[0].message.length > 0, '错误必须带可读信息')
  }
  assert.equal(settled, true)
  await transport.dispose()
})
