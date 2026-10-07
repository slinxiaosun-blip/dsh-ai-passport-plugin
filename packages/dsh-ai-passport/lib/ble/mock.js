/**
 * 内存传输实现（mock）。
 *
 * 用途有两个，都很重要：
 *   1. **无硬件联调**：没插设备也能把协议、任务域、审批域、面板全部跑通。
 *   2. **回归测试**：链路时序（丢包、延迟、掉线）在这里可控复现，
 *      真机上偶发的丢片问题可以搬到测试里稳定重现。
 *
 * 它还内置了一个"虚拟设备"（VirtualDevice），会按协议回应握手、心跳与任务列表请求，
 * 因此 `transport: 'mock'` 不是空跑，而是真的能走完一整条业务链路。
 */

import { Transport, TransportError, LINK_STATE, TRANSPORT_ERROR } from './transport.js'
import { encodeChunks, decodeJson, Reassembler } from '../protocol/chunk.js'
import { CHANNEL, DEVICE_NAME, PROTOCOL_VERSION, CAPABILITY, MSG } from '../protocol/constants.js'

/**
 * 可注入的链路损伤参数，用来复现真机上的偶发问题。
 *
 * @typedef {object} MockFaults
 * @property {number} [dropRate] 丢片概率 0..1
 * @property {number} [latencyMs] 单程延迟
 * @property {number} [mtuPayload] 模拟协商到的载荷上限
 * @property {boolean} [failConnect] 连接必定失败
 * @property {string} [connectError] failConnect 时的错误消息
 */

export class MockTransport extends Transport {
  /**
   * @param {object} [options]
   * @param {string} [options.kind]
   * @param {number} [options.mtuPayload]
   * @param {MockFaults} [options.faults]
   * @param {boolean} [options.autoRespond] 虚拟设备是否自动应答（false 时用于测试超时/无响应）
   */
  constructor(options = {}) {
    super({ kind: options.kind ?? 'mock', mtuPayload: options.mtuPayload ?? 244 })
    this.faults = { dropRate: 0, latencyMs: 0, mtuPayload: this.mtuPayload, ...options.faults }
    this.mtuPayload = this.faults.mtuPayload ?? this.mtuPayload
    this.autoRespond = options.autoRespond ?? true

    /** @type {Map<string, object>} */
    this.devices = new Map()
    this.scanning = false
    this.deviceReassembler = new Reassembler()
    this.deviceMsgId = 0
    this.voiceBytesReceived = 0
    /** 设备侧收到的消息流水，供测试断言。 @type {object[]} */
    this.received = []
    this.pendingTimers = new Set()

    // 预置一台虚拟设备，方便直接连接
    this.addDevice({
      id: options.deviceId ?? 'mock-passport-1',
      name: DEVICE_NAME,
      rssi: -52,
      batteryPercent: 87,
      firmware: '0.1.0-mock',
      protocolVersion: PROTOCOL_VERSION,
      capabilities:
        CAPABILITY.DISPLAY | CAPABILITY.BUTTONS | CAPABILITY.MIC | CAPABILITY.SPEAKER | CAPABILITY.BATTERY,
    })
  }

  /** 测试与面板都能用：动态增删虚拟设备。 */
  addDevice(info) {
    const device = {
      id: info.id,
      name: info.name ?? DEVICE_NAME,
      rssi: info.rssi ?? -60,
      batteryPercent: info.batteryPercent ?? 100,
      firmware: info.firmware ?? '0.1.0-mock',
      protocolVersion: info.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: info.capabilities ?? CAPABILITY.DISPLAY | CAPABILITY.BUTTONS,
    }
    this.devices.set(device.id, device)
    return device
  }

  removeDevice(id) {
    return this.devices.delete(id)
  }

  async probe() {
    return { available: true, detail: '内存实现，无需硬件与原生依赖' }
  }

