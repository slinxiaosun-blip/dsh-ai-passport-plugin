/**
 * BLE 桥工作进程（独立 Node 进程，不在 DSH/Electron 里跑）。
 *
 * 为什么单独起进程，而不是在插件里直接 require('noble')：
 *
 *   1. **原生模块 ABI 风险隔离**。noble 是原生扩展，需要与宿主 Node 的 ABI 匹配。
 *      DSH 内置的是 Electron 的 Node，加载失败轻则 require 抛错，重则整个渲染/主进程崩掉。
 *      放进子进程后，最坏结果只是这个进程退出，插件降级为"BLE 不可用"，DSH 毫发无伤。
 *   2. **可以用系统 Node 的预编译产物**，不必为 Electron 做 electron-rebuild。
 *   3. 崩溃可自愈：父进程看到退出就重启并重连，用户无感。
 *
 * 通信协议：stdin/stdout 上的 JSON Lines。
 *   父 → 子：{ id, cmd, ...args }
 *   子 → 父：{ id, ok, value } | { id, ok:false, error:{code,message} } | { event, ...payload }
 * 二进制用 base64 传输（BLE 单包几百字节，开销可接受，换来协议极简）。
 *
 * 单独调试：node lib/ble/bridge-worker.js --mock
 */

import { createInterface } from 'node:readline'

import { ADV, DEVICE_NAME, SHORT_DEVICE_NAME, PROTOCOL_VERSION, UUID } from '../protocol/constants.js'

const MOCK = process.argv.includes('--mock')

// ── 连接各阶段的超时（用户反馈"连接超时太短"，统一放宽）──────────────────
// 设备广播、配对、服务发现都可能受环境影响而变慢，超时给足余量：
//   SCAN  等设备出现在扫描结果里（设备可能几分钟才广播一次）
//   CONNECT  找到后建立 BLE 连接（macOS 上首次配对尤其慢）
//   命令总超时（含这两段+服务发现）在 bridge-process.js 的 CONNECT_CMD_MS。
const SCAN_WAIT_MS = 30000        // 等设备在扫描中出现（原 10000，太短）
const CONNECT_TIMEOUT_MS = 30000  // 建立 BLE 连接（原 15000）

/** stdout 只用于协议输出，任何日志都必须走 stderr，否则会污染 JSON Lines 流。 */
function log(level, message) {
  process.stderr.write(`[ble-bridge] ${level} ${message}\n`)
}

let stdoutBlocked = false
function send(payload) {
  const line = `${JSON.stringify(payload)}\n`
  // ★ 必须检查 write() 的返回值：语音上行期间每 20ms 就有一批音频数据，
  //   stdout 管道背压时 write() 返回 false —— 忽略它会无限堆积内存，
  //   最终桥进程 OOM 被杀（表现为"插件断开/桥进程退出"）。
  //   返回 false 时暂停发送，等 drain 事件再继续；数据本身不丢
  //   （Noble 的 data 事件是推模式，我们只能靠 stdout 缓冲扛住突发）。
  const ok = process.stdout.write(line)
  if (!ok) {
    if (!stdoutBlocked) {
      stdoutBlocked = true
      process.stderr.write('[bridge] stdout 背压，暂停发送等待 drain\n')
    }
  } else if (stdoutBlocked) {
    stdoutBlocked = false
    process.stderr.write('[bridge] stdout 已恢复\n')
  }
}

function reply(id, value) {
  send({ id, ok: true, value })
}

function replyError(id, code, message) {
  send({ id, ok: false, error: { code, message } })
}

function emit(event, payload = {}) {
  send({ event, ...payload })
}

/**
 * 统一 noble 的两种形态：
 *   - @stoprocent/noble  —— 维护中，有 Promise 方法（waitForPoweredOnAsync 等）
 *   - @abandonware/noble —— 老实现，用 'stateChange' 事件
 * 这里只依赖两边都有的最小交集，避免被某一个实现的 API 漂移绑死。
 */
async function loadNoble() {
  const candidates = ['@stoprocent/noble', '@abandonware/noble', 'noble']
  const failures = []
  for (const name of candidates) {
    try {
      const module = await import(name)
      const noble = module.default ?? module
      if (noble && typeof noble.startScanning === 'function') {
        log('info', `noble 实现：${name}`)
        return { noble, name }
      }
      failures.push(`${name}: 导出里没有 startScanning`)
    } catch (error) {
      failures.push(`${name}: ${error.message}`)
    }
  }
  const error = new Error(`没有可用的 noble 实现。尝试过：\n  ${failures.join('\n  ')}`)
  error.code = 'not-available'
  throw error
}

