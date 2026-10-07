/**
 * 主机侧链路（HostLink）：把"传输"与"业务域"粘起来的那一层。
 *
 * 职责边界刻意收得很窄，只做四件事：
 *   1. 连接生命周期：握手、心跳、掉线检测、重连退避；
 *   2. 收发：分片/重组/ACK 重传、按消息类型分发到注册的处理器；
 *   3. 对设备的下行队列：BLE 写入需要节流，不能一串 await 全冲进去；
 *   4. 可观测：把链路事件与统计暴露给面板，出问题时能一眼看出卡在哪。
 *
 * 它**不**知道任务、审批、余额、语音的业务语义——那些由 bridge/*.js 注册处理器实现。
 * 这样做的直接好处：协议层与领域层可以各自单测，mock 传输下能跑全部业务逻辑。
 */

import { EventEmitter } from 'node:events'

import {
  Reassembler,
  PendingAcks,
  MsgIdAllocator,
  encodeChunks,
  encodeJson,
  decodeJson,
  hexPreview,
} from '../protocol/chunk.js'
import {
  ACK_MAX_RETRIES,
  ACK_TIMEOUT_MS,
  CHANNEL,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISS_LIMIT,
  MAX_PAYLOAD_BYTES,
  MSG,
  PROTOCOL_VERSION,
} from '../protocol/constants.js'
import { LINK_STATE, TransportError, TRANSPORT_ERROR } from './transport.js'

/** 重连退避序列（毫秒）。到顶后保持，不再无限增长。 */
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000]

/**
 * 下行发送队列。
 *
 * 为什么需要：BLE 的 Write Without Response 有流控窗口，一次性灌入大量通知
 * 会触发底层缓冲区溢出（表现为丢包或 `EBUSY`）。这里串行化并保留最小间隔，
 * 让链路在批量推送任务列表时保持稳定。
 */
class SendQueue {
  constructor(options = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 4
    /** @type {Array<{channel:string, chunk:Uint8Array, resolve:Function, reject:Function}>} */
    this.items = []
    this.running = false
    this.lastSentAt = 0
    this.stopped = false
  }

  push(transport, channel, chunk) {
    return new Promise((resolve, reject) => {
      if (this.stopped) {
        reject(new TransportError(TRANSPORT_ERROR.DISCONNECTED, '发送队列已停止'))
        return
      }
      this.items.push({ channel, chunk, resolve, reject })
      void this.#drain(transport)
    })
  }

  async #drain(transport) {
    if (this.running) return
    this.running = true
    try {
      while (this.items.length > 0) {
        const item = this.items.shift()
        const wait = this.minIntervalMs - (Date.now() - this.lastSentAt)
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        try {
          await transport.send(item.channel, item.chunk)
          this.lastSentAt = Date.now()
          item.resolve()
        } catch (error) {
          item.reject(error)
        }
      }
    } finally {
      this.running = false
    }
  }

  /** 断链时清空：残留项必须显式失败，否则调用方的 await 会永远挂着。 */
  clear(reason) {
    const error = new TransportError(TRANSPORT_ERROR.DISCONNECTED, reason ?? '链路已断开')
    for (const item of this.items) item.reject(error)
    this.items.length = 0
  }

  stop() {
    this.stopped = true
    this.clear('发送队列已停止')
  }

  get length() {
    return this.items.length
  }
}

