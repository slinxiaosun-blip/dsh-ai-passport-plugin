/**
 * 追问域测试（docs/06 §3/§4，2026-10-06 竞速模型改版）。
 *
 * 竞速语义：电脑卡片与设备**同时**开跑，先答者胜；设备分支退出（取消/超时/断链）
 * 不再 next() 交回电脑端 —— 卡片从一开始就显示着，竞速继续等它。
 *
 * 这里锁死四类结局 + 载荷约束：
 *   设备先答 / 电脑先答（设备收到 done）/ 两边都没答 / 要求修改（ASK_CANCELLED），
 *   以及"极短摘要 + 截断选项"的载荷预算。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { QuestionsDomain } from './questions.js'
import { MSG } from '../protocol/constants.js'

/**
 * 测试台。
 *
 * `next` 模拟内置电脑卡片：默认**挂起不答**（真实卡片就是这样等用户点的），
 * 用 `answerCard(value)` 显式让它作答；这样竞速的两条路都可以被精确驱动。
 */
function makeHarness({ questions: config = {}, connected = true, request, cardValue, userQuestions } = {}) {
  const sent = []
  const handlers = new Map()
  const linkHandlers = new Map()
  const link = {
    transport: { on() {}, off() {} },
    onMessage(type, fn) {
      handlers.set(type, fn)
      return () => handlers.delete(type)
    },
    send: async (type, payload) => {
      sent.push({ type, payload })
      return {}
    },
    snapshot: () => ({ state: connected ? 'connected' : 'idle' }),
    on(name, fn) {
      linkHandlers.set(name, fn)
      return () => linkHandlers.delete(name)
    },
    off(name) {
      linkHandlers.delete(name)
    },
  }

  let cardResolve = null
  let cardReject = null
  const cardPending = new Promise((resolve, reject) => { cardResolve = resolve; cardReject = reject })
  const next = () => (cardValue !== undefined ? Promise.resolve(cardValue) : cardPending)

  let questionHandler = null
  const ctx = {
    on(name, fn) {
      if (name === 'user-questions/request') questionHandler = fn
      return () => {}
    },
    // 计时追问的补答通道（官方 userQuestions 服务）按需注入
    get: (name) => (name === 'userQuestions' ? (userQuestions ?? null) : null),
  }

  const domainState = {}
  const domain = new QuestionsDomain({
    link,
    config: { questions: { enabled: true, timeoutMs: 120000, ...config } },
    logger: () => {},
    broadcast: () => {},
    domainState,
  })
  domain.attach({}, ctx)

  const ask = (req = request ?? defaultRequest()) => Promise.resolve(questionHandler(req, next))

  return {
    domain,
    sent,
    handlers,
    linkHandlers,
    ask,
    answerCard: (value) => cardResolve(value),
    rejectCard: (error) => cardReject(error),
  }
}

function defaultRequest() {
  return {
    callId: 'call-1',
    questions: [
      {
        id: 'q1',
        question: '选择要构建的目标平台？这是一句很长的题干用来验证设备只收摘要',
        detail: '这是一段超出设备屏幕预算的详情'.repeat(10),
        multiSelect: true,
        options: [
          { label: 'macOS', description: '推荐' },
          { label: 'Windows' },
          { label: 'Linux' },
        ],
      },
      {
        id: 'q2',
        question: '要不要跑测试？',
        multiSelect: false,
        options: [{ label: '跑' }, { label: '不跑' }],
      },
    ],
  }
}

const questionsSent = (sent) => sent.filter((m) => m.type === MSG.QUESTION_REQ)
const doneSent = (sent) => sent.filter((m) => m.type === MSG.QUESTION_DONE)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('设备不在/功能关闭：不动设备，直接由电脑卡片作答', async () => {
  for (const options of [{ connected: false }, { questions: { enabled: false } }]) {
    const { sent, ask } = makeHarness({ ...options, cardValue: 'card-answer' })
    assert.equal(await ask(), 'card-answer')
    assert.equal(questionsSent(sent).length, 0, '不应下发 question.req')
  }
})