/** 把 noble 的 state 字符串翻译成我们自己的可用性判断。 */
function stateIsReady(state) {
  return state === 'poweredOn'
}

function stateError(state) {
  switch (state) {
    case 'poweredOff':
      return ['adapter-off', '系统蓝牙未开启']
    case 'unauthorized':
      return ['permission-denied', '应用没有蓝牙权限（macOS：隐私与安全性→蓝牙；Windows：设置→蓝牙和其他设备）']
    case 'unsupported':
      return ['not-available', '这台机器不支持 BLE']
    case 'resetting':
      return ['unknown', '蓝牙正在重置，请稍后重试']
    default:
      return ['unknown', `蓝牙状态异常：${state}`]
  }
}

/** 等待适配器进入 poweredOn；超时明确报错而不是永远挂着。 */
function waitForPoweredOn(noble, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (stateIsReady(noble.state)) {
      resolve()
      return
    }
    // 优先用新实现提供的 Promise 方法
    if (typeof noble.waitForPoweredOnAsync === 'function') {
      noble.waitForPoweredOnAsync(timeoutMs).then(resolve, (error) => {
        const [code, message] = stateError(noble.state)
        reject(Object.assign(new Error(message), { code, cause: error }))
      })
      return
    }

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      noble.off?.('stateChange', onStateChange)
      const [code, message] = stateError(noble.state)
      reject(Object.assign(new Error(`${message}（等待 ${timeoutMs}ms 超时）`), { code }))
    }, timeoutMs)

    function onStateChange(state) {
      if (settled) return
      if (stateIsReady(state)) {
        settled = true
        clearTimeout(timer)
        noble.off?.('stateChange', onStateChange)
        resolve()
      }
    }
    noble.on('stateChange', onStateChange)
  })
}

class Bridge {
  constructor() {
    this.noble = null
    this.nobleName = null
    this.peripheral = null
    this.characteristics = { rx: null, tx: null, voice: null, ctrl: null }
    this.scanning = false
    this.disposed = false
    this.deviceFilter = null
    this.seenInScan = new Set()
    // GATT 表对不上的冒牌设备拉黑（本会话内不再上报/连接），
    // 防止它把重连循环垄断到底（真机返工记录）。
    this.blockedIds = new Set()
    /**
     * 自己维护"发现过的 peripheral"。
     *
     * ★ 为什么不能用 noble._peripherals：实测在 @stoprocent/noble（macOS/CoreBluetooth）
     *   下它**始终是空对象**（键数 0），设备根本不会进那个缓存。
     *   而 #findPeripheral 原本靠它查设备，于是**任何连接都必然报"找不到设备"**
     *   —— 现象是"扫描能看到设备、一点连接就说找不到"，看起来像固件不广播，
     *   实际是主机侧查了个永远为空的表。
     *   教训：不要依赖第三方库的内部字段（它连下划线都标了是私有）。
     */
    this.peripherals = new Map()
    /** 本次连接是否已对外宣告 connected；之前到达的上行数据先缓存。 */
    this.linkReady = false
    this.pendingData = []
  }

  async init() {
    if (MOCK) {
      this.nobleName = 'mock'
      log('info', '以 --mock 模式启动：不加载 noble，不访问硬件')
      return
    }
    const { noble, name } = await loadNoble()
    this.noble = noble
    this.nobleName = name
    await waitForPoweredOn(noble)
    this.#wireNobleEvents()
  }

  #wireNobleEvents() {
    this.noble.on('warning', (message) => log('warn', String(message)))

    this.noble.on('stateChange', (state) => {
      emit('state', { state, ready: stateIsReady(state) })
      if (!stateIsReady(state) && this.peripheral) {
        emit('disconnected', { reason: `adapter-${state}` })
        this.peripheral = null
        this.characteristics = { rx: null, tx: null, voice: null, ctrl: null }
      }
    })