export class HostLink extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./transport.js').Transport} options.transport
   * @param {string} [options.targetDeviceId] 只连接这台设备；不填则连第一台匹配的
   * @param {boolean} [options.autoReconnect]
   * @param {(level:string, message:string, detail?:object)=>void} [options.logger]
   */
  constructor(options) {
    super()
    if (!options?.transport) throw new TypeError('HostLink 需要一个 transport')

    this.transport = options.transport
    this.targetDeviceId = options.targetDeviceId
    this.autoReconnect = options.autoReconnect ?? true
    this.logger = options.logger ?? (() => {})

    this.reassembler = new Reassembler()
    this.acks = new PendingAcks({
      timeoutMs: ACK_TIMEOUT_MS,
      maxRetries: ACK_MAX_RETRIES,
      onGiveUp: (msgId) => this.#onAckGiveUp(msgId),
    })
    this.msgIds = new MsgIdAllocator()
    this.sendQueue = new SendQueue()

    /** @type {Map<string, (message:object, context:object)=>void|Promise<void>>} */
    this.handlers = new Map()
    /** @type {object | null} 设备上报的 hello 内容（固件版本、能力位、电量）。 */
    this.deviceInfo = null
    /** 握手是否闭环（收到设备回的 hello.ack）。 */
    this.handshakeComplete = false
    this.hostInfo = { protocolVersion: PROTOCOL_VERSION, hostName: safeHostname(), platform: process.platform }
    // 配对 token（阶段 C）：已配对时随每次握手发给设备，设备校验通过才处理业务消息
    this.hostToken = null
    this.heartbeatTimer = null
    this.missedHeartbeats = 0
    this.reconnectTimer = null
    this.reconnectAttempt = 0
    this.disposed = false
    /** 审计用：设备上报的最近 N 条关键事件。 */
    this.lastError = null
    // 断开归因（真机排障用）：谁先动手杀的链路 ——
    //   'peripheral-disconnect' = 设备/系统层断开
    //   'heartbeat-timeout'     = 主机心跳判死（主机主动杀）
    //   'bridge-exited'         = 桥子进程退出（崩溃/被杀）
    //   'user'                  = 用户主动断开
    this.lastDisconnect = null

    this.stats = {
      messagesIn: 0,
      messagesOut: 0,
      bytesIn: 0,
      bytesOut: 0,
      gaps: 0,
      stale: 0,
      bytesDropped: 0,
      ackTimeouts: 0,
      reconnects: 0,
      connectedAt: null,
    }

    this.#attachTransport()
  }

  // —— 公共 API ——

  /**
   * 注册一个消息处理器。
   *
   * @param {string} type MSG 中的类型
   * @param {(message:object, context:{msgId:number, channel:number, reply:Function})=>void|Promise<void>} handler
   * @returns {()=>void} 注销函数
   */
  onMessage(type, handler) {
    this.handlers.set(type, handler)
    return () => {
      if (this.handlers.get(type) === handler) this.handlers.delete(type)
    }
  }

  /** 启动：扫描并连接目标设备。 */
  async start() {
    if (this.disposed) throw new TransportError(TRANSPORT_ERROR.NOT_AVAILABLE, '链路已关闭')
    const probe = await this.transport.probe()
    if (!probe.available) {
      throw new TransportError(TRANSPORT_ERROR.NOT_AVAILABLE, probe.reason ?? '传输不可用', {
        hint: probe.hint,
      })
    }
    await this.transport.startScan()
  }

  /** 停止扫描/断开/停止重连。 */
  async stop(reason = 'user') {
    this.autoReconnect = false
    this.#clearReconnectTimer()
    this.#stopHeartbeat()
    if (this.transport.state === LINK_STATE.SCANNING) await this.transport.stopScan()
    if (this.transport.state === LINK_STATE.CONNECTED) await this.transport.disconnect(reason)
  }

  /**
   * 发送一条控制消息。
   *
   * @param {string} type
   * @param {object} [payload] 会与 `{type}` 合并
   * @param {object} [options]
   * @param {boolean} [options.ack] 是否要求 ACK（默认控制消息要求）
   * @param {number} [options.channel]
   */
  async send(type, payload = {}, options = {}) {
    return this.#sendMessage(type, payload, {
      channel: options.channel ?? CHANNEL.CONTROL,
      ack: options.ack ?? true,
    })
  }

  /** 发送语音下行（目前协议里没有 Mac→设备的音频，保留给未来的提示音/朗读）。 */
  async sendVoice(bytes) {
    return this.#sendMessage(null, bytes, { channel: CHANNEL.VOICE, ack: false, raw: true })
  }

  /** 当前链路快照，供面板与工具读取。 */
  snapshot() {
    return {
      transport: this.transport.kind,
      state: this.transport.state,
      device: this.transport.device,
      deviceInfo: this.deviceInfo,
      handshakeComplete: this.handshakeComplete,
      mtuPayload: this.transport.mtuPayload,
      stats: { ...this.stats, queueLength: this.sendQueue.length, ...this.acks.stats() },
      lastError: this.lastError
        ? { code: this.lastError.code, message: this.lastError.message, hint: this.lastError.hint }
        : null,
      lastDisconnect: this.lastDisconnect,
      reconnectAttempt: this.reconnectAttempt,
    }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.#clearReconnectTimer()
    this.#stopHeartbeat()
    this.sendQueue.stop()
    this.acks.clear()
    this.reassembler.clear()
    this.msgIds.clear()
    await this.transport.dispose()
    this.removeAllListeners()
  }

  // —— 传输事件接线 ——

  #attachTransport() {
    this.transport.on('state', ({ state }) => {
      this.emit('state', { state, snapshot: this.snapshot() })
    })

    this.transport.on('device', (device) => {
      this.emit('device', device)
      if (this.targetDeviceId && device.id !== this.targetDeviceId) return
      if (this.transport.state !== LINK_STATE.SCANNING) return
      void this.#connectTo(device)
    })

    this.transport.on('data', ({ channel, bytes }) => this.#onChunk(channel, bytes))

    this.transport.on('disconnect', (payload) => {
      this.#onDisconnected(payload)
    })

    this.transport.on('error', (error) => {
      // 设备未找到这类"扫描期间的正常噪音"不必升级成用户可见错误，
      // 否则面板上会一直闪红。真正的连接失败会走 connect 的 reject 路径。
      this.logger('debug', `[link] transport error: ${error.code} ${error.message}`)
    })
  }

  async #connectTo(device) {
    try {
      this.logger('info', `[link] 连接 ${device.name} (${device.id})`)
      const info = await this.transport.connect(device.id)
      this.reconnectAttempt = 0
      // 成功连上就清掉上一轮的错误。否则 lastError 永久钉在面板上 ——
      // 链路明明已 ready，红色横幅还在报几轮前的失败（真实反馈的缺陷）。
      this.lastError = null
      this.stats.connectedAt = Date.now()
      this.reassembler.clear()
      this.msgIds.clear()
      this.handshakeComplete = false
      this.emit('connected', info)
      await this.#handshake()
      this.#startHeartbeat()
    } catch (error) {
      this.lastError = error
      this.emit('link-error', error)
      this.#scheduleReconnect()
    }
  }

  /** 设置/清除配对 token（由 PairingDomain 调用）。 */
  setHostToken(token) {
    this.hostToken = token || null
  }

  /** 握手：设备主动发 hello，我们回 hello.ack 并做版本协商。 */
  async #handshake() {
    try {
      const payload = { protocolVersion: PROTOCOL_VERSION, capabilities: 0 }
      if (this.hostToken) payload.token = this.hostToken   // 已配对：带上 token
      await this.send(MSG.HELLO, payload)
    } catch (error) {
      this.logger('warn', `[link] 握手发送失败：${error.message}`)
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat()
    this.missedHeartbeats = 0
    this.heartbeatTimer = setInterval(() => {
      if (this.transport.state !== LINK_STATE.CONNECTED) return
      // ★ 发送队列积压时跳过 ping（见下方），**也不计入丢失** ——
      //   ping 根本没发出去，"没收到 pong"不等于"对端不在线"。
      if (this.sendQueue.length > 4) {
        this.logger('debug', `[link] 发送队列积压 ${this.sendQueue.length}，跳过本次心跳`)
        return
      }
      this.missedHeartbeats += 1
      if (this.missedHeartbeats > HEARTBEAT_MISS_LIMIT) {
        this.logger('warn', `[link] 连续 ${this.missedHeartbeats} 次心跳无响应，判定掉线`)
        this.#stopHeartbeat()
        // 交给 transport 处理底层断开，再走统一的重连路径
        void this.transport.disconnect('heartbeat-timeout')
        return
      }
      // 心跳不带 ACK：它的"回应"就是 pong，不需要额外重传层。
      //
      // ★ 语音上行期间音频通知会把控制通道挤拥塞，ping/pong 都可能丢。
      //   丢失不是"主机走了"，只是这一轮没送达 —— 之前 missedHeartbeats 一丢就
      //   累加，3 丢就判定掉线，于是"识别后有时自己断开连接"。
      //
      //   修法（两层）：
      //   1. **发送队列积压时不发 ping**：语音突发时 sendQueue 可能积压几十条，
      //      再塞一条 ping 只会加剧拥塞，而且 ping 发不出去还会被误计为"丢失"。
      //   2. **收任何控制消息都算心跳存活**：不只 pong，ACK/NACK/hello/voice.result
      //      都证明对端还在（见 #dispatch）。
      if (this.sendQueue.length > 4) {
        // 队列积压：跳过这次 ping（不算丢失 —— 等拥塞缓解后自然恢复）。
        this.logger('debug', `[link] 发送队列积压 ${this.sendQueue.length}，跳过本次心跳`)
        return
      }
      this.send(MSG.PING, { t: Date.now() }, { ack: false, channel: CHANNEL.HEARTBEAT }).catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref?.()
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.missedHeartbeats = 0
  }

  #onDisconnected(payload) {
    this.lastDisconnect = {
      reason: String(payload?.reason ?? 'unknown'),
      unexpected: Boolean(payload?.unexpected),
      at: Date.now(),
    }
    this.#stopHeartbeat()
    this.reassembler.clear()
    this.acks.clear()
    this.msgIds.clear()
    this.sendQueue.clear('链路已断开')
    // ★ deviceInfo **故意不置空**：固件版本是设备的静态属性，断线/重连窗口里
    //   面板把它闪成"—"没有信息量，反而像是插件坏了（真实反馈）。
    //   握手状态仍复位，下次 hello 会整体覆盖（换设备连接时不会串味）。
    this.handshakeComplete = false
    this.stats.connectedAt = null
    this.emit('disconnected', payload)
    if (payload.unexpected && this.autoReconnect) this.#scheduleReconnect()
  }

  #scheduleReconnect() {
    if (!this.autoReconnect || this.disposed || this.reconnectTimer) return
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]
    this.reconnectAttempt += 1
    this.stats.reconnects += 1
    this.logger('info', `[link] ${delay}ms 后重连（第 ${this.reconnectAttempt} 次）`)
    this.emit('reconnecting', { attempt: this.reconnectAttempt, delayMs: delay })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.disposed || !this.autoReconnect) return
      void this.transport.startScan().catch((error) => {
        this.lastError = error
        this.emit('link-error', error)
        this.#scheduleReconnect()
      })
    }, delay)
    this.reconnectTimer.unref?.()
  }

  #clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  #onAckGiveUp(msgId) {
    this.stats.ackTimeouts += 1
    this.msgIds.release(msgId)
    const error = new TransportError(TRANSPORT_ERROR.TIMEOUT, `消息 ${msgId} 未收到确认（重传 ${ACK_MAX_RETRIES} 次）`)
    this.lastError = error
    this.logger('warn', `[link] ${error.message}`)
    this.emit('ack-timeout', { msgId, error })
  }

  // —— 收发核心 ——

  #onChunk(_channel, bytes) {
    this.stats.bytesIn += bytes.length
    const result = this.reassembler.push(bytes)

    switch (result.kind) {
      case 'incomplete':
        return
      case 'gap':
        this.stats.gaps += 1
        this.stats.bytesDropped += bytes.length
        this.logger('debug', `[link] 丢片：msgId=${result.msgId} 期望 seq=${result.expectedSeq} 实收 ${result.gotSeq}`)
        // 本地先广播缺口：面板要靠它显示丢片，业务域要靠它判断某条消息是否真的到达。
        // 少了这一行，缺片就只有设备知道、主机侧完全看不见（这是修复前的真实缺陷：
        // NACK 发出去了，但主机自己没有任何本地事件，重传与告警都无从触发）。
        this.emit('gap', {
          msgId: result.msgId,
          channel: result.channel,
          expectedSeq: result.expectedSeq,
          gotSeq: result.gotSeq,
          stats: { ...this.stats },
        })
        // 通知设备重传整条：NACK 是"请重发"的唯一手段，比静默丢弃更快恢复。
        this.send(MSG.NACK, { msgId: result.msgId, reason: 'gap' }, { ack: false }).catch(() => {})
        return
      case 'stale':
        this.stats.stale += 1
        return
      case 'overflow':
        this.stats.bytesDropped += result.bytes
        this.logger('warn', `[link] 消息超限被丢弃：msgId=${result.msgId} ${result.bytes} 字节`)
        return
      case 'message':
        break
      default:
        return
    }

    this.stats.messagesIn += 1
    if (result.ackRequired) {
      // 诊断：ACK 的 msgId 必须与设备帧头里的 msgId 完全一致，否则设备会一直重传。
      // 这行把"回给谁"直接打出来，避免只能从设备侧反推。
      this.logger('debug', `[link] 回 ACK：设备帧 msgId=${result.msgId} channel=${result.channel}`)
      this.send(MSG.ACK, { msgId: result.msgId }, { ack: false }).catch(() => {})
    }

    const message = decodeJson(result.payload)
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      this.logger('debug', `[link] 无法解析的消息：${hexPreview(result.payload)}`)
      return
    }

    this.#dispatch(message, result)
  }

  #dispatch(message, result) {
    // 协议级消息在这里就地处理，不下发到业务域。
    switch (message.type) {
      case MSG.ACK:
        this.acks.acknowledge(Number(message.msgId))
        this.msgIds.release(Number(message.msgId))
        return
      case MSG.NACK:
        this.emit('nack', message)
        return
      case MSG.PONG:
        this.missedHeartbeats = 0
        this.emit('pong', message)
        return
      case MSG.HELLO:
        this.deviceInfo = {
          firmware: message.firmware,
          protocolVersion: Number(message.protocolVersion) || 0,
          capabilities: Number(message.capabilities) || 0,
          // null = 设备没报（老固件 / 电量计缺失）。旧写法 `Number(x)||0` 会把
          // "没报"和"真 0%"都变成 0，面板只能一律显示"—"，无法区分。
          batteryPercent: message.batteryPercent != null ? Number(message.batteryPercent) : null,
          screen: message.screen,
        }
        if (this.deviceInfo.protocolVersion !== PROTOCOL_VERSION) {
          this.logger(
            'warn',
            `[link] 协议版本不一致：设备 ${this.deviceInfo.protocolVersion} / 主机 ${PROTOCOL_VERSION}，按较低版本运行`,
          )
        }
        this.emit('device-info', this.deviceInfo)
        break
      case MSG.PING:
        this.send(MSG.PONG, { t: message.t }, { ack: false, channel: CHANNEL.HEARTBEAT }).catch(() => {})
        break
      case MSG.HELLO_ACK:
        // 设备确认主机已就绪 → 握手闭环完成。业务域可以在此之后开始推送状态，
        // 提前推送会因为设备端还没建好界面而丢失。
        this.handshakeComplete = true
        this.emit('ready', { deviceInfo: this.deviceInfo, host: message })
        break
      default:
        break
    }

    const handler = this.handlers.get(message.type)
    if (!handler) {
      this.logger('debug', `[link] 未处理的消息类型：${message.type}`)
      this.emit('unhandled', message)
      return
    }

    const context = {
      msgId: result.msgId,
      channel: result.channel,
      reply: (type, payload, options) => this.send(type, payload, options),
    }
    try {
      const returned = handler(message, context)
      if (returned && typeof returned.then === 'function') {
        returned.catch((error) => {
          this.logger('error', `[link] 处理 ${message.type} 失败：${error?.message ?? error}`)
          this.emit('handler-error', { message, error })
        })
      }
    } catch (error) {
      this.logger('error', `[link] 处理 ${message.type} 抛错：${error?.message ?? error}`)
      this.emit('handler-error', { message, error })
    }
  }

  async #sendMessage(type, payload, options) {
    if (this.transport.state !== LINK_STATE.CONNECTED) {
      throw new TransportError(TRANSPORT_ERROR.DISCONNECTED, '设备未连接，无法发送')
    }

    const bytes = options.raw ? payload : encodeJson({ type, ...payload })

    // ★ 硬约束：设备侧的接收缓冲只有 MAX_PAYLOAD_BYTES。超限发出去**不会报错**，
    //   只会让设备那边的消息永远拼不完整（表现为"任务列表显示不全"这类静默故障）。
    //   因此宁可在这里明确失败，逼调用方自己裁剪（见 bridge/state.js）。
    if (bytes.length > MAX_PAYLOAD_BYTES) {
      // 这里还没有分配 msgId，直接抛即可（别去 allocate 再 release：那会白白消耗号段）
      throw new Error(
        `消息 ${type ?? '(原始字节)'} 载荷 ${bytes.length} 字节，超过设备接收上限 ${MAX_PAYLOAD_BYTES} 字节；` +
          '调用方需要裁剪后再发（例如减少任务列表条数）',
      )
    }
    const channelName = options.channel === CHANNEL.VOICE ? 'voice' : 'control'
    const channelId = options.channel ?? CHANNEL.CONTROL

    const msgId = this.msgIds.allocate()
    let chunks
    try {
      // mtuPayload 语义 = ATT 载荷上限（MTU-3）。整帧还要加 4 字节分片头，
      // 所以每片 payload 必须再减 4 —— 否则满片帧超出 ATT 上限 3 字节，
      // 对端会静默截断（与设备端 update_chunk_payload 同一个坑，见那边的注释）。
      // 当前出站控制消息都较小（单片不触线），这是防患于未然。
      const maxChunkPayload = Math.max(16, (this.transport.mtuPayload ?? 244) - 4)
      chunks = encodeChunks({
        msgId,
        channel: channelId,
        payload: bytes,
        maxChunkPayload,
        // 语音按实时性处理：不重传，允许丢片。
        ackRequired: Boolean(options.ack) && channelId !== CHANNEL.VOICE,
      })
    } catch (error) {
      this.msgIds.release(msgId)
      throw error
    }

    this.stats.messagesOut += 1
    this.stats.bytesOut += bytes.length

    const sendAll = (list) => {
      // 不 await 全部：按顺序入队即可，队列自己节流；这里只把错误冒泡给调用方。
      return Promise.all(list.map((chunk) => this.sendQueue.push(this.transport, channelName, chunk)))
    }

    if (options.ack && channelId !== CHANNEL.VOICE) {
      this.acks.track(msgId, chunks, (retryChunks) => {
        void sendAll(retryChunks).catch(() => {})
      })
    }

    try {
      await sendAll(chunks)
    } catch (error) {
      this.acks.acknowledge(msgId)
      this.msgIds.release(msgId)
      throw error
    }

    // 无 ACK 的消息发完即释放号；有 ACK 的等 ACK 或超时释放。
    if (!options.ack || channelId === CHANNEL.VOICE) this.msgIds.release(msgId)
    return { msgId, chunks: chunks.length, bytes: bytes.length }
  }
}

function safeHostname() {
  try {
    // 延迟 require，避免在非 Node 宿主里报错
    const os = globalThis.process?.getBuiltinModule?.('node:os')
    return os?.hostname?.() ?? 'unknown-host'
  } catch {
    return 'unknown-host'
  }
}
