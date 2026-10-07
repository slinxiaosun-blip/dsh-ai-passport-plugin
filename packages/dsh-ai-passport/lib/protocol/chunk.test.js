/**
 * 分片层单元测试。
 *
 * 这些用例守住的是"重传不导致重复投递""缺片必须整条丢弃"这两条安全相关的不变量——
 * 审批消息走的就是这条路径，任何一条断言被放松都需要重新评估审批的防误触设计。
 *
 * 运行：node --test packages/dsh-ai-passport/lib/protocol/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  Reassembler,
  PendingAcks,
  MsgIdAllocator,
  encodeChunks,
  decodeHeader,
  encodeJson,
  decodeJson,
} from './chunk.js'
import { CHANNEL, FLAG, MAX_CHUNKS, PROTOCOL_VERSION } from './constants.js'

/** 把一个 chunk 的 flags 换成新的值，便于构造异常序列。 */
function withFlags(chunk, flags) {
  const out = new Uint8Array(chunk)
  out[0] = ((out[0] >> 4) << 4) | (flags & 0x0f)
  return out
}

test('帧头编解码可往返', () => {
  const [chunk] = encodeChunks({
    msgId: 0xabc,
    channel: CHANNEL.CONTROL,
    payload: encodeJson({ hello: 'world' }),
    ackRequired: true,
  })
  const frame = decodeHeader(chunk)
  assert.equal(frame.version, PROTOCOL_VERSION)
  assert.equal(frame.msgId, 0xabc)
  assert.equal(frame.channel, CHANNEL.CONTROL)
  assert.equal(frame.seq, 0)
  assert.ok(frame.flags & FLAG.FIRST)
  assert.ok(frame.flags & FLAG.LAST)
  assert.ok(frame.flags & FLAG.ACK_REQ)
  assert.deepEqual(decodeJson(frame.payload), { hello: 'world' })
})

test('msgId 边界：0 与 4095 都可编码，越界抛错', () => {
  for (const msgId of [0, 4095]) {
    const [chunk] = encodeChunks({ msgId, channel: 0, payload: new Uint8Array(1) })
    assert.equal(decodeHeader(chunk).msgId, msgId)
  }
  assert.throws(() => encodeChunks({ msgId: 4096, channel: 0, payload: new Uint8Array(1) }), RangeError)
  assert.throws(() => encodeChunks({ msgId: -1, channel: 0, payload: new Uint8Array(1) }), RangeError)
})

test('超长载荷被拒绝，而不是静默截断', () => {
  const tooBig = new Uint8Array(MAX_CHUNKS * 512 + 1)
  assert.throws(
    () => encodeChunks({ msgId: 1, channel: 0, payload: tooBig, maxChunkPayload: 512 }),
    RangeError,
  )
})

test('单片消息直接投递', () => {
  const payload = encodeJson({ type: 'ping' })
  const chunks = encodeChunks({ msgId: 7, channel: CHANNEL.HEARTBEAT, payload })
  const reassembler = new Reassembler()
  const result = reassembler.push(chunks[0])
  assert.equal(result.kind, 'message')
  assert.equal(result.msgId, 7)
  assert.deepEqual(decodeJson(result.payload), { type: 'ping' })
})

test('多片消息按序重组，内容与原文逐字节一致', () => {
  const payload = new Uint8Array(1000)
  for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251

  const chunks = encodeChunks({ msgId: 42, channel: CHANNEL.CONTROL, payload, maxChunkPayload: 128 })
  assert.equal(chunks.length, 8)
  assert.equal(decodeHeader(chunks[0]).flags & FLAG.FIRST, FLAG.FIRST)
  assert.equal(decodeHeader(chunks.at(-1)).flags & FLAG.LAST, FLAG.LAST)

  const reassembler = new Reassembler()
  let delivered = null
  for (const chunk of chunks) {
    const result = reassembler.push(chunk)
    if (result.kind === 'message') delivered = result
  }
  assert.ok(delivered, '整条消息应当被投递')
  assert.deepEqual([...delivered.payload], [...payload])
})

test('缺片时整条丢弃并报告缺口，不做无界缓存', () => {
  const payload = new Uint8Array(600)
  const chunks = encodeChunks({ msgId: 9, channel: CHANNEL.CONTROL, payload, maxChunkPayload: 128 })
  const reassembler = new Reassembler()

  assert.equal(reassembler.push(chunks[0]).kind, 'incomplete')
  // 跳过第 1 片，直接送第 2 片
  const gap = reassembler.push(chunks[2])
  assert.equal(gap.kind, 'gap')
  assert.equal(gap.msgId, 9)
  assert.equal(gap.expectedSeq, 1)
  assert.equal(gap.gotSeq, 2)
  // 整条已丢弃，残余状态不能留在内存里
  assert.equal(reassembler.stats().messages, 0)
  // 缺口之后剩下的片到达时视为 stale，而不是拼出半条消息
  assert.equal(reassembler.push(chunks[3]).kind, 'stale')
})

