/**
 * 语音域：把设备麦克风的音频变成 DSH 里可用的文本。
 *
 * 为什么识别必须在电脑上做：ESP32-C3 无 PSRAM、单核 RISC-V，跑不动任何有意义的 ASR。
 * 设备只负责"采音 + 压缩 + 分包上行"，识别与注入都在 Host。
 *
 * 识别走 `ctx.speechToText`（DSH 的语音识别注册表）：
 *   - `snapshot()` / `follow()` 读提供者与就绪状态
 *   - `prepare(id)` 触发模型准备（SenseVoice 首次需要下载约 240MB）
 *   - `resolve({audio, language})` + `transcribe(spec, signal)` 得到文本
 *
 * 音频链路的关键工程点：
 *   1. 设备端 IMA-ADPCM 4:1 压缩。16k/16bit 单声道原始是 32KB/s，压缩后 8KB/s，
 *      才落在 BLE 5 的稳定吞吐区间内。
 *   2. 音频通道**不做重传**：丢几片只是识别里少几十毫秒，重传造成的延迟比丢音更伤体验。
 *      但整段音频的完整性要检查——丢片比例过高时直接报错，而不是拿残缺音频去识别。
 *   3. 组装成规范的 WAV（16k/16bit/mono）：识别提供者按 WAV 头校验，
 *      少一个头就会以"音频格式不支持"这种含糊理由失败。
 */

import { AUDIO, MSG, FLAG } from '../protocol/constants.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** PTT 最短说话时长（秒）：短于它视为误碰，静默丢弃不进转写。 */
const MIN_TALK_SECONDS = 0.5

/** 插件包根目录（lib/bridge/voice.js → 上两级）。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 音频归档的默认目录：**挂件目录**（插件包）下的 `audio/`（用户要求）。 */
export const DEFAULT_AUDIO_DIR = path.join(PACKAGE_ROOT, 'audio')

/** 归档保留份数上限的默认值（超出即按时间清理最旧的）。 */
export const DEFAULT_AUDIO_KEEP_FILES = 20

/**
 * 把一次录音写进归档目录，并清理超额的旧文件（用户要求：落到挂件目录 + 自动清除）。
 *
 * 纯文件操作、无副作用外溢，便于单测直接调用：
 *   · 每组录音两个文件：`<stem>.wav`（解码后可播放）与 `<stem>.adpcm`（BLE 收到的压缩原流，
 *     排查丢片/解码问题时用）；
 *   · 清理按 **WAV 组**计数（不会留下孤儿 .adpcm），保留最新的 `keep` 组。
 *
 * @returns {{files: string[], pruned: string[]}}
 */
export function writeAudioArchive({ dir, stem, wavBytes, parts = [], keep = DEFAULT_AUDIO_KEEP_FILES }) {
  if (!dir || !stem || !wavBytes) throw new Error('归档参数不完整')
  fs.mkdirSync(dir, { recursive: true })
  const wavPath = path.join(dir, `${stem}.wav`)
  const rawPath = path.join(dir, `${stem}.adpcm`)
  fs.writeFileSync(wavPath, wavBytes)
  fs.writeFileSync(rawPath, Buffer.concat(parts))

  const groups = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.wav'))
    .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  const pruned = []
  for (const { name } of groups.slice(Math.max(1, Number(keep) || DEFAULT_AUDIO_KEEP_FILES))) {
    const base = name.slice(0, -'.wav'.length)
    for (const file of [`${base}.wav`, `${base}.adpcm`]) {
      try {
        fs.unlinkSync(path.join(dir, file))
        pruned.push(file)
      } catch {
        // 已经不在就算了
      }
    }
  }
  return { files: [`${stem}.wav`, `${stem}.adpcm`], pruned }
}

/** 识别结果查找表的保留时长：结果卡 30 秒 + 余量，过期后设备再来取就明确报"已过期"。 */
const RESULT_TTL_MS = 120_000

/**
 * 设备双击直发后等待挂件认领的时长；超时降级 sessionController.prompt（见 docs/06 §2.4）。
 *
 * ★ 必须**大于**挂件的轮询间隔上界（2 秒）：挂件从"看到 pending"到"认领"最多隔
 *   一整个轮询周期，旧窗口 800ms 会让约六成的发送被降级抢走认领权；而降级直发
 *   一旦失败，这条语音就直接丢了（真机返工记录：「双击发送有时提示发送失败」）。
 */
const FALLBACK_MS = 2500

/** "正在准备"这一类过渡阶段（此时既不显示"已启用"，也不该给"准备模型"按钮）。 */
const PREPARING_PHASES = new Set(['checking', 'downloading', 'preparing', 'loading', 'waking'])

/** "需要（或可以）显式准备"的阶段：模型没装、或上次准备失败/被取消。 */
const NEEDS_PREPARATION_PHASES = new Set(['unprepared', 'failed', 'cancelled'])

/** 启动探测的默认节奏：1.5s / 3s / 8s（最后一次会正常发布错误）。 */
const CATALOG_PROBE_DELAYS_MS = [1500, 3000, 8000]

