/**
 * `ap_device_ask` 问答链路回归钉子。
 *
 * 修复前的错法：工具自己发 `question.req`（`id` + 数组 options，设备端完全不认），
 * 却把等待登记进 `approval.pending`（只由 MSG.APPROVE 结算），于是必然超时。
 *
 * 现在的正确链路：工具 → QuestionsDomain.askOnDevice() → question.req
 * → 设备 question.pick（只有标签文本）→ question.answer(submit)
 * → 域按文本反查下标 → 工具返回 selectedIndex，并回 question.done 收页。
 *
 * 关键约束：HostLink.onMessage 同类型只留一个 handler，所以工具**不能**自己
 * 注册 question.pick/answer（会顶掉 DSH 追问瀑布）。这里同时钉住这一点。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { QuestionsDomain } from '../lib/bridge/questions.js'
import { registerTools } from '../lib/tools/index.js'
import { MSG } from '../lib/protocol/constants.js'
import { FakeHost } from './fake-host.js'

function makeHarness({ connected = true } = {}) {
  const sent = []
  const handlers = new Map()
  const linkHandlers = new Map()
  const link = {
    snapshot: () => ({ state: connected ? 'connected' : 'idle' }),
    onMessage(type, fn) {
      handlers.set(type, fn)
      return () => handlers.delete(type)
    },
    send: async (type, payload) => {
      sent.push({ type, payload })
      return {}
    },
    on(name, fn) {
      linkHandlers.set(name, fn)
      return () => linkHandlers.delete(name)
    },
    off(name) {
      linkHandlers.delete(name)
    },
  }

  const questions = new QuestionsDomain({
    link,
    config: { questions: { enabled: true, timeoutMs: 120_000 } },
    logger: () => {},
    broadcast: () => {},
    domainState: {},
  })
  // attach 才会注册断链兜底；同时留下 DSH 追问瀑布的入口做互斥验证。
  let askHandler = null
  questions.attach({}, {
    on: (name, fn) => {
      if (name === 'user-questions/request') askHandler = fn
      return () => {}
    },
    get: () => null,
  })

  const runtime = {
    snapshot: () => ({ link: { state: 'connected' }, transport: {}, balanceError: null }),
    link,
    domains: { questions },
  }
  const host = new FakeHost()
  registerTools(host, runtime, () => {})

  return {
    sent,
    handlers,
    linkHandlers,
    questions,
    askOnHost: (request, next = () => Promise.resolve({ answers: [] })) => askHandler(request, next),
    tool: host.registeredTools.get('ap_device_ask'),
    // 取最后一条：有些用例会连开两批，设备回包要对上最新那批。
    req: () => [...sent].reverse().find((entry) => entry.type === MSG.QUESTION_REQ),
    done: () => sent.find((entry) => entry.type === MSG.QUESTION_DONE),
  }
}

/** 模拟设备：先回 pick（标签文本），再回 answer。 */
function pickAndSubmit(h, label, extra = {}) {
  const { callId, qid } = h.req().payload
  h.handlers.get(MSG.QUESTION_PICK)({ callId, qid, selected: label ? [label] : [], custom: '', ...extra }, {})
  h.handlers.get(MSG.QUESTION_ANSWER)({ callId, action: 'submit' }, {})
  return callId
}

test('设备按键作答：工具拿到选项下标，question.req/done 都符合设备协议', async () => {
  const h = makeHarness()
  const pending = h.tool.execute({ question: '要继续吗？', options: ['继续', '停止'], timeoutSeconds: 5 })

  const req = h.req()
  assert.ok(req, '应下发 question.req')
  assert.equal(typeof req.payload.callId, 'string')
  assert.equal(req.payload.qid, `${req.payload.callId}-0`)
  assert.equal(req.payload.options, '继续|停止', '设备只认 | 分隔字符串，不认数组')
  assert.equal(req.payload.kind, 'choice')
  assert.equal(req.payload.index, 0)
  assert.equal(req.payload.total, 1)
  assert.equal(req.payload.multiSelect, 0)
  assert.equal(req.payload.recommendedIndex, -1, '没有推荐项时不能让设备预选第一项')
  assert.match(req.payload.summary, /要继续吗/)

  const callId = pickAndSubmit(h, '停止')
  const result = await pending
  assert.equal(result.answered, true)
  assert.equal(result.selectedIndex, 1)
  assert.equal(result.selected, '停止')

  const done = h.done()
  assert.equal(done.payload.callId, callId, 'done 的 callId 必须与 req 一致，设备才收页')
  assert.equal(done.payload.ok, 1)
  assert.equal(done.payload.reason, 'submitted')
  assert.equal(h.questions.snapshot(), null, '结算后 pending 必须清空')
})

test('工具没有自己注册上行 handler，DSH 追问瀑布不被顶掉', () => {
  const h = makeHarness()
  assert.deepEqual(
    [...h.handlers.keys()].sort(),
    [MSG.QUESTION_ANSWER, MSG.QUESTION_NAV, MSG.QUESTION_PICK].sort(),
    '仍只有 questions 域的三个 handler',
  )
})

