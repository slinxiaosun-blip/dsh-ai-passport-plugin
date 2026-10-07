/**
 * 接线层集成测试：追问瀑布（user-questions/request）与识别结果卡消费链
 * （voice.action → dispatch voice.take/voice.ack）与**完整运行时**的连接。
 *
 * 与 questions.test.js / voice-fill.test.js 的分工：那两个测域内状态机，
 * 这里测"域真的接上了宿主与面板动作分发"——接线错位的表现是
 * "一切测试都绿、真机上什么都不会发生"，只能在集成层抓。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRuntime } from '../lib/index.js'
import { normalizeConfig } from '../lib/config.js'
import { FakeHost } from './fake-host.js'
import { MSG } from '../lib/protocol/constants.js'

async function setupRuntime(hostOptions = {}, configOverrides = {}) {
  const host = new FakeHost(hostOptions)
  const config = normalizeConfig({ transport: 'mock', autoConnect: false, ...configOverrides })
  const runtime = createRuntime({ config, logger: () => {} })
  await runtime.connect()
  await new Promise((resolve) => setTimeout(resolve, 40))
  runtime.attachHost(host)
  return { host, runtime, config }
}

function sentByHost(runtime) {
  return runtime.link.transport.received.map((entry) => entry.message)
}

/** 等一条出站消息落地（link.send 是异步的，断言不能跑在它前面）。 */
async function waitForSent(runtime, type, match = () => true, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = sentByHost(runtime).filter((m) => m.type === type).find(match)
    if (found) return found
    if (Date.now() > deadline) {
      assert.fail(`等待 ${type} 消息超时（已发出：${sentByHost(runtime).map((m) => m.type).join(',')}）`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function invokeHandler(runtime, type, payload) {
  const handler = runtime.link.handlers.get(type)
  assert.ok(handler, `没有注册 ${type} 的处理器`)
  return handler({ type, ...payload }, { msgId: 1, channel: 0, reply: async () => {} })
}

function questionRequestListener(host) {
  const listeners = host.listeners('user-questions/request')
  assert.equal(listeners.length, 1, '追问域应当恰好注册一个瀑布监听者')
  return listeners[0]
}

test('追问瀑布：设备收到 question.req，提交后答案交回 ask()', async () => {
  const { host, runtime } = await setupRuntime()
  const listener = questionRequestListener(host)

  // 竞速模型：next() 在监听者里被**立刻**调用（电脑卡片同步显示并等用户点），
  // 这里用一个永不解析的 Promise 模拟"卡片挂着没点"，让设备那条路胜出。
  let cardStarted = false
  const request = {
    callId: 'call-42',
    questions: [{
      id: 'q1',
      question: '选平台',
      multiSelect: false,
      options: [{ label: 'macOS' }, { label: 'Windows' }],
    }],
  }
  const outcomePromise = listener(
    request,
    () => { cardStarted = true; return new Promise(() => {}) },
  )

  // 设备端应当收到第 1 题
  await new Promise((resolve) => setTimeout(resolve, 20))
  const req = sentByHost(runtime).find((m) => m.type === MSG.QUESTION_REQ)
  assert.ok(req, '设备应收到 question.req')
  assert.equal(req.callId, 'call-42')

  // 模拟设备作答：单选选中 + 提交
  await invokeHandler(runtime, MSG.QUESTION_PICK, { callId: 'call-42', qid: 'q1', selected: ['macOS'] })
  await invokeHandler(runtime, MSG.QUESTION_ANSWER, { callId: 'call-42', action: 'submit' })

  const outcome = await outcomePromise
  assert.deepEqual(outcome.answers, [{ id: 'q1', selected: ['macOS'] }])
  assert.equal(cardStarted, true, '电脑卡片必须同步显示（竞速的另一条路）')
  assert.equal(request.signal?.aborted, true, '设备胜出后要中止下游 request，卡片才会收起')

  const done = await waitForSent(runtime, MSG.QUESTION_DONE)
  assert.equal(done?.ok, 1, '设备应收到"已提交"的收尾')
  await runtime.dispose()
})

test('追问瀑布：设备取消 → 设备分支退出，由电脑卡片作答', async () => {
  const { host, runtime } = await setupRuntime()
  const listener = questionRequestListener(host)

  let answerCard = null
  const card = new Promise((resolve) => { answerCard = resolve })
  const outcomePromise = listener(
    { callId: 'call-43', questions: [{ id: 'q1', question: '选平台', options: [{ label: 'A' }] }] },
    () => card,
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  await invokeHandler(runtime, MSG.QUESTION_ANSWER, { callId: 'call-43', action: 'cancel' })

  // 取消不是"交回电脑端"，而是"设备这条支线退出" —— 卡片仍在等用户
  answerCard('card-answer')
  assert.equal(await outcomePromise, 'card-answer')
  await runtime.dispose()
})

test('追问瀑布：「要求修改」（reject）→ ASK_CANCELLED 拒绝整个等待', async () => {
  const { host, runtime } = await setupRuntime()
  const listener = questionRequestListener(host)

  const outcomePromise = listener(
    {
      callId: 'call-44',
      questions: [{
        id: 'p1',
        question: '计划标题',
        detail: '计划正文',
        intent: { kind: 'plan-review', approve: '批准' },
        options: [{ label: '批准' }, { label: '要求修改' }],
      }],
    },
    () => new Promise(() => {}),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  await invokeHandler(runtime, MSG.QUESTION_ANSWER, { callId: 'call-44', action: 'reject' })

  await assert.rejects(outcomePromise, (error) => error.name === 'UserQuestionError' && error.code === 'ASK_CANCELLED')
  await runtime.dispose()
})

test('计时追问：卡片超时后设备补答，经 userQuestions.answer 投递', async () => {
  const { host, runtime } = await setupRuntime()
  const listener = questionRequestListener(host)

  const request = {
    callId: 'call-90',
    agent: { id: 'agent-90' },
    wait: { timed: true, callId: 'toolcall-90' },
    questions: [{
      id: 'q1',
      question: '选平台',
      multiSelect: false,
      options: [{ label: 'macOS' }, { label: 'Windows' }],
    }],
  }
  let rejectCard = null
  const card = new Promise((_resolve, reject) => { rejectCard = reject })
  const outcomePromise = listener(request, () => card)

  await new Promise((resolve) => setTimeout(resolve, 20))
  // 客户端倒计时结束 → 问题变成"继续追问"（continued），补答通道仍然开着
  rejectCard(Object.assign(new Error('timed out'), { name: 'UserQuestionError', code: 'ASK_TIMED_OUT' }))
  await new Promise((resolve) => setTimeout(resolve, 30))

  await invokeHandler(runtime, MSG.QUESTION_PICK, { callId: 'call-90', qid: 'q1', selected: ['macOS'] })
  await invokeHandler(runtime, MSG.QUESTION_ANSWER, { callId: 'call-90', action: 'submit' })

  // 瀑布仍以 ASK_TIMED_OUT 结束（工具侧语义保持 pending），答案走补答通道
  await assert.rejects(outcomePromise, (error) => error.code === 'ASK_TIMED_OUT')
  assert.equal(host.userQuestions.answered.length, 1, '补答必须经 userQuestions.answer 投递')
  assert.equal(host.userQuestions.answered[0].callId, 'toolcall-90', '投递用 wait.callId')
  assert.deepEqual(host.userQuestions.answered[0].answer.answers, [{ id: 'q1', selected: ['macOS'] }])

  const done = await waitForSent(runtime, MSG.QUESTION_DONE)
  assert.equal(done.ok, 1, '设备侧收尾应是"已提交"')
  assert.equal(done.reason, 'continued-answered')
  await runtime.dispose()
})

test('识别结果卡消费链：voice.action → dispatch take/ack → toast 反馈设备', async () => {
  const { runtime } = await setupRuntime()
  runtime.domains.voice.resultTexts.set('v-test', { text: '把这段发出去', at: Date.now() })

  await invokeHandler(runtime, MSG.VOICE_ACTION, { resultId: 'v-test', mode: 'send' })

  // 挂件侧：先认领（多窗口先到先得）
  const first = await runtime.dispatch('voice.take', { resultId: 'v-test' })
  assert.equal(first.taken, true)
  assert.equal(first.mode, 'send')
  assert.equal(first.text, '把这段发出去')

  const second = await runtime.dispatch('voice.take', { resultId: 'v-test' })
  assert.equal(second.taken, false, '第二次认领必须失败')

  // 执行完回执；旧草稿带回存档
  const ack = await runtime.dispatch('voice.ack', {
    resultId: 'v-test',
    ok: true,
    replacedDraft: '写了一半的草稿',
  })
  assert.equal(ack.ok, true)

  const toasts = [await waitForSent(runtime, MSG.TOAST, (m) => m.text === '已发送')]
  assert.ok(toasts[0], '设备应收到「已发送」')
  assert.equal(runtime.snapshot().voice.replacedDraft, '写了一半的草稿')
  assert.equal(runtime.snapshot().voice.pending, null, 'ack 后 pending 必须清空')

  // 重复 ack 必须被拒（幂等）
  const repeat = await runtime.dispatch('voice.ack', { resultId: 'v-test', ok: true })
  assert.equal(repeat.ok, false)
  await runtime.dispose()
})
