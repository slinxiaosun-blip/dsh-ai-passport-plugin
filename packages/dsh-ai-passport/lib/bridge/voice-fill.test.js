/**
 * 识别结果卡的消费链测试（docs/06 §2）。
 *
 * 这条链跨三层（设备按键 → host pending 状态机 → 挂件 inputActions），
 * 中间任何一环的幂等性出错都会变成"双击发送发了两次"或"填入被静默吞掉"，
 * 而两者在真机上都极难与其它故障区分。这里锁死主机侧状态机的全部分支：
 * 认领一次性、回执反馈、过期报错、redo 撤销、800ms 降级直发、降级开关。
 */
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import { VoiceDomain, DEFAULT_AUDIO_DIR, writeAudioArchive } from './voice.js'
import { MSG } from '../protocol/constants.js'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeDomain({ voice = {}, speechToText } = {}) {
  const handlers = new Map()
  const sent = []
  const link = {
    transport: { on() {}, off() {} },
    onMessage(type, fn) {
      handlers.set(type, fn)
      return () => handlers.delete(type)
    },
    send: async (type, payload) => {
      sent.push({ type, payload })
      return {}
    },
    snapshot: () => ({ state: 'connected' }),
  }
  const domainState = { voiceLog: [] }
  const domain = new VoiceDomain({
    link,
    config: {
      voice: {
        enabled: true,
        directSend: true,
        fallbackPrompt: true,
        providerId: '',
        language: 'zh',
        maxSeconds: 15,
        ...voice,
      },
    },
    logger: () => {},
    broadcast: () => {},
    domainState,
  })
  // 识别目录探测需要宿主 ctx（speechToText 是可选服务，用 get 取）
  const ctx = {
    get: (name) => (name === 'speechToText' ? (typeof speechToText === 'function' ? speechToText() : speechToText) : null),
  }
  domain.attach({}, ctx)
  return { domain, handlers, sent, domainState, ctx }
}

/** 伪造一个识别服务：providers 里给一个"已就绪"的本地提供者。 */
function fakeSpeech({ ready = true, phase = null, providerId = 'sensevoice-local', text = '' } = {}) {
  // 每次转写收到的音频字节数（含 44 字节 WAV 头），供上限截断这类断言核对。
  const calls = []
  return {
    calls,
    // 宿主侧契约是 resolve(request) → spec → transcribe(spec)；这里直通，不做挑选逻辑。
    resolve: (request) => request,
    transcribe: async (spec) => {
      calls.push(spec?.audio?.length ?? 0)
      return { text }
    },
    snapshot: () => ({
      providers: [{
        id: providerId,
        name: 'SenseVoiceSmall (INT8)',
        location: 'host-local',
        languages: ['zh'],
        preparation: { phase: phase ?? (ready ? 'ready' : 'unprepared') },
      }],
      selection: { providerId },
    }),
  }
}

test('启动探测：模型早已就绪时立即显示已启用（不再等到手动刷新）', async () => {
  const { domain, domainState } = makeDomain({ speechToText: fakeSpeech() })
  domain.startInitialCatalogProbe([5])
  await wait(30)
  assert.equal(domainState.speech?.ready, true, '首屏就该是已启用')
  assert.equal(domainState.speechError, null)
  await domain.dispose()
})

test('启动探测：服务注册晚于插件时不误报，等到了就停止重试', async () => {
  let available = false
  const { domain, domainState } = makeDomain({ speechToText: () => (available ? fakeSpeech() : undefined) })
  domain.startInitialCatalogProbe([5, 20, 60])
  await wait(18)
  assert.equal(domainState.speechError, undefined, '早期尝试必须 quiet，不能误报"没有语音服务"')
  available = true
  await wait(60)
  assert.equal(domainState.speech?.ready, true, '服务出现后应当探测到已就绪')
  await domain.dispose()
})

test('启动探测：服务始终不存在时，最后一次尝试正常发布错误', async () => {
  const { domain, domainState } = makeDomain({ speechToText: undefined })
  domain.startInitialCatalogProbe([5, 20])
  await wait(60)
  assert.match(String(domainState.speechError ?? ''), /没有启用语音识别服务/)
  await domain.dispose()
})

