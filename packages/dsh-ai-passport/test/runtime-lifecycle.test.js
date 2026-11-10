/**
 * 运行时装配层的回归测试。
 *
 * 这里测的是 `createRuntime()` 里那些"看起来只是几行胶水、实际会静默失效"的地方：
 *   · connect() 的并发去重（面板连点两下 → 两次 startScan）；
 *   · dispose() 幂等（apply 重复调用时清理会跑不止一次）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRuntime } from '../lib/index.js'
import { normalizeConfig } from '../lib/config.js'
import { LINK_STATE } from '../lib/ble/transport.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function makeRuntime(overrides = {}) {
  const config = normalizeConfig({ transport: 'mock', autoConnect: false, ...overrides })
  const runtime = createRuntime({ config, logger: () => {} })
  return runtime
}

test('★ 并发 connect() 只触发一次 startScan（面板连点不会把扫描重置掉）', async () => {
  const runtime = await makeRuntime()

  let scans = 0
  const original = runtime.transport.startScan.bind(runtime.transport)
  runtime.transport.startScan = (...args) => {
    scans += 1
    return original(...args)
  }

  // 同一 tick 内连着点两下：旧实现会各自 start() 一次，第二次在已经是 SCANNING
  // 的状态下再要一次 startScan —— 底层要么报"already scanning"，要么把扫描重置。
  const [first, second] = await Promise.all([runtime.connect(), runtime.connect()])

  assert.equal(scans, 1, `并发 connect 只应扫描一次，实际 ${scans} 次`)
  assert.equal(first, second, '并发调用应当拿到同一个结果对象')

  await runtime.dispose()
})

test('★ 主动断开后再次 connect() 能正常连上（stop 不再把配置改脏）', async () => {
  const runtime = await makeRuntime({ autoReconnect: true })
  await runtime.connect()
  await sleep(60)
  assert.equal(runtime.link.state, LINK_STATE.CONNECTED)

  await runtime.disconnect()
  assert.equal(runtime.link.state, LINK_STATE.IDLE)
  assert.equal(runtime.config.autoReconnect, true, '断开不应改写配置对象')
  assert.equal(runtime.link.autoReconnect, true, '断开不应改写链路的重连开关')

  await runtime.connect()
  await sleep(80)
  assert.equal(runtime.link.state, LINK_STATE.CONNECTED, '断开之后必须还能重新连上')

  await runtime.dispose()
})

test('★ dispose() 幂等：重复调用不会抛错，也不会重复拆链路', async () => {
  const runtime = await makeRuntime()
  await runtime.connect()
  await sleep(40)

  await runtime.dispose()
  assert.equal(runtime.isDisposed, true)
  // 第二次应当直接返回（旧实现会在已经拆掉的传输上再等一轮超时）
  await runtime.dispose()
  assert.equal(runtime.isDisposed, true)
  assert.equal(runtime.link.state, LINK_STATE.IDLE)
})
