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

export class StateDomain {
  constructor({ link, logger, domainState }) {
    // 用 link 而不是裸 transport：发送要经过链路层（含载荷上限校验、ACK 记账、
    // 发送队列节流），直接操作 transport 会绕过这些保证。
    this.link = link
    this.domainState = domainState ?? null
    this.logger = logger ?? (() => {})
    this.ctx = null
    this.unsubscribes = []

    /** 正在运行的会话 id 集合 —— 用集合而不是计数，避免重复事件把计数搞乱。 */
    this.running = new Set()
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
          this.running.add(sessionId)
        } else {
          this.running.delete(sessionId)
        }
        this.push()
      }),
    )
  }

  #onSessionEvent(session, event) {
    const sessionId = session?.sessionId ?? session?.id ?? event?.sessionId
    if (!sessionId) return
    const kind = event?.kind ?? event?.type

    switch (kind) {
      case 'turn/start':
        this.running.add(sessionId)
        this.lastCompletedTitle = ''
        this.push()
        break
      case 'turn/end': {
        this.running.delete(sessionId)
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

  /** 按优先级算出当前状态。 */
  current() {
    if (this.approvalTitle) {
      return { state: TASK_STATE.WAITING_APPROVAL, title: this.approvalTitle }
    }
    if (this.running.size > 0) {
      return { state: TASK_STATE.RUNNING, title: `${this.running.size} 个任务执行中` }
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
    const { state, title } = this.current()
    if (!options.force && state === this.lastSent) return
    this.lastSent = state
    // 同步给面板快照：面板与设备显示的必须是**同一个**状态，
    // 否则用户在两边看到不一致时会怀疑哪边是真的。
    if (this.domainState) this.domainState.taskState = { state, title, at: Date.now() }
    // 不 await：状态推送是尽力而为的通知，调用方（事件回调）不该被网络耗时阻塞。
    // ACK 由链路层负责，失败只记一条 debug 日志。
    void this.link
      .send(MSG.TASK_STATE, { state, title })
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