export class VoiceDomain {
  constructor(shared) {
    this.link = shared.link
    this.config = shared.config
    this.logger = shared.logger
    this.broadcast = shared.broadcast
    this.domainState = shared.domainState

    /**
     * 会话表：sessionId → 待结束的会话数组（FIFO）。
     *
     * ★ 为什么是数组而不是单值：设备端 s_session_id = (s_session_id + 1) & 0x0f
     *   每 16 次录音回绕一次。上一次录音的 voice.end 可能要 1~5 秒才到（识别耗时），
     *   这期间用户再按一次 PTT 就会用**相同 sessionId** 开新会话。
     *   用 Map<id, session> 会被覆盖，导致 voice.end 错配到新会话上
     *   （→ 误报"识别失败"或张冠李戴出错文字）。
     *   改为 FIFO 数组后，voice.end 取**最旧**的那个（先进先出），
     *   与设备端"上一次先结束"的时序一致。
     *
     * @type {Map<number, Array<{parts:Buffer[], messages:number, packets:number, startedAt:number, format:object}>>}
     */
    this.sessions = new Map()
    /**
     * ★ 最近处理过的 voice.end 消息 id（去重）。
     *
     * 设备端 voice.end 走 ack_required=true，ACK 未及时到达会重传。
     * 重传的 voice.end 若被再次处理，FIFO 里已无原会话，会错把**下一次**
     * 录音的会话取出来（音频不完整）→ 抛错发 voice.error → 设备弹"识别失败"，
     * 然后下一次的 voice.end 才到、出正常文字（真机返工记录的"先闪失败再出字"）。
     *
     * 用 sessionId + 时窗去重：同一 sessionId 的 voice.end 在 30 秒内只处理一次。
     * @type {Map<number, number>} sessionId → 处理时刻
     */
    this.recentVoiceEnds = new Map()
    this.disposers = []
    this.ctx = null

    /**
     * 识别结果卡的状态机（docs/06 §2）：
     *   设备按"填入/发送"→ voice.action → 这里登记 pending → 挂件 voice.take 认领
     *   → 执行 inputActions → voice.ack 回执 → toast 反馈设备。
     * 认领是**一次性**的：多窗口都挂着挂件时先到先得，避免双击发送被发两次。
     */
    this.resultSeq = 0
    this.resultTexts = new Map()
    this.fallbackTimer = null
    if (!this.domainState.voice) {
      this.domainState.voice = { pending: null, replacedDraft: '' }
    }

    /** 语音通道的原始分片：HostLink 会把 voice 通道单独标出来 */
    this.voiceListener = ({ channel, bytes }) => {
      if (channel === 'voice') this.#onVoiceBytes(bytes)
    }

    this.registerProtocolHandlers()
  }

  attach(runtime, ctx) {
    this.runtime = runtime
    if (ctx) this.ctx = ctx
  }

