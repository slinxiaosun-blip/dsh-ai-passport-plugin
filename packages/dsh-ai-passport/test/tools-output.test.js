/**
 * Agent 工具注册契约的回归钉子。
 *
 * 背景：DSH 的 `tools.register()` 从 0.2.1-rc.5 起就强制 `output:{schema,render}`；
 * 插件四个工具全漏了，抛出的 TypeError 又被 `lib/index.js` 的注册兜底吞成一条 warn，
 * 于是真机上「工具一个都调不到」，而 184 项测试全绿 —— 因为假宿主的 register
 * 当时照单全收。本文件同时钉住「工具必须带 output」与「假宿主必须拒绝裸定义」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTools } from '../lib/tools/index.js'
import { FakeHost } from './fake-host.js'

const EXPECTED_NAMES = [
  'ap_balance',
  'ap_device_ask',
  'ap_device_notify',
  'ap_device_status',
]

function definitions(runtime = {}) {
  const host = new FakeHost()
  const disposers = registerTools(host, runtime, () => {})
  return { host, disposers, defs: [...host.registeredTools.values()] }
}

test('四个 Agent 工具都能通过宿主注册期硬校验', () => {
  const { defs, disposers } = definitions()
  assert.deepEqual(defs.map((def) => def.name).sort(), EXPECTED_NAMES)
  assert.equal(disposers.length, 4, '每个工具都要有对应的注销函数')

  for (const def of defs) {
    assert.equal(typeof def.description, 'string')
    assert.ok(def.parameters && typeof def.parameters === 'object', `${def.name} 缺 parameters`)
    assert.ok(def.output && typeof def.output === 'object', `${def.name} 缺 output`)
    assert.equal(typeof def.output.render, 'function', `${def.name} 的 output.render 必须是函数`)
    // { type: 'object' } 属于宿主 assertSupportedJsonSchema 支持的子集，
    // 且不会与动态字段（stats / 余额字段 / 可空 selected）打架。
    assert.deepEqual(def.output.schema, { type: 'object' })
  }

  for (const dispose of disposers) dispose()
})

test('假宿主会拒绝缺 output 或 schema 越界的定义（防止漏检复发）', () => {
  const host = new FakeHost()
  assert.throws(
    () => host.tools.register({ name: 'broken', description: 'x', parameters: {} }),
    /must declare output/,
  )
  assert.throws(
    () => host.tools.register({ name: 'broken', output: { schema: { type: 'object' } } }),
    /must declare output/,
  )
  assert.throws(
    () => host.tools.register({
      name: 'broken',
      output: { schema: { type: 'object', $ref: '#' }, render: () => [] },
    }),
    /不支持的关键字/,
  )
  assert.equal(host.registeredTools.size, 0, '被拒绝的定义不能留在注册表里')
})

test('每个工具的 render 产出单个文本块，且异常数据也不抛', () => {
  const { defs } = definitions()
  const samples = {
    ap_device_status: { connected: false, state: 'idle', hint: '点「扫描并连接」' },
    ap_device_notify: { delivered: true, text: '任务完成' },
    ap_device_ask: { answered: false, reason: '用户在设备上没有作答' },
    ap_balance: { available: true, totalBalance: 42.5 },
  }

  for (const def of defs) {
    const cyclic = { name: def.name }
    cyclic.self = cyclic
    for (const value of [samples[def.name], null, undefined, { weird: 1 }, cyclic]) {
      const blocks = def.output.render({}, value)
      assert.ok(Array.isArray(blocks) && blocks.length === 1, `${def.name} 应产出单个内容块`)
      assert.equal(blocks[0].type, 'text')
      assert.equal(typeof blocks[0].text, 'string')
      assert.ok(blocks[0].text.length > 0)
    }
  }
})

test('render 文本附完整 JSON，execute 的全部字段都能到模型手里', () => {
  const { defs } = definitions()
  const notify = defs.find((def) => def.name === 'ap_device_notify')
  const text = notify.output.render({}, { delivered: true, text: '任务完成' })[0].text
  assert.match(text, /已把提示推送到设备/)
  assert.match(text, /"text": "任务完成"/)
})

test('execute 的返回值是对象，符合各工具声明的 output.schema', async () => {
  const sent = []
  const runtime = {
    snapshot: () => ({
      link: {
        state: 'connected',
        handshakeComplete: true,
        device: { id: 'dev-1', name: 'Passport', rssi: -50 },
        deviceInfo: { firmware: '1.3.1', protocolVersion: 1, batteryPercent: 88 },
        stats: { messagesIn: 3 },
        lastError: null,
      },
      transport: { kind: 'bridge' },
      balanceError: null,
    }),
    link: {
      snapshot: () => ({ state: 'connected' }),
      send: async (type, payload) => { sent.push({ type, payload }) },
    },
    domains: { balance: { refresh: async () => ({ totalBalance: 42.5 }) } },
  }
  const { defs } = definitions(runtime)
  const byName = new Map(defs.map((def) => [def.name, def]))

  // ap_device_ask 会真实等待设备作答（最多 300 秒），这里不执行；它的
  // 问答链路错配是 P0 的另一条，不属于「工具注册契约」这一块。
  const values = await Promise.all([
    byName.get('ap_device_status').execute({}),
    byName.get('ap_device_notify').execute({ text: '任务完成' }),
    byName.get('ap_balance').execute({}),
  ])
  for (const value of values) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), '根必须是对象')
  }
  assert.equal(values[0].connected, true)
  assert.equal(values[1].delivered, true)
  assert.equal(values[2].totalBalance, 42.5)
  assert.equal(sent.length, 1, 'notify 应下发一条 TOAST')
  assert.equal(sent[0].payload.text, '任务完成')
})

test('output.schema 能被真实宿主的 assertSupportedJsonSchema 接受', async (t) => {
  const lib = process.env.DSH_TOOLS_JSON_SCHEMA
  if (!lib) return t.skip('未设置 DSH_TOOLS_JSON_SCHEMA，跳过真实宿主校验')
  const { assertSupportedJsonSchema } = await import(lib)
  for (const def of definitions().defs) {
    assert.doesNotThrow(() => assertSupportedJsonSchema(def.output.schema), `${def.name} 的 schema 被宿主拒绝`)
  }
})
