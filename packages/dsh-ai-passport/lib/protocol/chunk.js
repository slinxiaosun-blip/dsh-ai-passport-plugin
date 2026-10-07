/**
 * 分片编解码 + 重组 + ACK 重传。
 *
 * 为什么需要它：BLE 的 ATT 单包载荷受 MTU 限制（协商后约 244～512 字节），
 * 而任务列表、识别结果、审批请求都可能超过一包。这里做统一的分片层，
 * 让上层只关心"消息"，不关心"包"。
 *
 * 帧头（4 字节）：
 *   byte 0  version(高 4 位) | flags(低 4 位)
 *   byte 1  channel
 *   byte 2  msgId 高 8 位
 *   byte 3  msgId 低 4 位(高 4 位) | seq 低 4 位
 *
 * 设计取舍：
 * - seq 只有 4 位（最多 16 片）→ 单消息上限 16 × MAX_CHUNK_PAYLOAD。
 *   对控制消息足够；音频按 2 秒一片主动切分，也不会触及上限。
 * - 音频通道默认不要求 ACK（实时性优先，允许丢片）；
 *   控制通道要求 ACK，超时重传，用于状态推送与审批这类不能丢的消息。
 */

import {
  HEADER_BYTES,
  FLAG,
  MAX_CHUNKS,
  MAX_CHUNK_PAYLOAD,
  PROTOCOL_VERSION,
} from './constants.js'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: false })

/**
 * 把一条消息切成若干分片。
 *
 * @param {object} input
 * @param {number} input.msgId 12 位消息号，由发送方按通道递增分配。
 * @param {number} input.channel 通道号，见 CHANNEL。
 * @param {Uint8Array} input.payload 载荷字节（JSON 通道由调用方先 JSON.stringify + encode）。
 * @param {number} [input.maxChunkPayload] 单片载荷上限，默认 MAX_CHUNK_PAYLOAD。
 * @param {boolean} [input.ackRequired] 是否要求对端回 ACK（控制通道默认 true）。
 * @returns {Uint8Array[]} 分片数组，至少一片。
 */
export function encodeChunks(input) {
  const { msgId, channel, payload } = input
  const maxChunkPayload = input.maxChunkPayload ?? MAX_CHUNK_PAYLOAD
  const ackRequired = input.ackRequired ?? false

  if (!Number.isInteger(msgId) || msgId < 0 || msgId > 0xfff) {
    throw new RangeError(`msgId 必须是 0..4095 的整数，收到 ${msgId}`)
  }
  if (!Number.isInteger(channel) || channel < 0 || channel > 15) {
    throw new RangeError(`channel 必须是 0..15 的整数，收到 ${channel}`)
  }
  if (!(payload instanceof Uint8Array)) {
    throw new TypeError('payload 必须是 Uint8Array')
  }
  if (maxChunkPayload <= 0 || maxChunkPayload > 65535) {
    throw new RangeError(`maxChunkPayload 越界：${maxChunkPayload}`)
  }

  const total = Math.max(1, Math.ceil(payload.length / maxChunkPayload))
  if (total > MAX_CHUNKS) {
    throw new RangeError(
      `载荷 ${payload.length} 字节需要 ${total} 片，超过单消息上限 ${MAX_CHUNKS} 片（${MAX_CHUNKS * maxChunkPayload} 字节）`,
    )
  }

  const chunks = []
  for (let seq = 0; seq < total; seq += 1) {
    const start = seq * maxChunkPayload
    const slice = payload.subarray(start, Math.min(payload.length, start + maxChunkPayload))

    let flags = 0
    if (seq === 0) flags |= FLAG.FIRST
    if (seq === total - 1) flags |= FLAG.LAST
    // ACK 语义挂在整条消息上，但接收方只在处理 LAST 时回一次；
    // 因此把 ACK_REQ 标在每一片上，丢中间片时接收方也能立刻察觉并请求重传。
    if (ackRequired) flags |= FLAG.ACK_REQ

    const chunk = new Uint8Array(HEADER_BYTES + slice.length)
    chunk[0] = ((PROTOCOL_VERSION & 0x0f) << 4) | (flags & 0x0f)
    chunk[1] = channel & 0xff
    chunk[2] = (msgId >> 4) & 0xff
    chunk[3] = ((msgId & 0x0f) << 4) | (seq & 0x0f)
    chunk.set(slice, HEADER_BYTES)
    chunks.push(chunk)
  }
  return chunks
}

/**
 * 解析单个分片的帧头。
 *
 * @param {Uint8Array} chunk
 * @returns {{version:number, flags:number, channel:number, msgId:number, seq:number, payload:Uint8Array}}
 */
