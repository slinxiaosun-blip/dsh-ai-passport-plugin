/**
 * BLE 传输抽象层。
 *
 * 这一层存在的唯一理由：把"蓝牙怎么连"与"连上之后干什么"彻底分开。
 *
 * 背景（这是本方案最大的技术风险）：主机侧（macOS / Windows）要做 BLE Central，
 * Node 生态里只有
 * noble 系列可选，而它是**原生模块**，需要与 DSH 内置的 Node 24 ABI 匹配。
 * 一旦 ABI 不匹配、或 Electron 的 fuses 阻止加载外部原生模块，noble 就用不了。
 *
 * 因此我们提供三种可互换的实现，通过配置选择，任何一种可用都能交付：
 *   1. `noble`  —— 进程内直连，体验最好（默认）
 *   2. `bridge` —— 连一个外部 BLE 桥进程的本地 WebSocket（把原生依赖挪出 DSH 进程）
 *   3. `mock`   —— 纯内存实现，无硬件与依赖即可联调全部上层逻辑
 *
 * 无论哪种实现，都必须是 EventEmitter，并发出下面这些事件：
 *   'scan-start' | 'scan-stop' | 'device' (DeviceInfo)
 *   'connect' (DeviceInfo) | 'disconnect' ({reason}) | 'error' (TransportError)
 *   'data' ({ channel: 'control'|'voice', bytes: Uint8Array })
 */

import { EventEmitter } from 'node:events'

/** 链路状态。上层面板与设备屏幕都直接映射这组值。 */
export const LINK_STATE = Object.freeze({
  IDLE: 'idle',
  SCANNING: 'scanning',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed',
})

/** 错误类别。面板据此给出可操作的指引，而不是甩一个原始堆栈。 */
export const TRANSPORT_ERROR = Object.freeze({
  NOT_AVAILABLE: 'not-available', // 驱动本身不可用（未安装 / ABI 不匹配）
  PERMISSION_DENIED: 'permission-denied', // 系统蓝牙权限被拒（macOS 隐私设置 / Windows 蓝牙设置）
  ADAPTER_OFF: 'adapter-off', // 蓝牙未开启
  DEVICE_NOT_FOUND: 'device-not-found',
  CONNECT_FAILED: 'connect-failed',
  DISCONNECTED: 'disconnected',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown',
})

export class TransportError extends Error {
  /**
   * @param {string} code TRANSPORT_ERROR 之一
   * @param {string} message 面向用户的中文说明
   * @param {object} [options]
   * @param {unknown} [options.cause]
   * @param {string} [options.hint] 下一步该做什么
   */
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = 'TransportError'
    this.code = code
    this.hint = options.hint
  }
}

/** 把底层异常翻译成带类别与处置建议的 TransportError，避免把原始错误直接抛给用户。 */
export function classifyError(error) {
  if (error instanceof TransportError) return error
  const raw = error instanceof Error ? error : new Error(String(error))
  const text = `${raw.message}`.toLowerCase()

  if (text.includes('permission') || text.includes('not permitted') || text.includes('eperm')) {
    return new TransportError(
      TRANSPORT_ERROR.PERMISSION_DENIED,
      '蓝牙权限被拒绝',
      {
        cause: raw,
        hint: 'macOS：系统设置 → 隐私与安全性 → 蓝牙，勾选 DeepSeek Harness；Windows：设置 → 蓝牙和其他设备，确认应用有蓝牙权限。改动后需要重启应用。',
      },
    )
  }
  if (text.includes('poweredoff') || text.includes('powered off') || text.includes('adapter')) {
    return new TransportError(TRANSPORT_ERROR.ADAPTER_OFF, '系统蓝牙未开启', {
      cause: raw,
      hint: '在控制中心或系统设置里打开蓝牙后重试。',
    })
  }
  if (text.includes('cannot find module') || text.includes('was compiled against a different node.js version')
    || text.includes('err_dlopen_failed') || text.includes('invalid elf header')) {
    return new TransportError(TRANSPORT_ERROR.NOT_AVAILABLE, 'BLE 驱动不可用', {
      cause: raw,
      hint: '把 transport 切换为 bridge 或 mock，或在面板里查看诊断信息。',
    })
  }
  return new TransportError(TRANSPORT_ERROR.UNKNOWN, raw.message, { cause: raw })
}

/**
 * 传输基类。子类只需实现 `doStartScan` / `doStopScan` / `doConnect` / `doDisconnect` / `doSend`，
 * 通用逻辑（状态机、错误分类、监听器清理）都在这里，避免三种实现各写一套。
 */