test('多题逐题下发；提交时未答题按 Skip，整批恰好覆盖每道题', async () => {
  const { sent, handlers, ask } = makeHarness()
  const outcomePromise = ask()

  assert.equal(questionsSent(sent).length, 1, '先只发第 1 题')
  const first = questionsSent(sent)[0].payload
  assert.equal(first.callId, 'call-1')
  assert.equal(first.index, 0)
  assert.equal(first.total, 2)
  assert.equal(first.multiSelect, 1, '标志拍平成 0/1（设备端不解析 JSON 布尔）')
  assert.ok(first.summary.length <= 12, '设备只收一行极短摘要')
  assert.ok(!('question' in first) && !('detail' in first), '正文不再下发设备')
  assert.equal(first.options, 'macOS|Windows|Linux', '选项拍平成 | 分隔')
  assert.equal(first.recommendedIndex, 0, '“推荐”选项下标要传给设备做预选')
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') < 1024, '单条必须低于设备 1024B 上限')

  // 只答第 1 题；q2 不答 → Skip
  handlers.get(MSG.QUESTION_PICK)({ callId: 'call-1', qid: 'q1', selected: ['macOS', 'Linux'], custom: '还要 Android' })
  handlers.get(MSG.QUESTION_ANSWER)({ callId: 'call-1', action: 'submit' })

  const outcome = await outcomePromise
  assert.deepEqual(outcome.answers, [
    { id: 'q1', selected: ['macOS', 'Linux'], custom: '还要 Android' },
    { id: 'q2', selected: [] },
  ])
  assert.equal(doneSent(sent)[0]?.payload.ok, 1)
})

test('电脑卡片先答：设备收到 done 收起，答案是电脑那份', async () => {
  const { sent, ask, answerCard } = makeHarness()
  const outcomePromise = ask()
  assert.equal(questionsSent(sent).length, 1, '设备分支已启动（两边同时显示）')

  answerCard({ answers: [{ id: 'q1', selected: ['macOS'] }] })
  const outcome = await outcomePromise
  assert.deepEqual(outcome.answers, [{ id: 'q1', selected: ['macOS'] }])

  const done = doneSent(sent)[0]
  assert.equal(done?.payload.ok, 0, '设备页应被收起')
  assert.equal(done?.payload.reason, 'answered-elsewhere')
})

test('设备先答 → 中止下游 signal（网页卡片才会自动收起）', async () => {
  const request = defaultRequest()
  const { handlers, ask } = makeHarness({ request })
  const outcomePromise = ask()
  handlers.get(MSG.QUESTION_ANSWER)({ callId: 'call-1', action: 'submit' })
  await outcomePromise
  // 客户端卡片用 request.signal 作为等待生命周期，只有它结束卡片才会被移除
  assert.equal(request.signal?.aborted, true, '设备胜出后必须中止下游 request')
})

test('单选题的多选被钳制成互斥（协议层不信任 UI）', async () => {
  const { handlers, ask } = makeHarness()
  const outcomePromise = ask()
  handlers.get(MSG.QUESTION_PICK)({ callId: 'call-1', qid: 'q2', selected: ['跑', '不跑'] })
  handlers.get(MSG.QUESTION_ANSWER)({ callId: 'call-1', action: 'submit' })
  const outcome = await outcomePromise
  assert.deepEqual(outcome.answers.find((a) => a.id === 'q2').selected, ['不跑'], '只留最后一次选择')
})

test('question.nav 切换题目并重发 question.req', async () => {
  const { domain, sent, handlers, ask } = makeHarness()
  void ask()
  handlers.get(MSG.QUESTION_NAV)({ callId: 'call-1', index: 1 })
  const reqs = questionsSent(sent)
  assert.equal(reqs.length, 2)
  assert.equal(reqs[1].payload.index, 1)
  assert.equal(reqs[1].payload.qid, 'q2')
  assert.equal(reqs[1].payload.multiSelect, 0)
  await domain.dispose()
})