  registerProtocolHandlers() {
    // 音频走独立的 data 事件（不是 JSON 消息），单独接线
    this.link.transport.on('data', this.voiceListener)

    this.disposers.push(
      this.link.onMessage(MSG.VOICE_BEGIN, (message) => {
        const sessionId = Number(message.sessionId ?? 0)
        // ★ 会话号碰撞检测：设备端 s_session_id = (s_session_id + 1) & 0x0f，
        //   每 16 次录音就回绕一次。若上一次录音的 voice.end 还没处理完
        //   （识别耗时 1~5 秒），新 voice.begin 用**相同 sessionId** 到达。
        //
        //   现象：旧会话被覆盖 → 旧 voice.end 到达时 get() 返回的是**新**会话
        //   （不是 null），于是走正常流程把**新**会话误当成旧的、发出**错误的结果**，
        //   或者在边界情况下回 voice.error。用户看到的"先失败后出字"就是这种错位。
        //
        //   修法：不再依赖 sessionId 唯一。给每个会话一个内部自增 uid，
        //   voice.end 用 sessionId 找**最近**的那个未结束会话（FIFO），
        //   避免回绕时错配。见 this.pendingBySession。
        const session = {
          // 流式：按到达顺序累积音频载荷（一条录音可跨多条 BLE 消息）
          parts: [],
          messages: 0,   // 收到的 FIRST 分片数（≈ BLE 消息条数，用于诊断）
          packets: 0,    // 总分片数
          seqGaps: 0,    // [诊断] 单条消息内 seq 断档次数（丢片 → 解码错位）
          expectSeq: null,
          startedAt: Date.now(),
          format: {
            sampleRate: Number(message.sampleRate) || AUDIO.SAMPLE_RATE,
            bits: Number(message.bits) || AUDIO.BITS,
            channels: Number(message.channels) || AUDIO.CHANNELS,
            codec: message.codec ?? AUDIO.CODEC,
          },
        }
        // FIFO：sessionId 可能回绕复用，同 id 的多个未结束会话排队。
        const queue = this.sessions.get(sessionId) ?? []
        queue.push(session)
        this.sessions.set(sessionId, queue)
        this.broadcast({ type: 'voice.begin', sessionId, format: session.format })
        // 通知状态域：设备开始录音，抑制 task.state 推送（否则"已完成→空闲"的
        // 回落定时器会在说话时把状态打回"空闲"，见 state.js setDeviceRecording）。
        this.runtime?.domains?.state?.setDeviceRecording?.(true)
      }),
    )

    this.disposers.push(
      this.link.onMessage(MSG.VOICE_END, async (message, context) => {
        const sessionId = Number(message.sessionId ?? 0)

        // ★ 幂等去重：设备端 voice.end 走 ack_required=true，ACK 丢会触发重传。
        //   重传的 voice.end 必须忽略 —— 否则 FIFO 会错把下一次录音的会话
        //   取出来（音频不完整）→ 抛错发 voice.error → 设备弹"识别失败"。
        //   同一 sessionId 的 voice.end 在 30 秒内只处理一次。
        const VOICE_END_DEDUP_MS = 30_000
        const now0 = Date.now()
        const lastEnd = this.recentVoiceEnds.get(sessionId)
        if (lastEnd !== undefined && now0 - lastEnd < VOICE_END_DEDUP_MS) {
          this.logger('debug', `[voice] voice.end 重复到达 session=${sessionId}（${now0 - lastEnd}ms 前已处理），忽略重传`)
          return
        }
        this.recentVoiceEnds.set(sessionId, now0)
        // 清理超窗的旧记录，避免 Map 无限增长
        for (const [sid, t] of this.recentVoiceEnds) {
          if (now0 - t > VOICE_END_DEDUP_MS) this.recentVoiceEnds.delete(sid)
        }

        // ★ FIFO：取**最旧**的那个未结束会话。设备端"上一次先结束"，
        //   若 sessionId 回绕复用，新的会话排在队尾，不能抢走旧的 voice.end。
        const queue = this.sessions.get(sessionId)
        // ★ 清理陈旧会话：上一次录音的 voice.end 若丢失（BLE 丢包/超时），
        //   残留会话会被下一次 voice.end 错误取出来 —— 空/损坏的会话让
        //   assembleWav 抛错，设备弹"识别失败"，随后真正的结果才出文字
        //   （真机返工记录的"先失败后出字"）。
        //   会话的音频是边录边发的，正常情况下 voice.end 紧跟最后一片音频到达；
        //   超过 STALE_SESSION_MS 没等到 voice.end 的会话判定为孤儿，直接丢弃。
        const STALE_SESSION_MS = 10_000
        if (queue && queue.length > 0) {
          const now = Date.now()
          while (queue.length > 0 && now - queue[0].startedAt > STALE_SESSION_MS) {
            const stale = queue.shift()
            this.logger('debug', `[voice] 丢弃陈旧会话 session=${sessionId}（已等 ${(now - stale.startedAt) / 1000 | 0}s 无 voice.end）`)
          }
        }
        const session = queue && queue.length > 0 ? queue.shift() : null
        if (queue && queue.length === 0) this.sessions.delete(sessionId)
        if (!session) {
          // 没有匹配的未结束会话：可能是回绕错位后残留的 voice.end。
          // 静默丢弃（不回 voice.error），避免设备误弹"识别失败"。
          this.logger('debug', `[voice] voice.end 无匹配会话 session=${sessionId}，静默丢弃`)
          return
        }

        // 通知状态域：设备录音结束，恢复 task.state 推送（补推一次当前状态）。
        this.runtime?.domains?.state?.setDeviceRecording?.(false)

        // [诊断] 设备上报的原始 PCM 电平（编码前）：≈0 → 麦克风没采到；
        // 很大 → 采集本身过载。与主机侧解码结果对照可切开"采集 vs 传输/解码"。
        const deviceMaxRms = Number.isFinite(Number(message.maxRms)) ? Number(message.maxRms) : null

        try {
          const wav = assembleWav(session)
          if (!wav) throw new Error('录音为空或丢片过多')

          // 误碰收束：PTT 短于 500ms 的按压不进转写（与参考项目 PTT_MIN_TALK_MS 同值）。
          // 主页确定键现在是"按住说话"，日常误点很常见；让它进转写只会在设备上
          // 弹一句"没有识别到内容"。这里静默丢弃（不回 voice.error，设备不报错）。
          const durationSec = wav.pcmBytes / (session.format.sampleRate * 2)
          if (durationSec < MIN_TALK_SECONDS) {
            this.logger('debug', `[voice] 录音过短（${(durationSec * 1000).toFixed(0)}ms），按误碰丢弃`)
            return
          }

          // 音频归档（用户要求，正式版可控）：WAV + 压缩原流落到**挂件目录**，并自动清理旧文件。
          // 默认关闭（voice.keepAudio），避免意外写盘；打开后每次成功解码都会写一组。
          // 设备侧的原始电平/丢片探针仍在 voice.end 消息里（deviceMaxRms/seqGaps），需要时读日志字段即可。
          if (this.config.voice?.keepAudio) {
            this.#archiveAudio(session, sessionId, wav, deviceMaxRms)
          }

          const text = await this.#transcribe(wav, session.format)
          if (!text) throw new Error('没有识别到内容')

          // resultId：设备识别结果卡与挂件消费（voice.take/voice.ack）用它对账。
          // 设备按键只报 resultId + 意图，文本真相留在这里，避免两处各存一份。
          const resultId = `v${Date.now().toString(36)}-${this.resultSeq}`
          this.resultSeq = (this.resultSeq + 1) % 0xffff
          this.resultTexts.set(resultId, { text, at: Date.now() })
          for (const [id, entry] of this.resultTexts) {
            if (Date.now() - entry.at > RESULT_TTL_MS) this.resultTexts.delete(id)
          }

          // 记进日志供挂件列出（上限 10 条，防止长时间使用后无限增长）
          this.domainState.voiceLog = [
            { resultId, text, sessionId, at: Date.now(), deviceMaxRms, seqGaps: session.seqGaps },
            ...(this.domainState.voiceLog ?? []),
          ].slice(0, 10)
          this.broadcast({ type: 'voice.result', resultId, text, sessionId })

          // ★ 回发 voice.result 的失败**不能**触发 voice.error —— 识别本身是成功的，
          //   只是回发失败（载荷超限/链路抖动）。之前 await context.reply 抛错会跳到
          //   catch，于是发 voice.error（设备弹"识别失败"），但 broadcast 已经把
          //   voice.result 发给面板了 —— 面板看到文字、设备看到失败（真机返工记录）。
          //   现在把回发单独 try/catch，失败只记日志，不影响识别结果。
          try {
            await context.reply(MSG.VOICE_RESULT, {
              sessionId,
              resultId,
              text,
              audioSeconds: Number((wav.pcmBytes / (session.format.sampleRate * 2)).toFixed(2)),
            })
          } catch (replyError) {
            this.logger('warn', `[voice] voice.result 回发失败（识别成功）：${replyError.message}`)
          }

          // 免确认直发的旧路径（voice.autoSend → domains.tasks.prompt）已删除：
          // tasks 域在功能精简时移除后它是死代码，且"识别完不经确认就发"与
          // docs/06 的设计相反。现在的直发入口是设备结果卡上的**双击**（voice.action）。
          return text
        } catch (error) {
          this.logger('warn', `[voice] 识别失败：${error.message}`)
          this.domainState.voiceLog = [
            { error: error.message, sessionId, at: Date.now(), deviceMaxRms, seqGaps: session.seqGaps },
            ...(this.domainState.voiceLog ?? []),
          ].slice(0, 10)
          this.broadcast({ type: 'voice.error', error: error.message, sessionId })
          // ★ 字段名必须是 message（不是 error）：设备端 app.c 读的是 ap_json_str(json, "message", ...)
          //   发 error 字段设备永远读不到，只显示默认的"语音识别失败"（真机返工记录）。
          //   回发失败也不能再抛（这里已在 catch 里，再抛会变成 unhandled rejection）。
          await context.reply(MSG.VOICE_ERROR, { sessionId, message: error.message }).catch((replyError) => {
            this.logger('warn', `[voice] voice.error 回发失败：${replyError.message}`)
          })
        }
      }),
    )

    // 识别结果卡的按键动作（设备 → Mac）：fill=填入输入框 / send=填入并发送 / redo=重录。
    //
    // 设备只报意图（resultId + mode），真正动输入框的是挂件 —— inputActions 在
    // 页面里，宿主这边碰不到 DSH 的输入框。本方法只维护 pending 状态机：
    //   voice.action → 登记 pending → 挂件 voice.take 一次性认领 → voice.ack 回执
    //   → toast 反馈设备；send 模式 800ms 无人认领则降级 sessionController.prompt。
    this.disposers.push(
      this.link.onMessage(MSG.VOICE_ACTION, (message) => {
        const resultId = String(message.resultId ?? '')
        const mode = String(message.mode ?? '')

        if (mode === 'discard') {
          // 设备端「清除 / 放弃」这条结果：**真作废** —— 既撤掉挂着的 pending，
          // 也把文本从表里删掉。只清 pending 是不够的：resultTexts 还在，
          // 用户误触「填入」时旧文本照样会被塞进输入框。
          this.logger('debug', `[voice] 设备清除识别结果 ${resultId}`)
          this.#clearPending(resultId)
          this.resultTexts.delete(resultId)
          this.domainState.voiceLog = (this.domainState.voiceLog ?? []).filter(
            (item) => item.resultId !== resultId,
          )
          return
        }
        if (mode === 'redo') {
          // 设备放弃这条结果、重新录音：撤掉挂着的 pending，别让挂件稍后填入旧文本
          this.logger('debug', `[voice] 设备放弃识别结果 ${resultId}，重新录音`)
          this.#clearPending(resultId)
          return
        }
        if (mode !== 'fill' && mode !== 'send') {
          this.logger('warn', `[voice] voice.action 未知 mode=${mode}（resultId=${resultId}）`)
          return
        }

        const entry = this.resultTexts.get(resultId)
          ?? (this.domainState.voiceLog ?? []).find((item) => item.resultId === resultId)
        if (!entry?.text) {
          void this.link.send(MSG.TOAST, { text: '识别结果已过期，请重新说' }).catch(() => {})
          return
        }
        if (mode === 'send' && !this.config.voice.directSend) {
          void this.link.send(MSG.TOAST, { text: '双击直发已关闭，文本在语音列表里可手动填入' }).catch(() => {})
          return
        }

        this.domainState.voice = {
          ...(this.domainState.voice ?? {}),
          pending: { resultId, text: entry.text, mode, at: Date.now(), claimedBy: null },
        }
        this.broadcast({ type: 'voice.pending', pending: this.domainState.voice.pending })
        if (mode === 'send') this.#armFallback(resultId)
        this.logger('info', `[voice] 设备请求 ${mode}：${resultId}（${entry.text.length} 字）`)
      }),
    )
  }

