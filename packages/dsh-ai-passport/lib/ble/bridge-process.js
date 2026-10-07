/**
 * 基于外部桥进程的 BLE 传输。
 *
 * 这是**默认推荐**的实现，原因见 bridge-worker.js 顶部注释：
 * 把原生模块（noble）关进子进程，ABI 不匹配时最多让这一个进程退出，
 * 不会把 DSH 主进程或渲染进程一起带走。
 *
 * 另外两个好处：
 *   - 子进程崩溃会自动重启并按退避重连，用户看到的是"闪一下又连上了"；
 *   - 可以用系统 Node（预编译 noble 直接可用），不必为 Electron 做 electron-rebuild。
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Transport, TransportError, TRANSPORT_ERROR } from './transport.js'
import { DEVICE_NAME } from '../protocol/constants.js'

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge-worker.js')

/** 子进程重启退避（毫秒）。 */
const RESTART_BACKOFF_MS = [500, 1000, 2000, 5000, 10000]

// 整个 connect 命令（worker 侧扫描 30s + 连接 30s + 服务发现）的总超时。
// 必须 ≥ worker 内部各阶段之和，否则外层先超时、内层还在等（用户反馈"连接超时太短"）。
const CONNECT_CMD_MS = 70000

export class BridgeProcessTransport extends Transport {
  /**
   * @param {object} [options]
   * @param {string} [options.nodePath] 用哪个 Node 跑桥进程；默认取当前 process.execPath，
   *   若它看起来是 Electron 则回退到系统 node（Electron 二进制不能直接当 Node 用）。
   * @param {string} [options.workerPath] 覆盖工作进程路径（测试用）
   * @param {boolean} [options.mock] 让桥进程走 --mock（不碰硬件，CI 与演示用）
   * @param {number} [options.mtuPayload]
   * @param {(level:string,message:string)=>void} [options.logger]
   */
  constructor(options = {}) {
    super({ kind: options.mock ? 'bridge-mock' : 'bridge', mtuPayload: options.mtuPayload ?? 244 })
    this.nodePath = options.nodePath ?? pickNodeBinary()
    this.workerPath = options.workerPath ?? WORKER_PATH
    this.mock = options.mock ?? false
    this.logger = options.logger ?? (() => {})

    this.child = null
    /** 桥进程是否已经报过 ready（它的 stdout 已接线、可以接命令）。 */
    this.childReady = false
    /** @type {Array<() => void>} */
    this.readyWaiters = []
    this.pending = new Map()
    this.nextRequestId = 1
    this.readLine = null
    this.restartAttempt = 0
    this.disposed = false
    this.intentionalStop = false
    /** 桥进程上报的 noble 实现名，用于诊断显示。 */
    this.nobleImplementation = null
    /** 诊断：桥进程报告的适配器状态（poweredOn / poweredOff / unauthorized / unknown…）。 */
    this.adapterState = null
    /** 诊断：最近一次失败的原因（探测/启动/命令），面板与 curl 都读它。 */
    this.lastBridgeError = null
    /**
     * 扫描时各设备的 RSSI（id → dBm）。
     * noble 只在扫描发现时给 rssi，连接回包里没有 —— 不在这里记下来，
     * 面板的"信号"一栏就永远是"—"（真实反馈过的缺陷）。
     */
    this.rssiById = new Map()
  }

  /** 诊断快照：面板与 curl 都读它，用于判断蓝牙卡在哪一步。 */
  diagnose() {
    return {
      kind: this.kind,
      state: this.state,
      nodePath: this.nodePath,
      workerPath: this.workerPath,
      childRunning: Boolean(this.child && this.child.exitCode === null),
      noble: this.nobleImplementation,
      adapterState: this.adapterState,
      lastError: this.lastBridgeError,
    }
  }

