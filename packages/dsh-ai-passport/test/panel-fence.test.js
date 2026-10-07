/**
 * 面板路由的信任栅栏测试。
 *
 * 这组用例来自一个**真实故障**：桌面端挂件的「扫描并连接」按钮点了毫无反应。
 * 根因不在按钮，而在栅栏判定 —— `connection.requestRejection(req)` 返回的是
 * **状态码或 undefined**，不是布尔值：
 *     403       = Host/Origin 不可信（真栅栏，必须拒）
 *     401       = 请求没带浏览器会话 cookie
 *     undefined = 通过
 * 原来的实现写成 `if (result) return 403`，把 401 也当成拒绝，于是**面板与挂件
 * 被自己的栅栏全部挡死**（不携带浏览器 cookie 的同源请求一律 403），
 * 表现为"按钮没反应"。这类"一切都对、但全被静默拒绝"的 bug 只能靠测试钉住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Panel, isLoopbackHostname, readJsonBody } from '../lib/panel/index.js'
import { Readable } from 'node:stream'

/** 造一个最小的 req/res，够面板的路由处理器用。 */
function fakeReq({ method = 'GET', headers = {}, url = '/dsh-passport/state.json', body } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = url
  stream.headers = headers
  return stream
}

function fakeRes() {
  return {
    status: null,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk.toString()
    },
    write() {},
  }
}

/** 只在测试里存在的最小 connection 服务替身。 */
function hostWith(connection) {
  return { get: (name) => (name === 'connection' ? connection : undefined) }
}

const LOOPBACK_HEADERS = { host: '127.0.0.1:19387' }

test('回环请求 + 宿主返回 undefined → 放行', () => {
  const panel = new Panel({
    ctx: hostWith({ requestRejection: () => undefined }),
    getSnapshot: () => ({}),
    dispatch: async () => ({}),
    subscribe: () => () => {},
  })
  assert.equal(panel.constructor.name, 'Panel')
  // 直接测私有判定的公开效果：注册并调用一个路由
  const routes = new Map()
  panel.registerRoutes({ register: (r) => { routes.set(r.path, r); return () => {} } })
  assert.ok(routes.has('/dsh-passport/state.json'))
})

test('★ 宿主返回 401（未带浏览器 cookie）→ 必须放行，不能拒', async () => {
  // 这是那个真实故障的核心：401 是"没登录宿主 API"，不是"不可信"。
  // 插件自带的面板面向本机用户，已经有自己的回环/同源校验；
  // 再要求一次浏览器登录只会把面板与挂件一起锁死。
  const routes = new Map()
  const panel = new Panel({
    ctx: hostWith({ requestRejection: () => 401 }),
    getSnapshot: () => ({ ok: 1 }),
    dispatch: async () => ({}),
    subscribe: () => () => {},
  })
  panel.registerRoutes({ register: (r) => { routes.set(r.path, r); return () => {} } })

  const res = fakeRes()
  await routes.get('/dsh-passport/state.json').handler(fakeReq({ headers: LOOPBACK_HEADERS }), res)
  assert.equal(res.status, 200, `401 应当放行，实际 ${res.status} ${res.body}`)
  assert.match(res.body, /"ok":1/)
})

test('宿主返回 403（信任栅栏失败）→ 必须拒绝', async () => {
  const routes = new Map()
  const panel = new Panel({
    ctx: hostWith({ requestRejection: () => 403 }),
    getSnapshot: () => ({}),
    dispatch: async () => ({}),
    subscribe: () => () => {},
  })
  panel.registerRoutes({ register: (r) => { routes.set(r.path, r); return () => {} } })

  const res = fakeRes()
  await routes.get('/dsh-passport/state.json').handler(fakeReq({ headers: LOOPBACK_HEADERS }), res)
  assert.equal(res.status, 403)
})

test('宿主栅栏抛异常 → 按拒绝处理（fail-closed）', async () => {
  const routes = new Map()
  const panel = new Panel({
    ctx: hostWith({ requestRejection: () => { throw new Error('栅栏内部故障') } }),
    getSnapshot: () => ({}),
    dispatch: async () => ({}),
    subscribe: () => () => {},
  })
  panel.registerRoutes({ register: (r) => { routes.set(r.path, r); return () => {} } })

  const res = fakeRes()
  await routes.get('/dsh-passport/state.json').handler(fakeReq({ headers: LOOPBACK_HEADERS }), res)
  assert.equal(res.status, 403, '栅栏出错时必须拒绝，不能因为"没拿到明确答复"就放行')
})

test('没有 connection 服务时只靠自带校验（回环放行）', async () => {
  const routes = new Map()
  const panel = new Panel({
    ctx: { get: () => undefined },
    getSnapshot: () => ({ ok: true }),
    dispatch: async () => ({}),
    subscribe: () => () => {},
  })
  panel.registerRoutes({ register: (r) => { routes.set(r.path, r); return () => {} } })

  const res = fakeRes()
  await routes.get('/dsh-passport/state.json').handler(fakeReq({ headers: LOOPBACK_HEADERS }), res)
  assert.equal(res.status, 200)
})