  /**
   * 挂件认领一次 pending（多窗口先到先得）。
   *
   * @returns {{mode:string,text:string}|null} null = 不存在 / 已被认领 / 已处理。
   */
  take(resultId) {
    const pending = this.domainState.voice?.pending
    if (!pending || pending.resultId !== resultId || pending.claimedBy) return null
    pending.claimedBy = 'widget'
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer)
      this.fallbackTimer = null
    }
    return { mode: pending.mode, text: pending.text }
  }

  /**
   * 挂件执行完成的回执：清 pending、把结果 toast 给设备。
   *
   * `replacedDraft` 是 send 模式整段替换前的旧草稿（决策 1 的"可找回"缓解，
   * 见 docs/06 §2.3）——存进面板可见的状态里，不再静默丢失。
   */
  ack({ resultId, ok, reason, replacedDraft } = {}) {
    const pending = this.domainState.voice?.pending
    if (!pending || pending.resultId !== resultId) {
      return { ok: false, message: '该识别结果已处理过' }
    }
    this.#clearPending(resultId)
    if (typeof replacedDraft === 'string' && replacedDraft) {
      this.domainState.voice.replacedDraft = replacedDraft
      this.broadcast({ type: 'voice.replaced', replacedDraft })
    }
    const done = ok !== false
    // reason 优先：挂件在"成功但语义不同"时也会带一句更准的话
    // （比如 setDraft 成功但没有 submit 动词时是「已填入」而不是「已发送」）。
    const text = String(reason || '')
      || (done ? (pending.mode === 'send' ? '已发送' : '已填入') : '操作失败，文本已保留在语音列表')
    void this.link.send(MSG.TOAST, { text }).catch(() => {})
    return { ok: true, message: text }
  }

  #clearPending(resultId) {
    const pending = this.domainState.voice?.pending
    if (!pending || (resultId && pending.resultId !== resultId)) return
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer)
      this.fallbackTimer = null
    }
    this.domainState.voice.pending = null
    this.broadcast({ type: 'voice.pending', pending: null })
  }

  /** send 模式的降级定时器：超时没挂件认领就直接把文本发成一条用户消息。 */
  #armFallback(resultId) {
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer)
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null
      const pending = this.domainState.voice?.pending
      if (!pending || pending.resultId !== resultId || pending.claimedBy) return
      pending.claimedBy = 'fallback'
      if (!this.config.voice.fallbackPrompt) {
        void this.link.send(MSG.TOAST, { text: '客户端未打开，无法发送' }).catch(() => {})
        this.#clearPending(resultId)
        return
      }
      void this.#promptFallback(pending.text)
        .then((notice) => {
          this.#clearPending(resultId)
          void this.link.send(MSG.TOAST, { text: notice }).catch(() => {})
        })
        .catch((error) => {
          this.#clearPending(resultId)
          void this.link.send(MSG.TOAST, { text: `发送失败：${error?.message ?? error}` }).catch(() => {})
        })
    }, FALLBACK_MS)
  }

  /** 降级直发：不经输入框，直接作为一条用户消息排队进目标会话。 */
  async #promptFallback(text) {
    const ctx = this.ctx
    const controller = typeof ctx?.get === 'function' ? ctx.get('sessionController') : null
    if (!controller?.prompt) throw new Error('宿主没有 sessionController，无法直发')
    const sessionId = await this.#resolveTargetSession(controller)
    if (!sessionId) throw new Error('没有可发送的会话')
    const requestId = `passport-voice-${Date.now().toString(36)}`
    await controller.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      // ★ content 必须是**文本分部数组**：SessionPromptRequest 的严格校验只接受
      //   [{type:'text', text}]，传纯字符串会被拒 —— 现象是降级直发 100% 失败、
      //   设备 toast「发送失败：…」（真机返工记录）。
      content: [{ type: 'text', text }],
    })
    return '已直接发送到任务'
  }

  /** 直发目标：优先正在跑的会话（语音多是对当前任务的追加指令），否则最近更新的非空会话。 */
  async #resolveTargetSession(controller) {
    try {
      const result = await controller.list({})
      const items = Array.isArray(result) ? result : (result?.items ?? [])
      const running = items.find((item) => item.running)
      if (running?.sessionId) return running.sessionId
      const candidates = items
        .filter((item) => item.sessionId && !item.blank)
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      return candidates[0]?.sessionId ?? null
    } catch {
      return null
    }
  }

  /**
   * 语音通道字节流：流式按**到达顺序**追加音频载荷。
   *
   * ★ 为什么不用 4bit seq 做键（旧设计的坑）：
   *   设备一条录音要分多条 `ap_link_send_voice` 上行（单消息受 2048B 载荷上限），
   *   而 seq 在每条消息里都从 0 重新开始。旧实现按 `seq` 去重，会让第 2 条起的
   *   载荷全部被当成"重复"丢掉 —— 只剩第一条 0.26 秒的音频。
   *   现改为：BLE notify 对同一特征值**按发送顺序到达**，直接按到达顺序追加即可；
   *   4bit seq 与 FIRST/LAST 只用于日志诊断，不参与排序/去重。
   */
  #onVoiceBytes(bytes) {
    // 分片头 4 字节之后是载荷；sessionId 借 header 的 msgId 字段传递
    if (bytes.length <= 4) return
    const flags = bytes[0] & 0x0f
    const msgId = ((bytes[2] & 0xff) << 4) | ((bytes[3] >> 4) & 0x0f)
    const seq = bytes[3] & 0x0f
    const payload = bytes.subarray(4)

    // 音频属于**最新**开始的录音（设备边录边发），取队尾。
    const queue = this.sessions.get(msgId)
    const session = queue && queue.length > 0 ? queue[queue.length - 1] : null
    if (!session) {
      // 没收到 voice.begin 就来的音频：丢弃，不猜它是哪一段
      this.logger('debug', `[voice] 收到无归属的音频分片 msgId=${msgId}`)
      return
    }
    // [诊断] 单条消息内 seq 必须 0,1,2… 连续：断档 = 分片丢失 →
    // 拼接后的字节流错位 → 解码出饱和噪声（正是本轮排障的现象）。
    // FIRST 到达时把期望重置为 0（跨消息 seq 归零是正常的，不算断档）。
    if (flags & FLAG.FIRST) {
      session.messages += 1
      session.expectSeq = 0
    }
    if (session.expectSeq === null || seq !== session.expectSeq) {
      session.seqGaps += 1
      console.log(`[voice-dbg] ★seq 断档 session=${msgId} 期望=${session.expectSeq} 实际=${seq}（丢片→解码错位）`)
    }
    session.expectSeq = seq + 1
    session.parts.push(Buffer.from(payload))
    session.packets += 1
  }

  // —— 识别 ——

  /**
   * 读识别提供者目录与就绪状态，面板用。
   *
   * @param {{quiet?: boolean}} [options] quiet=true 时，**服务缺失不发布错误**
   *   （只用于启动探测的早期尝试：`speechToText` 是可选服务，注册时机可能晚于本插件，
   *   那几秒里发布"没有语音识别服务"是误报 —— 真机反馈过"模型早就配好了却显示未启用"）。
   */
  async refreshCatalog({ quiet = false } = {}) {
    const speech = this.#speechService()
    if (!speech) {
      if (!quiet) {
        this.domainState.speech = null
        this.domainState.speechError = '当前 DSH 没有启用语音识别服务（ctx.speechToText 不存在）'
        this.broadcast({ type: 'speech.error', message: this.domainState.speechError })
      }
      return null
    }
    try {
      const snapshot = speech.snapshot()
      const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : []
      const selectedId = snapshot?.selection?.providerId ?? null
      const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0] ?? null

      // ★ ready 的语义：DSH 在推理时接受 **ready 或 standby**（asar 原文：
      //   "At execution, the worker requires ready or standby resources"）。
      //   standby = 资源已装好、只是没预热，第一次录音会自动唤醒 worker。
      //   早先这里写成 `phase === 'ready'`，于是模型一闲置就报"未启用" ——
      //   真机反馈："模型之前就配置好了，本来就应该显示已启用"。
      const phase = selected?.preparation?.phase ?? 'unprepared'
      const info = {
        providerId: selected?.id ?? null,
        providerName: selected?.name ?? null,
        location: selected?.location ?? null,
        languages: selected?.languages ?? [],
        ready: phase === 'ready' || phase === 'standby',
        phase,
        // 给挂件用：只有"确实没装/上次失败"才该出现「准备模型」；
        // "正在准备"期间显示进度说明而不是按钮。
        needsPreparation: NEEDS_PREPARATION_PHASES.has(phase),
        preparing: PREPARING_PHASES.has(phase),
        detail: describePreparation(selected?.preparation),
        providerCount: providers.length,
      }
      this.domainState.speech = info
      this.domainState.speechError = providers.length === 0
        ? '没有可用的识别提供者。请在 DSH 里启用本地语音识别（SenseVoice）或安装一个识别插件。'
        : null
      this.broadcast({ type: 'speech.updated', speech: info })
      return info
    } catch (error) {
      this.domainState.speechError = `读取识别状态失败：${error.message}`
      this.broadcast({ type: 'speech.error', message: this.domainState.speechError })
      return null
    }
  }

  /**
   * 启动时的识别目录探测。
   *
   * ★ 为什么必须有：`refreshCatalog()` 原先只在"手动刷新"和"准备模型"里被调用，
   *   于是插件启动后 `domainState.speech` 一直是 null —— 挂件与面板因此显示"未启用"，
   *   而模型其实早就装好了（真机反馈："模型之前就配置好了，本来就应该显示已启用"）。
   *   现在启动后主动刷一次，并给几次重试：早期尝试用 quiet 模式，
   *   避免服务注册稍晚就误报"没有语音识别服务"。
   *
   * @param {number[]} [delays] 各次尝试的延迟（毫秒）；测试传小值即可快速跑完。
   */
  startInitialCatalogProbe(delays = CATALOG_PROBE_DELAYS_MS) {
    if (this.catalogProbeTimer) return
    const attempt = (index) => {
      this.catalogProbeTimer = setTimeout(async () => {
        this.catalogProbeTimer = null
        const isLast = index + 1 >= delays.length
        let info = null
        try {
          info = await this.refreshCatalog({ quiet: !isLast })
        } catch (error) {
          this.logger('debug', `[voice] 识别目录探测失败：${error?.message ?? error}`)
        }
        if (info?.ready) return
        if (!isLast) attempt(index + 1)
      }, delays[index])
      this.catalogProbeTimer.unref?.()
    }
    attempt(0)
  }

  /** 触发模型准备（SenseVoice 首次会下载约 240MB）。 */
  async prepare() {
    const speech = this.#speechService()
    if (!speech) throw new Error('当前 DSH 没有启用语音识别服务')
    const catalog = await this.refreshCatalog()
    const providerId = this.config.voice.providerId || catalog?.providerId
    if (!providerId) throw new Error('没有可用的识别提供者')
    speech.prepare(providerId, {})
    this.logger('info', `[voice] 已请求准备识别模型：${providerId}`)
    return { providerId }
  }

  /**
   * 归档本次录音（仅在 `voice.keepAudio` 打开时调用）。
   *
   * 失败只记日志、绝不影响识别：归档是旁路功能，不能让写盘问题毁掉一次转写。
   * 文件名用时间戳前缀，天然按时间排序（清理逻辑也据此保留最新几组）。
   */
  #archiveAudio(session, sessionId, wav, deviceMaxRms = null) {
    try {
      const dir = String(this.config.voice?.audioDir ?? '').trim() || DEFAULT_AUDIO_DIR
      const keep = this.config.voice?.audioKeepFiles ?? DEFAULT_AUDIO_KEEP_FILES
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
      const { files, pruned } = writeAudioArchive({
        dir,
        stem: `${stamp}-session${sessionId}`,
        wavBytes: wav.bytes,
        parts: session.parts,
        keep,
      })
      this.logger(
        'info',
        `[voice] 已归档 ${files.join(' + ')} → ${dir}` + (pruned.length ? `（清理 ${pruned.length} 个旧文件）` : ''),
      )
      this.logger(
        'debug',
        `[voice] 归档探针 deviceMaxRms=${deviceMaxRms} seqGaps=${session.seqGaps} ` +
          `msgs=${session.messages} packets=${session.packets}`,
      )
    } catch (error) {
      this.logger('warn', `[voice] 音频归档失败：${error?.message ?? error}`)
    }
  }

  async #transcribe(wav, format) {
    const speech = this.#speechService()
    if (!speech) throw new Error('当前 DSH 没有启用语音识别服务（ctx.speechToText 不存在）')

    const request = { audio: wav.bytes, language: this.config.voice.language }
    if (this.config.voice.providerId) request.providerId = this.config.voice.providerId

    const spec = speech.resolve(request)
    const transcript = await speech.transcribe(spec, AbortSignal.timeout(60_000))
    const text = String(transcript?.text ?? '').trim()
    this.logger(
      'info',
      `[voice] 识别完成：${text.length} 字 / 音频 ${transcript?.audioSeconds?.toFixed?.(2) ?? '?'}s / 耗时 ${transcript?.inferenceSeconds?.toFixed?.(2) ?? '?'}s`,
    )
    void format
    return text
  }

  #speechService() {
    const ctx = this.ctx
    if (!ctx) return null
    // 可选服务一律用 get：老宿主没有 speechToText，写进 inject 会让插件永远不 apply
    const speech = typeof ctx.get === 'function' ? ctx.get('speechToText') : ctx.speechToText
    return speech && typeof speech.transcribe === 'function' ? speech : null
  }

  async dispose() {
    if (this.catalogProbeTimer) {
      clearTimeout(this.catalogProbeTimer)
      this.catalogProbeTimer = null
    }
    try {
      this.link.transport.off('data', this.voiceListener)
    } catch {
      // 传输已关闭
    }
    for (const dispose of this.disposers) {
      try {
        dispose()
      } catch {
        // 宿主已拆
      }
    }
    this.disposers.length = 0
    this.sessions.clear()
    this.resultTexts.clear()
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer)
      this.fallbackTimer = null
    }
  }
}

