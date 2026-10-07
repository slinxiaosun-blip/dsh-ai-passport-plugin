/**
 * 追问域：把 DSH 的 `ask_user_question`（含计划评审）搬到设备按键上作答。
 *
 * 设计见 docs/06 §3/§4。核心决定：
 *
 *   1. **主机持有整批真相，设备一次只显示一题**。
 *      2048B 载荷 + 400KB SRAM + 11 字/行的硬约束下，整批问题不可能一次下发；
 *      设备每次勾选回发 `question.pick`，主机累计，最后主机组装完整 answers
 *      过瀑布返回（DSH 要求一批答案恰好覆盖每道题，缺项报 BAD_ANSWER）。
 *
 *   2. **任何异常都交回电脑端**（超时 / 断链 / 用户取消 / 重复请求）：
 *      与审批域同一条原则——设备无响应绝不悬挂，更不替用户猜答案。
 *
 *   3. **计划评审是带 intent 的问题**，不是独立消息类型（DSH 的数据形状如此）。
 *      `intent.kind==='plan-review'` 的题走 `kind:'plan'` 下发；设备上
 *      「批准」= 以 intent.approve 作答，「要求修改」= 交回取消（ASK_CANCELLED），
 *      **不能**当成普通选项选进答案（docs/06 §1.3 的语义陷阱）。
 *
 *   4. **计划正文不上设备**（2026-10-06 改版）：设备只显示一行摘要 + 按钮，
 *      全文留在电脑卡片（此前的主机分页方案已随"设备端查看全文"一并删除）。
 */

import { MSG } from '../protocol/constants.js'

/**
 * 单条 question.req 的载荷预算。
 *
 * 设备端下行队列的单条 JSON 上限是 APP_MSG_MAX_LEN=1024 字节（app.c），
 * 而题干/详情/选项文案都可能很长（计划评审的 detail 是整个计划正文）。
 * 超预算的字段按字符截断（CJK 3 字节/字，预算按字节算够用）。
 */
const BUDGET = {
  // ★ 设备端只显示**一行极短摘要**（正文都在电脑卡片上看，用户决策 2026-10-06）：
  //   屏幕小、长文本读不动，设备退化成"实体遥控器"最合适。
  summaryChars: 12,
  optionLabelChars: 10,   // 行宽约 10 个汉字，超出截断
  maxOptions: 5,
}