test('重传的重复片不会导致重复投递', () => {
  const payload = encodeJson({ type: 'task.list', items: ['a', 'b', 'c'] })
  const chunks = encodeChunks({ msgId: 11, channel: CHANNEL.CONTROL, payload, maxChunkPayload: 8, ackRequired: true })
  assert.ok(chunks.length > 1)

  const reassembler = new Reassembler()
  const delivered = []
  // 前一片重复送三次（模拟 ACK 丢失后的重传）
  for (let i = 0; i < 3; i += 1) {
    const r = reassembler.push(chunks[0])
    if (r.kind === 'message') delivered.push(r)
  }
  for (let i = 1; i < chunks.length; i += 1) {
    const r = reassembler.push(chunks[i])
    if (r.kind === 'message') delivered.push(r)
  }
  assert.equal(delivered.length, 1, '同一条消息只能投递一次')
  assert.deepEqual(decodeJson(delivered[0].payload).items, ['a', 'b', 'c'])
})

test('没有 FIRST 的中间片按 stale 处理', () => {
  const payload = new Uint8Array(400)
  const chunks = encodeChunks({ msgId: 5, channel: 0, payload, maxChunkPayload: 128 })
  const reassembler = new Reassembler()
  const result = reassembler.push(chunks[1])
  assert.equal(result.kind, 'stale')
})

test('单消息字节上限被强制，异常对端不能撑爆内存', () => {
  const reassembler = new Reassembler({ maxMessageBytes: 300 })
  const payload = new Uint8Array(900)
  const chunks = encodeChunks({ msgId: 3, channel: 0, payload, maxChunkPayload: 200 })
  let overflow = null
  for (const chunk of chunks) {
    const r = reassembler.push(chunk)
    if (r.kind === 'overflow') { overflow = r; break }
  }
  assert.ok(overflow, '超过上限必须报 overflow')
  assert.equal(reassembler.stats().messages, 0)
})

test('断链后 clear() 释放全部待重组状态', () => {
  const payload = new Uint8Array(600)
  const chunks = encodeChunks({ msgId: 1, channel: 0, payload, maxChunkPayload: 128 })
  const reassembler = new Reassembler()
  reassembler.push(chunks[0])
  assert.equal(reassembler.stats().messages, 1)
  reassembler.clear()
  assert.equal(reassembler.stats().messages, 0)
})

test('ACK 超时触发固定次数重传后放弃', async () => {
  const chunks = encodeChunks({ msgId: 1, channel: 0, payload: new Uint8Array(4) })
  let sends = 0
  const givenUp = []
  const acks = new PendingAcks({
    timeoutMs: 5,
    maxRetries: 2,
    onGiveUp: (msgId) => givenUp.push(msgId),
  })
  acks.track(1, chunks, () => { sends += 1 })

  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(sends, 2, '应当恰好重传 maxRetries 次')
  assert.deepEqual(givenUp, [1])
  assert.equal(acks.stats().inFlight, 0)
})

test('ACK 到达后停止重传', async () => {
  const chunks = encodeChunks({ msgId: 2, channel: 0, payload: new Uint8Array(4) })
  let sends = 0
  const acks = new PendingAcks({ timeoutMs: 5, maxRetries: 3 })
  acks.track(2, chunks, () => { sends += 1 })
  assert.equal(acks.acknowledge(2), true)
  assert.equal(acks.acknowledge(2), false, '重复 ACK 不应报成功')

  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(sends, 0)
})

test('消息号分配器回绕时跳过在途号', () => {
  const allocator = new MsgIdAllocator()
  const first = allocator.allocate()
  assert.equal(first, 0)

  // 占满除了一个之外的所有号
  const held = []
  for (let i = 1; i < 0xfff; i += 1) held.push(allocator.allocate())
  // 此时只剩 4095 可用
  const last = allocator.allocate()
  assert.equal(last, 0xfff)

  // 全部在途 → 必须抛错而不是无限循环或撞号
  assert.throws(() => allocator.allocate(), /消息号耗尽/)

  allocator.release(first)
  assert.equal(allocator.allocate(), first)
})

test('构造异常序列：只有 FIRST 但与 LAST 同片时的标记可被正确识别', () => {
  const [single] = encodeChunks({ msgId: 1, channel: 0, payload: new Uint8Array(4) })
  // 去掉 LAST 位后不应投递
  const noLast = withFlags(single, FLAG.FIRST)
  const reassembler = new Reassembler()
  assert.equal(reassembler.push(noLast).kind, 'incomplete')
})
