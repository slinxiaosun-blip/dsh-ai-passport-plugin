/**
 * 语音流式重组的单元测试。
 *
 * 为什么需要它：这是"设备一次录音分多条 BLE 消息上行"最容易出错的一环。
 * 旧实现按 4bit seq 去重，第 2 条消息的 seq 从 0 重来会被全部当重复丢掉 ——
 * 只剩第一条 ~0.26 秒音频，而且**不报错、只是识别出半句话**，极难察觉。
 * 改成按到达顺序拼接后，这里用"跨两条消息、seq 各自从 0 开始"的场景锁死行为。
 *
 * 独立于硬件/真机：只测 voice.js 的纯逻辑（重组 + ADPCM 解码 + WAV）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assembleWav, decodeImaAdpcm } from './voice.js'

const HEADER = 4

/** 构造一个语音分片：4 字节头（flags/msgId/seq）+ 载荷。 */
function chunk({ flags = 0, msgId = 1, seq = 0, payload }) {
  const head = Buffer.alloc(HEADER)
  head[0] = flags & 0x0f
  head[1] = 1 // channel，此处不参与重组
  head[2] = (msgId >> 4) & 0xff
  head[3] = ((msgId & 0x0f) << 4) | (seq & 0x0f)
  return Buffer.concat([head, payload])
}

/** 构造一段自洽的 ADPCM 字节流：块头(4B) + 若干数据字节。 */
function adpcmBytes(dataLen) {
  const buf = Buffer.alloc(4 + dataLen)
  buf.writeInt16LE(0, 0)      // predictor
  buf.writeUInt8(0, 2)        // stepIndex
  buf.writeUInt8(0, 3)        // 保留
  for (let i = 4; i < buf.length; i++) buf[i] = 0 // 数据（全 0，解出直流）
  return buf
}

function newSession() {
  return {
    parts: [],
    messages: 0,
    packets: 0,
    startedAt: Date.now(),
    format: { sampleRate: 16000, bits: 16, channels: 1, codec: 'ima-adpcm' },
  }
}

test('跨多条消息的音频按到达顺序拼接（seq 各自从 0 重来不丢）', () => {
  const session = newSession()
  const adpcm = adpcmBytes(16)
  const half = adpcm.length / 2

  // 模拟设备分两条 ap_link_send_voice 上行：
  //   消息 1: seq 0 (FIRST) + seq 1 (LAST)
  //   消息 2: seq 0 (FIRST) + seq 1 (LAST)   ← seq 重置，旧实现这里会全丢
  const msg1 = [
    { flags: 0b0001, seq: 0, payload: adpcm.subarray(0, half) },
    { flags: 0b0010, seq: 1, payload: adpcm.subarray(half) },
  ]
  const msg2 = [
    { flags: 0b0001, seq: 0, payload: adpcm.subarray(0, half) },
    { flags: 0b0010, seq: 1, payload: adpcm.subarray(half) },
  ]

  // 手工把分片载荷按到达顺序塞进 session.parts（等价 #onVoiceBytes 的追加）
  for (const c of [...msg1, ...msg2]) {
    const ch = chunk({ ...c, msgId: 1 })
    session.parts.push(ch.subarray(HEADER))
    if (c.flags & 0b0001) session.messages += 1
    session.packets += 1
  }

  assert.equal(session.messages, 2, '应收到 2 条消息的 FIRST')
  assert.equal(session.packets, 4, '应收到 4 个分片')

  const wav = assembleWav(session)
  assert.ok(wav, '拼接后应能产出 WAV')
  // 两条消息 = adpcm 两遍 → 压缩字节应为 adpcm.length * 2
  assert.equal(wav.compressedBytes, adpcm.length * 2, '压缩字节 = 两条消息之和')
  // 解码 PCM = (压缩字节 - 4 块头) * 4 采样字节，两条消息各解一遍
  assert.ok(wav.pcmBytes > 0, '应解出 PCM')
})

test('空会话 / 不足一个块头 → 返回 null（不拿残缺音频去猜）', () => {
  assert.equal(assembleWav({ parts: [] }), null, '无分片返回 null')

  const s = newSession()
  s.parts.push(Buffer.from([1, 2, 3])) // 只有 3 字节，不够 4 字节块头
  assert.equal(assembleWav(s), null, '不足块头返回 null')
})

test('ADPCM 解码：块头 + 数据 → 采样数正确', () => {
  const dataLen = 8
  const adpcm = adpcmBytes(dataLen)
  const pcm = decodeImaAdpcm(adpcm)
  // 每字节 2 个 4bit 采样 × 2 字节/采样 = 4 字节输出/数据字节
  assert.equal(pcm.length, dataLen * 4, 'PCM 字节数 = 数据字节 × 4')
})
