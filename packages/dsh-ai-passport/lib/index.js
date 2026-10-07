/**
 * dsh-ai-passport —— AI Passport × DeepSeek Harness 联动插件。
 *
 * 这个文件只做"装配"，不放业务逻辑：
 *   传输（ble/） → 链路（ble/host-link.js） → 业务域（bridge/） → 面板与工具
 *
 * 一个必须遵守的加载约束（照抄 dsh-whale-widget 踩过的坑）：
 * **不要在插件对象上写 `inject: [...]`**。对象级 inject 会把整个 apply() 推迟到
 * 那些服务就绪之后，而 DSH 桌面端的 index 注入表是宿主启动时**一次性收集**的；
 * 订阅一旦晚于那次收集，注入行就永远进不了表。所以 apply() 立刻执行，
 * 先把注入行登记上，其余依赖服务的逻辑放进 root.inject([...], cb) 局部等待。
 *
 * 另外，BLE 依赖（可选原生模块、系统权限）**绝不进 inject**：
 * 蓝牙不可用时插件本身必须照常加载，只是面板上显示"BLE 不可用"。
 */

import { normalizeConfig, loadConfigSchema } from './config.js'
import { HostLink } from './ble/host-link.js'
import { MockTransport } from './ble/mock.js'
import { BridgeProcessTransport } from './ble/bridge-process.js'
import { Panel } from './panel/index.js'
import { StateDomain } from './bridge/state.js'
import { BalanceDomain } from './bridge/balance.js'
import { ApprovalDomain } from './bridge/approval.js'
import { PairingDomain } from './bridge/pairing.js'
import { VoiceDomain } from './bridge/voice.js'
import { QuestionsDomain } from './bridge/questions.js'
import { registerTools } from './tools/index.js'

export const name = 'dsh-ai-passport'

/** 面板地址，供日志与工具提示引用。 */
export const PANEL_PATH = '/dsh-passport'

// ★ 只在真的拿到 schema 时才导出 Config。
//   导出 null 会让"没有 schema"这个正常降级变成下游需要特判的异常值。
const configSchema = await loadConfigSchema()
export const Config = configSchema === null ? undefined : configSchema
heartbeat('module', `evaluated Config=${configSchema === null ? 'none' : 'schema'}`)

/**
 * 入口。**全程兜底**：插件加载失败绝不能让宿主起不来。
 *
 * 这条原则是被一次真实故障逼出来的：插件在宿主启动路径上抛错时，
 * 整个桌面应用打不开（"desktop welcome: Web RPC failed"），
 * 用户连界面都进不去。相比"插件某个功能不可用"，
 * "应用打不开"的代价高一个数量级 —— 因此这里宁可降级，不可冒泡。
 */
export function apply(root, rawConfig) {
  try {
    return applyUnsafe(root, rawConfig)
  } catch (error) {
    // 用 console 而不是 ctx.logger：logger 本身可能就是抛错的那一环。
    heartbeat('apply-failed', String(error?.message ?? error))
    console.error('[dsh-ai-passport] 插件初始化失败，已降级为不加载：', error?.message ?? error)
    if (error?.stack) console.error(error.stack.split('\n').slice(0, 6).join('\n'))
    return undefined
  }
}

/**
 * 写启动心跳。
 *
 * 为什么需要它：排查"插件没加载"时，我在"宿主没重启""配置被覆盖""加载抛错"
 * 之间反复猜了三轮。一个心跳文件能把这个问题变成一次 `cat`：
 * 模块求值了没有、apply 被调了没有、配置是什么、有没有抛错。
 */
function heartbeat(stage, detail) {
  try {
    const os = globalThis.process?.getBuiltinModule?.('node:os')
    const fs = globalThis.process?.getBuiltinModule?.('node:fs')
    if (!fs || !os) return
    const dir = `${os.homedir()}/.dsh`
    fs.appendFileSync(
      `${dir}/dsh-ai-passport.log`,
      `${new Date().toISOString()} ${stage} ${detail ?? ''}\n`,
    )
  } catch {
    // 心跳本身绝不能成为失败源
  }
}

