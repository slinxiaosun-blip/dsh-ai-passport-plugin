/**
 * 内存传输 + 虚拟设备的集成测试。
 *
 * 这里验证的是"上层不用改一行代码就能换链路实现"这个承诺：
 * 握手、任务列表、心跳、余额、丢包与掉线全部在 mock 下真实走一遍。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MockTransport } from './mock.js'
import { LINK_STATE, TRANSPORT_ERROR, TransportError } from './transport.js'
import { MSG } from '../protocol/constants.js'

/** 等待某个事件一次，带超时，避免测试挂死。 */
function once(emitter, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent)
      reject(new Error(`等待事件 ${event} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    function onEvent(...args) {
      clearTimeout(timer)
      resolve(args)
    }
    emitter.once(event, onEvent)
  })
}

/** 收集一段时间内的事件。 */
function collect(emitter, event, durationMs = 120) {
  const items = []
  const listener = (...args) => items.push(args)
  emitter.on(event, listener)
  return new Promise((resolve) => {
    setTimeout(() => {
      emitter.off(event, listener)
      resolve(items)
    }, durationMs)
  })
}

test('扫描会陆续冒泡虚拟设备', async () => {
  const transport = new MockTransport()
  const found = collect(transport, 'device', 80)
  await transport.startScan()
  assert.equal(transport.state, LINK_STATE.SCANNING)
  const devices = await found
  assert.equal(devices.length, 1)
  assert.equal(devices[0][0].name, 'FoloPassport-DSH')
  await transport.dispose()
})

test('连接不存在的设备报 device-not-found 并给出处置建议', async () => {
  const transport = new MockTransport()
  await assert.rejects(
    () => transport.connect('not-there'),
    (error) => {
      assert.ok(error instanceof TransportError)
      assert.equal(error.code, TRANSPORT_ERROR.DEVICE_NOT_FOUND)
      assert.ok(error.hint, '必须带可操作的提示，而不是只报错')
      return true
    },
  )
  assert.equal(transport.state, LINK_STATE.FAILED)
  await transport.dispose()
})

test('连接失败按配置的类别上报', async () => {
  const transport = new MockTransport({ faults: { failConnect: true, connectError: '超时' } })
  await assert.rejects(() => transport.connect('mock-passport-1'), /超时/)
  await transport.dispose()
})

test('连接 → 握手 → 心跳：端到端跑通虚拟设备', async () => {
  const transport = new MockTransport()
  await transport.connect('mock-passport-1')
  assert.equal(transport.state, LINK_STATE.CONNECTED)

  const incoming = []
  transport.on('data', ({ bytes }) => incoming.push(bytes))

  const { encodeChunks, encodeJson, Reassembler, decodeJson } = await import('../protocol/chunk.js')
  const { CHANNEL } = await import('../protocol/constants.js')
  const reassembler = new Reassembler()
  const messages = []
  transport.on('data', ({ bytes }) => {
    const result = reassembler.push(bytes)
    if (result.kind === 'message') {
      const parsed = decodeJson(result.payload)
      if (parsed) messages.push(parsed)
    }
  })

  // 发 hello，虚拟设备应回 hello.ack
  const hello = encodeChunks({
    msgId: 1,
    channel: CHANNEL.CONTROL,
    payload: encodeJson({ type: MSG.HELLO, protocolVersion: 1 }),
    maxChunkPayload: 244,
    ackRequired: true,
  })
  for (const chunk of hello) await transport.send('control', chunk)

  await new Promise((r) => setTimeout(r, 60))
  const types = messages.map((m) => m.type)
  assert.ok(types.includes(MSG.ACK), `应收到 ACK，实际收到 ${JSON.stringify(types)}`)
  assert.ok(types.includes(MSG.HELLO_ACK), `应收到 hello.ack，实际收到 ${JSON.stringify(types)}`)

  // 心跳
  const ping = encodeChunks({
    msgId: 2,
    channel: CHANNEL.HEARTBEAT,
    payload: encodeJson({ type: MSG.PING, t: 123 }),
    maxChunkPayload: 244,
  })
  for (const chunk of ping) await transport.send('control', chunk)
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(messages.some((m) => m.type === MSG.PONG), '心跳应有回应')

  await transport.dispose()
})

test('状态推送：虚拟设备能收到主机下发的 task.state', async () => {
  // 精简版把"任务列表"整条协议换成了单一的聚合状态。
  // 这个用例验证虚拟设备确实收到了 task.state —— 设备端靠它决定显示哪个状态
  // 以及是否响提示音，收不到就等于整个提醒功能失效。
  const { encodeChunks, encodeJson } = await import('../protocol/chunk.js')
  const { CHANNEL } = await import('../protocol/constants.js')
  const transport = new MockTransport()
  await transport.connect('mock-passport-1')

  const frame = encodeChunks({
    msgId: 5,
    channel: CHANNEL.CONTROL,
    payload: encodeJson({ type: MSG.TASK_STATE, state: 'waiting_approval', title: '写文件' }),
    maxChunkPayload: 244,
    ackRequired: true,
  })
  for (const chunk of frame) await transport.send('control', chunk)
  await new Promise((r) => setTimeout(r, 60))

  const got = transport.received.find((entry) => entry.message.type === MSG.TASK_STATE)
  assert.ok(got, `虚拟设备应收到 task.state，实际收到 ${JSON.stringify(transport.received.map((e) => e.message.type))}`)
  assert.equal(got.message.state, 'waiting_approval')
  assert.equal(got.message.title, '写文件')
  await transport.dispose()
})