test('设备取消 → 设备分支退出，电脑卡片仍可作答', async () => {
  const { sent, handlers, ask, answerCard } = makeHarness()
  const outcomePromise = ask()
  handlers.get(MSG.QUESTION_ANSWER)({ callId: 'call-1', action: 'cancel' })
  assert.equal(doneSent(sent).length, 0, '用户主动取消不发 question.done（设备自己收起）')
  answerCard('card-answer')
  assert.equal(await outcomePromise, 'card-answer')
})

test('计划待审不设超时：时间到了也不收页，一直等用户作答', async () => {
  const { sent, handlers, ask } = makeHarness({
    questions: { timeoutMs: 20 },   // 普通追问会在这个时间收页
    request: {
      callId: 'call-plan',
      questions: [{
        id: 'p1',
        question: '重构语音链路',
        options: [{ label: '同意执行' }],
        intent: { kind: 'plan-review', approve: '同意执行' },
      }],
    },
  })
  const outcomePromise = ask()
  await wait(60)
  assert.equal(doneSent(sent).length, 0, '计划待审不该自己收页（用户要求：一直停留）')
  assert.equal(questionsSent(sent).length, 1, '也不该重发')

  // 用户最终在设备上作答 → 正常提交
  handlers.get(MSG.QUESTION_PICK)({ callId: 'call-plan', qid: 'p1', selected: ['同意执行'] })
  handlers.get(MSG.QUESTION_ANSWER)({ callId: 'call-plan', action: 'submit' })
  const outcome = await outcomePromise
  assert.deepEqual(outcome.answers, [{ id: 'p1', selected: ['同意执行'] }])
  assert.equal(doneSent(sent)[0]?.payload.ok, 1)
})

test('设备超时 → question.done 收起设备页，竞速继续等电脑卡片', async () => {
  const { sent, ask, answerCard } = makeHarness({ questions: { timeoutMs: 20 } })
  const outcomePromise = ask()
  await wait(60)
  const done = doneSent(sent)[0]
  assert.equal(done?.payload.ok, 0)
  assert.equal(done?.payload.reason, 'timeout')
  answerCard('card-answer')
  assert.equal(await outcomePromise, 'card-answer', '设备超时不该拖死电脑那条路')
})

test('断链 → 设备分支退出并通知收起，电脑卡片仍可作答', async () => {
  const { sent, linkHandlers, ask, answerCard } = makeHarness()
  const outcomePromise = ask()
  linkHandlers.get('disconnected')({ reason: 'link lost' })
  assert.equal(doneSent(sent)[0]?.payload.reason, 'disconnected')
  answerCard('card-answer')
  assert.equal(await outcomePromise, 'card-answer')
})

test('dispose 时设备分支退出且不悬挂', async () => {
  const { domain, ask, answerCard } = makeHarness({ questions: { timeoutMs: 10000 } })
  const outcomePromise = ask()
  await domain.dispose()
  answerCard('card-answer')
  assert.equal(await outcomePromise, 'card-answer')
})

const timedOut = () => Object.assign(new Error('timed out'), {
  name: 'UserQuestionError', code: 'ASK_TIMED_OUT',
})

test('计时追问：卡片超时后设备仍可补答，经 userQuestions.answer 投递', async () => {
  const calls = []
  const service = {
    answer: async (agent, callId, answer) => { calls.push({ agent, callId, answer }) },
  }
  const request = {
    ...defaultRequest(),
    agent: { id: 'agent-1' },
    wait: { timed: true, callId: 'call-77' },
  }
  const { sent, handlers, ask, rejectCard } = makeHarness({ request, userQuestions: service })
  const outcomePromise = ask()
  rejectCard(timedOut())

  await wait(10)
  assert.equal(questionsSent(sent).length, 1, '补答窗口里设备页继续显示（不重发）')
  handlers.get(MSG.QUESTION_ANSWER)({ callId: 'call-1', action: 'submit' })

  // ★ 瀑布最终仍以 ASK_TIMED_OUT 结束：工具侧语义保持 pending
  await assert.rejects(outcomePromise, (error) => error.code === 'ASK_TIMED_OUT')
  assert.equal(calls.length, 1, '补答只投递一次')
  assert.equal(calls[0].callId, 'call-77', '投递用的是 wait.callId')
  assert.deepEqual(calls[0].answer.answers.map((a) => a.id), ['q1', 'q2'], '整批答案')
  const done = doneSent(sent)[0]
  assert.equal(done?.payload.ok, 1)
  assert.equal(done?.payload.reason, 'continued-answered')
})

