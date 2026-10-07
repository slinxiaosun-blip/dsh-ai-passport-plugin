/**
 * 余额域：把 DeepSeek 余额送到设备屏幕上。
 *
 * 两条取数路径，与 DSH 自己的「账号与余额」设置卡片保持一致：
 *   ① `ctx.deepseekAccount.getBalance(client)` —— 账号登录态（推荐，token 注入与
 *      失效清理都由 DSH 负责，我们绝不自己拼 HTTP 请求）；
 *   ② API key 路径 —— 账号服务不可用或未登录时，用 `ctx.get('credentials')`
 *      取出 key 再调 `/user/balance`。
 *
 * 三条必须遵守的坑（`dsh-whale-widget` 已经踩过，这里直接照它的结论）：
 *   - 可选服务一律用 `ctx.get(...)`，**绝不写进 inject**：老宿主没有 deepseekAccount，
 *     一旦进 inject 整个插件会永远等待而不 apply，比没有这个功能严重得多；
 *   - 出错**不缓存**：网络抖动导致的失败被缓存下来，界面上会一直显示旧值或错误；
 *   - 取不到就明确显示"未获取到余额"，**不显示伪造的 0**——0 元和"没查到"是两回事。
 */

import { MSG } from '../protocol/constants.js'

/** 余额缓存有效期：设备每隔一段时间问一次，缓存避免频繁打平台接口。 */
const CACHE_TTL_MS = 60_000

export class BalanceDomain {
  constructor(shared) {
    this.link = shared.link
    this.config = shared.config
    this.logger = shared.logger
    this.broadcast = shared.broadcast
    this.domainState = shared.domainState

    /** @type {{value:object, at:number} | null} */
    this.cache = null
    /** 记录今日已用的基线：余额差推算法需要它。 */
    this.dayBaseline = null
    this.disposers = []

    this.registerProtocolHandlers()
  }

  attach(runtime, ctx) {
    this.runtime = runtime
    if (ctx) this.ctx = ctx
  }

  registerProtocolHandlers() {
    this.disposers.push(
      this.link.onMessage(MSG.BALANCE_REQ, async (_message, context) => {
        try {
          const balance = await this.refresh({ force: true })
          await context.reply(MSG.BALANCE, balance)
        } catch (error) {
          this.logger('warn', `[balance] 设备请求余额失败：${error.message}`)
          await context.reply(MSG.TOAST, { text: '余额获取失败' })
        }
      }),
    )
  }

  /**
   * 取余额并（可选）推给设备。
   *
   * @param {object} [options]
   * @param {boolean} [options.force] 忽略缓存
   * @param {boolean} [options.push] 是否主动推给设备（默认 true）
   */
  async refresh(options = {}) {
    const { force = false, push = true } = options
    const now = Date.now()
    if (!force && this.cache && now - this.cache.at < CACHE_TTL_MS) {
      if (push) await this.#push(this.cache.value)
      return this.cache.value
    }

    let value
    let lastError = null
    try {
      value = await this.#fetchFromAccount()
    } catch (error) {
      lastError = error
      this.logger('debug', `[balance] 账号余额路径失败：${error.message}`)
    }

    if (!value) {
      try {
        value = await this.#fetchFromApiKey()
      } catch (error) {
        lastError = error
        this.logger('debug', `[balance] API key 余额路径失败：${error.message}`)
      }
    }

    if (!value) {
      // 关键：失败不写进 cache，下次仍然会真的重试
      const message = describeBalanceFailure(lastError)
      this.domainState.balance = null
      this.domainState.balanceError = message
      this.broadcast({ type: 'balance.error', message })
      if (push) {
        await this.link.send(MSG.TOAST, { text: '未获取到余额' }).catch(() => {})
      }
      return null
    }

    this.cache = { value, at: now }
    this.domainState.balance = value
    this.domainState.balanceError = null
    if (push) await this.#push(value)
    return value
  }