function applyUnsafe(root, rawConfig) {
  heartbeat('apply', JSON.stringify(rawConfig ?? null).slice(0, 200))
  const config = normalizeConfig(rawConfig)

  const logger = createLogger(root, config.logLevel)
  logger('info', `[passport] 加载中（transport=${config.transport}）`)

  // 资源登记：apply() 可能被重复调用（HMR / 配置变更），所有东西都必须可逆。
  const disposers = []
  root.effect(() => () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        logger('warn', `[passport] 清理时出错：${error?.message ?? error}`)
      }
    }
    disposers.length = 0
  })

  // ① 桌面端注入行：必须最早登记，因为它是一次性收集的。
  disposers.push(
    root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        const alreadyThere = table.some(
          (row) =>
            row &&
            ((row.kind === 'script-src' && row.src === `${PANEL_PATH}/panel.js`) ||
              (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(PANEL_PATH))),
        )
        if (alreadyThere) return
        // 面板是独立页面，这里只放一个不打扰的入口提示，不注入任何 UI。
        // 用内联 script 行而不是 script-src：页面侧解释器对 script-src 加载失败会 reject
        // 整个 boot（whale-widget issue #154 的致命启动错误），内联更安全。
        table.push({
          kind: 'script',
          placement: 'body',
          text: `try{console.info('[dsh-ai-passport] 控制面板：${PANEL_PATH}')}catch(e){}`,
        })
      } catch (error) {
        logger('debug', `[passport] 注入行登记失败：${error?.message ?? error}`)
      }
    }),
  )

  // ② 运行时状态：链路 + 各业务域，全部挂在同一个对象上，便于快照与测试。
  const runtime = createRuntime({ config, logger })
  disposers.push(() => runtime.dispose())

  // ③ 依赖服务就绪后再接线。webServer 只用于面板；缺它时其余功能照常工作。
  //    整段再包一层：面板注册失败不应影响链路与业务域。
  root.inject(['webServer', 'sessionController'], (ctx) => {
    try {
    // 业务域的宿主依赖在这里统一注入：会话事件订阅、审批瀑布、语音识别都需要 ctx。
    // 这一步如果漏了，表现是"面板能用但状态永远不更新"——静默失效，最难查。
    runtime.attachHost(ctx)

    if (!config.panel.enabled) {
      logger('info', '[passport] 面板已按配置关闭')
      return
    }
    const panel = new Panel({
      ctx,
      logger,
      getSnapshot: () => runtime.snapshot(),
      dispatch: (action, payload) => runtime.dispatch(action, payload),
      subscribe: (listener) => runtime.subscribe(listener),
    })
      panel.start()
      for (const dispose of panel.registerRoutes(ctx.webServer)) disposers.push(dispose)
      disposers.push(() => panel.dispose())
      logger('info', `[passport] 控制面板已挂载：${PANEL_PATH}`)
    } catch (error) {
      // 面板注册失败：记日志、继续。链路与业务域不受影响。
      logger('warn', `[passport] 面板注册失败（其余功能不受影响）：${error?.message ?? error}`)
    }
  })

  // ④ Agent 工具：让 DSH 自己也能操作设备。需要 tools 服务。
  root.inject(['tools'], (ctx) => {
    // 工具注册失败同样只降级：Agent 少几个工具，远好过插件整体不可用。
    try {
      for (const dispose of registerTools(ctx, runtime, logger)) disposers.push(dispose)
      logger('debug', '[passport] Agent 工具已注册')
    } catch (error) {
      logger('warn', `[passport] 工具注册失败：${error?.message ?? error}`)
    }
  })

  // ⑤ 自动连接：不阻塞 apply()，失败只记日志（蓝牙不可用不应影响插件加载）。
  if (config.autoConnect) {
    void runtime.connect().catch((error) => {
      logger('warn', `[passport] 自动连接未成功：${error?.message ?? error}`)
    })
  }
}

/**
 * 组装运行时：传输 → 链路 → 业务域。
 *
 * 抽成独立函数是为了让单测能直接构造它，不必经过插件加载器。
 */
