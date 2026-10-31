/**
 * 任务状态聚合域（精简版）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  与旧版 tasks.js 的根本差别
 * ══════════════════════════════════════════════════════════════════════════
 *  旧版把**任务列表**下发到设备：每条会话一个条目，设备端有列表 UI、详情页、
 *  选中项与滚动。实际使用确认：240×320 上列表"既看不全也读不快"，
 *  而用户真正需要的是"现在要不要我管一下"。
 *
 *  因此这里只做一件事：把"当前整体处于什么状态"聚合出来推给设备。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么状态必须在主机侧聚合，而不是让设备自己判断
 * ══════════════════════════════════════════════════════════════════════════
 *  判断"当前状态"需要同时知道：有几个会话在跑、有没有审批挂起、刚才是否结束。
 *  这些信息只有主机侧完整。设备端猜出来的状态一定会与主机不一致，
 *  而**一个会撒谎的状态指示器比没有更糟** —— 用户会照着它做决定。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  状态优先级
 * ══════════════════════════════════════════════════════════════════════════
 *      待审批  >  运行中  >  已完成（短暂停留）  >  空闲
 *
 *  「待审批」优先级最高：它在等一个**人**的动作，其它状态都只是信息。
 *  「已完成」只在结束后停留几秒，然后回到空闲 —— 否则设备会永远显示"已完成"，
 *  那个状态就失去了"刚刚发生"的含义。
 *
 *  设计取舍：**只在状态真正变化时推送**。设备屏幕小、BLE 带宽有限，
 *  而且设备端是靠"状态变化"来决定是否响提示音的 —— 重复推送同一状态
 *  会让设备反复响铃，用户很快就会把提示音关掉。
 */

import { MSG, TASK_STATE } from '../protocol/constants.js'

/** 「已完成」在屏幕上停留的时长，之后回落到「空闲」。 */
const COMPLETED_LINGER_MS = 8000

/**
 * 「不忙」持续多久才算真的结束。
 *
 * ★ 这里走过一次弯路，记下来免得再犯：
 *   一度以为这台 DSH「没有 `turn/end`」，于是把 status(false) 当唯一结束信号，
 *   并把它改成"false 不结束"—— 结果任务结束后设备一直挂「运行中」。
 *   真因不在 DSH：`stateTrace` 只留 12 条，我看的时候任务还没结束，
 *   环里自然只有 step/tool/job。把环撑大后 `turn/end` 清清楚楚躺在那儿
 *   （13:46:17.532 turn/end → .541 status:idle）。
 *   **环形缓冲的窗口长度会伪造出"事件不存在"的结论。**
 *
 * 因此结束有两条路，谁先到谁算：
 *   ① `turn/end` —— 真实终点，立即进「已完成」；
 *   ② `api-session/status` 的 false —— 兜底。它不能当即当真：工具调用之间
 *      可能闪一下 false，当真就会把运行中打回空闲、把计时锚点清掉。
 *      故先记时刻并起短定时器，IDLE_END_MS 之后仍然不忙才判定结束。
 *
 * 闪断被吸收，没有 turn/end 的宿主最多晚 1.2 秒可见。
 */
const IDLE_END_MS = 1200

/** `stateTrace` 保留的条目数。太小会把整轮生命周期挤掉（上面那条弯路的起因）。 */
const TRACE_LIMIT = 40

/** `turnTrace` 保留的边界条数。只记 turn/status，噪声为零，可一眼看完整轮次。 */
const TURN_TRACE_LIMIT = 20