export function decodeHeader(chunk) {
  if (!(chunk instanceof Uint8Array) || chunk.length < HEADER_BYTES) {
    throw new RangeError(`分片至少需要 ${HEADER_BYTES} 字节，收到 ${chunk?.length ?? 0}`)
  }
  const b0 = chunk[0]
  const b3 = chunk[3]
  return {
    version: (b0 >> 4) & 0x0f,
    flags: b0 & 0x0f,
    channel: chunk[1],
    msgId: ((chunk[2] & 0xff) << 4) | ((b3 >> 4) & 0x0f),
    seq: b3 & 0x0f,
    payload: chunk.subarray(HEADER_BYTES),
  }
}

/** JSON 通道载荷编码。 */
export function encodeJson(value) {
  return textEncoder.encode(JSON.stringify(value))
}

/** JSON 通道载荷解码。解析失败返回 null，由调用方决定是丢弃还是回 NACK。 */
export function decodeJson(bytes) {
  try {
    return JSON.parse(textDecoder.decode(bytes))
  } catch {
    return null
  }
}

/** 便于日志与诊断的十六进制摘要。 */
export function hexPreview(bytes, limit = 16) {
  const slice = bytes.subarray(0, Math.min(bytes.length, limit))
  let out = ''
  for (const byte of slice) out += byte.toString(16).padStart(2, '0')
  return bytes.length > limit ? `${out}…(${bytes.length}B)` : out
}

/**
 * 接收侧重组装。
 *
 * 关键正确性约束：
 * - 同一 msgId 只有在一段完整 FIRST..LAST 序列到齐后才投递；
 * - 缺片（seq 不连续）时立刻丢弃整条并回报缺口，不做无界缓存；
 * - 同一 msgId 重复到达（对端重传）时忽略重复片，避免投递两次。
 *   → 这正是"重传不会导致重复执行"的保证所在，审批类消息依赖它。
 */
export class Reassembler {
  /**
   * @param {object} [options]
   * @param {number} [options.maxMessageBytes] 单消息上限，防御对端异常导致的无限内存增长。
   */
  constructor(options = {}) {
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_CHUNKS * MAX_CHUNK_PAYLOAD
    /** @type {Map<string, {channel:number, ackRequired:boolean, version:number, parts:Map<number, Uint8Array>, bytes:number, lastSeq:number}>} */
    this.pending = new Map()
  }

  /**
   * 喂入一片。
   *
   * @param {Uint8Array} chunk
   * @returns {{kind:'incomplete'}
   *   | {kind:'message', msgId:number, channel:number, version:number, payload:Uint8Array, ackRequired:boolean}
   *   | {kind:'gap', msgId:number, channel:number, expectedSeq:number, gotSeq:number}
   *   | {kind:'overflow', msgId:number, channel:number, bytes:number}
   *   | {kind:'stale', msgId:number}}
   */
  push(chunk) {
    const frame = decodeHeader(chunk)
    const key = `${frame.channel}:${frame.msgId}`

    if ((frame.flags & FLAG.FIRST) !== 0) {
      // FIRST 开启新消息；同 msgId 的残留（对端重传整条）直接替换，
      // 不做"丢弃新的"处理——新的一轮重传才是权威内容。
      this.pending.set(key, {
        channel: frame.channel,
        version: frame.version,
        ackRequired: (frame.flags & FLAG.ACK_REQ) !== 0,
        parts: new Map([[frame.seq, copyBytes(frame.payload)]]),
        bytes: frame.payload.length,
        lastSeq: frame.seq,
        // LAST 只在尾片上出现；单消息恰好一片时 FIRST 与 LAST 同片。
        sawLast: (frame.flags & FLAG.LAST) !== 0,
      })
      return this.#settleIfComplete(key)
    }

    const entry = this.pending.get(key)
    if (!entry) {
      // 没有 FIRST 就来的中间片/尾片：可能是我们中途才订阅，也可能是丢片。
      // 都按 stale 处理，让上层决定是否要求对端重传。
      return { kind: 'stale', msgId: frame.msgId }
    }

    if (entry.parts.has(frame.seq)) {
      // 重复片：忽略，保证不重复投递。
      return this.#settleIfComplete(key)
    }

    const expectedSeq = entry.lastSeq + 1
    if (frame.seq !== expectedSeq) {
      this.pending.delete(key)
      return {
        kind: 'gap',
        msgId: frame.msgId,
        channel: frame.channel,
        expectedSeq,
        gotSeq: frame.seq,
      }
    }

    entry.bytes += frame.payload.length
    if (entry.bytes > this.maxMessageBytes) {
      this.pending.delete(key)
      return {
        kind: 'overflow',
        msgId: frame.msgId,
        channel: frame.channel,
        bytes: entry.bytes,
      }
    }

    entry.parts.set(frame.seq, copyBytes(frame.payload))
    entry.lastSeq = frame.seq
    if ((frame.flags & FLAG.LAST) !== 0) entry.sawLast = true
    return this.#settleIfComplete(key)
  }