    this.noble.on('discover', (peripheral) => {
      const advertisement = peripheral.advertisement ?? {}
      const name = advertisement.localName ?? peripheral.name ?? ''

      // 三重识别，任一命中即可：
      //   ① 广播包里带我们的 128 位服务 UUID —— **最可靠**，与名字无关
      //   ② 名字命中已知的几个（广播短名 / GAP 全名 / 旧固件的裸名）
      //   ③ 带 Manufacturer Data（留给以后加厂商标识的固件）
      //
      // 为什么不能只按名字：实测设备名放在 scan response 里时，macOS 不保证把它
      // 合并进 advertisementData，于是 localName 为空 —— 按名字过滤的客户端就
      // "扫不到设备"。UUID 在广播包里，一定看得到。
      //
      // 为什么也不能只按 UUID：刚刷机、UUID 还没生效的设备会被漏掉；
      // Manufacturer Data 同理是给未来留的后路。
      const serviceUuids = Array.isArray(advertisement.serviceUuids) ? advertisement.serviceUuids : []
      const overflowUuids = Array.isArray(advertisement.overflowServiceUuids)
        ? advertisement.overflowServiceUuids
        : []
      const hasService = [...serviceUuids, ...overflowUuids]
        .some((uuid) => normalizeUuid(uuid) === UUID.SERVICE)

      const KNOWN_NAMES = [DEVICE_NAME, SHORT_DEVICE_NAME, 'FoloPassport', 'Folo-PSP']
      const nameMatches = KNOWN_NAMES.includes(name)

      //   ③ 厂商数据**内容**命中我们的标签（FAP1，与固件 AP_ADV_MFG_TAG 一致）。
      //
      // ★ 这里曾是「有厂商数据就算」——一个灾难性兜底：耳机/手表/邻居的任何
      //   蓝牙设备都带厂商数据。断链重连时主机抓到谁就连谁，连上后 GATT 表
      //   对不上（设备上没有找到 AI Passport 的控制特征），失败重试又抢到
      //   同一台，无限循环 —— 现象就是「间歇性断连 + 一直连不上、重启设备才好」
      //   （重启后我们的设备广播最猛，抢赢一次）。
      const mfg = advertisement.manufacturerData
      const hasOurTag = Buffer.isBuffer(mfg) && mfg.length >= 4
        && mfg.subarray(0, 4).toString('latin1') === ADV.MFG_TAG
      if (!hasService && !nameMatches && !hasOurTag) return

      if (this.blockedIds.has(peripheral.id)) return

      // 无论是否上报过，都要记进自己的表 —— 去重只影响"上报事件"，
      // 不该影响"以后能不能连上它"。
      this.peripherals.set(peripheral.id, peripheral)

      if (this.deviceFilter && peripheral.id !== this.deviceFilter) return
      if (this.seenInScan.has(peripheral.id)) return
      this.seenInScan.add(peripheral.id)

      emit('device', {
        id: peripheral.id,
        name: name || 'Folo-PSP',
        rssi: peripheral.rssi ?? null,
        address: peripheral.address ?? null,
        connectable: peripheral.connectable !== false,
        hasService,
      })
    })
  }

  async startScan(filter) {
    if (MOCK) {
      emit('device', { id: 'mock-bridge-1', name: DEVICE_NAME, rssi: -50, connectable: true, hasService: true })
      return
    }
    if (!this.noble) throw Object.assign(new Error('适配器未初始化'), { code: 'not-available' })
    this.deviceFilter = filter ?? null
    this.seenInScan.clear()
    if (this.scanning) return
    this.scanning = true
    // allowDuplicates=false：省电，也避免同一个设备刷屏。
    // 但这也意味着 RSSI 只在首次发现时上报，面板不应期待实时刷新。
    await this.noble.startScanningAsync([], false).catch(async () => {
      // 老实现没有 Promise 版本
      await new Promise((resolve, reject) => {
        try {
          this.noble.startScanning([], false, (error) => (error ? reject(error) : resolve()))
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  async stopScan() {
    if (MOCK || !this.noble || !this.scanning) {
      this.scanning = false
      return
    }
    this.scanning = false
    await this.noble.stopScanningAsync?.().catch(() => {}) ?? Promise.resolve()
    if (typeof this.noble.stopScanning === 'function' && typeof this.noble.stopScanningAsync !== 'function') {
      this.noble.stopScanning()
    }
  }

  async connect(deviceId) {
    if (MOCK) {
      emit('connected', { id: deviceId, name: DEVICE_NAME })
      return { id: deviceId, name: DEVICE_NAME, mtuPayload: 244 }
    }
    if (!this.noble) throw Object.assign(new Error('适配器未初始化'), { code: 'not-available' })
    if (this.scanning) await this.stopScan()

    this.linkReady = false
    this.pendingData = []

    const peripheral = await this.#findPeripheral(deviceId)
    this.peripheral = peripheral

    // 重连可能落在同一个 peripheral 对象上：先摘掉旧监听再挂新的，
    // 否则 disconnect 事件会被处理两次（两次"已断开"播报会把上层状态搅乱）。
    if (typeof peripheral.removeAllListeners === 'function') {
      peripheral.removeAllListeners('disconnect')
    }
    peripheral.on('disconnect', () => {
      this.characteristics = { rx: null, tx: null, voice: null, ctrl: null }
      this.peripheral = null
      emit('disconnected', { reason: 'peripheral-disconnect' })
    })

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // ★ 超时也要看实际状态：连接可能已在系统层建立、只是回调慢。
        if (peripheral.state === 'connected') {
          resolve()
          return
        }
        reject(Object.assign(new Error('连接超时'), { code: 'timeout' }))
      }, CONNECT_TIMEOUT_MS)
      peripheral.connect((error) => {
        clearTimeout(timer)
        if (!error) return resolve()
        // ★ 重连竞态（真机返工记录："连接失败：Peripheral already connected"）：
        //   设备侧自愈重开广播后，macOS 可能已把旧连接接了回来；此时再 connect
        //   会报 "Peripheral already connected"。这不是失败——链路就在手里，
        //   按已连接继续走发现/订阅即可。当成失败会钉住"连接失败"并反复重试，
        //   而设备明明在线。
        if (/already connected/i.test(String(error.message ?? '')) || peripheral.state === 'connected') {
          resolve()
          return
        }
        reject(Object.assign(new Error(`连接失败：${error.message}`), { code: 'connect-failed', cause: error }))
      })
    })

    await this.#discoverCharacteristics()

    // 订阅设备上行：TX 是 JSON 控制通道，VOICE 是音频通道。
    for (const [key, characteristic] of [['tx', this.characteristics.tx], ['voice', this.characteristics.voice]]) {
      if (!characteristic) continue
      await this.#subscribe(characteristic, key)
    }

    const mtuPayload = await this.#negotiateMtu()

    const info = {
      id: peripheral.id,
      name: peripheral.advertisement?.localName ?? DEVICE_NAME,
      address: peripheral.address ?? null,
      mtuPayload,
    }
    // 连接过程中可能已经有上行数据到达（设备收到订阅就发 hello）。
    // 上层在 connected 事件之后才开始收消息，因此这里把期间收到的数据**补发**出去，
    // 否则 hello 会在"下层已收到、上层还没监听"的窗口里丢失 —— 握手于是永远不闭环。
    this.linkReady = true
    emit('connected', info)
    const buffered = this.pendingData
    this.pendingData = []
    for (const item of buffered) emit('data', item)
    return info
  }

  async #findPeripheral(deviceId) {
    if (this.peripheral && this.peripheral.id === deviceId) return this.peripheral

    // 先查自己维护的表（见构造函数里 this.peripherals 的说明）
    const known = this.peripherals.get(deviceId)
    if (known) {
      if (this.scanning) await this.stopScan()
      return known
    }

    // 没有就扫一次把它捞出来。注意**不要**清空 this.peripherals ——
    // 之前发现过的设备可能在这次扫描的广播窗口里恰好没出现。
    this.deviceFilter = deviceId
    this.seenInScan.clear()
    await this.startScan(deviceId)
    const deadline = Date.now() + SCAN_WAIT_MS
    while (Date.now() < deadline) {
      const found = this.peripherals.get(deviceId)
      if (found) {
        await this.stopScan()
        return found
      }
      await sleep(100)
    }
    await this.stopScan()

    // 报错时把"这次到底看到了什么"一并给出，便于区分
    // "设备没广播" 与 "过滤条件不对" 这两种完全不同的原因。
    const seen = [...this.peripherals.entries()].map(([id, p]) => {
      const a = p.advertisement ?? {}
      return `${id.slice(0, 8)}…(${a.localName || p.name || '无名'})`
    })
    throw Object.assign(
      new Error(
        seen.length
          ? `找不到设备 ${deviceId}；本次扫描看到：${seen.join('、')}`
          : `找不到设备 ${deviceId}；本次扫描没有发现任何 BLE 设备`,
      ),
      { code: 'device-not-found' },
    )
  }

  async #discoverCharacteristics() {
    const peripheral = this.peripheral

    // ★ 必须用 discoverAllServicesAndCharacteristics，**不能**传 UUID 过滤。
    //
    // 实测（@stoprocent/noble / macOS CoreBluetooth）：只要给
    // discoverSomeServicesAndCharacteristics 传了服务或特征 UUID 过滤，
    // 回调就永远不返回有效结果 —— err 是个连 message 都为 undefined 的空对象，
    // 而且换成 4 位短 UUID（A900）、32 位无连字符、大写等任何写法都一样失败；
    // 不传过滤则立刻成功（实测拿到 1 个服务 + 4 个特征）。
    // 这是 noble Darwin 后端过滤路径的问题，不是设备的问题。
    //
    // 因此改为"全量发现 + 在 JS 里自己匹配"。顺带好处是：如果设备端 UUID 变了，
    // 我们能拿到实际值并报出来，而不是只得到一个无信息的失败。
    const services = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Object.assign(new Error('发现服务超时（10 秒）'), { code: 'connect-failed' })),
        10000,
      )
      peripheral.discoverAllServicesAndCharacteristics((error, foundServices, foundCharacteristics) => {
        clearTimeout(timer)
        if (error) {
          reject(Object.assign(
            new Error(`发现服务失败：${error.message || String(error)}`),
            { code: 'connect-failed', cause: error },
          ))
        } else {
          resolve({ services: foundServices ?? [], characteristics: foundCharacteristics ?? [] })
        }
      })
    })

    const all = services.characteristics
    if (!all.length) {
      throw Object.assign(
        new Error('设备上找不到任何 GATT 特征。请确认已刷入带 DSH 联动固件的版本。'),
        { code: 'connect-failed' },
      )
    }

    // ★ 只在**我们自己的服务**下匹配特征。
    //
    // 设备上除了 AI Passport 服务，还带着标准的设备信息服务（2a29 厂商名、2a24 型号…）
    // 与电池服务（2a19）。它们一般不会与我们的 UUID 撞名，但用"全表扁平匹配"是
    // 靠运气 —— 一旦将来某个标准特征编号与我们相同，就会静默取错特征，
    // 而且现象是"连上了但收不到消息"，极难定位。按服务归属过滤是零成本的确定性做法。
    const ourServiceUuid = normalizeUuid(UUID.SERVICE)
    const ours = services.services?.find((sv) => normalizeUuid(sv.uuid) === ourServiceUuid)
    const scoped = ours
      ? all.filter((c) => normalizeUuid(c._serviceUuid ?? c.serviceUuid ?? '') === ourServiceUuid)
      : all
    const pool = scoped.length ? scoped : all
    if (!scoped.length) {
      log('warn', `未能把特征限定到本服务（服务列表：${(services.services ?? []).map((x) => x.uuid).join('、')}），退回全表匹配`)
    }

    const byUuid = new Map(pool.map((c) => [normalizeUuid(c.uuid), c]))
    this.characteristics = {
      rx: byUuid.get(normalizeUuid(UUID.RX)) ?? null,
      tx: byUuid.get(normalizeUuid(UUID.TX)) ?? null,
      voice: byUuid.get(normalizeUuid(UUID.VOICE)) ?? null,
      ctrl: byUuid.get(normalizeUuid(UUID.CTRL)) ?? null,
    }

    if (!this.characteristics.rx || !this.characteristics.tx) {
      // 报错时把**实际看到的** UUID 列出来 —— 两端 UUID 不一致时，
      // 这行日志直接给出该改成什么，不用再靠抓包或猜。
      const seen = all.map((c) => c.uuid).join('、')

      // ★ GATT 表对不上有两种完全不同的情况，处置必须区分：
      //
      //   A. 广播身份是我们（服务 UUID/名字命中），但发现到的表不是我们的 ——
      //      这是 **系统 BLE 陈旧缓存/僵尸连接**：设备刷过机后 GATT 表变了，系统
      //      仍留着出厂固件时代的服务表（真机返工记录：重连报「找不到控制特征」，
      //      实际看到的是旧表；重启设备有效正是因为重启掐断了系统层的旧连接）。
      //      macOS 上实测到；Windows 的 WinRT 后端缓存行为不同，命中时同样处置即可。
      //      处置：断开重连让系统重发现，**绝不拉黑自己**。
      //
      //   B. 广播身份不是我们（混过识别过滤的冒牌设备）→ 断开并本会话拉黑，
      //      防止它垄断重连循环。
      const adv = peripheral.advertisement ?? {}
      const svcUuids = [...(Array.isArray(adv.serviceUuids) ? adv.serviceUuids : []),
                        ...(Array.isArray(adv.overflowServiceUuids) ? adv.overflowServiceUuids : [])]
        .map((u) => normalizeUuid(u))
      const advName = adv.localName ?? peripheral.name ?? ''
      const KNOWN = [DEVICE_NAME, SHORT_DEVICE_NAME, 'FoloPassport', 'Folo-PSP']
      const isOurs = svcUuids.includes(normalizeUuid(UUID.SERVICE)) || KNOWN.includes(advName)

      if (isOurs) {
        log('warn', `GATT 表与广播身份不符（${peripheral.id}，疑似系统 BLE 陈旧缓存），断开重试`)
        try {
          await this.disconnect()
        } catch {
          // 已断开
        }
        throw Object.assign(
          new Error('设备 GATT 表疑似系统 BLE 陈旧缓存（刷机后未重发现），已断开重试'),
          { code: 'stale-cache' },
        )
      }

      log('warn', `GATT 表不匹配（疑似非本设备 ${peripheral.id}），断开并拉黑`)
      this.blockedIds.add(peripheral.id)
      try {
        await this.disconnect()
      } catch {
        // 已断开
      }
      throw Object.assign(
        new Error(
          `设备上没有找到 AI Passport 的控制特征（RX/TX）。\n` +
            `  期望 RX=${UUID.RX}\n` +
            `  期望 TX=${UUID.TX}\n` +
            `  实际看到：${seen}`,
        ),
        { code: 'connect-failed' },
      )
    }
    this.characteristics = {
      rx: byUuid.get(UUID.RX) ?? null,
      tx: byUuid.get(UUID.TX) ?? null,
      voice: byUuid.get(UUID.VOICE) ?? null,
      ctrl: byUuid.get(UUID.CTRL) ?? null,
    }
    if (!this.characteristics.rx || !this.characteristics.tx) {
      throw Object.assign(new Error('GATT 服务不完整：缺少 RX 或 TX 特征值'), { code: 'connect-failed' })
    }
  }

  async #subscribe(characteristic, key) {
    // ★ data 监听器必须在 subscribe **之前**挂上。
    //
    // 踩过的坑：原本是先 subscribe、成功回调里再 on('data')。
    // 但设备一端收到订阅就立刻发 hello（那是握手的第一步），
    // 这条通知正好落在"订阅已生效、监听器还没挂"的窗口里被丢掉。
    // 后果是链路永久静默：能连上、订阅成功、设备日志显示"已主动发送 hello"，
    // 而主机一条消息都收不到 —— 从任何一侧的日志都看不出错误。
    characteristic.on('data', (data) => {
      const payload = { channel: key, bytes: Buffer.from(data).toString('base64') }
      // connected 事件之前到达的数据先缓存，等 connected 之后再发（见 connect()）
      if (!this.linkReady) this.pendingData.push(payload)
      else emit('data', payload)
    })

    await new Promise((resolve, reject) => {
      characteristic.subscribe((error) => {
        if (error) {
          reject(Object.assign(new Error(`订阅 ${key} 失败：${error.message}`), { code: 'connect-failed' }))
          return
        }
        resolve()
      })
    })
  }

  /**
   * 协商 ATT 载荷。失败就退回保守值，不因为拿不到 MTU 就不干活。
   *
   * 跨平台差异（macOS / Windows 一次烧录通用的关键之一）：
   *   - macOS（CoreBluetooth）：noble 有 requestMtu，按请求值协商；
   *   - Windows（noble-win / WinRT）：可能没有 requestMtu，但 WinRT 会自动
   *     协商到 512 字节 ATT MTU，244 的默认载荷天然安全；
   *   - 两条路都拿不到数值时回 244 —— 与固件侧 preferred MTU（≥247）匹配。
   */
  async #negotiateMtu() {
    const peripheral = this.peripheral
    try {
      if (typeof peripheral.requestMtu === 'function') {
        const mtu = await peripheral.requestMtu(517)
        if (Number.isFinite(mtu) && mtu > 23) return Math.max(20, mtu - 3)
      }
      const cached = peripheral.mtu
      if (Number.isFinite(cached) && cached > 23) return Math.max(20, cached - 3)
      log('info', 'MTU 未上报（Windows/WinRT 常见），使用默认载荷 244')
    } catch (error) {
      log('warn', `MTU 协商失败，退回 244：${error.message}`)
    }
    return 244
  }

  async disconnect() {
    if (MOCK) {
      emit('disconnected', { reason: 'user' })
      return
    }
    if (!this.peripheral) return
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000)
      this.peripheral.disconnect(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.peripheral = null
    this.characteristics = { rx: null, tx: null, voice: null, ctrl: null }
  }

  async write(channel, base64) {
    if (MOCK) return
    const characteristic = channel === 'voice' ? this.characteristics.rx : this.characteristics.rx
    if (!characteristic) throw Object.assign(new Error('未连接或无 RX 特征值'), { code: 'disconnected' })
    const bytes = Buffer.from(base64, 'base64')
    // withoutResponse 更快；ble 栈在拥塞时会自己排队，父进程的发送队列已经做了节流。
    await new Promise((resolve, reject) => {
      characteristic.write(bytes, true, (error) => {
        if (error) reject(Object.assign(new Error(`写入失败：${error.message}`), { code: 'unknown', cause: error }))
        else resolve()
      })
    })
  }

  async readCtrl() {
    if (MOCK) return Buffer.from(JSON.stringify({ protocolVersion: PROTOCOL_VERSION })).toString('base64')
    if (!this.characteristics.ctrl) return null
    const data = await new Promise((resolve, reject) => {
      this.characteristics.ctrl.read((error, value) => (error ? reject(error) : resolve(value)))
    })
    return Buffer.from(data).toString('base64')
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    try {
      await this.disconnect()
      await this.stopScan()
      this.noble?.removeAllListeners?.()
    } catch (error) {
      log('warn', `收尾时出错：${error.message}`)
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** noble 的 uuid 可能带短横线也可能不带，统一成小写无横线再比较。 */
function normalizeUuid(uuid) {
  return String(uuid).toLowerCase().replace(/-/g, '')
}

// —— 主循环 ——

const bridge = new Bridge()

/** 未捕获异常必须明确上报再退出，否则父进程只看到进程没了、不知道为什么。 */
process.on('uncaughtException', (error) => {
  log('error', `未捕获异常：${error.stack ?? error.message}`)
  emit('fatal', { code: error.code ?? 'unknown', message: error.message })
  setTimeout(() => process.exit(1), 50)
})
process.on('unhandledRejection', (reason) => {
  log('error', `未处理的 Promise 拒绝：${reason instanceof Error ? reason.message : String(reason)}`)
})

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let request
  try {
    request = JSON.parse(text)
  } catch {
    log('warn', `无法解析的命令：${text.slice(0, 120)}`)
    return
  }
  void handle(request)
})

