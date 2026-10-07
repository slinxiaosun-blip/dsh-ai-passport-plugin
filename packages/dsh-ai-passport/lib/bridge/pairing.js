/**
 * 配对（认领 / 信任握手）—— 主机侧。
 *
 * 为什么不用 BLE bonding/passkey：主机侧走 noble，macOS 的配对体验与成功率都差，
 * 且换主机/换设备要反复配对；应用层握手复用同一条 GATT，跨平台一致。
 *
 * 流程（与设备端 app_pair.c 对应，见 docs/06 §9.14）：
 *   1. 设备未配对时屏幕显示一次性 6 位码（每次上电不同），并回 pair.required；
 *   2. 用户在挂件里输入该码 → 本域发 pair.begin{code, host}；
 *   3. 设备校验通过后生成 token，回 pair.ok{deviceId, token} → 本域写入信任表；
 *   4. 之后每次握手 hello 都带 token，设备校验通过才处理业务消息。
 *
 * 安全边界（如实记录）：码与 token 走**未加密**的 BLE 链路，这是"认领/信任"机制
 * （防连错设备、防别人随手用你的设备），**不是**抗主动窃听的加密认证。
 */
import fs from 'node:fs'
import path from 'node:path'

import { MSG } from '../protocol/constants.js'

export class PairingDomain {
  #storePath
  #link
  #logger

  constructor({ link, logger, storePath }) {
    this.#link = link
    this.#logger = logger
    this.#storePath = storePath
    this.record = null // { deviceId, token, name, pairedAt }
    this.deviceId = null
    this.devicePaired = null // 设备自报的配对状态（hello.paired）
    this.needed = false // 需要用户在挂件里输码
    this.error = null // 最近一次配对失败原因
    this.remaining = null // 剩余尝试次数
    this.hostName = ''
    this.disposers = []
    this.#load()
  }

  /** 域生命周期：框架按约定调用 attach(runtime, ctx) / dispose()。 */
  attach() {
    try {
      this.hostName = this.#link.hostInfo?.hostName ?? ''
    } catch {
      this.hostName = ''
    }
    // 已配对则把 token 塞进后续 hello
    if (this.record?.token) this.#link.setHostToken?.(this.record.token)

    this.disposers.push(
      this.#link.onMessage(MSG.HELLO, (message) => {
        this.devicePaired = message.paired === undefined ? null : Number(message.paired) === 1
        if (message.deviceId) this.deviceId = String(message.deviceId)
        // 设备已配对但它的 token 与本地不一致（换了电脑/清了本地）→ 需要重新配对
        if (this.devicePaired === false) {
          this.needed = true
          this.error = null
        } else if (!this.record?.token) {
          this.needed = true
        } else {
          this.needed = false
        }
      }),
      this.#link.onMessage(MSG.PAIR_REQUIRED, (message) => {
        this.needed = true
        this.error = message.reason === 'token' ? 'token-mismatch' : null
        this.#logger('warn', `[pairing] 设备要求配对（${message.reason ?? 'unpaired'}）`)
      }),
      this.#link.onMessage(MSG.PAIR_OK, (message) => {
        const token = String(message.token ?? '')
        const deviceId = String(message.deviceId ?? this.deviceId ?? '')
        if (!token) {
          this.error = 'empty-token'
          return
        }
        this.record = { deviceId, token, name: this.hostName, pairedAt: new Date().toISOString() }
        this.#save()
        this.deviceId = deviceId
        this.devicePaired = true
        this.needed = false
        this.error = null
        this.remaining = null
        this.#link.setHostToken?.(token)
        // 立刻用 token 重新握手：设备校验通过后才会处理业务消息
        this.#link.send(MSG.HELLO, { protocolVersion: 1, capabilities: 0, token }).catch(() => {})
        this.#logger('info', `[pairing] 配对成功：设备 ${deviceId}`)
        this.#emit()
      }),
      this.#link.onMessage(MSG.PAIR_FAILED, (message) => {
        this.error = String(message.reason ?? 'failed')
        this.remaining = message.remaining == null ? null : Number(message.remaining)
        this.needed = true
        this.#logger('warn', `[pairing] 配对失败：${this.error}（剩余 ${this.remaining ?? '?'} 次）`)
        this.#emit()
      }),
    )
  }

  async dispose() {
    for (const off of this.disposers) {
      try {
        off()
      } catch {
        /* 忽略 */
      }
    }
    this.disposers = []
  }

  /** 挂件动作：输入 6 位码。 */
  submit(code) {
    const digits = String(code ?? '').replace(/\D/g, '')
    if (digits.length !== 6) {
      this.error = 'bad-input'
      this.#emit()
      return { ok: false, error: 'bad-input' }
    }
    this.error = null
    this.remaining = null
    void this.#link
      .send(MSG.PAIR_BEGIN, { code: digits, host: this.hostName || 'dsh' }, { ack: true })
      .catch((error) => {
        this.error = 'send-failed'
        this.#logger('warn', `[pairing] pair.begin 发送失败：${error.message}`)
        this.#emit()
      })
    this.#emit()
    return { ok: true }
  }

  /** 挂件动作：解除配对（通知设备清 token，并删除本地信任记录）。 */
  async unpair() {
    try {
      await this.#link.send(MSG.PAIR_RESET, {}, { ack: true })
    } catch (error) {
      this.#logger('warn', `[pairing] pair.reset 发送失败：${error.message}`)
    }
    this.record = null
    this.devicePaired = false
    this.needed = true
    this.#save()
    this.#link.setHostToken?.(null)
    this.#emit()
    return { ok: true }
  }

  /** 快照（挂件用）。 */
  snapshot() {
    return {
      needed: this.needed,
      paired: this.record != null,
      deviceId: this.deviceId,
      devicePaired: this.devicePaired,
      hostName: this.record?.name ?? this.hostName,
      error: this.error,
      remaining: this.remaining,
    }
  }

  #emit() {
    this.#link.emit?.('pairing-changed', this.snapshot())
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.#storePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.token === 'string' && parsed.token.length === 32) {
        this.record = {
          deviceId: String(parsed.deviceId ?? ''),
          token: parsed.token,
          name: String(parsed.name ?? ''),
          pairedAt: String(parsed.pairedAt ?? ''),
        }
        this.deviceId = this.record.deviceId || null
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.#logger('warn', `[pairing] 信任表读取失败：${error.message}`)
      }
    }
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.#storePath), { recursive: true })
      if (!this.record) {
        fs.rmSync(this.#storePath, { force: true })
        return
      }
      fs.writeFileSync(this.#storePath, `${JSON.stringify(this.record, null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      this.#logger('warn', `[pairing] 信任表写入失败：${error.message}`)
    }
  }
}