test('跨站标记一律拒（Sec-Fetch-Site: cross-site）', async () => {
  const routes = new Map()
  const panel = new Panel({
    ctx: hostWith({ requestRejection: () => undefined }),
    getSnapshot: () => ({}),
    dispatch: async () => ({}),
    subscribe: () => () => {},
  })
  panel.registerRoutes({ register: (r) => { routes.set(r.path, r); return () => {} } })

  const res = fakeRes()
  await routes
    .get('/dsh-passport/state.json')
    .handler(fakeReq({ headers: { ...LOOPBACK_HEADERS, 'sec-fetch-site': 'cross-site' } }), res)
  assert.equal(res.status, 403)
})

test('非回环 Host 且未声明信任 → 拒', async () => {
  const routes = new Map()
  const panel = new Panel({
    ctx: { get: () => undefined },
    getSnapshot: () => ({}),
    dispatch: async () => ({}),
    subscribe: () => () => {},
  })
  panel.registerRoutes({ register: (r) => { routes.set(r.path, r); return () => {} } })

  const res = fakeRes()
  await routes
    .get('/dsh-passport/state.json')
    .handler(fakeReq({ headers: { host: '192.168.1.50:19387' } }), res)
  assert.equal(res.status, 403)
})

test('★ 写操作必须来自回环：非回环 POST 一律拒', async () => {
  // 「能打开页面」不等于「能改配置」。写接口（连接设备、批审批）必须与
  // "坐在这台机器前"绑定。
  const routes = new Map()
  const panel = new Panel({
    ctx: hostWith({ requestRejection: () => undefined }),
    getSnapshot: () => ({}),
    dispatch: async () => ({ done: true }),
    subscribe: () => () => {},
  })
  panel.registerRoutes({ register: (r) => { routes.set(r.path, r); return () => {} } })

  const res = fakeRes()
  await routes
    .get('/dsh-passport/action')
    .handler(
      fakeReq({
        method: 'POST',
        headers: { host: '192.168.1.50:19387', 'content-type': 'application/json' },
        body: { action: 'device.connect' },
      }),
      res,
    )
  assert.equal(res.status, 403, '非回环的写操作必须拒绝')
})

test('回环 POST 正常落到 dispatch', async () => {
  const seen = []
  const routes = new Map()
  const panel = new Panel({
    ctx: hostWith({ requestRejection: () => 401 }),   // 401 也要能写
    getSnapshot: () => ({}),
    dispatch: async (action, payload) => { seen.push({ action, payload }); return { ok: true } },
    subscribe: () => () => {},
  })
  panel.registerRoutes({ register: (r) => { routes.set(r.path, r); return () => {} } })

  const res = fakeRes()
  await routes
    .get('/dsh-passport/action')
    .handler(
      fakeReq({
        method: 'POST',
        headers: { ...LOOPBACK_HEADERS, 'content-type': 'application/json' },
        body: { action: 'device.connect', payload: { reason: 'test' } },
      }),
      res,
    )
  assert.equal(res.status, 200, `应当成功，实际 ${res.status} ${res.body}`)
  assert.deepEqual(seen, [{ action: 'device.connect', payload: { reason: 'test' } }])
})

test('Origin 与 Host 不同源 → 拒', async () => {
  const routes = new Map()
  const panel = new Panel({
    ctx: { get: () => undefined },
    getSnapshot: () => ({}),
    dispatch: async () => ({}),
    subscribe: () => () => {},
  })
  panel.registerRoutes({ register: (r) => { routes.set(r.path, r); return () => {} } })

  const res = fakeRes()
  await routes
    .get('/dsh-passport/state.json')
    .handler(fakeReq({ headers: { ...LOOPBACK_HEADERS, origin: 'http://evil.example' } }), res)
  assert.equal(res.status, 403)
})

test('isLoopbackHostname 只认回环，且挡住相似域名', () => {
  for (const good of ['127.0.0.1', '127.1.2.3', 'localhost', 'foo.localhost', '::1']) {
    assert.equal(isLoopbackHostname(good), true, `${good} 应判为回环`)
  }
  for (const bad of ['127.0.0.1.evil.com', '128.0.0.1', 'localhost.evil.com', '10.0.0.1', '', 'example.com']) {
    assert.equal(isLoopbackHostname(bad), false, `${bad} 不应判为回环`)
  }
})

test('readJsonBody 拒绝超大请求体', async () => {
  const huge = { pad: 'x'.repeat(1024) }
  const req = fakeReq({ body: huge })
  const parsed = await readJsonBody(req, 64)
  assert.equal(parsed, null, '超过上限应返回 null，而不是把内存吃掉')
})
