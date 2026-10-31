/**
 * 任务状态聚合域：运行计时（elapsedMs / sinceReliable）。
 *
 * 这里守的是几条**看起来会"差不多对"、实际会骗人**的规则：
 *   - 起点只认 turn/start；中途观察到的起点必须标成不可靠，**且不下发计时**；
 *   - 后到的 api-session/status 不许把可靠起点降级，也不许把起点推后；
 *   - 多会话取最早开始，最早那个结束后基准前移，且要重播一次种子；
 *   - 断线不清锚点（清了你就会看到"掉线一分钟、时长少一分钟"）。
 *
 * 全部用固定时钟，不依赖真实时间流逝。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { StateDomain } from './state.js'
import { MSG, TASK_STATE } from '../protocol/constants.js'

/** 假链路：只记下发出去的消息，状态恒为 connected（除非测试显式改）。 */
class FakeLink {
  constructor() {
    this.sent = []
    this.state = 'connected'
  }

  snapshot() {
    return { state: this.state }
  }

  async send(type, payload) {
    this.sent.push({ type, payload })
  }
}

/** 假宿主上下文：只实现 ctx.on，并把事件手动投递进来。 */
function makeCtx() {
  const handlers = new Map()
  return {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(handler)
      return () => {}
    },
    emit(name, ...args) {
      for (const handler of handlers.get(name) ?? []) handler(...args)
    },
    get() {
      return null
    },
  }
}

/** 固定时钟：set(ms) 之后 Date.now() 返回该值。 */
function useFakeClock(start = 1_000_000) {
  const realNow = Date.now
  let now = start
  Date.now = () => now
  return {
    set(ms) {
      now = ms
    },
    advance(ms) {
      now += ms
    },
    restore() {
      Date.now = realNow
    },
  }
}

function makeDomain(options = {}) {
  const link = new FakeLink()
  const domain = new StateDomain({ link, logger: () => {}, domainState: null, ...options })
  const ctx = makeCtx()
  domain.attach(null, ctx)
  link.sent.length = 0 // 丢掉 attach 的首推
  return { link, domain, ctx }
}

const lastTaskState = (link) => link.sent.filter((m) => m.type === MSG.TASK_STATE).at(-1)?.payload

test('turn/start 播种：可靠起点 + 时长从 0 起算', () => {
  const clock = useFakeClock()
  try {
    const { link, domain, ctx } = makeDomain()
    clock.set(1_000_000)
    ctx.emit('session/event', { sessionId: 's1' }, { kind: 'turn/start' })

    const payload = lastTaskState(link)
    assert.equal(payload.state, TASK_STATE.RUNNING)
    assert.equal(payload.title, '1 个任务执行中')
    assert.equal(payload.elapsedMs, 0)
    assert.equal(payload.sinceReliable, true)
    assert.equal(domain.snapshot().runningCount, 1)
  } finally {
    clock.restore()
  }
})

test('只有 api-session/status 时：起点不可靠，干脆不下发计时', () => {
  const clock = useFakeClock()
  try {
    const { link, ctx } = makeDomain()
    clock.set(1_000_000)
    ctx.emit('api-session/status', 's1', true)

    const payload = lastTaskState(link)
    assert.equal(payload.state, TASK_STATE.RUNNING)
    // ★ 设备端按设计稿只印纯 MM:SS，没有位置标注「这是近似值」。
    //   既然起点偏晚、数字会系统性偏小，就不给数字 —— 空着比错着强。
    assert.equal(payload.elapsedMs, undefined, '不可靠起点不下发 elapsedMs')
    assert.equal(payload.sinceReliable, undefined)
  } finally {
    clock.restore()
  }
})