test('计时追问：补答被 REPLY_QUEUED 拒绝时，收起设备页并说明已在他处作答', async () => {
  const service = {
    answer: async () => { throw Object.assign(new Error('queued'), { code: 'REPLY_QUEUED' }) },
  }
  const request = { ...defaultRequest(), wait: { timed: true, callId: 'call-78' } }
  const { sent, handlers, ask, rejectCard } = makeHarness({ request, userQuestions: service })
  const outcomePromise = ask()
  rejectCard(timedOut())
  await wait(10)
  handlers.get(MSG.QUESTION_ANSWER)({ callId: 'call-1', action: 'submit' })

  await assert.rejects(outcomePromise, (error) => error.code === 'ASK_TIMED_OUT')
  const done = doneSent(sent)[0]
  assert.equal(done?.payload.ok, 0)
  assert.equal(done?.payload.reason, 'answered-elsewhere')
})

test('非计时追问的电脑端报错：仍按原样收设备页（回归钉子，不许退化成永不收页）', async () => {
  const { sent, ask, rejectCard } = makeHarness()
  const outcomePromise = ask()
  rejectCard(Object.assign(new Error('cancelled'), { code: 'ASK_CANCELLED' }))
  await assert.rejects(outcomePromise, (error) => error.code === 'ASK_CANCELLED')
  const done = doneSent(sent)[0]
  assert.equal(done?.payload.ok, 0)
  assert.equal(done?.payload.reason, 'timeout')
})

test('「要求修改」（reject）→ 拒绝等待成 ASK_CANCELLED，不是电脑卡片作答', async () => {
  const { handlers, ask } = makeHarness()
  const outcomePromise = ask()
  handlers.get(MSG.QUESTION_ANSWER)({ callId: 'call-1', action: 'reject' })
  await assert.rejects(outcomePromise, (error) => {
    assert.equal(error.name, 'UserQuestionError')
    assert.equal(error.code, 'ASK_CANCELLED')
    return true
  })
})

test('plan-review 题按 kind=plan 下发并带 approveLabel', async () => {
  const { domain, sent, ask } = makeHarness({
    request: {
      callId: 'call-2',
      questions: [{
        id: 'p1',
        question: '重构登录模块的鉴权层',
        detail: '# 计划\n1. 提取 Token 校验中间件',
        multiSelect: false,
        intent: { kind: 'plan-review', approve: 'Approve' },
        options: [{ label: 'Approve' }, { label: 'Request changes' }],
      }],
    },
  })
  void ask()
  const payload = questionsSent(sent)[0].payload
  assert.equal(payload.kind, 'plan')
  assert.equal(payload.approveLabel, 'Approve')
  assert.ok(!('detail' in payload), '计划正文不下发设备（留在电脑卡片）')
  await domain.dispose()
})

test('批次隔离：旧批次的消息不许改当前批次', async () => {
  const { handlers, ask } = makeHarness()
  const outcomePromise = ask()
  handlers.get(MSG.QUESTION_PICK)({ callId: 'stale-call', qid: 'q1', selected: ['macOS'] })
  handlers.get(MSG.QUESTION_ANSWER)({ callId: 'stale-call', action: 'submit' })
  handlers.get(MSG.QUESTION_ANSWER)({ callId: 'call-1', action: 'submit' })
  const outcome = await outcomePromise
  assert.deepEqual(outcome.answers.find((a) => a.id === 'q1').selected, [])
})
