/**
 * 审批域：把 DSH 的审批请求送到设备上，让用户按实体键决定。
 *
 * 对接点是 `approval/request` 这个 **waterfall 事件**：
 *
 *   ctx.on('approval/request', (req, next) => ...)
 *
 * 语义要点（决定了实现方案）：
 *   - 它是瀑布流：我们返回一个结果就**终止**后续 answerer（包括网页端弹窗）；
 *     返回 `next()` 则把决定权交回下游。因此"设备能批"和"网页能批"必须择一，
 *     不能两边同时弹——否则用户会在两个地方看到同一个请求，
 *     而且任何一个先回答都会让另一个变成幽灵弹窗。
 *   - 返回值的合法集合是 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'，
 *     其中**只有 'allowed-once' 是放行**。
 *   - 请求方可能带 signal（用户中断/超时）；信号中断我们必须立刻收手并回 'cancelled'。
 *   - `approval.request()` 要求有一个打开的 turn，因此这个事件只在正常执行中出现。
 *
 * 设计上的安全取舍（宁可麻烦，不可误放行）：
 *   1. 设备无响应（断链、超时、信号中断）→ 返回 `next()` 交回网页端，**绝不默认放行**。
 *      这一点很关键：如果设备断链就静默 allow，等于"拔掉蓝牙即可绕过审批"。
 *   2. 设备端默认停在"拒绝"上，高风险工具需要显式按上键切到"允许"。
 *   3. 可配置只允许在设备上批只读工具，写操作强制回电脑批。
 */

import { APPROVE_SCOPE, DECISION, MSG } from '../protocol/constants.js'

/** 只读工具白名单：这些工具不改动工作区，允许在设备上批。 */
const READ_ONLY_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'list',
  'ls',
  'search',
  'web_search',
  'web_fetch',
  'fs_read',
  'fs_search',
])

let nextRequestSeq = 0

/** 永不解析的 Promise：竞速里表示"这条支线不再参与"（如设备超时后只等电脑）。 */
const NEVER = new Promise(() => {})

/** 电脑端"没有回答者"的哨兵（链尾兜底值）：不是用户决定，竞速里必须忽略。 */
function isNoAnswerer(card) {
  return card.kind === 'answer' && (card.value === undefined || card.value === 'unavailable')
}