  /** 探测 Node 与工作进程是否可用（不启动子进程，避免无谓开销）。 */
  async probe() {
    if (!(await fileExists(this.workerPath))) {
      return {
        available: false,
        reason: '找不到 BLE 桥工作进程文件',
        hint: `期望路径：${this.workerPath}`,
      }
    }
    // 逐个探测，选出第一个真实存在的解释器。必须在 spawn 之前做完 ——
    // "解释器不存在"应该在这里变成一条可读错误，而不是让宿主在启动期崩掉。
    const candidates = nodeBinaryCandidates()
    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        this.nodePath = candidate
        return { available: true, detail: `桥进程：${candidate}` }
      }
    }
    return {
      available: false,
      reason: `找不到任何可用的 Node 解释器（已尝试 ${candidates.length} 个路径）`,
      hint: `试过：${candidates.join('、')}。设环境变量 DSH_PASSPORT_NODE 指向真实的 node 可执行文件。`,
    }
  }

  // —— 子进程生命周期 ——

  async #ensureChild() {
    if (this.child && !this.child.killed && this.child.exitCode === null) return

    const args = [this.workerPath]
    if (this.mock) args.push('--mock')

    this.childReady = false
    this.logger('info', `[bridge] 启动 ${this.nodePath} ${args.join(' ')}`)
    const child = spawn(this.nodePath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // 关掉 Electron 的相关变量，避免子进程里误判运行环境
        ELECTRON_RUN_AS_NODE: '1',
      },
    })
    this.child = child

    this.readLine = createInterface({ input: child.stdout, terminal: false })
    this.readLine.on('line', (line) => this.#onLine(line))

    // 桥进程的 stderr 是它的日志，转发到插件日志便于排查，不参与协议。
    const errLines = createInterface({ input: child.stderr, terminal: false })
    errLines.on('line', (line) => this.logger('debug', `[bridge] ${line}`))

    child.on('error', (error) => {
      // spawn 失败（解释器不存在、无执行权限等）：转成可读错误并留给诊断字段，
      // 绝不让它冒泡成未捕获异常。
      const wrapped = new TransportError(
        TRANSPORT_ERROR.NOT_AVAILABLE,
        `桥进程启动失败：${error.message}`,
        { cause: error, hint: `解释器：${this.nodePath}。设 DSH_PASSPORT_NODE 可覆盖。` },
      )
      this.lastBridgeError = { cmd: 'spawn', code: wrapped.code, message: wrapped.message }
      this.#failAllPending(wrapped)
      this.emit('error', wrapped)
    })

    child.on('exit', (code, signal) => {
      this.child = null
      this.childReady = false
      // 等待 ready 的调用方必须被唤醒并失败，否则它们的 await 永远不会返回。
      this.#flushReadyWaiters(new Error(`桥进程退出（code=${code} signal=${signal}）`))
      this.readLine?.close()
      const detail = `桥进程退出（code=${code} signal=${signal}）`
      this.logger('warn', `[bridge] ${detail}`)
      const error = new TransportError(TRANSPORT_ERROR.DISCONNECTED, detail)
      this.#failAllPending(error)
      // 正在收尾时子进程退出是预期行为，不是掉线：此时既不该改写链路状态，
      // 也不该触发重连，否则 dispose() 之后还会凭空冒出一个新子进程。
      if (this.disposed || this.intentionalStop) return
      if (this.state === 'connected') {
        this.emitUnexpectedDisconnect('bridge-exited', error)
      }
      this.#scheduleRestart()
    })

    await this.#request('init')
  }

  #scheduleRestart() {
    const delay = RESTART_BACKOFF_MS[Math.min(this.restartAttempt, RESTART_BACKOFF_MS.length - 1)]
    this.restartAttempt += 1
    this.logger('info', `[bridge] ${delay}ms 后重启桥进程（第 ${this.restartAttempt} 次）`)
    const timer = setTimeout(() => {
      timer.unref?.()
      void this.#ensureChild().catch((error) => {
        this.logger('error', `[bridge] 重启失败：${error.message}`)
        this.#scheduleRestart()
      })
    }, delay)
    timer.unref?.()
  }

  #failAllPending(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  // —— 协议解析 ——

  #onLine(line) {
    const text = line.trim()
    if (!text) return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      this.logger('warn', `[bridge] 无法解析的响应：${text.slice(0, 160)}`)
      return
    }

    if (message.event) {
      this.#onEvent(message)
      return
    }

    const entry = this.pending.get(message.id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(message.id)

    if (message.ok) {
      entry.resolve(message.value)
      return
    }
    const code = message.error?.code ?? 'unknown'
    const err = new TransportError(mapWorkerErrorCode(code), message.error?.message ?? '桥进程报错')
    // 记下"哪个命令、为什么失败"：这是排查"点了连接没反应"最直接的一条线索。
    this.lastBridgeError = { cmd: entry.cmd ?? '?', workerCode: code, code: err.code, message: err.message }
    entry.reject(err)
  }

  #onEvent(message) {
    switch (message.event) {
      case 'ready':
        this.childReady = true
        this.logger('debug', `[bridge] ready pid=${message.pid} mock=${message.mock}`)
        this.#flushReadyWaiters(null)
        break
      case 'state':
        this.adapterState = message.state
        if (message.ready) this.lastBridgeError = null
        this.emit('adapter-state', { state: message.state, ready: message.ready })
        break
      case 'device':
        if (message.rssi != null) this.rssiById.set(message.id, message.rssi)
        this.emit('device', {
          id: message.id,
          name: message.name ?? DEVICE_NAME,
          rssi: message.rssi,
          address: message.address,
          connectable: message.connectable !== false,
          hasService: Boolean(message.hasService),
        })
        break
      case 'connected':
        this.mtuPayload = message.mtuPayload ?? this.mtuPayload
        break
      case 'disconnected':
        // 只有"非主动断开"才算意外。主动 disconnect() 时桥进程同样会发这个事件，
        // 若不加区分就会把状态从 idle 拉成 failed（这是修复前的真实缺陷：
        // 主动断开后 LINK_STATE 是 failed，面板会显示成"链路故障"）。
        if (this.state === 'connected' && !this.intentionalStop) {
          this.emitUnexpectedDisconnect(message.reason ?? 'bridge-disconnected')
        }
        break
      case 'data':
        this.emitData(message.channel === 'voice' ? 'voice' : 'control', Buffer.from(message.bytes, 'base64'))
        break
      case 'fatal':
        this.logger('error', `[bridge] 致命错误：${message.message}`)
        break
      default:
        this.logger('debug', `[bridge] 未知事件：${message.event}`)
    }
  }

  /**
   * 等桥进程就绪。
   *
   * 为什么必须有这一步：子进程 spawn 之后 stdout 的接线与解释器启动都需要时间，
   * 抢先写命令会石沉大海（表现为命令超时或"桥进程退出"）。就绪信号是桥进程
   * 主动发的第一条消息，用它作为唯一的同步点最可靠。
   */
  #waitForReady(timeoutMs = 15000) {
    if (this.childReady) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.readyWaiters.indexOf(waiter)
        if (index >= 0) this.readyWaiters.splice(index, 1)
        reject(new TransportError(TRANSPORT_ERROR.TIMEOUT, `桥进程未在 ${timeoutMs}ms 内就绪`))
      }, timeoutMs)
      timer.unref?.()
      const waiter = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      this.readyWaiters.push(waiter)
    })
  }

  #flushReadyWaiters(error) {
    const waiters = this.readyWaiters
    this.readyWaiters = []
    for (const waiter of waiters) {
      if (error) waiter.reject(error)
      else waiter.resolve()
    }
  }

  /** 发一条命令给桥进程并等结果。 */
  async #request(cmd, payload = {}, timeoutMs = 20000) {
    if (!this.child) {
      const err = new TransportError(TRANSPORT_ERROR.NOT_AVAILABLE, '桥进程未运行')
      this.lastBridgeError = { cmd, code: err.code, message: err.message }
      throw err
    }
    await this.#waitForReady()
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new TransportError(TRANSPORT_ERROR.NOT_AVAILABLE, '桥进程未运行'))
        return
      }
      const id = this.nextRequestId
      this.nextRequestId += 1
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const err = new TransportError(TRANSPORT_ERROR.TIMEOUT, `桥进程命令 ${cmd} 超时（${timeoutMs}ms）`)
        this.lastBridgeError = { cmd, code: err.code, message: err.message }
        reject(err)
      }, timeoutMs)
      // unref 很关键：否则一个未完成的请求会让进程（以及 node --test）迟迟不退出。
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer, cmd })
      try {
        this.child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new TransportError(TRANSPORT_ERROR.DISCONNECTED, `写入桥进程失败：${error.message}`, { cause: error }))
      }
    })
  }

  // —— Transport 钩子 ——

  /** @protected */
  async doStartScan() {
    await this.#ensureChild()
    const value = await this.#request('scan', { filter: this.filterDeviceId ?? null })
    this.nobleImplementation = value?.noble ?? this.nobleImplementation
  }

  /** @protected */
  async doStopScan() {
    if (!this.child) return
    await this.#request('stopScan').catch(() => {})
  }

  /** @protected */
  async doConnect(deviceId) {
    await this.#ensureChild()
    if (!deviceId) throw new TransportError(TRANSPORT_ERROR.DEVICE_NOT_FOUND, '没有指定要连接的设备')
    const info = await this.#request('connect', { deviceId }, CONNECT_CMD_MS)
    // 连接回包不含 rssi（noble 只在扫描发现时给），从扫描记录里补上。
    // 自动重连时没有新扫描也不要紧：rssiById 按进程生命周期保留。
    const rssi = this.rssiById.get(deviceId)
    return { ...info, name: info.name ?? DEVICE_NAME, rssi: rssi ?? null }
  }

  /** @protected */
  async doDisconnect() {
    if (!this.child) return
    // 置位期间桥进程回的 disconnected 事件属于"自己要求的断开"，不能当成掉线。
    this.intentionalStop = true
    try {
      await this.#request('disconnect', {}, 8000).catch(() => {})
    } finally {
      // 给桥进程的那条 disconnected 事件一点时间先到达，再复位，
      // 否则事件晚到仍会被当成意外掉线，触发无意义的重连。
      await sleep(50)
      this.intentionalStop = false
    }
  }

  /** @protected */
  async doSend(channel, chunk) {
    if (!this.child) throw new TransportError(TRANSPORT_ERROR.DISCONNECTED, '桥进程未运行')
    await this.#request('write', { channel, bytes: Buffer.from(chunk).toString('base64') }, 10000)
  }

  /** @protected */
  async doDispose() {
    this.disposed = true
    this.intentionalStop = true
    if (this.child) {
      await this.#request('dispose', {}, 3000).catch(() => {})
      // 给它一点时间自己退出；不退就杀掉，不留孤儿进程。
      await sleep(60)
      if (this.child && this.child.exitCode === null) {
        try {
          this.child.kill('SIGTERM')
        } catch {
          // 已经退出了
        }
      }
    }
    this.#failAllPending(new TransportError(TRANSPORT_ERROR.NOT_AVAILABLE, '传输已关闭'))
  }
}

