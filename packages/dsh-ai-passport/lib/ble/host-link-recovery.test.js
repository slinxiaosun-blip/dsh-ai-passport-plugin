/**
 * 链路状态机回归测试（2026-11 审计的四条 P0）。
 *
 * 这四条的共同点：**都不会报错**，只会在特定时序下静默失效，而且真机上极难复现——
 *   · `HostLink` 没有 `state` 属性 → 连接去重判断永不生效，返回值里也没有状态；
 *   · `stop()` 顺手把 autoReconnect 配置改成 false → 断开一次之后永远不再自动重连；
 *   · 心跳判死时没标 unexpected → 最需要重连的场景反而不重连；
 *   · 只有 pong 才算心跳存活 → 语音上行把控制通道挤满时被误判掉线。
 *
 * 因此它们必须靠假时钟 + 真实链路来钉住，而不是靠人肉回归。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MockTransport } from './mock.js'
import { HostLink } from './host-link.js'
import { LINK_STATE } from './transport.js'
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_MISS_LIMIT, MSG } from '../protocol/constants.js'

function waitFor(emitter, event, timeoutMs = 2000) {
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 起一条已经连上并完成握手的链路。 */
async function connectedLink(options = {}) {
  const transport = new MockTransport(options.transportOptions)
  const link = new HostLink({
    transport,
    autoReconnect: options.autoReconnect ?? false,
    logger: options.logger ?? (() => {}),
  })
  const connected = waitFor(link, 'connected')
  await link.start()
  await connected
  await sleep(30)
  return { transport, link }
}

test('★ link.state 是 transport.state 的投影（连接去重与返回值都读它）', async () => {
  const transport = new MockTransport()
  const link = new HostLink({ transport, autoReconnect: false, logger: () => {} })

  assert.equal(link.state, transport.state, '未连接时也应与传输状态一致')
  assert.equal(link.state, LINK_STATE.IDLE)

  const connected = waitFor(link, 'connected')
  await link.start()
  await connected
  await sleep(20)
  assert.equal(link.state, LINK_STATE.CONNECTED, '连上后 link.state 必须是 connected')

  await link.dispose()
})

test('★ stop() 不改写 autoReconnect 配置：再次 start() 后自动重连仍然有效', async () => {
  const { transport, link } = await connectedLink({ autoReconnect: true })

  await link.stop('user')
  // 旧实现把 this.autoReconnect 直接改成 false —— 配置项被永久改脏。
  assert.equal(link.autoReconnect, true, 'stop() 不应改写配置里的 autoReconnect')
  assert.equal(link.userStopped, true, 'stop() 应只置"本轮主动断开"标记')

  // 用户重新点连接 → 标记清除，自动重连恢复
  const again = waitFor(link, 'connected')
  await link.start()
  await again
  await sleep(20)
  assert.equal(link.userStopped, false, 'start() 必须清除主动断开标记')
  assert.equal(link.state, LINK_STATE.CONNECTED)

  const reconnecting = waitFor(link, 'reconnecting')
  transport.simulateDrop('test-drop')
  const [payload] = await reconnecting
  assert.equal(payload.attempt, 1, '掉线后应当排上重连（旧实现在这里不会重连）')

  await link.dispose()
})

test('★ 用户主动断开后，设备侧掉线不再触发重连', async () => {
  const { transport, link } = await connectedLink({ autoReconnect: true })

  let reconnects = 0
  link.on('reconnecting', () => {
    reconnects += 1
  })

  await link.stop('user')
  transport.simulateDrop('after-stop')
  await sleep(50)

  assert.equal(reconnects, 0, '用户已经主动断开，不该再自动重连')
  await link.dispose()
})

test('★ 心跳判死按"意外掉线"处理：标记 unexpected 并排上重连', async (t) => {
  // 心跳是 5s 一次、连续 7 次无响应才判死 —— 真实等待要 35s，只能用假时钟。
  t.mock.timers.enable({ apis: ['setInterval'] })

  // autoRespond=false：虚拟设备不回 pong，也不回任何业务应答。
  const transport = new MockTransport({ autoRespond: false })
  const link = new HostLink({ transport, autoReconnect: true, logger: () => {} })

  const connected = waitFor(link, 'connected')
  await link.start()
  await connected
  await sleep(30)

  const reconnecting = waitFor(link, 'reconnecting')
  // 判死阈值是"超过 HEARTBEAT_MISS_LIMIT 次"，多打一轮确保越线。
  for (let i = 0; i < HEARTBEAT_MISS_LIMIT + 2; i += 1) {
    t.mock.timers.tick(HEARTBEAT_INTERVAL_MS)
    await sleep(2) // 让 send / disconnect 的微任务落地
  }

  const [payload] = await reconnecting
  assert.equal(payload.attempt, 1)
  assert.equal(link.lastDisconnect.reason, 'heartbeat-timeout')
  assert.equal(
    link.lastDisconnect.unexpected,
    true,
    '心跳判死必须标成意外掉线，否则上层不会重连（旧缺陷）',
  )
  assert.equal(link.state, LINK_STATE.IDLE, '断链后应回到 idle')

  await link.dispose()
})

test('★ 收到任意控制消息都算心跳存活，不只 pong', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })

  const transport = new MockTransport({ autoRespond: false })
  const link = new HostLink({ transport, autoReconnect: false, logger: () => {} })

  const connected = waitFor(link, 'connected')
  await link.start()
  await connected
  await sleep(30)

  let timeouts = 0
  link.on('disconnected', (payload) => {
    if (payload.reason === 'heartbeat-timeout') timeouts += 1
  })

  // 每 3 次心跳插一条设备消息（这里用 balance：业务上无副作用，但证明对端活着）。
  // 累计心跳次数远超判死阈值，只要它一直被清零就不会掉线。
  for (let round = 0; round < 4; round += 1) {
    for (let i = 0; i < 3; i += 1) {
      t.mock.timers.tick(HEARTBEAT_INTERVAL_MS)
      await sleep(2)
    }
    transport.emitFromDevice({ type: MSG.BALANCE, currency: 'CNY', totalBalance: 1 })
    await sleep(5)
  }

  assert.equal(timeouts, 0, '收得到设备消息就说明对端在线，不该被判掉线')
  assert.equal(link.state, LINK_STATE.CONNECTED)

  await link.dispose()
})