  /** @protected */
  async doStartScan() {
    this.scanning = true
    // 异步逐个冒泡，模拟真实扫描的"设备陆续出现"，让面板列表刷新逻辑被真实地测到。
    for (const device of this.devices.values()) {
      this.#later(() => {
        if (this.scanning) this.emit('device', { ...device })
      }, 10)
    }
  }

  /** @protected */
  async doStopScan() {
    this.scanning = false
  }

  /** @protected */
  async doConnect(deviceId) {
    if (this.faults.failConnect) {
      throw new TransportError(TRANSPORT_ERROR.CONNECT_FAILED, this.faults.connectError ?? '模拟连接失败')
    }
    const device = this.devices.get(deviceId)
    if (!device) {
      throw new TransportError(TRANSPORT_ERROR.DEVICE_NOT_FOUND, `找不到设备 ${deviceId}`, {
        hint: '确认设备已开机并在广播，然后在面板里重新扫描。',
      })
    }
    if (this.scanning) await this.doStopScan()
    this.deviceReassembler.clear()
    // 真机上设备是握手的发起方：连上就立刻上报自己的固件版本、能力位与电量。
    // mock 必须复刻这个方向，否则上层的握手路径在 mock 下根本测不到。
    this.#later(() => {
      this.emitFromDevice({
        type: MSG.HELLO,
        protocolVersion: device.protocolVersion,
        firmware: device.firmware,
        capabilities: device.capabilities,
        batteryPercent: device.batteryPercent,
        screen: { width: 240, height: 320 },
      })
    }, 5)
    return { ...device }
  }

  /** @protected */
  async doDisconnect() {
    this.scanning = false
    this.deviceReassembler.clear()
  }

  /** @protected */
  async doSend(channel, chunk) {
    if (Math.random() < (this.faults.dropRate ?? 0)) return

    const deliver = () => {
      const result = this.deviceReassembler.push(chunk)
      if (result.kind === 'message') {
        const message = decodeJson(result.payload)
        if (message) {
          this.received.push({ channel, message })
          if (this.autoRespond) this.#respond(channel, message, result.msgId)
        }
        // 控制通道要回 ACK，让 ACK 重传逻辑在 mock 下也被真实覆盖。
        if (result.ackRequired && channel === 'control') {
          this.#sendToHost(CHANNEL.CONTROL, { type: MSG.ACK, msgId: result.msgId })
        }
      } else if (channel === 'control' && result.kind === 'gap') {
        // 缺口：让 mock 也走 NACK 路径，上层重传逻辑因此被真实执行
        this.#sendToHost(CHANNEL.CONTROL, { type: MSG.NACK, msgId: result.msgId, reason: 'gap' })
      }
    }

    if (this.faults.latencyMs > 0) this.#later(deliver, this.faults.latencyMs)
    else deliver()
  }

  /** @protected */
  async doDispose() {
    for (const timer of this.pendingTimers) clearTimeout(timer)
    this.pendingTimers.clear()
    this.devices.clear()
    this.received.length = 0
  }

  // —— 虚拟设备行为 ——

  /** 虚拟设备按消息类型给出符合协议的最小应答。 */
  #respond(channel, message, msgId) {
    switch (message.type) {
      case MSG.HELLO:
        // 主机发起握手 → 设备回 hello.ack，握手到此闭环。
        this.lastHelloAck = message
        this.#sendToHost(CHANNEL.CONTROL, {
          type: MSG.HELLO_ACK,
          hostName: 'mock-host',
          dshVersion: 'mock',
          protocolVersion: PROTOCOL_VERSION,
          workspace: '/mock/workspace',
        })
        break
      case MSG.PING:
        this.#sendToHost(CHANNEL.HEARTBEAT, { type: MSG.PONG, t: message.t })
        break
      // task.list.req 已随精简版移除：设备不再请求任务列表，
      // 状态改由主机主动推送（见 bridge/state.js）。
      case MSG.BALANCE_REQ:
        this.#sendToHost(CHANNEL.CONTROL, {
          type: MSG.BALANCE,
          currency: 'CNY',
          totalBalance: 42.5,
          rechargeBalance: 30,
          bonusBalance: 12.5,
          todayUsed: 1.23,
        })
        break
      case MSG.VOICE_END:
        this.#sendToHost(CHANNEL.CONTROL, {
          type: MSG.VOICE_RESULT,
          text: '帮我把 README 的错别字改一下',
          audioSeconds: 2.4,
        })
        break
      default:
        break
    }
    void channel
    void msgId
  }

  /** 模拟设备主动上行（定时器驱动，面板能看到主动推送）。 */
  emitFromDevice(message, channel = CHANNEL.CONTROL) {
    this.#sendToHost(channel, typeof message === 'object' ? message : { type: message })
  }

  #sendToHost(channel, payload) {
    if (this.state !== LINK_STATE.CONNECTED) return
    if (Math.random() < (this.faults.dropRate ?? 0)) return
    const chunks = encodeChunks({
      msgId: this.deviceMsgId,
      channel,
      payload: new TextEncoder().encode(JSON.stringify(payload)),
      maxChunkPayload: this.mtuPayload,
    })
    this.deviceMsgId = (this.deviceMsgId + 1) & 0xfff
    for (const chunk of chunks) {
      const deliver = () => {
        if (this.state !== LINK_STATE.CONNECTED) return
        const frameChannel = chunk[1] === CHANNEL.VOICE ? 'voice' : 'control'
        this.emitData(frameChannel, chunk)
      }
      if (this.faults.latencyMs > 0) this.#later(deliver, this.faults.latencyMs)
      else deliver()
    }
  }

  /** 模拟设备掉线，用于验证上层的重连与 UI 降级路径。 */
  simulateDrop(reason = 'simulated-drop') {
    this.emitUnexpectedDisconnect(reason)
  }

  /** 模拟设备上报电量变化。 */
  simulateBattery(percent) {
    this.emitFromDevice({ type: 'battery', percent })
  }

  #later(fn, delay) {
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer)
      try {
        fn()
      } catch (error) {
        this.emit('error', error)
      }
    }, delay)
    timer.unref?.()
    this.pendingTimers.add(timer)
  }
}