/**
 * 把流式累积的 ADPCM 分片还原成 WAV 字节。
 *
 * 音频按**到达顺序**拼接（见 #onVoiceBytes 的说明：一条录音跨多条 BLE 消息，
 * 4bit seq 每条消息都重置，不能用它排序）。BLE 对同一 notify 特征值按序送达。
 * 只需校验：至少有一片、且拼出的字节够一个 ADPCM 块头 —— 否则说明根本没收到音频。
 */
export function assembleWav(session) {
  const parts = session?.parts
  if (!parts || parts.length === 0) return null

  const compressed = Buffer.concat(parts)
  if (compressed.length < 4) return null   // 不足一个 ADPCM 块头
  const pcm = decodeImaAdpcm(compressed)

  const { sampleRate, bits, channels } = session.format
  const bytes = Buffer.from(encodeWav(pcm, sampleRate, bits, channels))
  return { bytes, pcmBytes: pcm.length, compressedBytes: compressed.length }
}

/**
 * IMA/DVI ADPCM 解码（4 bit → 16 bit）。
 *
 * 与设备端 app_voice.c 的实现必须严格一致：同样的步长表、同样的索引更新顺序。
 * 任何一侧改了表或改了更新顺序，声音都会变成噪声——这是最容易出错也最容易被忽略的地方，
 * 所以两张表在这里以字面量写死并附注释，不做任何"优化"。
 */
