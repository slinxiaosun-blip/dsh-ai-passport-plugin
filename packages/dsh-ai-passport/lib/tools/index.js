/**
 * Agent 工具：让 DSH 自己也能操作设备。
 *
 * 这一层把"设备"变成 Agent 可调用的能力，于是双向都通了：
 *   - 用户 → 设备 → 任务（设备上发起）
 *   - Agent → 设备 → 用户（Agent 在设备上提问/提醒，拿回用户的回答）
 *
 * 每个工具都遵守两条约定：
 *   1. **失败要说清楚为什么**，包括"设备没连上"这种最常见的情况，
 *      而不是抛一个空栈的异常让模型去猜；
 *   2. **不在设备上做危险的事**（审批放行、删除任务）——那些只由用户在设备上主动按键触发。
 */

import { MSG } from '../protocol/constants.js'

/**
 * 注册全部工具。
 *
 * @param {object} ctx 宿主上下文（已确保 tools 服务存在）
 * @param {object} runtime createRuntime 产出的运行时
 * @param {(level:string, message:string)=>void} logger
 * @returns {Array<() => void>} 注销函数
 */
export function registerTools(ctx, runtime, logger) {
  const tools = ctx.tools ?? (typeof ctx.get === 'function' ? ctx.get('tools') : null)
  if (!tools?.register) {
    logger('debug', '[tools] 宿主没有 tools 服务，跳过工具注册')
    return []
  }

  const disposers = []
  const define = (definition) => {
    disposers.push(tools.register(definition))
  }

  define({
    name: 'ap_device_status',
    description:
      '读取 AI Passport 掌上设备的连接状态：链路是否连通、固件与协议版本、电量、信号强度、链路统计。在需要确认"设备是否可用"或排查连接问题时先调用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const snapshot = runtime.snapshot()
      const link = snapshot.link
      return {
        connected: link.state === 'connected',
        state: link.state,
        transport: snapshot.transport,
        handshakeComplete: link.handshakeComplete,
        device: link.device
          ? { id: link.device.id, name: link.device.name, rssi: link.device.rssi }
          : null,
        firmware: link.deviceInfo?.firmware ?? null,
        protocolVersion: link.deviceInfo?.protocolVersion ?? null,
        batteryPercent: link.deviceInfo?.batteryPercent ?? null,
        stats: link.stats,
        lastError: link.lastError,
        hint: link.state === 'connected' ? null : '设备未连接时无法下发任何指令；可在控制面板 /dsh-passport 点「扫描并连接」。',
      }
    },
  })

  define({
    name: 'ap_device_notify',
    description:
      '在 AI Passport 设备屏幕上显示一条提示，并让设备响提示音。适合"任务做完了""需要你过来看一下"这类需要触达用户本人的场合——用户可能不在电脑前。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要显示的文本，建议不超过 40 个字' },
        urgent: { type: 'boolean', description: '是否使用更醒目的提醒（不同提示音 + 背光闪烁）' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(input) {
      requireConnection(runtime)
      const text = String(input.text ?? '').trim()
      if (!text) throw new Error('提示文本不能为空')
      await runtime.link.send(MSG.TOAST, { text: text.slice(0, 120), urgent: Boolean(input.urgent) })
      return { delivered: true, text }
    },
  })

  define({
    name: 'ap_device_ask',
    description:
      '在 AI Passport 设备上向用户提问，并等待用户在设备上按键作答。当需要用户立刻确认一个选择、而用户可能不在电脑前时使用。设备只有三个按键，因此问题应当是"是/否"或少量选项。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '问题文本，建议不超过 30 个字' },
        options: {
          type: 'array',
          description: '可选项，最多 4 个；省略时默认 ["确定", "取消"]',
          items: { type: 'string' },
        },
        timeoutSeconds: { type: 'number', description: '等待秒数，默认 60，最大 300' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    async execute(input) {
      requireConnection(runtime)
      const question = String(input.question ?? '').trim()
      if (!question) throw new Error('问题不能为空')
      const options = Array.isArray(input.options) && input.options.length > 0
        ? input.options.slice(0, 4).map((option) => String(option))
        : ['确定', '取消']
      const timeoutSeconds = Math.min(300, Math.max(5, Number(input.timeoutSeconds) || 60))

      const id = `ask-${Date.now().toString(36)}`
      const answer = await askDevice(runtime, { id, question, options, timeoutSeconds })
      if (answer === null) {
        return { answered: false, reason: '用户在设备上没有作答（超时或断开），请改用普通提问。' }
      }
      return { answered: true, selectedIndex: answer.index, selected: options[answer.index] ?? null }
    },
  })




  define({
    name: 'ap_balance',
    description:
      '读取 DeepSeek 账户余额（总额 / 充值余额 / 赠送余额）。设备上的余额页用的是同一份数据。',
    parameters: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: '是否强制忽略缓存重新拉取，默认 false' },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const balance = await runtime.domains.balance.refresh({ force: Boolean(input.refresh), push: false })
      if (!balance) {
        return {
          available: false,
          reason: runtime.snapshot().balanceError ?? '未获取到余额',
          hint: '可以在 DSH 里登录 DeepSeek 账号，或配置 API key。',
        }
      }
      return { available: true, ...balance }
    },
  })

  return disposers
}

function requireConnection(runtime) {
  const state = runtime.link.snapshot().state
  if (state !== 'connected') {
    throw new Error(
      `AI Passport 未连接（当前状态：${state}），无法在设备上显示内容。请先确认设备已开机并在广播，然后打开控制面板 /dsh-passport 点「扫描并连接」。`,
    )
  }
}

/**
 * 在设备上提问并等作答。
 *
 * 走的是审批域那套"请求-应答"机制（同一份 pending 表），
 * 因此超时、断链、面板代答这些边界情况只需要维护一处。
 */
function askDevice(runtime, { id, question, options, timeoutSeconds }) {
  const approval = runtime.domains.approval
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      approval.pending.delete(id)
      resolve(null)
    }, timeoutSeconds * 1000)
    timer.unref?.()

    approval.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        // 设备回的是 options 的下标，这里做一次范围校验，避免越界取值
        const index = Number(value?.index)
        resolve(Number.isInteger(index) && index >= 0 && index < options.length ? { index } : null)
      },
      timer,
      request: { id, question, options, kind: 'question' },
      settled: false,
    })

    void runtime.link
      .send(MSG.QUESTION_REQ, { id, question, options, timeoutMs: timeoutSeconds * 1000 })
      .catch(() => {
        clearTimeout(timer)
        approval.pending.delete(id)
        resolve(null)
      })
  })
}
