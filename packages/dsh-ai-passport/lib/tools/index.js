/**
 * Agent 工具：让 DSH 自己也能操作设备。
 *
 * 这一层把"设备"变成 Agent 可调用的能力，于是双向都通了：
 *   - 用户 → 设备 → 任务（设备上发起）
 *   - Agent → 设备 → 用户（Agent 在设备上提问/提醒，拿回用户的回答）
 *
 * 每个工具都遵守三条约定：
 *   1. **失败要说清楚为什么**，包括"设备没连上"这种最常见的情况，
 *      而不是抛一个空栈的异常让模型去猜；
 *   2. **不在设备上做危险的事**（审批放行、删除任务）——那些只由用户在设备上主动按键触发；
 *   3. **必须声明 output**（`schema` + `render`）。DSH 的 `tools.register()` 从
 *      0.2.1-rc.5 起就硬性校验这一项，缺一个会直接抛 TypeError；异常被
 *      `index.js` 的注册兜底吞掉后，表现是整批工具"注册了却完全不可用"。
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
    output: objectOutput((value) => value.connected
      ? `AI Passport 已连接：${value.device?.name ?? value.device?.id ?? '未知设备'}`
      : `AI Passport 未连接（状态 ${value.state ?? 'unknown'}）。${value.hint ?? ''}`),
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
    output: objectOutput((value) => value.delivered
      ? `已把提示推送到设备：${value.text}`
      : '提示未能送达设备'),
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
      '在 AI Passport 设备上向用户提问，并等待用户在设备上按键作答。当需要用户立刻确认一个选择、而用户可能不在电脑前时使用。设备屏幕只显示一行题干和少量选项，问题务必极简；用户也可选「其他」用语音补充。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '问题文本，设备只显示前 12 个字，务必极简' },
        options: {
          type: 'array',
          description: '可选项，最多 4 个、每项不超过 10 个字；省略时默认 ["确定", "取消"]',
          items: { type: 'string' },
        },
        timeoutSeconds: { type: 'number', description: '等待秒数；省略或 0 = 不超时（默认），最大 300' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    output: objectOutput((value) => value.answered
      ? `用户在设备上选择了「${value.selected ?? '自定义输入'}」（下标 ${value.selectedIndex}）`
        + (value.custom ? `，补充：${value.custom}` : '')
      : `用户未在设备上作答：${value.reason ?? '未知原因'}`),
    async execute(input) {
      requireConnection(runtime)
      const questions = runtime.domains?.questions
      if (typeof questions?.askOnDevice !== 'function') {
        return { answered: false, reason: '设备问答服务未就绪，请改用普通提问。' }
      }
      const question = String(input.question ?? '').trim()
      if (!question) throw new Error('问题不能为空')
      const options = Array.isArray(input.options) && input.options.length > 0
        ? input.options.slice(0, 4).map((option) => String(option))
        : ['确定', '取消']
      // 默认不设超时（用户 11-10 要求）：一直等设备作答/取消；
      // 显式传正数时仍按秒收窄（5..300）。
      const rawTimeout = input.timeoutSeconds
      const timeoutSeconds = rawTimeout == null || Number(rawTimeout) <= 0
        ? 0
        : Math.min(300, Math.max(5, Number(rawTimeout)))

      // ★ 走 questions 域的批次，而不是自己注册 question.pick/answer：
      //   HostLink 同类型只留一个 handler，工具自己监听会把 DSH 追问瀑布顶掉。
      //   域负责拼 question.req（options 必须是 '|' 串）、超时/断链兜底和
      //   question.done 收页；设备只回标签文本，由域反查成下标。
      const callId = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const answer = await questions.askOnDevice({
        callId,
        question,
        options,
        timeoutMs: timeoutSeconds * 1000,
      })
      if (answer === null) {
        return { answered: false, reason: '用户在设备上没有作答（取消、超时或设备正忙），请改用普通提问。' }
      }
      return {
        answered: true,
        selectedIndex: answer.index,
        selected: options[answer.index] ?? answer.label ?? null,
        ...(answer.custom ? { custom: answer.custom } : {}),
      }
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
    output: objectOutput((value) => value.available === false
      ? `未能获取 DeepSeek 余额：${value.reason ?? '未知原因'}`
      : 'DeepSeek 账户余额已读取'),
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

/**
 * 构造宿主契约要求的工具 output。
 *
 * - `schema` 只约束"根是对象"：status 的 stats、balance 的余额字段、ask 的
 *   可空 selected 都是动态的，写死 properties 反而容易与执行期的真实返回值
 *   冲突。`{ type: 'object' }` 属于 `assertSupportedJsonSchema` 支持的子集。
 * - `render` 把 canonical 值投影成一句话 + 完整 JSON，信息无损且模型可读；
 *   全程 try/catch，渲染绝不反过来打断工具调用。
 *
 * @param {(value:object)=>string} summary
 */
function objectOutput(summary) {
  return {
    schema: { type: 'object' },
    render(_args, value) {
      try {
        const data = value && typeof value === 'object' ? value : { value: value ?? null }
        return [{ type: 'text', text: `${summary(data)}\n${JSON.stringify(data, null, 2)}` }]
      } catch {
        return [{ type: 'text', text: '工具结果已完成，但无法序列化为文本。' }]
      }
    },
  }
}

function requireConnection(runtime) {
  const state = runtime.link.snapshot().state
  if (state !== 'connected') {
    throw new Error(
      `AI Passport 未连接（当前状态：${state}），无法在设备上显示内容。请先确认设备已开机并在广播，然后打开控制面板 /dsh-passport 点「扫描并连接」。`,
    )
  }
}