test('识别状态：standby（装好但没预热）必须算"已启用"', async () => {
  const { domain, domainState } = makeDomain({ speechToText: fakeSpeech({ phase: 'standby' }) })
  await domain.refreshCatalog()
  assert.equal(domainState.speech.ready, true, 'standby 时推理仍可用（asar：requires ready or standby）')
  assert.equal(domainState.speech.needsPreparation, false, '不该再提示准备模型')
  assert.equal(domainState.speech.preparing, false)
  await domain.dispose()
})

test('识别状态：unprepared 才算需要准备模型；下载中显示进度而不是按钮', async () => {
  const a = makeDomain({ speechToText: fakeSpeech({ phase: 'unprepared' }) })
  await a.domain.refreshCatalog()
  assert.equal(a.domainState.speech.ready, false)
  assert.equal(a.domainState.speech.needsPreparation, true)
  await a.domain.dispose()

  const b = makeDomain({ speechToText: fakeSpeech({ phase: 'downloading' }) })
  await b.domain.refreshCatalog()
  assert.equal(b.domainState.speech.ready, false)
  assert.equal(b.domainState.speech.preparing, true, '下载中应显示进度说明')
  assert.equal(b.domainState.speech.needsPreparation, false, '下载中不该再给"准备模型"按钮')
  await b.domain.dispose()
})

/** 伪造一条已完成的识别结果（等价于转写完成后的登记）。 */
function seed(domain, resultId, text) {
  domain.resultTexts.set(resultId, { text, at: Date.now() })
}

function toastTexts(sent) {
  return sent.filter((m) => m.type === 'toast').map((m) => m.payload.text)
}

test('fill：登记 pending → 一次性认领 → ack 回执 toast「已填入」', () => {
  const { domain, handlers, sent, domainState } = makeDomain()
  seed(domain, 'v1', '你好世界')

  handlers.get('voice.action')({ resultId: 'v1', mode: 'fill' })
  assert.equal(domainState.voice.pending?.resultId, 'v1')
  assert.equal(domainState.voice.pending?.mode, 'fill')

  const taken = domain.take('v1')
  assert.equal(taken?.mode, 'fill')
  assert.equal(taken?.text, '你好世界')
  assert.equal(domain.take('v1'), null, '第二次认领必须为空（多窗口先到先得）')

  const ack = domain.ack({ resultId: 'v1', ok: true })
  assert.equal(ack.ok, true)
  assert.equal(domainState.voice.pending, null, '回执后 pending 必须清掉')
  assert.ok(toastTexts(sent).includes('已填入'), '设备应收到「已填入」反馈')
  assert.equal(domain.ack({ resultId: 'v1', ok: true }).ok, false, '重复 ack 必须回"已处理过"')
})

test('send：ack 带回被替换的旧草稿并存档（决策 1 的可找回缓解）', () => {
  const { domain, handlers, sent, domainState } = makeDomain()
  seed(domain, 'v2', '把这段发出去')

  handlers.get('voice.action')({ resultId: 'v2', mode: 'send' })
  assert.equal(domainState.voice.pending?.mode, 'send')
  domain.take('v2')

  const ack = domain.ack({ resultId: 'v2', ok: true, replacedDraft: '写了一半的草稿' })
  assert.equal(ack.ok, true)
  assert.equal(domainState.voice.replacedDraft, '写了一半的草稿', '旧草稿必须可找回，不许静默丢失')
  assert.ok(toastTexts(sent).includes('已发送'), '设备应收到「已发送」反馈')
})

test('ack 失败时用 reason 反馈设备，不吞错', () => {
  const { domain, handlers, sent } = makeDomain()
  seed(domain, 'v3', '文本')
  handlers.get('voice.action')({ resultId: 'v3', mode: 'fill' })
  domain.take('v3')

  domain.ack({ resultId: 'v3', ok: false, reason: '输入框忙，文本已保留' })
  assert.ok(toastTexts(sent).includes('输入框忙，文本已保留'))
})