export function createRuntime({ config, logger }) {
  const transport = createTransport(config, logger)
  const link = new HostLink({
    // eslint-disable-next-line no-undef
    transport,
    autoReconnect: config.autoReconnect,
    logger,
  })

  const listeners = new Set()
  /** 业务域的最新快照，由各域自己维护。 */
  const domainState = {
    /** 聚合后的整体状态（精简版取代了原来的任务列表）。 */
    taskState: null,
    approvals: [],
    balance: null,
    balanceError: null,
    speech: null,
    speechError: null,
    /** 最近的语音识别结果。挂件用它列出"可填入输入框"的文本。 */
    voiceLog: [],
    /**
     * 识别结果卡的消费状态（docs/06 §2）：
     *   pending —— 设备按下"填入/发送"后待挂件认领执行的那一条（一次性）；
     *   replacedDraft —— 双击发送整段替换前的旧草稿（可找回，见 docs/06 §2.3）。
     */
    voice: { pending: null, replacedDraft: '' },
  }

  const broadcast = (event) => {
    const payload = { ...event, state: snapshot() }
    for (const listener of listeners) {
      try {
        listener(payload)
      } catch (error) {
        logger('debug', `[passport] 事件监听者抛错：${error?.message ?? error}`)
      }
    }
  }

  const domains = []
  const shared = { link, config, logger, broadcast, domainState, domains }

  const state = new StateDomain(shared)
  const balance = new BalanceDomain(shared)
  const approval = new ApprovalDomain(shared)
  const voice = new VoiceDomain(shared)
  const questions = new QuestionsDomain(shared)
  // 配对（阶段 C）：信任表落在 ~/.dsh/dsh-ai-passport.pairing.json（与插件日志同目录）
  // 信任表路径：插件沙箱里没有顶层 node:os，按本文件既有的 getBuiltinModule 取法
  const pairingStorePath = (() => {
    try {
      const nodeOs = globalThis.process?.getBuiltinModule?.('node:os')
      return nodeOs ? `${nodeOs.homedir()}/.dsh/dsh-ai-passport.pairing.json` : null
    } catch {
      return null
    }
  })()
  const pairing = new PairingDomain({ link, logger, storePath: pairingStorePath ?? '' })
  // 审批域需要把"有无审批挂起"告诉状态域 —— 待审批是最高优先级的状态，
  // 它必须压过"运行中"，否则设备会在等待授权的当口显示"运行中"。
  approval.onApprovalChange = (title) => state.setApproval(title)
  domains.push(state, balance, approval, voice, questions, pairing)

  // 链路事件 → 面板事件。链路的原始事件名与面板事件名不必一致，
  // 这里做一层映射，面板就不必知道 HostLink 的内部细节。
  link.on('state', ({ state }) => broadcast({ type: 'link.state', state: state.state }))
  link.on('device', (device) => broadcast({ type: 'link.device', device }))
  link.on('connected', (device) => broadcast({ type: 'link.connected', device }))
  link.on('ready', () => broadcast({ type: 'link.ready' }))
  // hello 到达即推送（固件/电量随包更新）。少了这条，握手后 deviceInfo 的变化
  // 可能赶不上面板已收到的快照 —— 面板停留在"—"，看起来就是"没显示"。
  link.on('device-info', (info) => broadcast({ type: 'link.device-info', info }))
  link.on('disconnected', (payload) => {
    // 换设备/断链后清空语音日志：旧设备的识别结果留在列表里会误点"填入"
    domainState.voiceLog = []
    // ★ 真正断链时清掉录音标志：掉线时 voice.end 可能没到达，标志会卡住后续推送。
    //   这是清该标志的唯一合理时机（hello.ack 重握手不该清，见 state.onLinkReady）。
    state.onLinkReset()
    broadcast({ type: 'link.disconnected', reason: payload.reason })
  })
  link.on('reconnecting', (payload) => broadcast({ type: 'link.reconnecting', ...payload }))
  link.on('gap', (payload) => broadcast({ type: 'link.gap', ...payload }))
  link.on('link-error', (error) =>
    broadcast({ type: 'link.error', code: error.code, message: error.message, hint: error.hint }),
  )

  function snapshot() {
    return {
      link: link.snapshot(),
      transport: transport.kind,
      // 蓝牙诊断：把"点了连接没反应"拆成可读的几项（适配器状态、桥进程、最近错误）。
      // 没有它就只能猜是权限、模块、还是设备不在广播。
      diagnose: typeof transport.diagnose === 'function' ? transport.diagnose() : null,
      taskState: domainState.taskState,
      approvals: domainState.approvals,
      balance: domainState.balance,
      balanceError: domainState.balanceError,
      speech: domainState.speech,
      speechError: domainState.speechError,
      voiceLog: domainState.voiceLog,
      voice: domainState.voice,
      questions: questions.snapshot(),
      pairing: pairing.snapshot(),
      // 拦截轨迹：审批/追问的瀑布到底走没走到我们（真机排障用）
      approvalTrace: domainState.approvalTrace ?? [],
      questionsTrace: domainState.questionsTrace ?? [],
      config: {
        transport: config.transport,
        targetDeviceId: config.targetDeviceId,
        autoReconnect: config.autoReconnect,
        voice: config.voice,
        approval: config.approval,
        questions: config.questions,
      },
    }
  }

  const runtime = {
    link,
    transport,
    config,
    logger,
    domains: { state, balance, approval, voice, questions },
    snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    broadcast,

    /**
     * 注入宿主上下文。
     *
     * 必须由 apply() 在 root.inject 回调里调用：业务域需要 ctx 才能订阅
     * session/event、approval/request 与读取 speechToText。
     */
    attachHost(ctx) {
      this.hostCtx = ctx
      for (const domain of domains) {
        try {
          // 第二个参数只有在域确实需要宿主时才被使用（约定式接口）
          domain.attach?.(runtime, ctx)
        } catch (error) {
          logger('warn', `[passport] 域接不上宿主：${error?.message ?? error}`)
        }
      }
      // 余额定时刷新已按用户要求删除（余额改为按需获取：设备长按下键请求、
      // 面板/工具手动刷新、链路握手完成时各刷一次）。
      // 注：原先这里写的是 `domains.balance?.startAutoRefresh?.()` —— `domains` 是闭包里的
      // 数组，`.balance` 恒为 undefined，可选链把接线错误静默吞掉了（定时器从未启动）。
      // 该问题随定时器一并消失，记录在此避免后人再踩同一个作用域陷阱。
      // 识别目录探测：启动后主动刷一次状态（服务注册晚于插件时带重试），
      // 否则挂件/面板会一直显示"未启用"，哪怕模型早就装好了。
      try {
        voice?.startInitialCatalogProbe?.()
      } catch (error) {
        logger('debug', `[passport] 识别目录探测未启动：${error?.message ?? error}`)
      }
    },

    /** 扫描并连接（面板「扫描并连接」按钮与自动连接都走这里）。 */
    async connect() {
      if (link.state === 'connected') return { state: link.state }
      try {
        await link.start()
        return { state: link.state }
      } catch (error) {
        // 之前这里"点了没反应"的根源之一：错误被吞掉，界面无从显示。
        // 现在把可读原因一并回给面板，并明确区分"权限/适配器/设备"三类。
        const hint = error?.hint ? ` —— ${error.hint}` : ''
        logger('warn', `[passport] 连接失败：${error?.message ?? error}${hint}`)
        return {
          state: link.state,
          message: `${error?.message ?? '连接失败'}${hint}`,
          error: { code: error?.code ?? 'unknown', message: error?.message ?? String(error), hint: error?.hint },
          state_: snapshot(),
        }
      }
    },

    async disconnect() {
      await link.stop('user')
      return { state: link.state, message: '已断开连接' }
    },

    /**
     * 面板动作分发。
     *
     * 约定：返回对象可带 `message`（面板会显示成提示条）与 `state`（面板立即刷新）。
     * 抛出的错误由面板路由统一转成 500，所以这里只处理"可预期"的失败。
     */
    async dispatch(action, payload) {
      switch (action) {
        case 'device.connect': {
          const result = await runtime.connect()
          return {
            state: snapshot(),
            // message 由面板显示成提示条：失败时必须带上原因，不能静默
            message: result?.message ?? '已发起扫描，等待设备广播…',
          }
        }

        case 'pair.submit': {
          // 用户在挂件里输入设备屏幕上的 6 位配对码
          const result = pairing.submit(payload?.code)
          return {
            state: snapshot(),
            message: result.ok ? '已提交配对码，等待设备确认…' : '请输入 6 位数字配对码',
          }
        }

        case 'pair.unpair': {
          await pairing.unpair()
          return { state: snapshot(), message: '已解除配对（设备下次连接需重新配对）' }
        }

        case 'device.diagnose':
          return { state: snapshot(), message: describeDiagnose(transport) }

        case 'device.disconnect':
          return runtime.disconnect()

        case 'device.ping':
          await link.send('ping', { t: Date.now() }, { ack: false, channel: 2 })
          return { message: '心跳已发送', state: snapshot() }

        case 'device.toast':
          await link.send('toast', { text: String(payload.text ?? '你好') })
          return { message: '提示已发送到设备', state: snapshot() }

        case 'device.refresh':
          // 精简版没有任务列表可刷；改为强制重推一次状态。
          state.onLinkReady()
          return { message: '已重推状态', state: snapshot() }

        case 'balance.refresh':
          await balance.refresh()
          return { state: snapshot() }

        case 'speech.refresh':
          await voice.refreshCatalog()
          return { state: snapshot() }

        case 'speech.prepare':
          await voice.prepare()
          return { message: '已开始准备识别模型', state: snapshot() }

        // 识别结果卡的消费链（docs/06 §2）：挂件先 take 认领（多窗口先到先得），
        // 执行完 ack 回执；take 与 ack 都是幂等的，重复调用只回"已处理过"。
        // 返回值约定与其它动作一致（路由统一包一层 {ok:true, result}）。
        case 'voice.take': {
          const taken = voice.take(String(payload.resultId ?? ''))
          return taken
            ? { taken: true, mode: taken.mode, text: taken.text, state: snapshot() }
            : { taken: false, message: '该识别结果已被处理或不存在', state: snapshot() }
        }

        case 'voice.ack': {
          const result = voice.ack({
            resultId: String(payload.resultId ?? ''),
            ok: payload.ok !== false,
            reason: payload.reason ? String(payload.reason) : '',
            replacedDraft: payload.replacedDraft ? String(payload.replacedDraft) : '',
          })
          return { ...result, state: snapshot() }
        }

        case 'approval.decide': {
          const decided = approval.decide(String(payload.id ?? ''), payload.decision === 'allow' ? 'allow' : 'deny')
          return {
            message: decided ? '已提交决定' : '该审批已结束或不存在',
            state: snapshot(),
          }
        }

        default:
          throw new Error(`未知的面板动作：${action}`)
      }
    },

    /** 关闭：先让业务域收尾，再断链路（域可能需要发最后一条消息）。 */
    async dispose() {
      for (const domain of domains) {
        try {
          await domain.dispose()
        } catch (error) {
          logger('debug', `[passport] 域收尾失败：${error?.message ?? error}`)
        }
      }
      listeners.clear()
      await link.dispose()
    },
  }

  // 链路握手完成 → 补推一次状态（去重记忆要清掉，否则"状态没变"就永远不推），
  // 并顺手刷一次余额，让面板与设备都有数据。
  link.on('ready', () => {
    state.onLinkReady()
    void balance.refresh().catch(() => {})
  })

  return runtime
}

