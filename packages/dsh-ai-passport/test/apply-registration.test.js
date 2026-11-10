/**
 * `apply()` 装配层的集成测试 —— 直接走真实的注入回调。
 *
 * 为什么单列一份：`createRuntime()` 的测试绕过了 apply()，而 apply() 里有两段
 * "服务就绪后才接线"的回调（面板、工具），它们分别被 try/catch 包着 ——
 * 一旦内部出错只会留一条 warn，测试如果不看注册表就永远发现不了。
 *
 * 这里踩到过一个真问题：假宿主的 `webServer.register` 写错了 this（箭头函数
 * 捕获的是宿主而不是 webServer 本身），于是**面板路由从没注册成功过**，
 * 而所有测试都是绿的 —— 因为没人检查注册表。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'
import { FakeHost } from './fake-host.js'

/**
 * 复刻 Cordis 宿主的最小子集：effect 收集清理函数，inject 在服务就绪时回调。
 *
 * ★ 直接把 effect / inject 补到 FakeHost 实例上，而不是 `Object.create(host)`。
 *   用原型链造 "root" 会让 EventEmitter 的 `_events` 落到父对象上，
 *   `ctx.on()` 注册的监听器就查不到、也退不掉 —— 断言会变成假绿/假红。
 *   真宿主里 ctx 与各服务本来就挂在同一个对象上，直接复用实例更接近真实。
 */
function makeRoot(host, options = {}) {
  const cleanups = []
  host.effect = (fn) => {
    cleanups.push(fn())
  }
  host.inject = options.deferInject
    ? () => {
        // 模拟"服务还没就绪"：注册了注入需求，但回调暂时不执行
      }
    : (_names, cb) => {
        cb(host)
      }
  return { root: host, cleanups }
}

/** 跑一遍全部清理项（含异步）。 */
async function runCleanups(cleanups) {
  for (const dispose of [...cleanups].reverse()) {
    const returned = dispose()
    if (returned && typeof returned.then === 'function') await returned
  }
}

test('★ apply() 把 4 个 Agent 工具真正注册进宿主', () => {
  const host = new FakeHost()
  const { root } = makeRoot(host)

  apply(root, { transport: 'mock', autoConnect: false })

  const names = [...host.registeredTools.keys()].sort()
  assert.deepEqual(names, ['ap_balance', 'ap_device_ask', 'ap_device_notify', 'ap_device_status'])
  // 每个工具都必须带 output（宿主 0.2.x 的硬要求，缺了会整批注册失败）
  for (const [name, definition] of host.registeredTools) {
    assert.equal(typeof definition.output?.render, 'function', `${name} 缺少 output.render`)
    assert.deepEqual(definition.output.schema, { type: 'object' }, `${name} 的 output.schema 形状不对`)
  }
})

test('★ apply() 把控制面板的 7 条路由真正注册进 webServer', () => {
  const host = new FakeHost()
  const { root } = makeRoot(host)

  apply(root, { transport: 'mock', autoConnect: false })

  const paths = [...host.webServer.routes.keys()].sort()
  assert.deepEqual(paths, [
    'exact:/dsh-passport',
    'exact:/dsh-passport/action',
    'exact:/dsh-passport/events',
    'exact:/dsh-passport/index.html',
    'exact:/dsh-passport/panel.css',
    'exact:/dsh-passport/panel.js',
    'exact:/dsh-passport/state.json',
  ])
})

test('★ 卸载时工具与路由全部撤销，不留监听器', async () => {
  const host = new FakeHost()
  const { root, cleanups } = makeRoot(host)

  apply(root, { transport: 'mock', autoConnect: false })
  assert.equal(host.registeredTools.size, 4)
  assert.equal(host.webServer.routes.size, 7)

  await runCleanups(cleanups)

  assert.equal(host.registeredTools.size, 0, '工具应当被注销')
  assert.equal(host.webServer.routes.size, 0, '同一条链路的 0 条面板路由')
  // 注入行监听器也要撤：否则 HMR 后同一张表会被追加两条一模一样的行
  assert.equal(host.listenerCount('webserver/index-inject'), 0, '注入行监听器应当已撤销')
})

test('服务尚未就绪时插件照常加载（不抛错、不阻断宿主启动）', () => {
  const host = new FakeHost()
  const { root } = makeRoot(host, { deferInject: true })

  assert.doesNotThrow(() => apply(root, { transport: 'mock', autoConnect: false }))
  assert.equal(host.registeredTools.size, 0, '注入回调没跑，自然还没有工具')
  // 关键点：apply() 本身必须立刻返回，注入行在这一次调用里就要登记好
  assert.equal(host.listenerCount('webserver/index-inject'), 1)
})