test('未知 resultId：明确报过期，不静默失败', () => {
  const { domain, handlers, sent, domainState } = makeDomain()
  handlers.get('voice.action')({ resultId: 'v-none', mode: 'fill' })
  assert.equal(domainState.voice.pending, null, '过期结果不许登记 pending')
  assert.ok(toastTexts(sent).some((t) => t.includes('过期')), '设备应被告知结果已过期')
})

test('directSend 关闭时 send 被拒绝并说明原因', () => {
  const { domain, handlers, sent, domainState } = makeDomain({ voice: { directSend: false } })
  seed(domain, 'v4', '文本')
  handlers.get('voice.action')({ resultId: 'v4', mode: 'send' })
  assert.equal(domainState.voice.pending, null)
  assert.ok(toastTexts(sent).some((t) => t.includes('关闭')), '设备应被告知直发已关闭')
})

test('discard：设备端「清除」把结果真作废（文本也删），之后误触填入只会提示过期', async () => {
  const { domain, handlers, sent, domainState } = makeDomain()
  seed(domain, 'v-clear', '这段不要了')

  await handlers.get(MSG.VOICE_ACTION)({ resultId: 'v-clear', mode: 'fill' })
  assert.ok(domainState.voice.pending, '先确认 fill 会登记 pending（对照组）')

  await handlers.get(MSG.VOICE_ACTION)({ resultId: 'v-clear', mode: 'discard' })
  assert.equal(domain.resultTexts.has('v-clear'), false, '文本必须从表里删掉，不能只清 pending')
  assert.equal(domainState.voice.pending, null, '挂着的 pending 也要撤掉')
  assert.equal((domainState.voiceLog ?? []).some((i) => i.resultId === 'v-clear'), false, '列表里也不该再留着')

  // 作废之后再误触「填入」：只能得到"已过期"，绝不把旧文本塞进输入框
  sent.length = 0
  await handlers.get(MSG.VOICE_ACTION)({ resultId: 'v-clear', mode: 'fill' })
  assert.equal(toastTexts(sent).some((t) => t.includes('过期')), true, '应当提示已过期')
  assert.equal(domainState.voice.pending, null, '不该重新登记 pending')
})

test('redo 撤掉挂着的 pending（重录时旧结果不许再被填入）', () => {
  const { domain, handlers, domainState } = makeDomain()
  seed(domain, 'v5', '旧文本')
  handlers.get('voice.action')({ resultId: 'v5', mode: 'fill' })
  assert.ok(domainState.voice.pending)

  handlers.get('voice.action')({ resultId: 'v5', mode: 'redo' })
  assert.equal(domainState.voice.pending, null)
  assert.equal(domain.take('v5'), null, '撤销后不能被认领')
})

test('send 2.5s 无挂件认领 → 降级 sessionController.prompt 直发（content 必须是文本分部数组）', async () => {
  const { domain, handlers, sent, domainState } = makeDomain()
  const prompts = []
  domain.attach({}, {
    get: (name) => (name === 'sessionController'
      ? {
          list: async () => ({ items: [{ sessionId: 's1', running: true, updatedAt: 1 }] }),
          prompt: async (args) => { prompts.push(args) },
        }
      : null),
  })
  seed(domain, 'v6', '降级发送')
  handlers.get('voice.action')({ resultId: 'v6', mode: 'send' })

  await wait(2700)
  assert.equal(prompts.length, 1, '应恰好直发一次')
  // ★ 回归钉子：SessionPromptRequest 的 content 是分部数组，不是纯字符串。
  //   传字符串会被严格校验拒绝 → 降级必失败 → 设备 toast「发送失败」。
  assert.deepEqual(prompts[0].content, [{ type: 'text', text: '降级发送' }])
  assert.equal(prompts[0].mode, 'queue')
  assert.equal(prompts[0].sessionId, 's1')
  assert.ok(toastTexts(sent).includes('已直接发送到任务'))
  assert.equal(domainState.voice.pending, null)
})