/** 极短摘要：设备只显示一行，超长截断（正文都在电脑卡片上）。 */
function clampSummary(text, maxChars = 12) {
  const value = String(text ?? '')
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`
}

export class ApprovalDomain {
  constructor(shared) {
    this.link = shared.link
    this.config = shared.config
    this.logger = shared.logger
    this.broadcast = shared.broadcast
    this.domainState = shared.domainState

    /**
     * 等待设备决定的请求。
     * @type {Map<string, {resolve:Function, reject:Function, timer:any, request:object, settled:boolean}>}
     */
    this.pending = new Map()
    /**
     * 拦截轨迹（诊断用，面板可读）。
     *
     * ★ 真机上"审批没弹出"与"瀑布根本没走到我们的监听者"现象完全一样，
     *   而插件日志在 DSH 宿主里不易取。把每个分支的去向记进 state.json，
     *   一眼看出是哪一环把请求放走的（追问域同样配置，真机返工记录）。
     */
    this.trace = []
    this.domainState.approvalTrace = this.trace
    this.unsubscribes = []
    /**
     * 审批状态变化回调，由 index.js 注入（指向 StateDomain.setApproval）。
     *
     * 为什么用回调而不是让审批域直接依赖状态域：两者是**平级**的业务域，
     * 直接互相引用会形成环（状态域要读审批状态，审批域又要推状态）。
     * 由组合根注入单向回调，依赖方向始终是"审批 → 状态"。
     */
    this.onApprovalChange = null
    this.disposers = []

    this.registerProtocolHandlers()
  }

  attach(runtime, ctx) {
    this.runtime = runtime
    if (ctx && ctx !== this.ctx) {
      this.ctx = ctx
      this.subscribeApproval()
    }
  }

  registerProtocolHandlers() {
    this.disposers.push(
      this.link.onMessage(MSG.APPROVE, (message) => {
        const id = String(message.id ?? '')
        const entry = this.pending.get(id)
        if (!entry) {
          // 面板和设备可能同时作答；后到的那次是正常竞态，不是错误。
          this.logger('debug', `[approval] 收到已结束的审批决定：${id}`)
          return
        }
        const decision = message.decision === DECISION.ALLOW ? DECISION.ALLOW : DECISION.DENY
        // ★ DSH 的 ApprovalOutcome 只有 allowed-once / rejected / cancelled / unavailable，
        //   其文档明确写着 "grants apply only to the requested action" ——
        //   审批授权**按设计**只对请求的那一次操作有效。
        //   因此设备上的"总是运行"（scope=always）在 DSH 层面无法表达，
        //   到了这里只能落到 allowed-once。这里显式记一条日志，
        //   避免"用户以为设了总是允许、实际只放行一次"这种静默落差。
        // 设备端已移除"总是运行"选项（DSH 的审批授权按设计只对单次操作有效）。
        // 这里仍保留对 scope=always 的兼容处理与告警：万一有旧固件在跑，
        // 必须让"以为设了总是允许、实际只放行一次"这个落差可见，而不是静默吞掉。
        const scope = String(message.scope ?? 'once')
        if (decision === DECISION.ALLOW && scope === APPROVE_SCOPE.ALWAYS) {
          this.logger(
            'warn',
            '[approval] 收到 scope=always（旧固件），但 DSH 只支持单次授权，本次按 allowed-once 处理',
          )
        }
        this.#settle(id, decision === DECISION.ALLOW ? 'allowed-once' : 'rejected', 'device')
      }),
    )
  }

  /**
   * 订阅审批瀑布。
   *
   * `root.inject(['approval'], ...)` 只是保证服务存在；真正的事件订阅在这里，
   * 且在 ctx 就绪后才注册（否则订阅会静默失效）。
   */
  /** 记一条拦截轨迹（面板 state.json 可读）。 */
  #trace(event) {
    this.trace.push({ at: Date.now(), event })
    if (this.trace.length > 20) this.trace.shift()
  }

  subscribeApproval() {
    const ctx = this.ctx
    if (!ctx?.on) return

    for (const unsubscribe of this.unsubscribes) {
      try {
        unsubscribe()
      } catch {
        // 宿主已拆
      }
    }
    this.unsubscribes.length = 0

    // 注意：即使设备审批被关闭，**也必须注册监听者**并显式 next()。
    // 如果干脆不注册，瀑布里就少了一个 answerer；真实 DSH 在没有网页端接管时
    // 会得到 'unavailable'（fail closed），而不是我们期望的"交回电脑端处理"。
    // 关闭配置的正确语义是"永远交回下游"，不是"不参与"。
    if (!this.config.approval.enabled) {
      this.logger('info', '[approval] 设备审批已按配置关闭，请求全部交回电脑端')
    }

    this.unsubscribes.push(
      // ★ prepend: true —— 监听者按注册顺序执行，先注册的先跑，不调 next() 就
      //   截断整条链。内置网页卡片在 DSH 启动时就注册了（永远在我们前面），
      //   它一执行就把请求吃掉 —— 设备**永远**轮不到（真机返工记录："审批一直
      //   不显示"，追问同因）。插到链首后设备优先作答，next() 时才轮到网页卡片。
      ctx.on('approval/request', (req, next) => {
        this.#trace('进入瀑布')
        if (!this.config.approval.enabled) {
          this.#trace('交回：配置关闭')
          return next()
        }
        return this.#onApprovalRequest(req, next)
      }, { prepend: true }),
    )
  }

  /**
   * 审批竞速（用户决策：电脑卡片与设备**同步显示**，先答者胜）。
   *
   * 旧模型是"设备独占"：拿到请求不调 next()，自己等设备按键，只有设备没答上来
   * 才交回电脑卡片 —— 结果是串行：设备先弹，用户没按，超时后电脑卡片才出现。
   * 新模型同时开两条路：
   *   · next() 立刻跑完剩下的链 → 内置电脑卡片马上显示、等用户点；
   *   · 设备端同步弹「极短摘要 + 允许/拒绝」两个按钮。
   * 谁先给出结果谁生效，另一边由 #settle / 投影收敛收起。
   *
   * 兜底哨兵：电脑端没有回答者时，链尾兜底会返回 'unavailable'（或 undefined）。
   * 那不是用户决定，只是"电脑端没参与" —— 必须忽略它继续等设备，
   * 否则"只开设备、没开电脑"的场景会被哨兵秒杀、设备按钮形同虚设。
   */
  async #onApprovalRequest(req, next) {
    const toolName = String(req?.toolName ?? 'unknown')

    // ★ 让下游（网页审批卡片）的等待可以被我们主动结束：把 req.signal 换成
    //   可控 controller（原 signal 的中止照旧转发），设备胜出时 abort 一下，
    //   卡片才会自动收起。否则"设备批完，电脑弹窗还挂着"（真机返工记录）。
    const lifetime = new AbortController()
    const upstream = req?.signal
    if (upstream) {
      if (upstream.aborted) lifetime.abort()
      else upstream.addEventListener('abort', () => lifetime.abort(), { once: true })
    }
    if (req && typeof req === 'object') req.signal = lifetime.signal

    // ① 电脑卡片分支：同步启动（next() 必须在监听者里立刻调用，卡片才会马上显示）
    const card = this.#cardOutcome(next)

    // ② 设备分支的准入
    const enabled = Boolean(this.config.approval.enabled)
    const connected = this.link.snapshot().state === 'connected'
    const toolAllowed = !this.config.approval.readOnlyToolsOnDevice || READ_ONLY_TOOLS.has(toolName)
    if (!enabled || !connected || !toolAllowed) {
      this.#trace(`纯电脑端（${toolName}${connected ? '' : '，设备未连接'}${enabled ? '' : '，配置关闭'}）`)
      return this.#cardResult(await card)
    }

    this.#trace(`送设备作答（${toolName}）`)
    const handle = await this.#askDeviceHandle(req, toolName)

    const first = await Promise.race([
      card,
      handle.answer.then((outcome) => (outcome == null ? NEVER : { from: 'device', value: outcome })),
    ])

    if (first.from === 'device') {
      // 设备先答：结束下游 request → 网页审批卡片自动收起
      this.#trace(`设备已作答（${first.value}）`)
      lifetime.abort()
      return first.value
    }

    if (isNoAnswerer(first)) {
      // 电脑端没有回答者（没开窗口）：继续等设备，别被哨兵秒杀
      this.#trace('电脑端无回答者，继续等设备')
      const outcome = await handle.answer
      if (outcome != null) {
        this.#trace(`设备已作答（${outcome}）`)
        lifetime.abort()
        return outcome
      }
      this.#trace('设备也没答上来 → fail closed')
      return this.#cardResult(first)
    }

    // 电脑先答：收起设备审批页（#settle 会清状态、广播、并触发 APPROVE_RESULT 下发）
    this.#trace(`电脑已作答（${first.value}）`)
    this.#settle(handle.id, first.value, 'pc')
    return this.#cardResult(first)
  }

  /** 包一层电脑卡片结果：区分"用户作答/出错"与"没有回答者"。 */
  #cardOutcome(next) {
    try {
      return Promise.resolve(next()).then(
        (value) => ({ kind: 'answer', value }),
        (error) => ({ kind: 'error', error }),
      )
    } catch (error) {
      return Promise.resolve({ kind: 'error', error })
    }
  }

  #cardResult(card) {
    if (card.kind === 'error') throw card.error
    return card.value
  }

  /**
   * 把请求送到设备并等一个结果（竞速模型：电脑卡片同时在等）。
   *
   * @returns {{id: string, answer: Promise<'allowed-once'|'rejected'|'cancelled'|null>}}
   *   answer 解析为 null 表示"设备没答上来"（超时/断链/发送失败）。
   */
  async #askDeviceHandle(req, toolName) {
    const id = `ap-${Date.now().toString(36)}-${(nextRequestSeq += 1).toString(36)}`
    const timeoutMs = this.config.approval.timeoutMs
    const risk = READ_ONLY_TOOLS.has(toolName) ? 'low' : 'high'

    // 面板快照保留完整信息；**下发设备的载荷只带一行极短摘要** ——
    // 设备屏幕不再显示 toolName/reason 正文（用户决策：内容在电脑卡片上看）。
    const summary = clampSummary(toolName)
    const panelEntry = {
      id,
      toolName,
      summary,
      reason: req?.reason ?? null,
      displayReason: pickDisplayReason(req?.displayReason),
      callId: req?.callId ?? null,
      timeoutMs,
      risk,
    }
    const payload = { id, summary, risk, timeoutMs }

    const answer = new Promise((resolve) => {
      // timeoutMs = 0 → 不挂定时器：审批页一直等（用户要求）。
      // 收页仍由 approve.result（电脑端先答）/ 设备作答 / 断链 / 工具中止驱动。
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.#settle(id, 'timeout', 'timeout')
          }, timeoutMs)
        : null
      timer?.unref?.()
      this.pending.set(id, { resolve, timer, request: payload, settled: false })
    })

    // 请求方中断（用户点了停止、或上层超时）→ 我们也要立刻收手
    const onAbort = () => this.#settle(id, 'cancelled', 'abort')
    req?.signal?.addEventListener?.('abort', onAbort, { once: true })

    this.domainState.approvals = [...this.domainState.approvals, panelEntry]
    this.broadcast({ type: 'approval.asked', ...panelEntry })
    // 通知状态域：设备屏幕上进入「待审批」，并触发提示音
    this.onApprovalChange?.(toolName)
    this.logger('info', `[approval] 请求设备审批：${toolName}（${id}）`)

    try {
      await this.link.send(MSG.APPROVE_REQ, payload)
    } catch (error) {
      this.logger('warn', `[approval] 审批请求发送失败：${error.message}`)
      // ★ 请求没送到设备，就必须把状态撤回。
      //   否则设备会永远停在「待审批」，而那个界面根本没出现 ——
      //   用户看到的提示与实际能做的事完全不符，且无从恢复。
      this.onApprovalChange?.(null)
      this.#settle(id, 'send-failed', 'send-failed')
    }

    const outcome = (async () => {
      const result = await answer
      req?.signal?.removeEventListener?.('abort', onAbort)

      // 通知设备收起审批页（无论是谁决定的）
      void this.link
        .send(MSG.APPROVE_RESULT, { id, outcome: result.outcome, decidedBy: result.decidedBy }, { ack: false })
        .catch(() => {})

      if (result.outcome === 'timeout') {
        this.logger('warn', `[approval] 设备审批超时：${toolName}`)
        return null
      }
      if (result.outcome === 'cancelled') {
        // 请求方自己取消了：回 'cancelled' 而不是交回下游，
        // 因为下游再问一次也只会得到同样的取消。
        return 'cancelled'
      }
      if (result.outcome === 'send-failed') return null
      return result.outcome
    })()

    return { id, answer: outcome }
  }

  /** 结算一个待决定的请求。重复结算（设备与面板同时作答）是安全的空操作。 */
  #settle(id, outcome, decidedBy) {
    const entry = this.pending.get(id)
    if (!entry || entry.settled) return false
    entry.settled = true
    clearTimeout(entry.timer)
    this.pending.delete(id)
    this.domainState.approvals = this.domainState.approvals.filter((item) => item.id !== id)
    this.broadcast({ type: 'approval.settled', id, outcome, decidedBy })
    // 审批结束 → 设备屏幕离开「待审批」。
    // 只在没有其它挂起审批时才清空：多请求并发时，最后一个结束才算真的没了。
    if (this.pending.size === 0) this.onApprovalChange?.(null)
    entry.resolve({ outcome, decidedBy })
    return true
  }

  /**
   * 面板上直接决定（与设备等价）。
   *
   * @param {string} id
   * @param {'allow'|'deny'} decision
   */
  decide(id, decision) {
    return this.#settle(id, decision === DECISION.ALLOW ? 'allowed-once' : 'rejected', 'panel')
  }

  async dispose() {
    for (const id of [...this.pending.keys()]) {
      // 插件卸载时把所有待决定请求显式取消：留一个永远不 resolve 的 Promise
      // 会让 DSH 的那一轮对话永久挂住。
      this.#settle(id, 'cancelled', 'dispose')
    }
    for (const unsubscribe of this.unsubscribes) {
      try {
        unsubscribe()
      } catch {
        // 宿主已拆
      }
    }
    this.unsubscribes.length = 0
    for (const dispose of this.disposers) {
      try {
        dispose()
      } catch {
        // 同上
      }
    }
    this.disposers.length = 0
    this.domainState.approvals = []
  }
}

/** displayReason 是多语言对象；设备是中文界面，优先中文再退回英文。 */
function pickDisplayReason(displayReason) {
  if (!displayReason) return null
  if (typeof displayReason === 'string') return displayReason
  return displayReason.zh ?? displayReason['zh-CN'] ?? displayReason.en ?? null
}