const IMA_INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]
const IMA_STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 40, 43, 48, 52, 56, 60, 64, 68, 73, 78, 83, 89,
  94, 99, 105, 112, 117, 124, 130, 137, 144, 151, 157, 163, 170, 177, 184, 191, 198, 205, 212, 219, 226, 233, 240,
  247, 255, 262, 270, 278, 286, 294, 303, 312, 321, 331, 341, 351, 362, 373, 384, 396, 408, 420, 433, 446, 459, 473,
  487, 502, 517, 532, 548, 564, 581, 598, 616, 634, 653, 672, 691, 712, 733, 754, 776, 799, 822, 846, 871, 896, 922,
  948, 976, 1004, 1032, 1062, 1092, 1123, 1155, 1188, 1222, 1257, 1292, 1328, 1366, 1404, 1444, 1484, 1526, 1568,
  1613, 1659, 1706, 1754, 1804, 1856, 1909, 1963, 2019, 2076, 2135, 2195, 2257, 2322, 2388, 2455, 2525, 2597, 2670,
  2745, 2823, 2902, 2984, 3068, 3154, 3243, 3334, 3428, 3524, 3622, 3723, 3827, 3933, 4042, 4154, 4269, 4386, 4507,
  4630, 4756, 4885, 5017, 5152, 5291, 5433, 5578, 5727, 5879, 6035, 6194, 6357, 6524, 6695, 6870, 7048, 7231, 7418,
  7610, 7806, 8007, 8212, 8423, 8638, 8858, 9083, 9314, 9550, 9792, 10039, 10292, 10551, 10816, 11087, 11364,
  11648, 11938, 12235, 12539, 12850, 13168, 13493, 13826, 14166, 14514, 14870, 15234, 15606, 15987, 16376, 16774,
  17181, 17597, 18022, 18456, 18900, 19354, 19818, 20292, 20776, 21271, 21776, 22293, 22820, 23359, 23909, 24471,
  25045, 25630, 26228, 26838, 27461, 28097, 28746, 29408, 30084, 30773, 31477, 32194, 32926, 33672, 34433, 35209,
  36000, 36807, 37630, 38469, 39325, 40197, 41087, 41994, 42919, 43862, 44824, 45805, 46805, 47825, 48865, 49926,
  51008, 52112, 53237, 54384, 55554, 56747, 57963, 59203, 60468, 61757, 63072, 64413, 65780, 67174, 68596, 70046,
  71526, 73035, 74575, 76145, 77748, 79383, 81051, 82753, 84490, 86262, 88070, 89915, 91797, 93718, 95678, 97678,
  99719, 101802, 103928, 106098, 108314, 110575, 112884, 115241, 117648, 120106, 122616, 125180, 127798, 130473,
  133205, 135996, 138848, 141761, 144738, 147780, 150888, 154065, 157312, 160631, 164024, 167493, 171040, 174667,
  178377, 182172, 186054, 190026, 194090, 198250, 202507, 206865, 211327, 215896, 220575, 225368, 230278, 235309,
  240465, 245750, 251168, 256724, 262423, 268270, 274270, 280428, 286750, 293241, 299908, 306756, 313792, 321023,
  328456, 336098, 343957, 352042, 360360, 368921, 377735, 386811, 396159, 405790, 415715, 425945, 436493, 447371,
  458592, 470170, 482119, 494455, 507193, 520351, 533946, 548000,
]

