/**
 * HostLink 集成测试（基于 mock 传输 + 虚拟设备）。
 *
 * 覆盖的是链路层最容易被写错、也最难在真机上调试的几条路径：
 * 握手与版本协商、心跳与掉线判定、消息分发与回复、丢片后的 NACK 重传。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MockTransport } from './mock.js'
import { HostLink } from './host-link.js'
import { LINK_STATE } from './transport.js'
import { MSG, CHANNEL, PROTOCOL_VERSION } from '../protocol/constants.js'
import { encodeChunks, encodeJson } from '../protocol/chunk.js'

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

async function connectedLink(options = {}) {
  const transport = new MockTransport(options.transportOptions)
  const link = new HostLink({ transport, autoReconnect: false, logger: () => {} })
  const connected = waitFor(link, 'connected')
  await link.start()
  await connected
  // 握手是异步的，给它一点时间落地
  await new Promise((r) => setTimeout(r, 30))
  return { transport, link }
}

test('start() 扫描并自动连接目标设备，完成握手', async () => {
  const { transport, link } = await connectedLink()
  assert.equal(link.transport.state, LINK_STATE.CONNECTED)
  assert.ok(link.snapshot().device, '快照里应有已连接设备')
  assert.equal(link.snapshot().stats.messagesOut > 0, true, '握手应当发出过消息')
  await link.dispose()
  await transport.dispose()
})

test('设备上报 hello → deviceInfo 填充 → 主机回 hello.ack → 握手闭环', async () => {
  const transport = new MockTransport()
  const link = new HostLink({ transport, autoReconnect: false, logger: () => {} })
  // 真机方向：设备是握手发起方。mock 已复刻该方向，所以这里能测到完整闭环。
  const infoPromise = waitFor(link, 'device-info')
  const readyPromise = waitFor(link, 'ready')
  const connected = waitFor(link, 'connected')
  await link.start()
  await connected

  const [info] = await infoPromise
  assert.equal(info.protocolVersion, PROTOCOL_VERSION)
  assert.ok(info.batteryPercent > 0, '设备电量应随 hello 上报')
  assert.ok(info.capabilities > 0, '能力位应随 hello 上报')

  await readyPromise
  assert.equal(link.snapshot().handshakeComplete, true)
  assert.ok(transport.lastHelloAck, '主机应当回过 hello.ack')
  await link.dispose()
})

test('可以注册消息处理器并按类型分发', async () => {
  const { transport, link } = await connectedLink()
  const seen = []
  link.onMessage(MSG.BALANCE, (message) => {
    seen.push(message)
  })
  await link.send(MSG.BALANCE_REQ, {})
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].currency, 'CNY')
  assert.equal(seen[0].totalBalance, 42.5)
  await link.dispose()
  await transport.dispose()
})

test('处理器抛错不会打挂链路，只上报 handler-error', async () => {
  const { transport, link } = await connectedLink()
  // 用 balance.req → balance 这条仍然存在的消息对。
  // （原来用的是 task.list —— 精简版已把任务列表整条协议删掉了。）
  link.onMessage(MSG.BALANCE, () => {
    throw new Error('处理器内部故障')
  })
  const errored = waitFor(link, 'handler-error')
  await link.send(MSG.BALANCE_REQ, {})
  const [payload] = await errored
  assert.equal(payload.error.message, '处理器内部故障')
  // 链路仍然可用
  assert.equal(link.transport.state, LINK_STATE.CONNECTED)
  await link.dispose()
  await transport.dispose()
})

test('未注册处理器时进 unhandled，不抛错', async () => {
  const { transport, link } = await connectedLink()
  const unhandled = waitFor(link, 'unhandled')
  await link.send(MSG.BALANCE_REQ, {})
  const [message] = await unhandled
  assert.equal(message.type, MSG.BALANCE)
  await link.dispose()
})

test('丢片触发本地 gap 事件 + 回设备的 NACK，并计入 stats.gaps', async () => {
  const { transport, link } = await connectedLink()

  const gapSeen = waitFor(link, 'gap', 1500)

  // 直接构造一条三片的消息，丢掉中间那片再喂给链路 —— 这是唯一能确定性复现缺口的办法。
  // 依赖随机丢包去撞缺口会让这个用例变成偶发失败，那比没有用例更糟。
  const chunks = encodeChunks({
    msgId: 2424,
    channel: CHANNEL.CONTROL,
    payload: encodeJson({ type: 'task.list', items: Array.from({ length: 30 }, (_, i) => ({ sessionId: `s${i}` })) }),
    maxChunkPayload: 64,
  })
  assert.ok(chunks.length >= 3, '用例前提：该消息必须至少三片')

  // 模拟从 BLE 收到的分片：transport 的 data 事件就是链路的输入口
  transport.emit('data', { channel: 'control', bytes: chunks[0] })
  transport.emit('data', { channel: 'control', bytes: chunks[2] })
  transport.emit('data', { channel: 'control', bytes: chunks[1] })

  const [gap] = await gapSeen
  assert.equal(gap.msgId, 2424)
  assert.equal(gap.expectedSeq, 1)
  assert.equal(gap.gotSeq, 2)
  assert.ok(link.snapshot().stats.gaps >= 1)

  // 同时必须回设备一条 NACK，否则对端不知道该重传哪一条
  await new Promise((r) => setTimeout(r, 60))
  const nackMessage = transport.received.find((r) => r.message.type === MSG.NACK)
  assert.ok(nackMessage, '设备侧应当收到 NACK')
  assert.equal(nackMessage.message.msgId, 2424)
  await link.dispose()
  await transport.dispose()
})

test('设备主动掉线时进入 reconnecting（自动重连开启时）', async () => {
  const transport = new MockTransport()
  const link = new HostLink({ transport, autoReconnect: true, logger: () => {} })
  const connected = waitFor(link, 'connected')
  await link.start()
  await connected

  const reconnecting = waitFor(link, 'reconnecting', 3000)
  transport.simulateDrop('simulated')
  const [{ attempt, delayMs }] = await reconnecting
  assert.equal(attempt, 1)
  assert.ok(delayMs > 0)
  await link.dispose()
  await transport.dispose()
})

test('stop() 之后不再自动重连', async () => {
  const transport = new MockTransport()
  const link = new HostLink({ transport, autoReconnect: true, logger: () => {} })
  const connected = waitFor(link, 'connected')
  await link.start()
  await connected

  let reconnected = false
  link.on('reconnecting', () => { reconnected = true })
  await link.stop()
  transport.simulateDrop('after-stop')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(reconnected, false, 'stop() 之后不应再触发重连')
  await link.dispose()
  await transport.dispose()
})

test('发送控制消息会被虚拟设备确认（ACK 路径被真实覆盖）', async () => {
  const { transport, link } = await connectedLink()
  const result = await link.send(MSG.TASK_LIST_REQ, {})
  assert.ok(result.msgId >= 0)
  assert.ok(result.chunks >= 1)
  const acked = waitFor(link, 'pong').catch(() => null)
  await acked
  // ACK 不产生事件，但会释放 msgId；这里断言在途数量归零
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(link.snapshot().stats.inFlight, 0, 'ACK 到达后不应有在途消息')
  await link.dispose()
  await transport.dispose()
})

test('快照包含面板需要的全部字段', async () => {
  const { transport, link } = await connectedLink()
  const snapshot = link.snapshot()
  for (const key of ['transport', 'state', 'device', 'deviceInfo', 'mtuPayload', 'stats', 'lastError', 'reconnectAttempt']) {
    assert.ok(key in snapshot, `快照缺少字段 ${key}`)
  }
  assert.equal(snapshot.transport, 'mock')
  await link.dispose()
  await transport.dispose()
})

test('hello 不带电量 → batteryPercent 是 null 而不是 0', async () => {
  // 真实反馈的缺陷：旧写法 `Number(x)||0` 把"设备没上报"变成 0，
  // 面板的 0 又是 falsy，于是"没报"和"真 0%"都显示成 "—"，无法区分。
  const transport = new MockTransport()
  delete transport.devices.get('mock-passport-1').batteryPercent
  const link = new HostLink({ transport, autoReconnect: false, logger: () => {} })
  const infoPromise = waitFor(link, 'device-info')
  await link.start()
  const [info] = await infoPromise
  assert.equal(info.batteryPercent, null, '未上报的电量应为 null')
  await link.dispose()
  await transport.dispose()
})

test('断线后 deviceInfo 保留：固件版本不在重连窗口里闪成 —', async () => {
  const { transport, link } = await connectedLink()
  const before = link.snapshot().deviceInfo
  assert.ok(before?.firmware, '握手后应有固件版本')
  await transport.disconnect('test')
  const after = link.snapshot().deviceInfo
  assert.equal(after?.firmware, before.firmware, '断线不应清掉固件版本')
  assert.equal(link.snapshot().handshakeComplete, false, '握手状态仍应复位')
  await link.dispose()
  await transport.dispose()
})