async function handle(request) {
  const { id, cmd } = request
  try {
    switch (cmd) {
      case 'init':
        await bridge.init()
        reply(id, { noble: bridge.nobleName, mock: MOCK })
        break
      case 'scan':
        await bridge.startScan(request.filter)
        reply(id, { scanning: true })
        break
      case 'stopScan':
        await bridge.stopScan()
        reply(id, { scanning: false })
        break
      case 'connect':
        reply(id, await bridge.connect(request.deviceId))
        break
      case 'disconnect':
        await bridge.disconnect()
        reply(id, { disconnected: true })
        break
      case 'write':
        await bridge.write(request.channel ?? 'control', request.bytes)
        reply(id, { written: true })
        break
      case 'readCtrl':
        reply(id, { bytes: await bridge.readCtrl() })
        break
      case 'dispose':
        await bridge.dispose()
        reply(id, { disposed: true })
        setTimeout(() => process.exit(0), 20)
        break
      case 'ping':
        reply(id, { pong: true })
        break
      default:
        replyError(id, 'unknown-command', `未知命令：${cmd}`)
    }
  } catch (error) {
    replyError(id, error.code ?? 'unknown', error.message ?? String(error))
  }
}

rl.on('close', () => {
  // 父进程关闭了 stdin：这是正常的退出信号，不要报错。
  void bridge.dispose().finally(() => process.exit(0))
})

emit('ready', { mock: MOCK, pid: process.pid })