test('先 status 后 turn/start：可靠起点可升级，且起点不被推后', () => {
  const clock = useFakeClock()
  try {
    const { link, ctx } = makeDomain()
    clock.set(1_000_000)
    ctx.emit('api-session/status', 's1', true)
    clock.set(1_004_000)
    ctx.emit('session/event', { sessionId: 's1' }, { kind: 'turn/start' })

    const payload = lastTaskState(link)
    assert.equal(payload.sinceReliable, true, 'turn/start 应把起点升级为可靠')
    assert.equal(payload.elapsedMs, 4_000, '起点仍是首次观察到的时刻，不能被推后')
  } finally {
    clock.restore()
  }
})

test('先 turn/start 后 status：可靠起点不被降级', () => {
  const clock = useFakeClock()
  try {
    const { link, ctx } = makeDomain()
    clock.set(1_000_000)
    ctx.emit('session/event', { sessionId: 's1' }, { kind: 'turn/start' })
    clock.set(1_001_000)
    ctx.emit('api-session/status', 's1', true)

    assert.equal(lastTaskState(link).sinceReliable, true)
  } finally {
    clock.restore()
  }
})

test('多会话取最早；最早结束则基准前移并重播种子', () => {
  const clock = useFakeClock()
  try {
    const { link, domain, ctx } = makeDomain()
    clock.set(1_000_000)
    ctx.emit('session/event', { sessionId: 'a' }, { kind: 'turn/start' })

    clock.set(1_010_000)
    ctx.emit('session/event', { sessionId: 'b' }, { kind: 'turn/start' })
    assert.equal(lastTaskState(link).elapsedMs, 10_000, '应取最早开始的 a')
    assert.equal(lastTaskState(link).title, '2 个任务执行中')

    clock.set(1_012_000)
    ctx.emit('session/event', { sessionId: 'a' }, { kind: 'turn/end' })
    assert.equal(lastTaskState(link).elapsedMs, 2_000, 'a 结束后基准应前移到 b 的开始时刻')
    assert.equal(domain.snapshot().runningCount, 1)
  } finally {
    clock.restore()
  }
})

test('任务数 1→2 必须重推（旧实现只比 state，会吞掉标题变化）', () => {
  const clock = useFakeClock()
  try {
    const { link, ctx } = makeDomain()
    clock.set(1_000_000)
    ctx.emit('session/event', { sessionId: 'a' }, { kind: 'turn/start' })
    clock.set(1_001_000)
    ctx.emit('session/event', { sessionId: 'b' }, { kind: 'turn/start' })

    const titles = link.sent.filter((m) => m.type === MSG.TASK_STATE).map((m) => m.payload.title)
    assert.deepEqual(titles, ['1 个任务执行中', '2 个任务执行中'])
  } finally {
    clock.restore()
  }
})

test('同一秒内的重复事件被合并，不刷屏', () => {
  const clock = useFakeClock()
  try {
    const { link, ctx } = makeDomain()
    clock.set(1_000_000)
    ctx.emit('session/event', { sessionId: 'a' }, { kind: 'turn/start' })
    const before = link.sent.length
    ctx.emit('session/event', { sessionId: 'a' }, { kind: 'tool/call' })
    ctx.emit('api-session/status', 'a', true)
    assert.equal(link.sent.length, before, '状态、标题、秒数都没变时不应再发')
  } finally {
    clock.restore()
  }
})

test('断线保留锚点：重连后时长继续，不归零', () => {
  const clock = useFakeClock()
  try {
    const { link, domain, ctx } = makeDomain()
    clock.set(1_000_000)
    ctx.emit('session/event', { sessionId: 'a' }, { kind: 'turn/start' })

    link.state = 'idle'
    clock.set(1_060_000)
    domain.onLinkReset()
    link.state = 'connected'
    domain.onLinkReady()

    const payload = lastTaskState(link)
    assert.equal(payload.elapsedMs, 60_000, '断线期间任务仍在跑，锚点不能丢')
    assert.equal(payload.sinceReliable, true)
  } finally {
    clock.restore()
  }
})