export class Transport extends EventEmitter {
  constructor(options = {}) {
    super()
    /** @type {string} 实现标识，用于面板显示与日志。 */
    this.kind = options.kind ?? 'abstract'
    /** @type {string} 链路状态，见 LINK_STATE。 */
    this.state = LINK_STATE.IDLE
    /** @type {import('./types.js').DeviceInfo | null} */
    this.device = null
    /** 协商到的 ATT 载荷上限，用于分片大小。 */
    this.mtuPayload = options.mtuPayload ?? 244
    this.disposed = false

    // Node 的 EventEmitter 约定：没有监听者的 'error' 事件会被当成未捕获异常抛出，
    // 直接把宿主进程带崩。传输层是长跑的基础设施，"暂时没人监听"是完全正常的状态
    // （比如面板还没打开），因此这里装一个兜底监听者：错误照常广播给真正的监听者，
    // 但只要没人接就安静地记下来，绝不抛。
    this.lastUnobservedError = null
    this.on('error', (error) => {
      if (this.listenerCount('error') > 1) return
      this.lastUnobservedError = error
    })
  }

  /** 该实现当前是否可用；不可用时返回原因，供面板提示。 */
  async probe() {
    return { available: true }
  }

  /** 开始扫描。 */
  async startScan() {
    if (this.disposed) throw new TransportError(TRANSPORT_ERROR.NOT_AVAILABLE, '传输已关闭')
    this.#setState(LINK_STATE.SCANNING)
    try {
      await this.doStartScan()
      this.emit('scan-start')
    } catch (error) {
      const classified = classifyError(error)
      this.#setState(LINK_STATE.FAILED)
      this.emit('error', classified)
      throw classified
    }
  }

  /** 停止扫描。重复调用是安全的。 */
  async stopScan() {
    try {
      await this.doStopScan()
    } catch (error) {
      this.emit('error', classifyError(error))
    } finally {
      if (this.state === LINK_STATE.SCANNING) this.#setState(LINK_STATE.IDLE)
      this.emit('scan-stop')
    }
  }

  /**
   * 连接设备。
   *
   * @param {string} [deviceId] 省略时使用最近一次扫描到的目标设备。
   */
  async connect(deviceId) {
    if (this.disposed) throw new TransportError(TRANSPORT_ERROR.NOT_AVAILABLE, '传输已关闭')
    this.#setState(LINK_STATE.CONNECTING)
    try {
      const info = await this.doConnect(deviceId ?? this.device?.id)
      this.device = info
      this.#setState(LINK_STATE.CONNECTED)
      this.emit('connect', info)
      return info
    } catch (error) {
      const classified = classifyError(error)
      this.#setState(LINK_STATE.FAILED)
      this.emit('error', classified)
      throw classified
    }
  }

  /** 主动断开。 */
  async disconnect(reason = 'user') {
    try {
      await this.doDisconnect()
    } catch (error) {
      this.emit('error', classifyError(error))
    } finally {
      if (this.state !== LINK_STATE.FAILED) this.#setState(LINK_STATE.IDLE)
      const previous = this.device
      this.device = null
      this.emit('disconnect', { reason, device: previous })
    }
  }

  /**
   * 发送一个已编码的分片。
   *
   * @param {'control'|'voice'} channel
   * @param {Uint8Array} chunk
   */
  async send(channel, chunk) {
    if (this.state !== LINK_STATE.CONNECTED) {
      throw new TransportError(TRANSPORT_ERROR.DISCONNECTED, '链路未连接，无法发送')
    }
    try {
      await this.doSend(channel, chunk)
    } catch (error) {
      throw classifyError(error)
    }
  }

  /** 释放资源。子类覆盖 `doDispose` 时不要忘记调 super。 */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    try {
      await this.doDispose()
    } catch {
      // 关闭路径上的异常不再上抛：调用方此时已在收尾，抛出去只会掩盖真正的原因。
    }
    this.removeAllListeners()
    this.#setState(LINK_STATE.IDLE)
  }

  /** 子类在收到底层数据时调用，统一走这里再向上冒泡。 */
  emitData(channel, bytes) {
    this.emit('data', { channel, bytes })
  }

  /** 子类在探测到非主动断开时调用。 */
  emitUnexpectedDisconnect(reason, error) {
    const previous = this.device
    this.device = null
    this.#setState(LINK_STATE.FAILED)
    this.emit('disconnect', { reason, device: previous, unexpected: true })
    if (error) this.emit('error', classifyError(error))
  }

  #setState(next) {
    if (this.state === next) return
    const previous = this.state
    this.state = next
    this.emit('state', { previous, state: next })
  }

  // —— 子类实现点 ——
  // 注意：这里刻意用「下划线约定」而不是 JS 私有方法（#xxx）。
  // 私有方法是词法作用域绑定的，子类定义同名 #方法**不会**覆盖基类的，
  // 基类内部调用仍命中自己的实现（已实测确认），子类的钩子会静默失效。
  /** @protected 开始扫描。 */
  async doStartScan() { throw new Error('未实现 doStartScan') }

  /** @protected 停止扫描。 */
  async doStopScan() {}

  /** @protected 建立连接，返回 DeviceInfo。 */
  async doConnect() { throw new Error('未实现 doConnect') }

  /** @protected 断开连接。 */
  async doDisconnect() {}

  /**
   * @protected 发送一个分片。
   * @param {'control'|'voice'} _channel
   * @param {Uint8Array} _chunk
   */
  async doSend(_channel, _chunk) { throw new Error('未实现 doSend') }

  /** @protected 释放底层资源。 */
  async doDispose() {}
}