export class StateDomain {
  constructor({ link, logger, domainState, idleEndMs = IDLE_END_MS }) {
    // 用 link 而不是裸 transport：发送要经过链路层（含载荷上限校验、ACK 记账、
    // 发送队列节流），直接操作 transport 会绕过这些保证。
    this.link = link
    this.domainState = domainState ?? null
    this.logger = logger ?? (() => {})
    this.ctx = null
    this.unsubscribes = []
    /** 「不忙」判定窗口。测试里调小，避免等真实时间。 */
    this.idleEndMs = idleEndMs
    this.idleTimer = null

    /** 正在运行的会话 id 集合 —— 用集合而不是计数，避免重复事件把计数搞乱。 */
    this.running = new Set()
    /**
     * 运行中会话的起点表：sessionId → { at, reliable }。
     *
     * ★ 为什么起点的"可靠"要单独记（reliable）：
     *   真实起点只有 `turn/start` 能给。而插件可能在任务跑了一半才启动
     *   （DSH 重启、插件热重载），此时只能靠 `api-session/status(true)` 的
     *   首次观察到点 —— 那是"我看见它时"而不是"它开始时"。把两者混为一谈，
     *   设备上就会显示一个偏小的时长，看起来精确、其实是错的。
     *   因此不可靠的起点会在设备端显示成「≥ MM:SS」。
     *
     * ★ 为什么不跟链路一起清空：
     *   断线期间任务仍在电脑上跑，起点依然有效；清掉会让重连后的计时
     *   从零重来（这正是"掉线一分钟，时长少一分钟"的来源）。
     *   只有插件卸载（detach）才清。
     */
    this.runStarts = new Map()
    /** 当前是否有审批挂起（由 ApprovalDomain 通过 setApproval 告知）。 */
    this.approvalTitle = null
    /** 最近一次结束的会话标题，用于「已完成」状态下的补充说明。 */
    this.lastCompletedTitle = ''
    /** 「已完成」状态的到期时间戳。 */
    this.completedUntil = 0
    this.completedTimer = null
    /** 最近一次推送出去的状态，用于去重。 */
    this.lastSent = null
    /**
     * ★ 设备是否正在录音（PTT 按住说话）。
     *
     * 录音期间**不能**推送 task.state —— 否则"已完成→空闲"的回落定时器
     * （COMPLETED_LINGER_MS=8 秒）会在用户说话时把状态打回"空闲"，
     * 表现为"按住说话 2-3 秒后界面突然跳到空闲"（真机返工记录）。
     *
     * 录音状态由 VoiceDomain 通过 setDeviceRecording() 告知：
     *   voice.begin → true；voice.end → false。
     */
    this.deviceRecording = false
  }

  attach(runtime, ctx) {
    this.ctx = ctx
    this.#subscribe()
    // 首次连上时把当前状态补推一次：设备可能在链路建立前就已就绪，
    // 若此时没有任何状态变化，它会一直停在默认的「空闲」。
    this.push({ force: true })
  }

  detach() {
    for (const unsubscribe of this.unsubscribes) {
      try {
        unsubscribe()
      } catch {
        // 宿主已经拆掉
      }
    }
    this.unsubscribes.length = 0
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    // 起点表只在这里清：插件卸载意味着"观察终止"，重新加载时按首次观察重算。
    this.runStarts.clear()
    this.running.clear()
    if (this.completedTimer) {
      clearTimeout(this.completedTimer)
      this.completedTimer = null
    }
    // ★ 断链/重连后必须清掉录音标志：否则 voice.end 没来得及到达（掉线时），
    //   deviceRecording 卡在 true，此后所有 task.state 推送都被抑制，
    //   设备界面永远停在旧状态上（真机返工记录）。
    this.deviceRecording = false
  }

  #subscribe() {
    const ctx = this.ctx
    if (!ctx?.on) {
      this.logger('warn', '[state] 宿主上下文不可用，任务状态将不会自动更新')
      return
    }

    // session/event 覆盖**所有**会话，因此用户在电脑上直接发起的对话
    // 也会反映到设备上，而不只是设备发起的那些。
    this.unsubscribes.push(
      ctx.on('session/event', (session, event) => {
        try {
          this.#onSessionEvent(session, event)
        } catch (error) {
          this.logger('debug', `[state] 处理会话事件失败：${error?.message ?? error}`)
        }
      }),
    )

