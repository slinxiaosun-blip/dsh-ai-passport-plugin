/**
 * 假宿主（Fake Host）：在测试里复刻 DSH 提供给插件的那些接口。
 *
 * 为什么值得专门写一个：
 * 插件与 DSH 的接缝（session/event 事件、approval/request 瀑布、speechToText 注册表、
 * sessionController 的签名）是本项目**最容易错、又最难在真机上定位**的部分。
 * 有了假宿主，这些路径可以在毫秒级反复验证，而不必每次都开 DSH、连设备、手工造一次审批。
 *
 * 刻意遵守 DSH 的真实语义，而不是"怎么方便怎么来"：
 *   - `list()` 只读，不激活 Agent；
 *   - `approval/request` 是瀑布：监听者返回非 undefined 即终止后续；
 *   - `session/event` 是 post-commit 的 fire-and-forget 广播；
 *   - 可选服务通过 `ctx.get(name)` 暴露，不存在时返回 undefined。
 */

import { EventEmitter } from 'node:events'

export class FakeHost extends EventEmitter {
  constructor(options = {}) {
    super()
    // 放宽监听器上限：插件会为多种事件各挂一个监听者，默认 10 个不够用。
    this.setMaxListeners(0)

    this.logs = []
    this.sessions = new Map()
    /** 记录所有对 sessionController 的调用，便于断言"到底发了什么"。 */
    this.calls = []

    // 计时追问的补答通道（官方 userQuestions 服务）。默认实现只记录调用，
    // 便于断言"设备补答到底有没有经 answer() 投递"；需要失败注入时用
    // `new FakeHost({ userQuestions: {...} })` 覆盖。
    this.userQuestions = options.userQuestions ?? {
      answered: [],
      async answer(agent, callId, answer) {
        host.userQuestions.answered.push({ agent, callId, answer })
      },
    }
    this.promptCounter = 0

    const host = this

    this.sessionController = {
      async list(_request, _signal) {
        host.calls.push({ method: 'list' })
        return {
          items: [...host.sessions.values()].map((session) => ({
            sessionId: session.id,
            agentAvailable: true,
            updatedAt: session.updatedAt ?? Date.now(),
            running: Boolean(session.running),
            blank: false,
            parentSessionId: session.parentSessionId,
            origin: session.origin,
            title: session.title,
            step: session.step,
            tool: session.tool,
          })),
        }
      },

      async create(request = {}) {
        host.calls.push({ method: 'create', request })
        if (options.createFails) throw new Error(options.createFails)
        const session = host.addSession({
          id: request.sessionId ?? `session-${host.sessions.size + 1}`,
          title: `新任务 ${host.sessions.size + 1}`,
        })
        return { sessionId: session.id, agentPreset: request.agentPreset }
      },

      async prompt(request, _signal) {
        host.calls.push({ method: 'prompt', request })
        if (options.promptFails) throw new Error(options.promptFails)
        if (!host.sessions.has(request.sessionId)) {
          const error = new Error(`会话不存在：${request.sessionId}`)
          error.code = 'session/not-found'
          throw error
        }
        host.promptCounter += 1
        const text = request.content?.map((part) => part.text).join('') ?? ''
        host.emit('prompted', { sessionId: request.sessionId, text, mode: request.mode, requestId: request.requestId })
        return { accepted: true }
      },

      cancel(request) {
        host.calls.push({ method: 'cancel', request })
        host.emit('cancelled', request.sessionId)
        return { accepted: true }
      },
    }

    this.speechToText = {
      registered: options.speechProvider
        ? [
            {
              id: options.speechProvider.id ?? 'fake-provider',
              name: options.speechProvider.name ?? '假识别器',
              location: 'host-local',
              languages: ['zh', 'en'],
              preparation: { phase: options.speechProvider.phase ?? 'ready' },
            },
          ]
        : [],
      selection: { providerId: options.speechProvider?.id ?? 'fake-provider', language: 'zh' },
      snapshot() {
        return { providers: this.registered, selection: this.selection }
      },
      prepare(providerId) {
        host.calls.push({ method: 'speech.prepare', providerId })
        host.prepared = providerId
      },
      resolve(request) {
        host.calls.push({ method: 'speech.resolve', request: { ...request, audio: `<${request.audio?.length ?? 0}B>` } })
        if (this.registered.length === 0) throw new Error('没有可用的识别提供者')
        return { ...request, provider: this.registered[0] }
      },
      async transcribe(spec, _signal) {
        host.calls.push({ method: 'speech.transcribe', audioBytes: spec.audio?.length ?? 0 })
        if (options.transcribeFails) throw new Error(options.transcribeFails)
        return {
          text: options.transcriptText ?? '帮我把 README 的错别字改一下',
          audioSeconds: 1.8,
          inferenceSeconds: 0.4,
        }
      },
    }

    this.deepseekAccount = options.noAccount
      ? undefined
      : {
          async getBalance() {
            host.calls.push({ method: 'account.getBalance' })
            if (options.balanceFails) throw new Error(options.balanceFails)
            if (options.notLoggedIn) return { status: 'signed-out', value: [] }
            return {
              status: 'ready',
              value: [
                { currency: 'CNY', balance: 30 },
                { currency: 'USD', balance: 5 },
              ],
              bonusWallets: [{ currency: 'CNY', balance: 12.5 }],
            }
          },
        }

    /** 注册进 tools 服务的工具定义，便于断言工具是否被注册。 */
    this.registeredTools = new Map()
    this.tools = {
      register: (definition) => {
        this.registeredTools.set(definition.name, definition)
        return () => this.registeredTools.delete(definition.name)
      },
    }

    this.webServer = {
      routes: new Map(),
      register: (route) => {
        this.routes.set(`${route.kind}:${route.path}`, route)
        return () => this.routes.delete(`${route.kind}:${route.path}`)
      },
      tapIndex: () => () => {},
    }

    this.connection = {
      requestRejection: () => null,
    }
  }