/** 把蓝牙诊断翻译成一句能照做的话。 */
function describeDiagnose(transport) {
  if (typeof transport.diagnose !== 'function') return '当前传输不支持诊断'
  const d = transport.diagnose()
  if (d.adapterState === 'poweredOn') {
    return d.childRunning ? '蓝牙适配器就绪，桥进程在运行' : '蓝牙就绪，但桥进程未运行'
  }
  switch (d.adapterState) {
    case 'poweredOff':
      return '系统蓝牙未开启 —— 请在控制中心打开蓝牙'
    case 'unauthorized':
      return '蓝牙权限被拒绝 —— 打开「系统设置 → 隐私与安全性 → 蓝牙」，勾选 DeepSeek Harness 后重启应用'
    case 'unsupported':
      return '这台机器不支持 BLE'
    case null:
      return d.lastError
        ? `桥进程未报告适配器状态；最近错误：${d.lastError.message}`
        : '桥进程尚未报告适配器状态（可能尚未启动）'
    default:
      return `蓝牙状态异常：${d.adapterState}`
  }
}

/** 按配置选择传输实现。三种实现都失败时给出明确说明，而不是静默降级。 */
function createTransport(config, logger) {
  switch (config.transport) {
    case 'mock':
      logger('info', '[passport] 使用内存传输（无硬件联调）')
      return new MockTransport()

    case 'noble': {
      // 进程内直连：留作后备。原生模块 ABI 不匹配会拖垮宿主，默认不选它。
      logger('warn', '[passport] transport=noble 需要进程内加载原生模块，若 DSH 异常退出请改用 bridge')
      return new BridgeProcessTransport({ logger })
    }

    case 'bridge':
    default:
      return new BridgeProcessTransport({
        logger,
        mtuPayload: config.mtuPayload,
      })
  }
}

/** 日志器：优先用宿主 logger，缺它时退回 console。 */
function createLogger(root, level) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 }
  const threshold = order[level] ?? order.info
  let hostLogger = null
  try {
    hostLogger = root?.logger ?? null
  } catch {
    hostLogger = null
  }
  return (messageLevel, message) => {
    if ((order[messageLevel] ?? order.info) < threshold) return
    const method = messageLevel === 'debug' ? 'debug' : messageLevel === 'warn' ? 'warn' : messageLevel === 'error' ? 'error' : 'info'
    try {
      if (hostLogger && typeof hostLogger[method] === 'function') {
        hostLogger[method](message)
        return
      }
    } catch {
      // 宿主 logger 抛错不应影响业务
    }
    // eslint-disable-next-line no-console
    console[method === 'debug' ? 'log' : method](message)
  }
}