function clampText(value, maxChars) {
  const text = String(value ?? '')
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

/** 首选项预选语义（对齐 DSH："Recommended" 首选项以草稿态预选）。 */
function isRecommended(option) {
  const description = String(option?.description ?? '')
  return description.includes('Recommended') || description.includes('推荐')
}

function normalizeQuestions(request) {
  const raw = Array.isArray(request?.questions) ? request.questions : []
  return raw
    .filter((question) => question && typeof question.id === 'string')
    .map((question) => ({
      id: question.id,
      question: String(question.question ?? ''),
      detail: question.detail != null ? String(question.detail) : '',
      multiSelect: Boolean(question.multiSelect),
      intent: question.intent ?? null,
      options: (Array.isArray(question.options) ? question.options : []).map((option) => ({
        label: String(option?.label ?? ''),
        description: String(option?.description ?? ''),
        recommended: isRecommended(option),
      })),
    }))
}

function extractCallId(request) {
  const direct = request?.callId ?? request?.wait?.callId ?? request?.toolCallId
  if (direct != null && String(direct)) return String(direct)
  // 无名请求用时间戳相关 id：只做设备与主机之间的对账，不进 DSH 的记录
  return `q-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`
}

/**
 * 「要求修改」的拒绝错误（ASK_CANCELLED）。
 *
 * ★ 语义出处（docs/06 §1.3）：官方计划评审卡片的 "Request changes" **不作答**，
 *   而是把等待拒绝成 ASK_CANCELLED，把用户带回输入框写修改意见。
 *   DSH 的 `ask()` 在 catch 里用 `restoreUserQuestionError` 恢复
 *   `{name:'UserQuestionError', message, code}` 形状的错误并原样抛出 ——
 *   因此宿主瀑布的 answerer 抛这个形状即可复刻"拒绝等待"，不必绕道电脑端。
 */
function rejectedQuestionError(message = 'the user requested changes') {
  const error = new Error(message)
  error.name = 'UserQuestionError'
  error.code = 'ASK_CANCELLED'
  return error
}

/** 永不解析的 Promise：竞速里表示"这条支线不再参与"（设备取消/超时后只等电脑）。 */
const NEVER = new Promise(() => {})

/** 电脑端"没有回答者"的哨兵：追问链尾兜底会抛 NO_PROVIDER，那不是用户决定。 */
function isNoAnswerer(card) {
  if (card.kind === 'answer') return card.value === undefined
  return card.error?.code === 'NO_PROVIDER'
}

/** 计时追问里，给卡片"报告 ASK_TIMED_OUT"的宽限窗口（见 #startDeviceBatch 的 abort 说明）。 */
const CONTINUED_GRACE_MS = 300

/** 卡片是以"倒计时结束"收场的吗？（askTimed 的既定语义，此时问题变为可补答） */
function isTimedOutCard(card) {
  return card.kind === 'error' && card.error?.code === 'ASK_TIMED_OUT'
}

/** 极短摘要：设备只显示一行，超长截断（正文都在电脑卡片上）。 */
function clampSummary(text, maxChars) {
  const value = String(text ?? '')
  const max = maxChars ?? BUDGET.summaryChars
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

export class QuestionsDomain {
  constructor(shared) {
    this.link = shared.link
    this.config = shared.config
    this.logger = shared.logger
    this.broadcast = shared.broadcast
    this.domainState = shared.domainState
    this.ctx = null
    this.unsubscribes = []
    this.disposers = []

    /** 当前送到设备上的那一批（一次只接一批：设备同一时刻只显示一个覆盖页）。 */
    this.pending = null

    /**
     * 拦截轨迹（诊断用，面板可读）。
     *
     * ★ 真机上"题目没到设备"与"瀑布根本没走到我们"现象完全一样，
     *   而插件日志在 DSH 宿主里不易取。把每个分支的去向记进 state.json，
     *   一眼就能看出是哪一环把请求放走的（真机排障的"先建立观测点"原则）。
     */
    this.trace = []
    this.domainState.questionsTrace = this.trace

    this.disposers.push(
      this.link.onMessage(MSG.QUESTION_NAV, (message) => this.#onNav(message)),
      this.link.onMessage(MSG.QUESTION_PICK, (message) => this.#onPick(message)),
      this.link.onMessage(MSG.QUESTION_ANSWER, (message) => this.#onAnswer(message)),
    )
  }

  attach(runtime, ctx) {
    this.ctx = ctx
    if (!ctx?.on) {
      this.logger('warn', '[questions] 宿主上下文不可用，追问不会送到设备')
      return
    }

    // ★ 即使设备追问被关闭，也必须注册监听者：少一个 answerer，真实 DSH 在
    //   没有网页端接管时会 fail closed 成"没有可用回答者"（审批域同款教训）。
    //   prepend 插到链首，才能与网页卡片**同时**开跑（竞速，见 #onAsk）。
    this.unsubscribes.push(
      ctx.on('user-questions/request', (request, next) => {
        this.#trace('进入瀑布')
        return this.#onAsk(request, next)
      }, { prepend: true }),
    )

    // 掉线时设备分支立刻退出（电脑卡片不受影响）
    const onDisconnected = () => this.#cancelDevice('disconnected')
    this.link.on('disconnected', onDisconnected)
    this.unsubscribes.push(() => this.link.off?.('disconnected', onDisconnected))
  }

  /** 记一条拦截轨迹（面板 state.json 可读）。 */
  #trace(event) {
    this.trace.push({ at: Date.now(), event })
    if (this.trace.length > 20) this.trace.shift()
  }

  /** 面板快照：当前有没有问题在设备上等着。 */
  snapshot() {
    if (!this.pending) return null
    return {
      callId: this.pending.callId,
      kind: this.pending.kind,
      index: this.pending.index,
      total: this.pending.questions.length,
    }
  }

  async dispose() {
    this.#cancelDevice('disposed')
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
        // 链路已关
      }
    }
    this.disposers.length = 0
  }

  // ── 瀑布 ────────────────────────────────────────────────────────────────

  /**
   * 竞速：电脑卡片立刻显示 + 设备同步显示快捷按钮，先答者胜。
   *
   * 与审批域同款（见 approval.js #onApprovalRequest 的详细说明）：
   * 旧模型是设备独占（不调 next()，设备不答才交回电脑卡片）→ 串行；
   * 新模型两条路同时跑，谁先给出结果谁生效，另一边收起。
   *
   * 哨兵：电脑端没有回答者时链尾抛 NO_PROVIDER —— 不是用户决定，
   * 必须忽略它继续等设备（否则"只开设备"的场景按钮形同虚设）。
   */
  async #onAsk(request, next) {
    // ★ 让下游（网页卡片）的等待可以被我们主动结束。
    //
    // 客户端卡片用 `request.signal` 作为等待的生命周期（answerQuestion 里
    // `AbortSignal.any([claimLifetime.signal, request.signal])`），而且只有
    // "request 结束 + 投影不再列它"时才会移除卡片。竞速里我们抢先返回（设备先答）
    // 会让下游那条 request 永远挂着 —— 现象就是"设备答完了，电脑卡片不消失"
    // （真机返工记录）。把 signal 换成我们可控的 controller（原 signal 的中止
    // 仍然转发过去），设备胜出时 abort 一下，卡片即可自动收起。
    const lifetime = new AbortController()
    const upstream = request?.signal
    if (upstream) {
      if (upstream.aborted) lifetime.abort()
      else upstream.addEventListener('abort', () => lifetime.abort(), { once: true })
    }
    if (request && typeof request === 'object') request.signal = lifetime.signal

    const card = this.#cardOutcome(next)

    const eligible = this.config.questions?.enabled !== false
      && this.link.snapshot().state === 'connected'
      && !this.pending
    const questions = eligible ? normalizeQuestions(request) : []
    if (!eligible || questions.length === 0) {
      this.#trace(`纯电脑端（${eligible ? '空问题' : '设备未连接/配置关闭/已有批次'}）`)
      return this.#cardResult(await card)
    }

    this.#trace('送设备作答')
    const device = this.#startDeviceBatch(request, questions)
    const first = await Promise.race([
      card,
      device.then((result) => (result == null ? NEVER : result)),
    ])

    if (first.kind === 'reject') {
      // 「要求修改」：拒绝等待（ASK_CANCELLED），与官方卡片 Request changes 同语义
      this.#cancelDevice('device-reject')
      lifetime.abort()   // 下游卡片随之收起
      throw first.error
    }
    if (first.from === 'device') {
      this.#trace('设备已作答')
      lifetime.abort()   // 结束下游 request → 网页卡片自动收起
      return first.value
    }
    if (isNoAnswerer(first)) {
      this.#trace('电脑端无回答者，继续等设备')
      const result = await device
      if (result?.kind === 'reject') {
        this.#cancelDevice('device-reject')
        lifetime.abort()
        throw result.error
      }
      if (result?.kind === 'answer') {
        this.#trace('设备已作答')
        lifetime.abort()   // 结束下游 request → 网页卡片自动收起
        return result.value
      }
      return this.#cardResult(first)
    }

    // ④ 计时追问：卡片倒计时结束后，问题变成"继续追问"（continued），
    //    官方补答通道（userQuestions.answer）仍然开着 —— 设备端不该跟着失效。
    //    这里不立刻收设备页，而是等设备作答后经该通道投递。
    if (isTimedOutCard(first) && this.#markContinued(request)) {
      this.#trace('计时追问：保留设备页等待补答')
      await this.#deliverContinued(request, device)
      // ★ 无论补答成败，本次瀑布**仍以原来的 ASK_TIMED_OUT 结束**：
      //   工具侧语义保持"pending"（答案之后作为一条 user 消息进入会话），
      //   绝不把迟到答案当成瀑布返回值 —— 那会和 askTimed 的既定语义打架。
      return this.#cardResult(first)
    }

    this.#trace(first.kind === 'error' ? `电脑端报错（${first.error?.code ?? 'error'}）` : '电脑端已作答')
    this.#cancelDevice(first.kind === 'error' ? 'timed-out' : 'answered-on-pc')
    return this.#cardResult(first)
  }

  /**
   * 把设备批次标记为"继续追问"状态（可补答）。
   *
   * @returns {boolean} true 表示已进入补答窗口，设备页继续显示。
   */
  #markContinued(request) {
    const pending = this.pending
    if (!pending || pending.settled) return false
    const wait = request?.wait
    const callId = typeof wait?.callId === 'string' ? wait.callId : ''
    // 只有计时请求才可能"继续"：没有 wait.callId 就没有补答通道可用
    if (wait?.timed !== true || !callId) {
      this.#trace('计时追问：缺少 wait.callId，无法补答')
      return false
    }
    pending.continued = true
    pending.waitCallId = callId
    pending.agent = request?.agent ?? null
    // 中止信号在这里是**歧义**的（工具被取消 / 倒计时结束都会中止），
    // 所以宽限窗口内先别急着收页：等卡片报出具体原因（ASK_TIMED_OUT = 继续追问）。
    if (pending.abortTimer) {
      clearTimeout(pending.abortTimer)
      pending.abortTimer = null
    }
    if (pending.timer) clearTimeout(pending.timer)
    // 不设超时的批次（计划待审）继续不设：补答窗口也不该自己关。
    const timeoutMs = pending.timeoutMs > 0 ? (this.config.questions?.timeoutMs ?? 120_000) : 0
    pending.timeoutMs = timeoutMs
    pending.startedAt = Date.now()
    pending.timer = timeoutMs > 0 ? setTimeout(() => this.#cancelDevice('timeout'), timeoutMs) : null
    this.#trace('计时追问：重开补答窗口')
    return true
  }

  /**
   * 等设备补答，并经 `userQuestions.answer(agent, callId, answers)` 投递。
   * 全流程 fail-safe：投递失败只收页 + 提示，**不重试、不猜测**。
   */
  async #deliverContinued(request, device) {
    const callId = typeof request?.wait?.callId === 'string' ? request.wait.callId : ''
    const result = await device
    // 设备没答上来（放弃/补答窗口超时/断链）：#cancelDevice 已按既有 reason 收尾
    if (result?.kind !== 'answer') return false

    const service = this.ctx?.get?.('userQuestions')
    if (!callId || typeof service?.answer !== 'function') {
      this.#trace('补答通道不可用，丢弃设备答案')
      this.#sendDone(result.callId ?? callId, false, 'timed-out')
      return false
    }

    try {
      await service.answer(request.agent, callId, result.value)
      this.#trace('补答已投递（continued）')
      this.logger('info', '[questions] 计时追问的补答已投递（作为一条 user 消息进入会话）')
      this.#sendDone(result.callId ?? callId, true, 'continued-answered')
      return true
    } catch (error) {
      const code = error?.code ?? 'error'
      this.logger('warn', `[questions] 补答投递失败（${code}）：${error?.message ?? error}`)
      this.#trace(`补答失败（${code}）`)
      this.#sendDone(result.callId ?? callId, false,
                     code === 'REPLY_QUEUED' ? 'answered-elsewhere' : 'rejected')
      return false
    }
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
   * 设备分支：把整批问题逐题推到设备，等它作答。
   *
   * @returns {Promise<{kind:'answer',value:object,from:'device'}|{kind:'reject',error:Error}|null>}
   *   null 表示设备没答上来（取消/超时/断链/发送失败）—— 竞速里只是这条支线退出，
   *   **不再 next() 交回电脑端**：电脑卡片从一开始就显示着。
   */
  #startDeviceBatch(request, questions) {
    const isPlanReview = questions.some((q) => q.intent?.kind === 'plan-review')
    // ★ 计划待审**不设超时**（用户要求）：一直停在设备页，等到用户在电脑端或设备端作答。
    //   普通追问仍按 questions.timeoutMs 收页（未在需求内，行为不变）。
    const timeoutMs = isPlanReview ? 0 : (this.config.questions?.timeoutMs ?? 120_000)
    return new Promise((resolve) => {
      this.pending = {
        callId: extractCallId(request),
        kind: isPlanReview ? 'plan' : 'choice',
        questions,
        picks: new Map(),
        index: 0,
        timeoutMs,
        startedAt: Date.now(),
        /** 设备分支的结算入口（竞速用）。 */
        settle: resolve,
        settled: false,
        timer: timeoutMs > 0
          ? setTimeout(() => {
              this.logger('info', `[questions] 设备 ${timeoutMs}ms 未作答，收起设备页面（电脑卡片仍在）`)
              this.#cancelDevice('timeout')
            }, timeoutMs)
          : null,
      }
      // 调用方（ask_user_question 工具）被中止 —— 但**倒计时结束也会中止同一个 signal**
      // （askTimed 的既定行为）。两者现象一样、后果完全相反：前者该收页，后者要保留
      // 补答窗口。因此这里只记标记 + 起一个宽限计时：窗口内卡片报出 ASK_TIMED_OUT
      // 就转成"继续追问"（#markContinued 会清掉这个计时），否则按取消处理（fail-safe）。
      request?.signal?.addEventListener?.('abort', () => {
        const pending = this.pending
        if (!pending || pending.settled) return
        pending.aborted = true
        if (pending.abortTimer) return
        pending.abortTimer = setTimeout(() => {
          pending.abortTimer = null
          if (this.pending === pending && !pending.settled) this.#cancelDevice('aborted')
        }, CONTINUED_GRACE_MS)
      }, { once: true })

      this.logger('info', `[questions] 收到 ${questions.length} 道追问（${this.pending.kind}），送设备作答`)
      this.#sendQuestion(0)
    })
  }

  /**
   * 结束设备分支（设备没答上来 / 用户取消 / 电脑先答 / 断链）。
   *
   * 与旧模型的关键区别：这里**不调用 next()** —— 电脑卡片在竞速里早已显示，
   * 设备分支退出只是让竞速继续等电脑那一边。
   */
  #cancelDevice(reason) {
    const pending = this.pending
    if (!pending || pending.settled) return
    pending.settled = true
    if (pending.timer) clearTimeout(pending.timer)
    if (pending.abortTimer) clearTimeout(pending.abortTimer)
    this.pending = null

    if (reason === 'timeout' || reason === 'disconnected') {
      this.#sendDone(pending.callId, false, reason)
    } else if (reason === 'answered-on-pc') {
      this.#sendDone(pending.callId, false, 'answered-elsewhere')
    } else if (reason === 'timed-out') {
      this.#sendDone(pending.callId, false, 'timeout')
    }

    this.logger('debug', `[questions] 设备分支结束（${reason}）`)
    pending.settle(null)
    this.broadcast({ type: 'question.updated', question: null })
  }

  /** 设备提交整批答案（竞速里的"设备先答"）。 */
  #settleDeviceAnswer(value) {
    const pending = this.pending
    if (!pending || pending.settled) return
    pending.settled = true
    if (pending.timer) clearTimeout(pending.timer)
    if (pending.abortTimer) clearTimeout(pending.abortTimer)
    this.pending = null
    // ★ 计时追问的补答：收尾由投递结果决定（成功 = continued-answered），
    //   这里不能先发 done —— 否则设备会先显示"已提交"，而投递可能失败。
    if (!pending.continued) this.#sendDone(pending.callId, true, 'submitted')
    pending.settle({ kind: 'answer', value, from: 'device', callId: pending.callId })
    this.broadcast({ type: 'question.updated', question: null })
  }

  /** 设备「要求修改」：拒绝等待本身（ASK_CANCELLED）。 */
  #settleDeviceReject(error) {
    const pending = this.pending
    if (!pending || pending.settled) return
    pending.settled = true
    if (pending.timer) clearTimeout(pending.timer)
    this.pending = null
    this.logger('info', `[questions] 设备「要求修改」：拒绝等待（ASK_CANCELLED）批 ${pending.callId}`)
    pending.settle({ kind: 'reject', error })
    this.broadcast({ type: 'question.updated', question: null })
  }

  // ── 设备消息 ────────────────────────────────────────────────────────────

  #onNav(message) {
    const pending = this.#matchPending(message)
    if (!pending) return
    const index = Math.min(
      Math.max(0, Number(message.index) || 0),
      pending.questions.length - 1,
    )
    pending.index = index
    this.#sendQuestion(index)
  }

  #onPick(message) {
    const pending = this.#matchPending(message)
    if (!pending) return
    const question = pending.questions.find((q) => q.id === String(message.qid ?? ''))
    if (!question) return

    // ★ 校验用"截断后"的合法标签集：设备显示/回发的是 question.req 里
    //   clampText 过的标签，拿原始 label 比对会把长标签的选中全部静默丢掉。
    const valid = new Set()
    for (const option of question.options) {
      valid.add(option.label)
      valid.add(clampText(option.label, BUDGET.optionLabelChars).replaceAll('|', '/'))
    }
    const labels = (Array.isArray(message.selected) ? message.selected : [])
      .map((label) => String(label))
      .filter((label) => valid.has(label))
    // 单选题互斥：设备 UI 已经保证，这里再兜一次底（协议层不信任任何一端的 UI）
    const selected = question.multiSelect ? labels : labels.slice(-1)
    const custom = message.custom != null ? String(message.custom).slice(0, 200) : ''

    pending.picks.set(question.id, { selected, custom, skipped: Boolean(message.skipped) })
    this.logger('debug', `[questions] pick ${question.id} → [${selected.join(', ')}]${custom ? ' +custom' : ''}`)
  }

  #onAnswer(message) {
    const pending = this.#matchPending(message)
    if (!pending) return
    const action = String(message.action ?? '')
    if (action === 'cancel') {
      // 设备上「取消」= 不再用设备作答；电脑卡片还在，交给它
      this.logger('info', '[questions] 用户在设备上取消，交给电脑卡片')
      this.#cancelDevice('user-cancel')
      return
    }
    if (action === 'reject') {
      // 「要求修改」（计划评审）：拒绝等待本身（ASK_CANCELLED），
      // 用户回来在输入框里写修改意见 —— 与官方卡片的 Request changes 同语义。
      this.#settleDeviceReject(rejectedQuestionError('the user requested changes to the plan'))
      return
    }
    if (action !== 'submit') {
      this.logger('warn', `[questions] 未知的 question.answer action=${action}`)
      return
    }

    // ★ 整批答案恰好覆盖每道题（DSH 的 BAD_ANSWER 校验）；
    //   未作答的题按 Skip 语义交空 selected（与官方卡片一致）。
    const answers = pending.questions.map((question) => {
      const pick = pending.picks.get(question.id) ?? { selected: [], custom: '' }
      const item = { id: question.id, selected: pick.selected }
      if (pick.custom) item.custom = pick.custom
      return item
    })
    this.logger('info', `[questions] 提交整批答案：${answers.map((a) => `${a.id}=[${a.selected.join(',')}]`).join(' ')}`)
    this.#settleDeviceAnswer({ answers })
  }

  #matchPending(message) {
    const pending = this.pending
    if (!pending) return null
    const callId = String(message?.callId ?? '')
    if (callId && callId !== pending.callId) {
      this.logger('debug', `[questions] 忽略批次 ${callId} 的消息（当前批次 ${pending.callId}）`)
      return null
    }
    return pending
  }

  // ── 下发 ────────────────────────────────────────────────────────────────

  #sendQuestion(index) {
    const pending = this.pending
    if (!pending) return
    const question = pending.questions[index]
    if (!question) return

    const payload = {
      callId: pending.callId,
      kind: question.intent?.kind === 'plan-review' ? 'plan' : 'choice',
      index,
      total: pending.questions.length,
      qid: question.id,
      // ★ 只发一行极短摘要：设备屏幕显示不下正文，长文本问题因此彻底消失
      //   （题干、选项全文、计划正文都留在电脑卡片上）。
      summary: clampSummary(question.question),
      // ★ 载荷全部拍平：设备端 ap_json_* 只能取标量，不解析嵌套数组/布尔。
      //   options 用 '|' 分隔（label 里的 '|' 会被清除），标志用 0/1。
      multiSelect: question.multiSelect ? 1 : 0,
      // 计划评审的"批准"选项 label 由 intent.approve 指定；设备按它作答，
      // 「要求修改」是拒绝等待（action:'reject'）而不是选项（docs/06 §1.3）。
      approveLabel: question.intent?.kind === 'plan-review'
        ? clampText(String(question.intent.approve ?? ''), BUDGET.optionLabelChars)
        : '',
      options: question.options
        .slice(0, BUDGET.maxOptions)
        .map((option) => clampText(option.label, BUDGET.optionLabelChars).replaceAll('|', '/'))
        .join('|'),
      recommendedIndex: Math.max(0, question.options.findIndex((option) => option.recommended)),
      hasCustom: 1,
      timeoutMs: Math.max(0, pending.timeoutMs - (Date.now() - pending.startedAt)),
    }
    void this.link
      .send(MSG.QUESTION_REQ, payload)
      .catch((error) => {
        this.logger('warn', `[questions] question.req 下发失败：${error?.message ?? error}`)
        this.#cancelDevice('send-failed')
      })
    this.broadcast({ type: 'question.updated', question: this.snapshot() })
  }

  #sendDone(callId, ok, reason) {
    // ok 用 0/1：设备端 ap_json_num 不解析 JSON 布尔。
    void this.link
      .send(MSG.QUESTION_DONE, { callId, ok: ok ? 1 : 0, reason })
      .catch(() => {})
  }
}
