/**
 * 配对域（阶段 C）的回归钉子。
 *
 * 覆盖的是"最容易静默出错"的几条：信任表落盘/读取、token 是否随握手带出、
 * 设备要求配对时是否把 UI 打开、失败原因是否如实上报、解除配对是否两侧都清。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { PairingDomain } from '../lib/bridge/pairing.js'

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pair-'))
  return path.join(dir, 'pairing.json')
}

/** 极简假链路：只实现配对域用到的四件事。 */
function fakeLink() {
  const handlers = new Map()
  const sent = []
  const events = []
  return {
    sent,
    events,
    hostInfo: { hostName: 'test-mac' },
    token: null,
    onMessage(type, cb) {
      handlers.set(type, cb)
      return () => handlers.delete(type)
    },
    async send(type, payload) {
      sent.push({ type, payload })
    },
    setHostToken(token) {
      this.token = token
    },
    emit(name, payload) {
      events.push({ name, payload })
    },
    deliver(type, payload) {
      const handler = handlers.get(type)
      if (handler) handler(payload)
    },
  }
}

test('配对：设备报 paired:0 → 打开配对入口；pair.ok 后写入信任表并带 token 重新握手', async () => {
  const storePath = tmpStore()
  const link = fakeLink()
  const domain = new PairingDomain({ link, logger: () => {}, storePath })
  domain.attach()

  link.deliver('hello', { protocolVersion: 1, paired: 0, deviceId: 'a1b2c3' })
  assert.equal(domain.snapshot().needed, true, '未配对必须让用户看到入口')
  assert.equal(domain.snapshot().deviceId, 'a1b2c3')

  domain.submit('123456')
  const begin = link.sent.find((m) => m.type === 'pair.begin')
  assert.ok(begin, '应当发出 pair.begin')
  assert.equal(begin.payload.code, '123456')
  assert.equal(begin.payload.host, 'test-mac')

  link.deliver('pair.ok', { deviceId: 'a1b2c3', token: 'a'.repeat(32) })
  assert.equal(domain.snapshot().paired, true)
  assert.equal(domain.snapshot().needed, false)
  assert.equal(link.token, 'a'.repeat(32), 'token 必须塞给链路，后续 hello 才带得上')

  const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'))
  assert.equal(saved.token, 'a'.repeat(32))
  assert.equal(saved.deviceId, 'a1b2c3')
  assert.ok(link.sent.some((m) => m.type === 'hello' && m.payload.token === 'a'.repeat(32)),
    '配对成功后应立刻用 token 重新握手')
  await domain.dispose()
  fs.rmSync(path.dirname(storePath), { recursive: true, force: true })
})

test('配对：失败原因如实上报（码错 / 限流 + 剩余次数 / 非法输入不发包）', async () => {
  const storePath = tmpStore()
  const link = fakeLink()
  const domain = new PairingDomain({ link, logger: () => {}, storePath })
  domain.attach()

  const bad = domain.submit('12')
  assert.equal(bad.ok, false)
  assert.equal(domain.snapshot().error, 'bad-input')
  assert.equal(link.sent.length, 0, '非法输入不应发包')

  domain.submit('123456')
  link.deliver('pair.failed', { reason: 'bad-code', remaining: 2 })
  assert.equal(domain.snapshot().error, 'bad-code')
  assert.equal(domain.snapshot().remaining, 2)
  assert.equal(domain.snapshot().needed, true)

  link.deliver('pair.failed', { reason: 'rate-limited', remaining: 0 })
  assert.equal(domain.snapshot().error, 'rate-limited')
  assert.equal(domain.snapshot().remaining, 0)
  await domain.dispose()
  fs.rmSync(path.dirname(storePath), { recursive: true, force: true })
})

test('配对：设备回 pair.required(token) → 提示需要重新配对；解除配对会清两侧', async () => {
  const storePath = tmpStore()
  fs.writeFileSync(storePath, JSON.stringify({ deviceId: 'aa11bb', token: 'b'.repeat(32) }))
  const link = fakeLink()
  const domain = new PairingDomain({ link, logger: () => {}, storePath })
  domain.attach()
  assert.equal(domain.snapshot().paired, true, '启动时应读到信任表')
  assert.equal(link.token, 'b'.repeat(32))

  link.deliver('pair.required', { reason: 'token' })
  assert.equal(domain.snapshot().error, 'token-mismatch')
  assert.equal(domain.snapshot().needed, true)

  await domain.unpair()
  assert.ok(link.sent.some((m) => m.type === 'pair.reset'), '解除配对要通知设备清 token')
  assert.equal(domain.snapshot().paired, false)
  assert.equal(link.token, null)
  assert.equal(fs.existsSync(storePath), false, '本地信任记录也要删掉')
  await domain.dispose()
  fs.rmSync(path.dirname(storePath), { recursive: true, force: true })
})

test('配对：信任表损坏不炸启动（当作未配对）', async () => {
  const storePath = tmpStore()
  fs.writeFileSync(storePath, '{ 这不是 JSON')
  const link = fakeLink()
  const domain = new PairingDomain({ link, logger: () => {}, storePath })
  domain.attach()
  assert.equal(domain.snapshot().paired, false)
  await domain.dispose()
  fs.rmSync(path.dirname(storePath), { recursive: true, force: true })
})