test('慢认领（1.5 秒后，落在一个轮询周期内）不被降级抢走', async () => {
  const { domain, handlers, sent } = makeDomain()
  const prompts = []
  domain.attach({}, {
    get: (name) => (name === 'sessionController'
      ? { list: async () => ({ items: [] }), prompt: async (args) => { prompts.push(args) } }
      : null),
  })
  seed(domain, 'v7', '文本')
  handlers.get('voice.action')({ resultId: 'v7', mode: 'send' })

  // 挂件 2 秒轮询一次：认领可能落在 pending 后 0~2 秒之间。
  // 旧 800ms 窗口会在这之前就抢走认领权（真机"有时发送失败"的根因之一）。
  await wait(1500)
  assert.ok(domain.take('v7'), '挂件在轮询周期内认领必须成功')
  await wait(1500)
  assert.equal(prompts.length, 0, '已认领就不许再降级直发')

  const ack = domain.ack({ resultId: 'v7', ok: true })
  assert.equal(ack.ok, true)
  assert.ok(toastTexts(sent).includes('已发送'), '挂件发送的反馈文案与降级区分')
})

test('fallbackPrompt 关闭：无挂件时只提示，不直发', async () => {
  const { domain, handlers, sent } = makeDomain({ voice: { fallbackPrompt: false } })
  const prompts = []
  domain.attach({}, {
    get: (name) => (name === 'sessionController'
      ? { list: async () => ({ items: [] }), prompt: async (args) => { prompts.push(args) } }
      : null),
  })
  seed(domain, 'v8', '文本')
  handlers.get('voice.action')({ resultId: 'v8', mode: 'send' })

  await wait(2700)
  assert.equal(prompts.length, 0)
  assert.ok(toastTexts(sent).some((t) => t.includes('无法发送')))
})

// ── 音频归档（用户要求：落到挂件目录 + 自动清除）─────────────────────────────

/**
 * 构造一条语音消息：4 字节分片头（**sessionId 走 msgId 字段**）+ ADPCM 流。
 *
 * ★ 踩过的坑：直接把 ADPCM 块头当分片头发进来，msgId 会被读成 0 →
 *   `[voice] 收到无归属的音频分片` → 音频被丢弃、归档自然也不会发生。
 */
function voicePacket(sessionId, blocks = 10) {
  const chunks = []
  for (let i = 0; i < blocks; i++) {
    const blockHead = Buffer.alloc(4)
    blockHead.writeInt16LE(0, 0)   // predictor
    blockHead.writeUInt8(0, 2)     // stepIndex
    blockHead.writeUInt8(0, 3)     // 保留
    chunks.push(blockHead, Buffer.alloc(504))   // 504 数据字节/块 → 10 块 ≈ 0.63s
  }
  const head = Buffer.alloc(4)
  head[0] = 0x0f                                    // flags（不参与重组）
  head[1] = 0                                       // channel
  head[2] = (sessionId >> 4) & 0xff
  head[3] = ((sessionId & 0x0f) << 4) | 0           // msgId = sessionId，seq = 0
  return Buffer.concat([head, Buffer.concat(chunks)])
}

/** 跑完一次"按下说话"：voice.begin → 音频分片 → voice.end（内部会解码并转写）。 */
async function driveSession(domain, handlers, sessionId, blocks = 10) {
  handlers.get(MSG.VOICE_BEGIN)({ sessionId, sampleRate: 16000, bits: 16, channels: 1, codec: 'ima-adpcm' })
  domain.voiceListener({ channel: 'voice', bytes: voicePacket(sessionId, blocks) })
  await handlers.get(MSG.VOICE_END)({ sessionId, maxRms: 120, seqGaps: 0 }, { msgId: 1, channel: 0, reply: async () => {} })
}

function tmpAudioDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-audio-'))
}

