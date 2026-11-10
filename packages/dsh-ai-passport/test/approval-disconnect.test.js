/**
 * 审批 × 断链兜底回归测试。
 *
 * 场景：设备上正弹着审批页，用户直接把设备拿走/关机（或蓝牙断了）。
 *
 * 旧行为：`#askDeviceHandle` 返回的 answer 只有"设备作答 / 超时 / 请求方中止 /
 * 电脑先答"四种结算方式，而审批**默认不超时**（timeoutMs=0，用户要求"一直等"）。
 * 设备走后它永远不会再作答 → 电脑端又恰好没有回答者时，
 * `await handle.answer` 永久挂住 → DSH 的那一轮对话卡死（"点了审批之后 agent 不动了"）。
 *
 * 修复要点：断链时把所有待审批结算成 `'disconnected'`，
 * 映射为 **null（设备没答上来）** 而不是 `'cancelled'`——
 * 后者的语义是"请求方自己取消"，那会替电脑端的用户按下取消键。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRuntime } from '../lib/index.js'
import { normalizeConfig } from '../lib/config.js'
import { FakeHost } from './fake-host.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function setup(overrides = {}) {
  const host = new FakeHost()
  const config = normalizeConfig({ transport: 'mock', autoConnect: false, ...overrides })
  const runtime = createRuntime({ config, logger: () => {} })
  await runtime.connect()
  await sleep(60)
  runtime.attachHost(host)
  return { host, runtime }
}

test('★ 审批等待中设备掉线：请求被结算而不是永久挂住，且交回电脑端', async () => {
  const { host, runtime } = await setup()

  // 电脑端没有回答者（next() 一路走到链尾 → undefined）
  const pending = host.askApproval({ toolName: 'write', reason: '改文件' })
  await sleep(30)
  assert.equal(runtime.domains.approval.pending.size, 1, '应当有一个待审批挂在设备上')

  runtime.transport.simulateDrop('test-drop')

  const result = await Promise.race([pending, sleep(1500).then(() => 'TIMEOUT')])
  assert.notEqual(result, 'TIMEOUT', '断链后审批必须被结算（旧实现会永久挂住整轮对话）')
  assert.equal(
    result.via,
    'fallback-downstream',
    '断链应把决定权交回下游，而不是替电脑端作答',
  )
  assert.equal(runtime.domains.approval.pending.size, 0, '待审批表必须清空')
  assert.equal(runtime.domains.approval.domainState.approvals.length, 0, '面板上的审批条目也必须收起')

  await runtime.dispose()
})

test('★ 断链不等于取消：电脑端随后作答仍然是最终结果', async () => {
  const { host, runtime } = await setup()

  // 电脑端的回答者要 200ms 才答（模拟用户在弹窗上思考一下）
  host.on('approval/request', async () => {
    await sleep(200)
    return 'rejected'
  })

  const pending = host.askApproval({ toolName: 'write', reason: '改文件' })
  await sleep(30)
  assert.equal(runtime.domains.approval.pending.size, 1)

  // 设备先走了
  runtime.transport.simulateDrop('test-drop')
  await sleep(20)
  assert.equal(runtime.domains.approval.pending.size, 0, '断链后设备侧条目应先收起')

  const result = await Promise.race([pending, sleep(1500).then(() => 'TIMEOUT')])
  assert.notEqual(result, 'TIMEOUT')
  assert.equal(result.outcome, 'rejected', '电脑端 200ms 后的作答仍必须生效（不能被断链吞掉）')
  assert.equal(result.via, 'listener')

  await runtime.dispose()
})