test('录音期间抑制推送；结束后补推且时长正确', () => {
  const clock = useFakeClock()
  try {
    const { link, domain, ctx } = makeDomain()
    clock.set(1_000_000)
    domain.setDeviceRecording(true)
    ctx.emit('session/event', { sessionId: 'a' }, { kind: 'turn/start' })
    assert.equal(lastTaskState(link), undefined, '录音期间的推送应被抑制')

    clock.set(1_003_000)
    domain.setDeviceRecording(false)
    const payload = lastTaskState(link)
    assert.equal(payload.state, TASK_STATE.RUNNING)
    assert.equal(payload.elapsedMs, 3_000)
  } finally {
    clock.restore()
  }
})

test('待审批保留锚点：回到运行中时计时连续', () => {
  const clock = useFakeClock()
  try {
    const { link, domain, ctx } = makeDomain()
    clock.set(1_000_000)
    ctx.emit('session/event', { sessionId: 'a' }, { kind: 'turn/start' })

    clock.set(1_002_000)
    domain.setApproval('Bash')
    assert.equal(lastTaskState(link).state, TASK_STATE.WAITING_APPROVAL)
    assert.equal(lastTaskState(link).elapsedMs, undefined, '待审批不下发计时')

    clock.set(1_030_000)
    domain.setApproval(null)
    const payload = lastTaskState(link)
    assert.equal(payload.state, TASK_STATE.RUNNING)
    assert.equal(payload.elapsedMs, 30_000, '审批等待计入，不是从零开始')
  } finally {
    clock.restore()
  }
})

test('detach 清空起点：重连后先不给计时，等下一次 turn/start 才恢复', () => {
  const clock = useFakeClock()
  try {
    const { link, domain, ctx } = makeDomain()
    clock.set(1_000_000)
    ctx.emit('session/event', { sessionId: 'a' }, { kind: 'turn/start' })

    domain.detach()
    const ctx2 = makeCtx()
    domain.attach(null, ctx2)
    link.sent.length = 0

    // 重连后只看到 status(true)：起点是"首次观察"，不可靠 → 不计时
    clock.set(1_100_000)
    ctx2.emit('api-session/status', 'a', true)
    assert.equal(lastTaskState(link).elapsedMs, undefined, '不可靠起点不下发')

    // 下一轮 turn/start 到达即可恢复：起点沿用首次观察时刻，不推后
    clock.set(1_102_000)
    ctx2.emit('session/event', { sessionId: 'a' }, { kind: 'turn/start' })
    const payload = lastTaskState(link)
    assert.equal(payload.sinceReliable, true)
    assert.equal(payload.elapsedMs, 2_000, '从首次观察时刻起算，不从 turn/start 重新开始')
  } finally {
    clock.restore()
  }
})

test('status 成对 true/false 不重置起点（真机 bug：计时恒为 0）', () => {
  const clock = useFakeClock()
  try {
    const { link, ctx } = makeDomain()
    clock.set(1_000_000)
    // 用 turn/start 立一个可靠起点：只有可靠起点才会下发计时，
    // 否则这条用例会因为"根本没下发"而空过。
    ctx.emit('session/event', { sessionId: 's1' }, { kind: 'turn/start' })

    // DSH 在同一轮里会成对发 true/false —— 工具调用之间也有短暂 false。
    clock.advance(2_000)
    ctx.emit('api-session/status', 's1', false)
    clock.advance(500)
    ctx.emit('api-session/status', 's1', true)
    clock.advance(3_500)
    ctx.emit('api-session/status', 's1', true)

    const payload = lastTaskState(link)
    assert.equal(
      payload.elapsedMs,
      6_000,
      '起点必须还是第一次 true 的时刻，不能被中间的 false 推后',
    )
    assert.equal(payload.sinceReliable, true, 'status 不得把可靠起点降级')
  } finally {
    clock.restore()
  }
})