    this.unsubscribes.push(
      ctx.on('api-session/status', (sessionId, running) => {
        if (running) {
          this.#trace('status:run', sessionId)
          this.#traceTurn('status:run', sessionId)
          this.running.add(sessionId)
          // 与 turn/start 重复到达是常态（真实 DSH 两条都会发）：
          // 已有记录就保留，绝不因为后到的 status 把 reliable 降级或把起点推后。
          this.#markStart(sessionId, false)
        } else {
          this.#trace('status:idle', sessionId)
          this.#traceTurn('status:idle', sessionId)
          // 不立刻结束：先记时刻 + 起短定时器（见 IDLE_END_MS 的说明）。
          // 闪断被吸收，真结束在 idleEndMs 后判定。
          this.#markIdle(sessionId)
        }
        this.push()
      }),
    )
  }

  #onSessionEvent(session, event) {
    const sessionId = session?.sessionId ?? session?.id ?? event?.sessionId
    if (!sessionId) return
    const kind = event?.kind ?? event?.type
    this.#trace(`event:${kind}`, sessionId)

    switch (kind) {
      case 'turn/start':
        this.#traceTurn('turn/start', sessionId)
        this.running.add(sessionId)
        // 真实起点：这条事件只在轮次真正开始时发，可靠。
        this.#markStart(sessionId, true)
        this.lastCompletedTitle = ''
        this.push()
        break
      case 'turn/end': {
        this.#traceTurn('turn/end', sessionId)
        this.running.delete(sessionId)
        this.runStarts.delete(sessionId)
        // 记下刚结束的会话标题，让「已完成」那一行能说清是哪个任务。
        // 标题可能出现在三个位置：事件里的 session 快照、projections、或只有 id
        // （此时退回会话控制器查一次）。DSH 各版本给的事件形状不完全一致，
        // 逐个兜底比假设某一种更稳。
        const inline = session?.title ?? session?.projections?.title ?? ''
        if (inline) {
          this.lastCompletedTitle = String(inline).slice(0, 32)
          this.#markCompleted()
        } else {
          // 事件没带标题：先按"任务刚刚结束"显示，查到标题后再补推一次。
          this.lastCompletedTitle = ''
          this.#markCompleted()
          void this.#lookupTitle(sessionId).then((title) => {
            if (title && Date.now() < this.completedUntil) {
              this.lastCompletedTitle = String(title).slice(0, 32)
              this.push({ force: true })
            }
          })
        }
        break
      }
      default:
        // 其余事件（step/tool/…）不影响整体状态，不推送 ——
        // 这正是旧版"每次工具调用都推一条"导致 BLE 流量偏高的原因。
        break
    }
  }

  #markCompleted() {
    this.completedUntil = Date.now() + COMPLETED_LINGER_MS
    if (this.completedTimer) clearTimeout(this.completedTimer)
    // 停留期结束后回落。用定时器而不是在每次 push 时比较时间戳：
    // 后者在没有新事件时永远不会触发，设备会一直停在「已完成」。
    //
    // ★ 定时器触发时**再查一次 deviceRecording**：定时器可能是录音开始前
    //   设定的（上一个任务完成时），8 秒后用户正在按住说话 —— 此时若不查，
    //   push() 会把 idle 发下去覆盖录音显示（真机返工记录的"第三秒跳空闲"，
    //   实际是"按下前 5 秒完成的任务，8 秒定时器在按下后 3 秒触发"）。
    //   push() 内部也有 deviceRecording 守卫，这里显式跳过更清晰。
    this.completedTimer = setTimeout(() => {
      this.completedTimer = null
      if (!this.deviceRecording) this.push()
      // 录音中就跳过；录音结束时 setDeviceRecording(false) 会补推一次。
    }, COMPLETED_LINGER_MS + 50)
    this.push()
  }

  /**
   * 审批状态变化。由 ApprovalDomain 在收到审批请求 / 结束时调用。
   *
   * `title` 非空表示有审批挂起；传 null 表示审批已结束。
   */
  setApproval(title) {
    const next = title ? String(title).slice(0, 32) : null
    if (this.approvalTitle === next) return
    this.approvalTitle = next
    this.push()
  }

  /**
   * 从会话控制器查标题（事件里没带标题时的兜底）。
   *
   * 两个必须注意的点：
   *   ① `list()` 是 **async**，返回 Promise —— 同步取字段会得到 undefined。
   *   ② 它返回 `{items: [...]}` 而不是裸数组。
   *   因此这里做成异步：拿到后补推一次状态，让标题在稍后一点出现，
   *   总好过永远显示"任务刚刚结束"这种泛泛的文案。
   */
  async #lookupTitle(sessionId) {
    try {
      const controller = typeof this.ctx?.get === 'function' ? this.ctx.get('sessionController') : null
      if (!controller?.list) return ''
      const result = await controller.list({})
      const items = Array.isArray(result) ? result : (result?.items ?? [])
      const summary = items.find((item) => item.sessionId === sessionId)
      return summary?.title ?? summary?.projections?.title ?? ''
    } catch {
      return ''
    }
  }

  /**
   * 记录会话起点。已存在就保留 —— 先到的那条更接近真实开始。
   *
   * 只有 `turn/start` 能把 reliable 从 false 提升到 true（它是唯一的真实起点）；
   * 反向（true → false）永远不允许，否则"明明知道真实起点"会被后到的
   * `api-session/status` 降级成「≥」。
   */
  /**
   * 记一条事件轨迹（真机排障用，随 state.json 一起暴露）。
   *
   * 计时这条链路上「设备显示什么」和「主机收到什么」隔着 BLE，光看结果只能猜。
   * 保留最近 TRACE_LIMIT 条事件，就能看出 DSH 发了哪些事件、
   * status 是不是成对刷 —— 比反复重启试错快得多。
   *
   * ★ 限度别调小：窗口盖不住一整轮时，看不到的事件会被误判成"不存在"。
   */
  #trace(kind, id) {
    if (!this.domainState) return
    const list = this.domainState.stateTrace ?? (this.domainState.stateTrace = [])
    list.push({ t: Date.now(), k: kind, id: String(id ?? '') })
    if (list.length > TRACE_LIMIT) list.splice(0, list.length - TRACE_LIMIT)
  }

  /**
   * 记一条**轮次边界**（turn/start、turn/end、status:run、status:idle）。
   *
   * 与 #trace 分开的理由：一轮里 step/tool/job 能刷几十条，把边界信息淹掉。
   * 边界单独一条链，长度就够覆盖好几轮，排查"起点从哪来、结束判没判"时
   * 一眼就能看完整，不必再靠 BLE 另一头猜。
   */
  #traceTurn(kind, id) {
    if (!this.domainState) return
    const list = this.domainState.turnTrace ?? (this.domainState.turnTrace = [])
    list.push({ t: Date.now(), k: kind, id: String(id ?? '') })
    if (list.length > TURN_TRACE_LIMIT) list.splice(0, list.length - TURN_TRACE_LIMIT)
  }

  #markStart(sessionId, reliable) {
    const existing = this.runStarts.get(sessionId)
    if (existing) {
      if (reliable) existing.reliable = true
      existing.idleAt = 0   // 又跑起来了，静默计时作废
      return
    }
    this.runStarts.set(sessionId, { at: Date.now(), reliable: Boolean(reliable), idleAt: 0 })
  }

  /**
   * 记下「这一刻它不忙」，并在 idleEndMs 后复查。
   *
   * 只打时间戳、不当即删记录：false 可能只是工具调用之间的空隙，
   * 当即删掉就会把起点推到下一次 true，计时从 0 重来。
   */
  #markIdle(sessionId) {
    const record = this.runStarts.get(sessionId)
    if (!record) return
    if (!record.idleAt) record.idleAt = Date.now()
    if (this.idleTimer) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.#pruneIdle()) this.push()
    }, this.idleEndMs)
    this.idleTimer.unref?.()   // 定时器不该拖住宿主退出
  }

  /**
   * 摘掉「不忙」已超过 idleEndMs 的会话 —— 这才是真正的结束。
   *
   * @returns {boolean} 是否真的摘掉了 —— 摘了说明状态要重推
   */
  #pruneIdle() {
    const now = Date.now()
    let changed = false
    for (const [sessionId, record] of this.runStarts) {
      if (!record.idleAt || now - record.idleAt < this.idleEndMs) continue
      this.runStarts.delete(sessionId)
      this.running.delete(sessionId)
      // 结束后走「已完成」停留，让用户看到结果而不是瞬间跳回空闲
      this.completedUntil = now + COMPLETED_LINGER_MS
      changed = true
    }
    return changed
  }

  /**
   * 当前这一轮忙碌的已运行时长。
   *
   * 取**最早开始**的那个会话：单会话时就是该任务时长；多会话时表达
   * "这轮忙了多久"，与标题「N 个任务执行中」说的是同一件事。
   */
  #elapsed() {
    if (this.running.size === 0) return { elapsedMs: null, sinceReliable: false }
    let earliest = null
    for (const sessionId of this.running) {
      const record = this.runStarts.get(sessionId)
      if (!record) continue
      if (!earliest || record.at < earliest.at) earliest = record
    }
    if (!earliest) return { elapsedMs: null, sinceReliable: false }

    // ★ 起点不可靠就**不下发** elapsedMs（设备因此不显示计时）。
    //
    //   不可靠 = 我们这个起点是「第一次看见它在跑」，真实开始时间更早，
    //   于是 elapsedMs 会系统性偏小。设备端按设计稿只印纯 `MM:SS`，
    //   没有任何位置再加 `~` 说明"这是近似值" —— 一个精确到秒却偏小的数字，
    //   比不显示更容易误导（会撒谎的指示器比没有更糟）。
    //
    //   触发场景很少：插件在会话已经开始执行之后才启动、或从未收到过
    //   该会话的 turn/start。此时等下一次 turn/start 就能恢复显示。
    if (!earliest.reliable) return { elapsedMs: null, sinceReliable: false }

    return {
      elapsedMs: Math.max(0, Date.now() - earliest.at),
      sinceReliable: true,
    }
  }

  /** 按优先级算出当前状态。 */
  current() {
    // 静默太久的会话在这里摘掉（turn/end 缺失时的兜底）。
    this.#pruneIdle()
    if (this.approvalTitle) {
      return { state: TASK_STATE.WAITING_APPROVAL, title: this.approvalTitle }
    }
    if (this.running.size > 0) {
      const { elapsedMs, sinceReliable } = this.#elapsed()
      // 待审批时不计时显示（审批页有自己的内容），但锚点保留：
      // 审批结束回到「运行中」时，时长接着走，而不是从零开始。
      return { state: TASK_STATE.RUNNING, title: `${this.running.size} 个任务执行中`, elapsedMs, sinceReliable }
    }
    if (Date.now() < this.completedUntil) {
      return { state: TASK_STATE.COMPLETED, title: this.lastCompletedTitle || '任务刚刚结束' }
    }
    return { state: TASK_STATE.IDLE, title: '' }
  }

  /**
   * 设备录音状态变化。由 VoiceDomain 在 voice.begin/voice.end 时调用。
   *
   * 录音结束时**补推一次**当前状态：录音期间被抑制的推送要补回来，
   * 否则设备会停在旧状态上（比如录音前是"已完成"，录完还一直显示"已完成"）。
   */
  setDeviceRecording(recording) {
    const next = Boolean(recording)
    if (this.deviceRecording === next) return
    this.deviceRecording = next
    if (!next) {
      // 录音刚结束：补推一次（不清 lastSent，让去重生效 —— 状态没变就不刷屏）
      this.push()
    }
  }

  /**
   * 把当前状态下发给设备。
   *
   * @param {{force?: boolean}} [options] force=true 时跳过去重（链路刚建立时用）
   */
  push(options = {}) {
    // ★ 录音期间抑制状态推送（见 setDeviceRecording 的说明）。
    //   force 也一样抑制：链路重连时补推状态会打断录音显示，同样不能放。
    if (this.deviceRecording) return
    if (this.link.snapshot().state !== 'connected') return
    const { state, title, elapsedMs, sinceReliable } = this.current()

    // 去重键 = 状态 + 标题 + 时长的秒数。
    //
    // ★ 为什么不再只比 state：
    //   ① 任务数从 1 变 2 时状态仍是 running，标题该变却被吞掉
    //      （原实现的实际问题，用户在设备上看到的一直是"1 个任务执行中"）；
    //   ② 起点表变化（最早那个任务结束）会让时长基准前移，也要重播一次
    //      种子，否则设备会带着旧锚点一直走下去。
    //   这里不比较毫秒、只比较秒：同一秒内的重复事件仍然被合并。
    //
    //   ★ 与"起点不可靠就不下发"互补的一处细节：没有种子时签名不带秒数
    //     （`running|1 个任务执行中`），一旦 `turn/start` 把起点升级为可靠、
    //     签名变成 `…|3`，两者必然不同 —— 所以那次"补种子"不会被去重吞掉。
    //     反过来（先可靠、后不可靠）不会发生：`#markStart` 只升不降。
    const signature = elapsedMs == null
      ? `${state}|${title}`
      : `${state}|${title}|${Math.floor(elapsedMs / 1000)}`
    if (!options.force && signature === this.lastSent) return
    this.lastSent = signature

    // 同步给面板快照：面板与设备显示的必须是**同一个**状态，
    // 否则用户在两边看到不一致时会怀疑哪边是真的。
    const payload = { state, title }
    if (elapsedMs != null) {
      payload.elapsedMs = elapsedMs
      payload.sinceReliable = sinceReliable
    }
    // 设备没有 RTC：状态条上那个 HH:MM 只能由主机给。
    // ★ 发「UTC 秒 + 时区偏移分钟」而不是格式化好的 "20:17"：
    //   设备自己走秒，字符串一过时就是错的；给种子则设备能一直算下去。
    //   也不发毫秒 —— 固件侧 `long` 只有 32 位，秒级够用且不会在 2038 前溢出。
    payload.hostEpochSec = Math.floor(Date.now() / 1000)
    payload.hostTzOffsetMin = -new Date().getTimezoneOffset()
    if (this.domainState) {
      this.domainState.taskState = {
        state,
        title,
        at: Date.now(),
        hostEpochSec: payload.hostEpochSec,
        hostTzOffsetMin: payload.hostTzOffsetMin,
        ...(elapsedMs != null ? { elapsedMs, sinceReliable } : {}),
      }
    }
    // 不 await：状态推送是尽力而为的通知，调用方（事件回调）不该被网络耗时阻塞。
    // ACK 由链路层负责，失败只记一条 debug 日志。
    void this.link
      .send(MSG.TASK_STATE, payload)
      .catch((error) => this.logger('debug', `[state] 状态下发失败：${error?.message ?? error}`))
  }

  /** 链路重新就绪时调用：清掉去重记忆并补推一次。 */
  onLinkReady() {
    this.lastSent = null
    // ★ 不清 deviceRecording：这个标志只由 voice.begin/voice.end 控制。
    //   清它的唯一合理时机是**真正断链**（见 onLinkReset / detach）。
    //   若在这里清，设备重发 hello（订阅事件重放、心跳后重新握手）就会
    //   在用户还在按着说话时把抑制解除，随后"已完成→空闲"的回落定时器
    //   立刻把状态打回空闲 —— 真机返工记录的"说到一半跳空闲"就是这么来的。
    this.push({ force: true })
  }

  /**
   * 链路真正断开/重连时调用（不是 hello.ack 重握手）。
   *
   * 掉线时 voice.end 可能没到达，deviceRecording 会卡在 true，
   * 把后续所有 task.state 推送都吞掉 —— 必须显式清掉。
   */
  onLinkReset() {
    this.deviceRecording = false
  }

  snapshot() {
    const { state, title } = this.current()
    return { state, title, runningCount: this.running.size, approval: this.approvalTitle }
  }
}