/** 解码一整块 ADPCM：前 4 字节是块头（predictor + index + 保留），之后每字节两个采样。 */
export function decodeImaAdpcm(data) {
  if (!data || data.length === 0) return Buffer.alloc(0)
  const out = Buffer.alloc((data.length - 4) * 4)
  let outIndex = 0

  let offset = 0
  while (offset + 4 <= data.length) {
    let predictor = data.readInt16LE(offset)
    let stepIndex = data.readUInt8(offset + 2)
    offset += 4
    if (stepIndex > 88) stepIndex = 88

    // 每块最多 505 字节数据 → 1010 个采样；这里以"本块剩余"为界，
    // 允许最后一块短一些（设备端的分块边界可能落在任意位置）。
    const blockEnd = Math.min(data.length, offset + 504)
    while (offset < blockEnd) {
      const byte = data[offset]
      offset += 1
      for (const nibble of [byte & 0x0f, (byte >> 4) & 0x0f]) {
        const step = IMA_STEP_TABLE[stepIndex]
        let diff = step >> 3
        if (nibble & 1) diff += step >> 2
        if (nibble & 2) diff += step >> 1
        if (nibble & 4) diff += step

        if (nibble & 8) predictor -= diff
        else predictor += diff

        if (predictor > 32767) predictor = 32767
        else if (predictor < -32768) predictor = -32768

        stepIndex += IMA_INDEX_TABLE[nibble]
        if (stepIndex < 0) stepIndex = 0
        else if (stepIndex > 88) stepIndex = 88

        out.writeInt16LE(predictor, outIndex)
        outIndex += 2
      }
    }
  }
  return out.subarray(0, outIndex)
}