test('工具批次进行中，DSH 追问瀑布改走电脑端，不覆盖设备页', async () => {
  const h = makeHarness()
  const pending = h.tool.execute({ question: '工具提问？', options: ['A', 'B'], timeoutSeconds: 60 })
  const toolCallId = h.req().payload.callId

  const hostResult = await h.askOnHost({
    callId: 'host-1',
    questions: [{ id: 'q1', question: 'DSH 的问题', options: [{ label: 'X' }] }],
  })
  assert.deepEqual(hostResult, { answers: [] }, '瀑布照常由电脑卡片作答')
  assert.equal(h.req().payload.callId, toolCallId, '不能下发第二批 req 覆盖设备页')
  assert.equal(h.questions.snapshot().callId, toolCallId, '工具批次仍占着设备')

  pickAndSubmit(h, 'B')
  assert.equal((await pending).selectedIndex, 1, '工具批次不受瀑布影响，仍可作答')
})

test('用户在设备上取消：工具返回未作答，且不重复发 done（设备已自行收页）', async () => {
  const h = makeHarness()
  const pending = h.tool.execute({ question: '确认？', options: ['是', '否'], timeoutSeconds: 5 })
  const { callId } = h.req().payload
  h.handlers.get(MSG.QUESTION_ANSWER)({ callId, action: 'cancel' }, {})
  assert.equal((await pending).answered, false)
  assert.equal(h.done(), undefined, 'user-cancel 时设备自己收页，主机不该再发 done')
})

test('省略 timeoutSeconds：timeoutMs 为 0，不挂超时定时器', async () => {
  const h = makeHarness()
  const pending = h.tool.execute({ question: '不超时？', options: ['是', '否'] })
  const req = h.req()
  assert.equal(req.payload.timeoutMs, 0, '默认不应带超时')
  assert.equal(h.questions.pending?.timer, null, 'timeoutMs=0 时不能有定时器')

  pickAndSubmit(h, '是')
  const result = await pending
  assert.equal(result.answered, true)
  assert.equal(result.selected, '是')
})

test('用户只填「其他」自定义文本：index 为 -1，custom 原样回传', async () => {
  const h = makeHarness()
  const pending = h.tool.execute({ question: '还有补充？', options: ['A', 'B'], timeoutSeconds: 5 })
  pickAndSubmit(h, '', { custom: '随便什么都行' })
  const result = await pending
  assert.equal(result.answered, true)
  assert.equal(result.selectedIndex, -1)
  assert.equal(result.custom, '随便什么都行')
})

test('设备跳过：按未作答处理，不发提交成功的 done', async () => {
  const h = makeHarness()
  const pending = h.tool.execute({ question: '确认？', options: ['是', '否'], timeoutSeconds: 5 })
  pickAndSubmit(h, '', { skipped: 1 })
  assert.equal((await pending).answered, false)
  assert.equal(h.done().payload.ok, 1, '批次确实提交了，只是没有有效作答')
})

test('设备断链：工具立刻拿到未作答，且收到 done 收页', async () => {
  const h = makeHarness()
  const pending = h.tool.execute({ question: '确认？', options: ['是', '否'], timeoutSeconds: 60 })
  const callId = h.req().payload.callId
  h.linkHandlers.get('disconnected')({ reason: 'link lost' })
  assert.equal((await pending).answered, false)
  const done = h.done()
  assert.equal(done.payload.callId, callId)
  assert.equal(done.payload.ok, 0)
  assert.equal(done.payload.reason, 'disconnected')
})

test('超时：域主动收页，且不会误杀之后开的新批次', async () => {
  const h = makeHarness()
  const first = h.questions.askOnDevice({
    callId: 'timeout-1', question: '确认？', options: ['是', '否'], timeoutMs: 20,
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(await first, null)
  assert.equal(h.done().payload.reason, 'timeout')

  const second = h.questions.askOnDevice({
    callId: 'fresh-2', question: '再来一次？', options: ['好', '不好'], timeoutMs: 0,
  })
  assert.equal(h.req().payload.callId, 'fresh-2')
  pickAndSubmit(h, '不好')
  assert.deepEqual(await second, { index: 1, label: '不好', custom: '' })
})

test('设备正忙：第二个工具提问立即返回未作答，且不覆盖当前批次', async () => {
  const h = makeHarness()
  const first = h.tool.execute({ question: '第一问？', options: ['A', 'B'], timeoutSeconds: 60 })
  const firstCallId = h.req().payload.callId

  const second = await h.tool.execute({ question: '第二问？', options: ['C', 'D'], timeoutSeconds: 60 })
  assert.equal(second.answered, false)
  assert.match(second.reason, /设备正忙/)
  assert.equal(h.req().payload.callId, firstCallId, '忙时不能下发第二批')

  pickAndSubmit(h, 'B')
  assert.equal((await first).selectedIndex, 1, '第一批仍可正常作答')
})

test('选项里的 | 会被替换，避免设备端切错选项', async () => {
  const h = makeHarness()
  const pending = h.tool.execute({ question: '选哪个？', options: ['A|B', 'C'], timeoutSeconds: 5 })
  assert.equal(h.req().payload.options, 'A/B|C')
  pickAndSubmit(h, 'A/B')
  assert.equal((await pending).selectedIndex, 0)
})