test('静默超过 idleEndMs 才结束：先进「已完成」，再回空闲', async () => {
  const clock = useFakeClock()
  try {
    const { domain, ctx } = makeDomain({ idleEndMs: 5 })
    clock.set(1_000_000)
    ctx.emit('api-session/status', 's1', true)
    ctx.emit('api-session/status', 's1', false)

    assert.equal(domain.current().state, TASK_STATE.RUNNING, '窗口内仍算在跑（吸收闪断）')

    clock.advance(20)
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.equal(domain.snapshot().runningCount, 0, '超过窗口应摘掉会话')
    assert.equal(domain.current().state, TASK_STATE.COMPLETED, '结束后先进「已完成」')

    clock.advance(8_500)
    assert.equal(domain.current().state, TASK_STATE.IDLE, '停留期满回空闲')
  } finally {
    clock.restore()
  }
})

test('turn/end 立即结束：状态进「已完成」，不再下发计时', () => {
  const clock = useFakeClock()
  try {
    const { link, domain, ctx } = makeDomain()
    clock.set(1_000_000)
    ctx.emit('session/event', { sessionId: 's1' }, { kind: 'turn/start' })
    clock.advance(5_000)
    ctx.emit('session/event', { sessionId: 's1' }, { kind: 'turn/end' })

    assert.equal(domain.snapshot().runningCount, 0)
    const payload = lastTaskState(link)
    assert.equal(payload.state, TASK_STATE.COMPLETED)
    assert.equal(payload.elapsedMs, undefined, '结束后不该带着一个还在走的数字')
  } finally {
    clock.restore()
  }
})

test('turnTrace 只记轮次边界，不被 step/tool 淹没', () => {
  // 这条守的是排查工具本身：一旦一轮的 step/tool 把环形缓冲挤满，
  // 就会得出"DSH 没有 turn/end"这种结论（真的踩过）。
  const clock = useFakeClock()
  try {
    const domainState = {}
    const { domain, ctx } = makeDomain({ domainState })
    clock.set(1_000_000)
    ctx.emit('session/event', { sessionId: 's1' }, { kind: 'turn/start' })
    for (let i = 0; i < 30; i++) {
      ctx.emit('session/event', { sessionId: 's1' }, { kind: 'tool/call' })
    }
    clock.advance(5_000)
    ctx.emit('session/event', { sessionId: 's1' }, { kind: 'turn/end' })
    ctx.emit('api-session/status', 's1', false)

    assert.deepEqual(
      domainState.turnTrace.map((entry) => entry.k),
      ['turn/start', 'turn/end', 'status:idle'],
    )
    // 噪音仍在 stateTrace 里，只是不占边界的位子
    assert.equal(domainState.stateTrace.filter((e) => e.k === 'event:tool/call').length, 30)
    domain.detach()
  } finally {
    clock.restore()
  }
})

test('每次推送都带主机墙钟：UTC 秒 + 时区偏移分钟', () => {
  const clock = useFakeClock()
  try {
    const { link, ctx } = makeDomain()
    // 用一个明确的时刻，便于断言"秒不是毫秒"
    const nowMs = 1_790_000_000_000
    clock.set(nowMs)
    ctx.emit('session/event', { sessionId: 's1' }, { kind: 'turn/start' })

    const running = lastTaskState(link)
    assert.equal(running.hostEpochSec, Math.floor(nowMs / 1000), '发秒，不发毫秒（C3 的 long 只有 32 位）')
    assert.equal(
      running.hostTzOffsetMin,
      -new Date().getTimezoneOffset(),
      '东正西负：北京应为 +480',
    )

    // 结束后（已完成 / 空闲）也必须带 —— 状态条上的时钟在空闲时同样要显示
    clock.advance(3_000)
    ctx.emit('session/event', { sessionId: 's1' }, { kind: 'turn/end' })
    const done = lastTaskState(link)
    assert.equal(done.state, TASK_STATE.COMPLETED)
    assert.equal(done.hostEpochSec, Math.floor((nowMs + 3_000) / 1000), '时钟要跟着走，不是只发一次')
    assert.equal(done.hostTzOffsetMin, -new Date().getTimezoneOffset())
  } finally {
    clock.restore()
  }
})
