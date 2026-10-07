/**
 * 内嵌 Web 控制面板：静态页面 + JSON/SSE 接口。
 *
 * 定位：插件自带的"上位机应用"界面。不依赖 DSH 前端内部结构（不注入挂件），
 * 而是一个独立页面，DSH 升级不会把它打碎。
 *
 * 安全模型（照抄 dsh-whale-widget 已经踩过坑的那套）：
 *   ① 写操作必须来自回环地址 —— "能打开页面"不等于"能改配置"；
 *   ② 拒 Sec-Fetch-Site: cross-site；带 Origin 时必须与 Host 同源；
 *   ③ 宿主 connection.requestRejection 可用时委托它（它知道 --trusted-host 声明了谁），
 *      它抛异常一律按拒绝处理（fail-closed）；
 *   ④ 校验器自身出错 → 拒绝。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PANEL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static')

/** 只读接口不需要回环限制（局域网里也能看状态），写接口必须回环。 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export class Panel {
  /**
   * @param {object} options
   * @param {object} options.ctx 插件上下文（用于取 connection 服务）
   * @param {() => object} options.getSnapshot 链路 + 域状态快照
   * @param {(action:string, payload:object)=>Promise<object>} options.dispatch 面板动作分发
   * @param {(listener:(event:object)=>void)=>()=>void} options.subscribe 事件订阅
   * @param {(level:string,message:string,detail?:object)=>void} [options.logger]
   */
  constructor(options) {
    this.ctx = options.ctx
    this.getSnapshot = options.getSnapshot
    this.dispatch = options.dispatch
    this.subscribe = options.subscribe
    this.logger = options.logger ?? (() => {})
    /** @type {Set<import('node:http').ServerResponse>} */
    this.sseClients = new Set()
    this.unsubscribe = null
    this.trustedAuthorities = String(process.env.DSH_PASSPORT_TRUSTED_HOSTS ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  }

  /**
   * 注册全部路由。
   *
   * @param {{register:(route:object)=>()=>void}} webServer
   * @returns {Array<() => void>} 注销函数列表
   */
  registerRoutes(webServer) {
    const disposers = []
    const route = (kind, routePath, handler) => {
      disposers.push(
        webServer.register({
          kind,
          path: routePath,
          handler: async (req, res) => {
            const rejection = this.#rejection(req)
            if (rejection) {
              this.#sendJson(res, rejection, { ok: false, error: 'forbidden', message: '请求未被信任' })
              return
            }
            try {
              await handler(req, res)
            } catch (error) {
              this.logger('error', `[panel] ${routePath} 处理失败：${error?.message ?? error}`)
              if (!res.headersSent) {
                this.#sendJson(res, 500, { ok: false, error: 'internal', message: String(error?.message ?? error) })
              }
            }
          },
        }),
      )
    }

    route('exact', '/dsh-passport', (_req, res) => this.#sendFile(res, 'index.html', 'text/html; charset=utf-8'))
    route('exact', '/dsh-passport/index.html', (_req, res) => this.#sendFile(res, 'index.html', 'text/html; charset=utf-8'))
    route('exact', '/dsh-passport/panel.js', (_req, res) => this.#sendFile(res, 'panel.js', 'text/javascript; charset=utf-8'))
    route('exact', '/dsh-passport/panel.css', (_req, res) => this.#sendFile(res, 'panel.css', 'text/css; charset=utf-8'))

    // 状态快照：面板首屏与轮询兜底都用它
    route('exact', '/dsh-passport/state.json', (_req, res) => {
      this.#sendJson(res, 200, { ok: true, state: this.getSnapshot() })
    })

    // 实时事件：SSE 比轮询省电，也比 WebSocket 少一层握手
    route('exact', '/dsh-passport/events', (req, res) => this.#handleSse(req, res))

    // 唯一的写入口：所有动作都走这里，便于统一鉴权与审计
    route('exact', '/dsh-passport/action', async (req, res) => {
      if (req.method !== 'POST') {
        this.#sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const body = await readJsonBody(req)
      if (!body || typeof body.action !== 'string') {
        this.#sendJson(res, 400, { ok: false, error: 'bad-request', message: '缺少 action 字段' })
        return
      }
      const result = await this.dispatch(body.action, body.payload ?? {})
      this.#sendJson(res, 200, { ok: true, result })
    })

    return disposers
  }

  /** 订阅域事件并广播给所有 SSE 客户端。 */
  start() {
    if (this.unsubscribe) return
    this.unsubscribe = this.subscribe((event) => this.broadcast(event))
  }

  /** 向所有面板推送一个事件。 */
  broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const client of this.sseClients) {
      try {
        client.write(payload)
      } catch {
        // 客户端已断开，下一次心跳会把它清掉
        this.sseClients.delete(client)
      }
    }
  }

  dispose() {
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const client of this.sseClients) {
      try {
        client.end()
      } catch {
        // 已经断了
      }
    }
    this.sseClients.clear()
  }

  // —— SSE ——

  #handleSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(`retry: 3000\n\n`)
    res.write(`data: ${JSON.stringify({ type: 'snapshot', state: this.getSnapshot() })}\n\n`)
    this.sseClients.add(res)

    // 心跳：代理与浏览器都会掐掉长时间无数据的连接
    const heartbeat = setInterval(() => {
      try {
        res.write(': keepalive\n\n')
      } catch {
        clearInterval(heartbeat)
        this.sseClients.delete(res)
      }
    }, 15000)
    heartbeat.unref?.()

    const cleanup = () => {
      clearInterval(heartbeat)
      this.sseClients.delete(res)
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
    void this.logger
  }

  // —— 信任栅栏 ——

  /** 通过 → null；否则返回应当拒绝的 HTTP 状态码。 */
  #rejection(req) {
    const verdict = this.#rejectionReason(req)
    if (verdict && verdict.status !== 200) {
      // 拒绝时记一条日志，带上"哪个分支拒的"与关键头部。
      // 没有这条日志时，"403" 完全无法区分是缺 Host、跨站标记、Origin 不同源、
      // 还是宿主栅栏 —— 而这几种的修法完全不同。
      this.logger(
        'warn',
        `[panel] 拒绝 ${req?.method ?? '?'} ${req?.url ?? '?'}：${verdict.reason} ` +
          `(host=${req?.headers?.host ?? '无'} origin=${req?.headers?.origin ?? '无'} ` +
          `sec-fetch-site=${req?.headers?.['sec-fetch-site'] ?? '无'})`,
      )
    }
    return verdict ? verdict.status : null
  }

  /** 校验并返回 {status, reason}；通过返回 null。 */
  #rejectionReason(req) {
    try {
      const headers = req?.headers ?? {}
      const isWrite = WRITE_METHODS.has(String(req?.method ?? 'GET').toUpperCase())

      let hostUrl
      try {
        hostUrl = new URL(`http://${String(headers.host ?? '')}`)
      } catch {
        return { status: 403, reason: '缺 Host 或 Host 畸形' }
      }
      const hostname = hostUrl.hostname.toLowerCase()
      const authority = hostUrl.host.toLowerCase()

      const loopback = isLoopbackHostname(hostname)
      if (!loopback) {
        const listed = this.trustedAuthorities.some((entry) =>
          entry.includes(':') ? entry === authority : entry === hostname,
        )
        // 宿主栅栏可用时把"非回环是否可信"交给它判断；不可用时只信显式声明。
        const fenceAvailable = Boolean(this.#connectionFence())
        if (!listed && !fenceAvailable) {
          return { status: 403, reason: `非回环主机 ${hostname} 且未声明信任` }
        }
      }

      // 写操作额外要求回环：任意能打开页面的人都不该有权改配置。
      if (isWrite && !loopback) return { status: 403, reason: '写操作来自非回环地址' }

      // 这两条与信任列表无关，任何情况都执行
      const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
      if (site === 'cross-site') return { status: 403, reason: 'Sec-Fetch-Site: cross-site' }

      const origin = headers.origin
      if (typeof origin === 'string' && origin && origin !== 'null') {
        let originUrl
        try {
          originUrl = new URL(origin)
        } catch {
          return { status: 403, reason: `Origin 无法解析：${origin}` }
        }
        if (originUrl.host.toLowerCase() !== authority) {
          return { status: 403, reason: `Origin(${originUrl.host}) 与 Host(${authority}) 不同源` }
        }
      }

      // 宿主栅栏兜底。
      //
      // ★ 契约细节（看实现才知道，这里是踩过的坑）：
      //   `requestRejection(req)` 返回的是**状态码或 undefined**，不是布尔值：
      //      403 = Host/Origin 不可信（真栅栏）
      //      401 = 请求没带浏览器会话 cookie（browserAuth 未通过）
      //      undefined = 通过
      //   最初写成 `if (result) return 403`，于是把 401 也当成拒绝 ——
      //   结果**面板与挂件被自己的栅栏全部挡死**（curl 与不带 cookie 的同源请求
      //   一律 403），按钮点了毫无反应。
      //
      //   正确的区分：
      //     · 403 → 必须拒（信任栅栏失败，这个判断只有宿主能做对）
      //     · 401 → **放行**。浏览器会话鉴权是宿主 API 的需要；本插件是
      //       "插件自带的本地控制面板"，面向本机用户，已经有自己的回环/同源校验，
      //       再要求一次浏览器登录只会把面板锁死。写操作另有"必须来自回环"的限制。
      const fence = this.#connectionFence()
      if (fence) {
        try {
          const result = fence.requestRejection(req)
          if (result === 403) {
            return { status: 403, reason: '宿主信任栅栏返回 403（Host/Origin 不在其 trustedHosts 里）' }
          }
          // 401 = 未带浏览器会话 cookie → 放行（见上方长注释）
        } catch (error) {
          // 栅栏自己抛异常 → 按拒绝处理（fail-closed）
          return { status: 403, reason: `宿主栅栏抛异常：${error?.message ?? error}` }
        }
      }
      return null
    } catch (error) {
      // 校验器自身出错 → 拒绝（fail-closed）
      return { status: 403, reason: `校验器自身出错：${error?.message ?? error}` }
    }
  }

  #connectionFence() {
    try {
      const connection = this.ctx?.get?.('connection') ?? this.ctx?.connection
      return connection && typeof connection.requestRejection === 'function' ? connection : null
    } catch {
      return null
    }
  }

  // —— 静态资源 ——

  async #sendFile(res, name, contentType) {
    // 只允许读 static 目录下的已知文件，杜绝路径穿越
    const safeName = path.basename(name)
    const target = path.join(PANEL_DIR, safeName)
    try {
      const body = await readFile(target)
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      })
      res.end(body)
    } catch (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`找不到面板资源 ${safeName}：${error.message}`)
    }
  }

  #sendJson(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(text)
  }
}

/** 只认回环：localhost / *.localhost / 127.0.0.0/8（逐段校验）/ ::1。 */
export function isLoopbackHostname(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  if (Number(match[1]) !== 127) return false
  return [match[2], match[3], match[4]].every((part) => Number(part) <= 255)
}

/** 读取 JSON 请求体，带大小上限（面板只发小对象，超过就是异常）。 */
export function readJsonBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}