  /** 模拟 DSH 的可选服务读取语义。 */
  get(name) {
    switch (name) {
      case 'sessionController':
        return this.sessionController
      case 'speechToText':
        return this.speechToText.registered.length > 0 || this.speechToTextAlwaysPresent
          ? this.speechToText
          : this.speechToTextAlwaysPresent === false
            ? undefined
            : this.speechToText
      case 'deepseekAccount':
        return this.deepseekAccount
      case 'tools':
        return this.tools
      case 'connection':
        return this.connection
      case 'webServer':
        return this.webServer
      case 'userQuestions':
        return this.userQuestions
      default:
        return undefined
    }
  }

  get logger() {
    const host = this
    const record = (level) => (message) => host.logs.push({ level, message: String(message) })
    return { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') }
  }

  addSession(session) {
    const normalized = {
      id: session.id,
      title: session.title ?? '未命名任务',
      running: false,
      updatedAt: Date.now(),
      ...session,
    }
    this.sessions.set(normalized.id, normalized)
    return normalized
  }

  /** 模拟一次用户/模型发起的轮次开始。 */
  startTurn(sessionId) {
    const session = this.sessions.get(sessionId)
    if (session) session.running = true
    this.emit('session/event', { id: sessionId }, { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } })
    this.emit('api-session/status', sessionId, true)
  }

  /** 模拟一次工具调用。 */
  toolCall(sessionId, name, seq = 2) {
    this.emit('session/event', { id: sessionId }, {
      type: 'tool/call',
      seq,
      time: Date.now(),
      data: { turn: 1, step: 1, callId: `call-${seq}`, name, arguments: '{}' },
    })
  }

  /** 模拟一轮助手回答。 */
  assistantMessage(sessionId, text, seq = 3) {
    this.emit('session/event', { id: sessionId }, {
      type: 'assistant/message',
      seq,
      time: Date.now(),
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, stream: [] },
    })
  }

  /** 模拟一次轮次结束。 */
  endTurn(sessionId, reason = { kind: 'completed' }, seq = 4) {
    const session = this.sessions.get(sessionId)
    if (session) session.running = false
    this.emit('session/event', { id: sessionId }, { type: 'turn/end', seq, time: Date.now(), data: { turn: 1, reason } })
  }

  /**
   * 模拟 DSH 向 answerer 瀑布发一次审批请求。
   *
   * 复刻真实语义：监听者返回非 undefined 即终止瀑布；全部返回 undefined 时
   * 由"最后的兜底答案者"给出结果——真实 DSH 里那是网页端弹窗，
   * 这里用一个可观测的哨兵值代替，便于断言"到底有没有交回下游"。
   */
  async askApproval(request) {
    const listeners = this.listeners('approval/request')
    if (listeners.length === 0) return { outcome: 'unhandled', via: 'no-listener' }
    let index = -1
    const next = async () => {
      index += 1
      if (index >= listeners.length) return undefined
      return listeners[index](request, next)
    }
    const result = await next()
    if (result === undefined) return { outcome: 'allowed-once', via: 'fallback-downstream' }
    return { outcome: result, via: 'listener' }
  }
}