/** 带 unref 的等待：不阻止进程退出（测试运行器尤其在意这一点）。 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function mapWorkerErrorCode(code) {
  switch (code) {
    case 'adapter-off':
      return TRANSPORT_ERROR.ADAPTER_OFF
    case 'permission-denied':
      return TRANSPORT_ERROR.PERMISSION_DENIED
    case 'not-available':
      return TRANSPORT_ERROR.NOT_AVAILABLE
    case 'device-not-found':
      return TRANSPORT_ERROR.DEVICE_NOT_FOUND
    case 'connect-failed':
      return TRANSPORT_ERROR.CONNECT_FAILED
    case 'disconnected':
      return TRANSPORT_ERROR.DISCONNECTED
    case 'timeout':
      return TRANSPORT_ERROR.TIMEOUT
    default:
      return TRANSPORT_ERROR.UNKNOWN
  }
}

/**
 * 挑一个能用的 Node 解释器。
 *
 * Electron 的可执行文件带 ELECTRON_RUN_AS_NODE 时能当 Node 用，但它跑原生模块的 ABI
 * 仍是 Electron 的。为了确保预编译的 noble 能加载，优先选择真正的系统 node。
 */
/**
 * 挑选一个可用的 Node 解释器来跑桥进程。
 *
 * ★ 踩过的坑：之前写成 `if (在 Electron 里) return '/usr/local/bin/node'`，
 *   那是硬编码路径 —— Apple Silicon 上 Homebrew 装在 /opt/homebrew，
 *   /usr/local/bin/node **根本不存在**，于是 spawn 必然失败。
 *   而这个失败发生在宿主启动路径上，后果是 "desktop welcome: Web RPC failed"，
 *   也就是**整个应用打不开**。一个纯粹的路径假设换来了应用级故障。
 *
 * 正确做法：**按序探测，用第一个真实存在的**；探测在 spawn 之前完成，
 * 这样"解释器不存在"能变成一条可读错误，而不是一次神秘崩溃。
 */
export function nodeBinaryCandidates() {
  const list = []
  const push = (p) => { if (p && !list.includes(p)) list.push(p) }

  // ① 显式配置优先
  push(process.env.DSH_PASSPORT_NODE)
  // ② 若我们本身就跑在普通 Node 上，直接用自己（最简单也最可靠）
  if (!process.versions?.electron) push(process.execPath)
  // ③ 系统 node（PATH 里的那个）
  push('/opt/homebrew/bin/node')   // Apple Silicon Homebrew
  push('/usr/local/bin/node')      // Intel Homebrew / 官方安装包
  push('/usr/bin/node')
  // ④ 兜底：Electron 自带的 Node。配合 ELECTRON_RUN_AS_NODE=1 就能当 Node 用；
  //    桥进程不依赖任何 Electron API，原生模块是 N-API 的，跨运行时可用。
  push(process.execPath)
  return list
}

function pickNodeBinary() {
  return nodeBinaryCandidates()[0]
}

async function fileExists(target) {
  try {
    const fs = await import('node:fs/promises')
    await fs.access(target)
    return true
  } catch {
    return false
  }
}