  async #push(value) {
    try {
      await this.link.send(MSG.BALANCE, value)
      this.broadcast({ type: 'balance.updated', balance: value })
    } catch (error) {
      this.logger('debug', `[balance] 推送失败：${error.message}`)
    }
  }

  /** 路径①：DSH 账号登录态。 */
  async #fetchFromAccount() {
    const ctx = this.ctx
    if (!ctx) return null
    const account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null
    if (!account || typeof account.getBalance !== 'function') return null

    const client = {
      version: String(process.env.DSH_CLIENT_VERSION ?? process.env.DSH_VERSION ?? 'unknown'),
      locale: String(process.env.DSH_LOCALE ?? '') || 'zh_CN',
      // DSH 要的是"东为正的整秒"，而 Date 给的是"西为正的分钟"
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }

    const result = await account.getBalance(client)
    // 未登录 / 没有授权 / 平台失败 → 返回 null，让调用方走下一步（不在这里吞成 0）
    if (!result || result.status !== 'ready' || !Array.isArray(result.value) || result.value.length === 0) {
      return null
    }
    return shapeAccountBalance(result)
  }

  /** 路径②：API key。仅在账号路径拿不到时尝试。 */
  async #fetchFromApiKey() {
    const ctx = this.ctx
    if (!ctx) return null
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : null
    if (!credentials || typeof credentials.resolve !== 'function') return null

    let resolved = null
    try {
      resolved = await credentials.resolve({ kind: 'provider', provider: 'deepseek' })
    } catch {
      resolved = null
    }
    const apiKey = resolved?.value ?? resolved?.secret
    if (!apiKey) return null

    const response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    const info = pickBalanceInfo(body?.balance_infos)
    if (!info) return null
    return {
      currency: info.currency ?? 'CNY',
      totalBalance: Number(info.total_balance ?? 0),
      rechargeBalance: null,
      bonusBalance: null,
      todayUsed: null,
      source: 'api-key',
      fetchedAt: Date.now(),
    }
  }

  // 定时刷新（startAutoRefresh/stopAutoRefresh）已按用户要求删除：
  // 余额改为**按需**获取 —— 设备长按下键请求、面板/工具手动刷新、链路握手完成时各刷一次。
  // 原来的 5 分钟轮询会在无人看余额时也定期打 API。

  async dispose() {
    for (const dispose of this.disposers) {
      try {
        dispose()
      } catch {
        // 宿主已拆
      }
    }
    this.disposers.length = 0
  }
}

/**
 * 把账号服务的钱包数组折算成设备要显示的数字。
 *
 * 口径必须与 API key 路径一致：`total_balance` 本身是"充值 + 赠金"，
 * 所以这里也把两种钱包相加，否则"今日已用"按余额差推算会偏小。
 */
export function shapeAccountBalance(result) {
  const wallets = Array.isArray(result.value) ? result.value : []
  const bonusWallets = Array.isArray(result.bonusWallets) ? result.bonusWallets : []
  const numeric = (value) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  const currency = wallets.some((wallet) => String(wallet?.currency ?? '').toUpperCase() === 'CNY')
    ? 'CNY'
    : String(wallets[0]?.currency ?? 'CNY').toUpperCase()

  const sumOf = (list) =>
    list
      .filter((wallet) => String(wallet?.currency ?? 'CNY').toUpperCase() === currency && numeric(wallet?.balance) !== null)
      .reduce((total, wallet) => total + Number(wallet.balance), 0)

  const recharge = sumOf(wallets)
  const bonus = sumOf(bonusWallets)

  return {
    currency,
    totalBalance: Number((recharge + bonus).toFixed(6)),
    rechargeBalance: Number(recharge.toFixed(6)),
    bonusBalance: Number(bonus.toFixed(6)),
    todayUsed: null,
    source: 'account',
    fetchedAt: Date.now(),
  }
}

/** 与 whale-widget 同一套选择逻辑：优先 CNY 且有余额的那条。 */
function pickBalanceInfo(infos) {
  if (!Array.isArray(infos) || infos.length === 0) return null
  const amount = (info) => (info && info.total_balance !== undefined ? Number(info.total_balance) : Number.NaN)
  return (
    infos.find((info) => info?.currency === 'CNY' && amount(info) > 0) ??
    infos.find((info) => amount(info) > 0) ??
    infos.find((info) => info?.currency === 'CNY') ??
    infos[0]
  )
}

/** 把失败原因说成人话，并给出下一步动作——设备屏幕小，提示必须能直接照做。 */
function describeBalanceFailure(error) {
  if (!error) return '未获取到余额：账号未登录，也没有可用的 API key'
  const message = String(error.message ?? error)
  if (/401|unauthorized|credential/i.test(message)) return '未获取到余额：凭据无效或已过期'
  if (/timeout|abort/i.test(message)) return '未获取到余额：请求超时'
  if (/HTTP 5\d\d/.test(message)) return '未获取到余额：平台暂时不可用'
  if (/fetch failed|ENOTFOUND|ECONNREFUSED/i.test(message)) return '未获取到余额：网络不通'
  return `未获取到余额：${message}`
}
