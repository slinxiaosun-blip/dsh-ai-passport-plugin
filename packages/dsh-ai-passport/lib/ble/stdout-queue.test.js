/**
 * 桥进程 stdout 背压队列的单测。
 *
 * 这类逻辑没有"报错"这种显式失败面：写不进去时它要么丢帧、要么无限涨内存，
 * 两种都只在真机高负载（语音上行时每 20ms 一帧）时才现形。所以必须用
 * 可控的 write 返回值把它钉死。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createStdoutQueue } from './stdout-queue.js'

/** 造一个可控的 stdout：writable=false 时 write 返回 false，drain() 手动触发。 */
function fakeStdout(options = {}) {
  const written = []
  let drainCallback = null
  const state = { writable: options.writable ?? true, drainArmed: 0 }

  const queue = createStdoutQueue({
    write: (line) => {
      // ★ 与 Node 的语义一致：write() 总是先把这一行接下（进它自己的缓冲），
      //   返回值只是"要不要暂停"的水位信号，不是"拒收"。
      written.push(line)
      return state.writable
    },
    onDrain: (callback) => {
      state.drainArmed += 1
      drainCallback = callback
    },
    log: () => {},
    limit: options.limit,
  })

  return {
    queue,
    written,
    state,
    /** 让 stdout 恢复可写并触发 drain。 */
    drain() {
      state.writable = true
      const callback = drainCallback
      drainCallback = null
      callback?.()
    },
  }
}

test('可写时直接写，不进队列', () => {
  const { queue, written } = fakeStdout()
  queue.send({ event: 'ready', pid: 1 })
  assert.equal(written.length, 1)
  assert.equal(queue.length, 0)
  assert.equal(queue.blocked, false)
  assert.match(written[0], /"event":"ready"/)
  assert.ok(written[0].endsWith('\n'), '每行必须以换行结束（JSON Lines）')
})

test('★ 写不动时入队，drain 之后按序补写（旧实现是假背压：照样继续 write）', () => {
  const { queue, written, state, drain } = fakeStdout()

  state.writable = false
  queue.send({ id: 1, ok: true, value: 'a' }) // 这一行的 write 返回 false → 进入背压
  assert.equal(queue.blocked, true)
  assert.equal(written.length, 1, '返回 false 的那一行已被流接下，不该再入队')

  // 背压期间的消息全部入队，不再写
  queue.send({ id: 2, ok: true, value: 'b' })
  queue.send({ event: 'device', id: 'd1' })
  assert.equal(written.length, 1, '背压期间不能再往 stdout 灌数据')
  assert.equal(queue.length, 2)

  drain()
  assert.equal(queue.length, 0, 'drain 后队列必须清空')
  assert.equal(queue.blocked, false)
  // 顺序必须保持：先 1，再 2，再 device
  assert.match(written[0], /"id":1/)
  assert.match(written[1], /"id":2/)
  assert.match(written[2], /"event":"device"/)
})

test('★ 队列溢出时只丢 data 帧，命令回执与错误永远保留', () => {
  const { queue, written, state, drain } = fakeStdout({ limit: 3 })

  state.writable = false
  queue.send({ id: 0, ok: true }) // 触发 blocked（这一行已被接下）
  // 队列上限 3：先塞满三条 data
  queue.send({ event: 'data', seq: 1 })
  queue.send({ event: 'data', seq: 2 })
  queue.send({ event: 'data', seq: 3 })
  assert.equal(queue.length, 3)

  // 再来一条 data → 淘汰最旧的 data，仍然只有 3 条
  queue.send({ event: 'data', seq: 4 })
  assert.equal(queue.length, 3)
  assert.equal(queue.dropped, 1)

  // 再来一条 reply → 也只能淘汰 data，reply 必须入队
  queue.send({ id: 9, ok: false, error: { code: 'x', message: 'y' } })
  assert.equal(queue.length, 3, '淘汰了一条 data 之后 reply 才能进来')

  drain()
  const text = written.join('')
  assert.ok(text.includes('"id":9'), '错误回执必须送达，否则上层会挂到超时')
  assert.ok(text.includes('"seq":4'), '最新的 data 帧应当被保留（丢的是最旧的）')
  assert.ok(!text.includes('"seq":1'), '最旧的 data 帧应当已被淘汰')
  assert.ok(!text.includes('"seq":2'), '队列满时优先淘汰 data，而不是挤掉回执')
})

test('恢复后计数归零，不会把上一轮的丢弃数算到下一轮', () => {
  const { queue, state, drain } = fakeStdout({ limit: 2 })

  state.writable = false
  queue.send({ id: 0, ok: true })
  queue.send({ event: 'data', seq: 1 })
  queue.send({ event: 'data', seq: 2 })
  queue.send({ event: 'data', seq: 3 })
  assert.ok(queue.dropped > 0)

  drain()
  assert.equal(queue.dropped, 0, '恢复后丢弃计数应清零')

  // 第二轮背压
  state.writable = false
  queue.send({ id: 5, ok: true })
  assert.equal(queue.blocked, true)
  assert.equal(queue.dropped, 0, '新一轮的计数不应继承上一轮')
})

test('write 抛错不会被吞成静默丢数据（异常继续冒泡给调用方）', () => {
  const queue = createStdoutQueue({
    write: () => {
      throw new Error('EPIPE')
    },
    onDrain: () => {},
    log: () => {},
  })
  // 队列本身不捕获异常：桥进程的写错误属于"管道断了"，应当尽快暴露。
  assert.throws(() => queue.send({ event: 'ready' }), /EPIPE/)
})