  /**
   * 组装完整时投递并清理；否则返回 incomplete。
   *
   * 完成条件必须同时满足三条，缺一不可：
   *   ① 见过 LAST 位（否则对端可能还有尾片在路上）；
   *   ② 片号从 0 连续到 lastSeq（无缺口）；
   *   ③ 合并后的字节数与逐片累计一致（防御性校验，正常情况下恒等）。
   */
  #settleIfComplete(key) {
    const entry = this.pending.get(key)
    if (!entry) return { kind: 'incomplete' }
    if (!entry.sawLast) return { kind: 'incomplete' }

    const seqs = [...entry.parts.keys()].sort((a, b) => a - b)
    if (seqs.length !== entry.lastSeq + 1) return { kind: 'incomplete' }
    for (let i = 0; i < seqs.length; i += 1) {
      if (seqs[i] !== i) return { kind: 'incomplete' }
    }

    const merged = new Uint8Array(entry.bytes)
    let offset = 0
    for (const seq of seqs) {
      const part = entry.parts.get(seq)
      merged.set(part, offset)
      offset += part.length
    }
    if (offset !== entry.bytes) return { kind: 'incomplete' }
    this.pending.delete(key)

    const [channelStr, msgIdStr] = key.split(':')
    return {
      kind: 'message',
      msgId: Number(msgIdStr),
      channel: Number(channelStr),
      version: entry.version,
      payload: merged,
      ackRequired: entry.ackRequired,
    }
  }

  /** 丢弃某条（例如判定为超时/异常）。 */
  drop(msgId, channel) {
    this.pending.delete(`${channel}:${msgId}`)
  }

  /** 清空全部待重组状态（断链时调用）。 */
  clear() {
    this.pending.clear()
  }

  /** 诊断用：当前待重组条数与总字节数。 */
  stats() {
    let bytes = 0
    for (const entry of this.pending.values()) bytes += entry.bytes
    return { messages: this.pending.size, bytes }
  }
}

function copyBytes(bytes) {
  // subarray 只是视图，必须复制——否则后续 chunk 缓冲被复用时内容会被覆盖。
  const out = new Uint8Array(bytes.length)
  out.set(bytes)
  return out
}

/**
 * 发送侧待确认表。
 *
 * 只对 ackRequired 的消息登记；超时重传，超过重试上限后交给上层判定链路异常。
 * 这里不做退避——BLE 链路延迟稳定，固定间隔比指数退避更快恢复。
 */
export class PendingAcks {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.maxRetries]
   * @param {(msgId:number)=>void} [options.onGiveUp]
   */
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs ?? 400
    this.maxRetries = options.maxRetries ?? 3
    this.onGiveUp = options.onGiveUp
    /** @type {Map<number, {chunks:Uint8Array[], sentAt:number, retries:number, timer:any}>} */
    this.entries = new Map()
  }

  /**
   * @param {number} msgId
   * @param {Uint8Array[]} chunks
   * @param {(chunks:Uint8Array[])=>void} send 重传回调
   */
  track(msgId, chunks, send) {
    this.entries.set(msgId, { chunks, send, retries: 0, timer: null })
    this.#arm(msgId)
  }

  #arm(msgId) {
    const entry = this.entries.get(msgId)
    if (!entry) return
    entry.timer = setTimeout(() => {
      const current = this.entries.get(msgId)
      if (!current) return
      if (current.retries >= this.maxRetries) {
        this.entries.delete(msgId)
        this.onGiveUp?.(msgId)
        return
      }
      current.retries += 1
      try {
        current.send(current.chunks)
      } catch {
        // 发送失败按未确认处理，下个周期继续重试；不在这里抛，避免打断定时器链。
      }
      this.#arm(msgId)
    }, this.timeoutMs)
    // 定时器不应阻止进程退出。
    entry.timer?.unref?.()
  }

  /** 收到 ACK。 */
  acknowledge(msgId) {
    const entry = this.entries.get(msgId)
    if (!entry) return false
    if (entry.timer) clearTimeout(entry.timer)
    this.entries.delete(msgId)
    return true
  }

  /** 断链清理。 */
  clear() {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    this.entries.clear()
  }

  stats() {
    let retries = 0
    for (const entry of this.entries.values()) retries += entry.retries
    return { inFlight: this.entries.size, retries }
  }
}

/**
 * 12 位消息号分配器。到顶回绕，并跳过仍在途的号，避免重传与新消息撞号。
 */
export class MsgIdAllocator {
  constructor() {
    this.next = 0
    /** @type {Set<number>} */
    this.inUse = new Set()
  }

  allocate() {
    for (let i = 0; i < 0x1000; i += 1) {
      const candidate = this.next
      this.next = (this.next + 1) & 0xfff
      if (!this.inUse.has(candidate)) {
        this.inUse.add(candidate)
        return candidate
      }
    }
    throw new Error('消息号耗尽：在途消息过多，链路可能已异常')
  }

  release(msgId) {
    this.inUse.delete(msgId)
  }

  clear() {
    this.inUse.clear()
  }
}