test('voice.maxSeconds 生效：超限录音截断到上限再转写（不整段丢弃）', async () => {
  // 每块 504 数据字节 → 2016 字节 PCM；16 块 = 32256 字节 ≈ 1.008 秒
  const speech = fakeSpeech({ text: '好的' })
  const { domain, handlers } = makeDomain({
    speechToText: speech,
    voice: { maxSeconds: 1, keepAudio: false },
  })
  await driveSession(domain, handlers, 1, 16)

  assert.equal(speech.calls.length, 1, '超限也要转写一次，不能直接丢弃')
  // WAV = 44 字节头 + 截断到 1 秒的 PCM（16000 × 2 × 1）
  assert.equal(speech.calls[0], 44 + 32_000, '转写收到的音频应被截到 maxSeconds')

  await domain.dispose()
})

test('voice.maxSeconds 宽松时不做任何截断', async () => {
  const speech = fakeSpeech({ text: '好的' })
  const { domain, handlers } = makeDomain({
    speechToText: speech,
    voice: { maxSeconds: 30, keepAudio: false },
  })
  await driveSession(domain, handlers, 2, 16)

  assert.equal(speech.calls.length, 1, '应转写一次')
  assert.equal(speech.calls[0], 44 + 32_256, '未超 30 秒上限，音频保持完整')

  await domain.dispose()
})

test('归档默认值：keepAudio 未显式配置时为开启（用户决策）', async () => {
  const { normalizeConfig } = await import('../config.js')
  const config = normalizeConfig({})
  assert.equal(config.voice.keepAudio, true, '默认必须开启')
  assert.equal(config.voice.audioDir, '', '默认目录 = 挂件目录下的 audio/')
  assert.equal(config.voice.audioKeepFiles, 20, '默认保留 20 组')
})

test('归档显式关闭：不产生任何文件', async () => {
  const dir = tmpAudioDir()
  const { domain, handlers } = makeDomain({
    voice: { keepAudio: false, audioDir: dir },
    speechToText: fakeSpeech({ text: '不该被归档' }),
  })
  await driveSession(domain, handlers, 1)
  assert.deepEqual(fs.readdirSync(dir), [], '关闭归档时目录必须保持干净')
  await domain.dispose()
})

test('归档开启：WAV 与原流成对落盘，且只保留最新 keep 组', async () => {
  const dir = tmpAudioDir()
  const { domain, handlers } = makeDomain({
    voice: { keepAudio: true, audioDir: dir, audioKeepFiles: 2 },
    speechToText: fakeSpeech({ text: '归档测试' }),
  })
  for (const id of [1, 2, 3]) await driveSession(domain, handlers, id)

  const files = fs.readdirSync(dir).sort()
  assert.equal(files.filter((f) => f.endsWith('.wav')).length, 2, '只保留最新 2 组')
  assert.equal(files.filter((f) => f.endsWith('.adpcm')).length, 2, '.adpcm 必须成对保留，不留孤儿')
  assert.equal(files.length, 4)
  // 第 1 组应当已被清理
  assert.ok(!files.some((f) => f.includes('session1.wav')), '最旧的一组应被自动清除')
  await domain.dispose()
})

test('归档目录默认落在挂件目录（插件包）下', () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  assert.equal(path.basename(packageRoot), 'dsh-ai-passport')
  assert.equal(DEFAULT_AUDIO_DIR, path.join(packageRoot, 'audio'))
})

test('writeAudioArchive：写入成对文件，并按 keep 清理最旧组', () => {
  const dir = tmpAudioDir()
  const wav = Buffer.from('RIFFfake')
  for (const stem of ['2026-01-01_00-00-00-session1', '2026-01-02_00-00-00-session2']) {
    writeAudioArchive({ dir, stem, wavBytes: wav, parts: [Buffer.from([1, 2])], keep: 5 })
  }
  assert.equal(fs.readdirSync(dir).length, 4, '两组 = 4 个文件')
  const third = writeAudioArchive({ dir, stem: '2026-01-03_00-00-00-session3', wavBytes: wav, parts: [], keep: 2 })
  assert.equal(third.pruned.length, 2, '超出 keep 的组应被清理（wav + adpcm）')
  const left = fs.readdirSync(dir).sort()
  assert.equal(left.length, 4)
  assert.ok(!left.some((f) => f.includes('session1')), '最旧的一组被清掉')
})