/** 生成规范的 44 字节 WAV 头。识别提供者会校验它。 */
export function encodeWav(pcm, sampleRate, bits, channels) {
  const byteRate = (sampleRate * channels * bits) / 8
  const blockAlign = (channels * bits) / 8
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt chunk 大小
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** 把准备状态说成能直接照做的一句话。 */
function describePreparation(preparation) {
  if (!preparation) return '未准备'
  switch (preparation.phase) {
    case 'ready':
      return '已就绪'
    case 'unprepared':
      return '尚未准备，需要先下载模型'
    case 'downloading': {
      const done = Math.round((preparation.completedBytes ?? 0) / (1024 * 1024))
      const total = preparation.totalBytes ? Math.round(preparation.totalBytes / (1024 * 1024)) : null
      return total ? `正在下载模型 ${done}/${total} MB` : `正在下载模型 ${done} MB`
    }
    case 'checking':
      return '正在检查缓存'
    case 'loading':
      return '正在加载模型'
    case 'waking':
      return '正在唤醒识别引擎'
    case 'cancelling':
      return '正在取消'
    case 'failed':
      return `准备失败：${preparation.message ?? '未知原因'}`
    case 'standby':
      return '待机'
    default:
      return String(preparation.phase ?? '未知状态')
  }
}
