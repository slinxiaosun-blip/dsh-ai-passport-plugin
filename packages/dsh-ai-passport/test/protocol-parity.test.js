/**
 * C ↔ JS 协议常量一致性检查。
 *
 * 为什么需要它：协议常量有两份镜像 ——
 *   · 主机侧：packages/dsh-ai-passport/lib/protocol/constants.js
 *   · 设备侧：vendor/ai-passport/main/app_proto.h
 *
 * 两份必须逐字段一致。任何一处漂移的后果都是**静默的**：不会编译失败，
 * 而是表现为"连上了但什么都不动"或"某些消息能收、某些不能"，
 * 在只有两个人的项目里非常容易查半天。
 *
 * 这里刻意用**解析源文件**而不是导入的方式做比对：设备侧的常量在 C 头文件里，
 * 没法 import。解析字面量虽然朴素，但正好把"写错一个字符"这类问题抓出来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as constants from '../lib/protocol/constants.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HEADER = path.resolve(PACKAGE_ROOT, '../../vendor/ai-passport/main/app_proto.h')

/** 解析 C 头文件里的 `#define NAME VALUE`，返回 name → 原始值字符串。 */
function parseDefines(source) {
  const defines = new Map()
  for (const line of source.split('\n')) {
    const match = /^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    defines.set(match[1], match[2])
  }
  return defines
}

/** 去掉 C 字面量的引号。 */
function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1)
  return trimmed
}

/** 取整数字面量（支持 0x 前缀）。 */
function toInt(value) {
  const trimmed = value.trim()
  return trimmed.startsWith('0x') ? Number.parseInt(trimmed, 16) : Number.parseInt(trimmed, 10)
}

/**
 * 解析可能引用其它宏的数值。
 *
 * C 头文件里 `#define AP_RX_BUFFER_BYTES AP_MAX_PAYLOAD_BYTES` 这种"宏引用宏"
 * 很常见（而且正是我们想要写法：两个数字本就不该各写一遍）。
 * 解析器必须跟着解析一层，否则会得到 NaN —— 那样测试会以"NaN 小于 2048" 失败，
 * 看起来像数值问题，实际是解析器不够用。
 */
function toIntResolved(table, macro, depth = 0) {
  if (depth > 8) throw new Error(`${macro} 的宏引用层数过深，可能存在循环定义`)
  const raw = table.get(macro)
  if (raw === undefined) return Number.NaN
  const trimmed = unquote(raw)
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10)
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return Number.parseInt(trimmed, 16)
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return toIntResolved(table, trimmed, depth + 1)
  return Number.NaN
}

let defines
async function getDefines() {
  if (!defines) {
    defines = parseDefines(await readFile(HEADER, 'utf8'))
  }
  return defines
}

/** 一条 C 宏与一个 JS 值必须相等。 */
async function expectMatch(macro, jsValue, transform = (value) => value) {
  const table = await getDefines()
  assert.ok(table.has(macro), `app_proto.h 缺少宏 ${macro}`)
  const raw = table.get(macro)
  const actual = transform(unquote(raw))
  assert.equal(
    actual,
    jsValue,
    `${macro} 不一致：C="${raw}"（解析为 ${JSON.stringify(actual)}） vs JS=${JSON.stringify(jsValue)}`,
  )
}

test('协议版本与帧格式常量一致', async () => {
  await expectMatch('AP_PROTOCOL_VERSION', constants.PROTOCOL_VERSION, toInt)
  await expectMatch('AP_HEADER_BYTES', constants.HEADER_BYTES, toInt)
  await expectMatch('AP_MAX_CHUNKS', constants.MAX_CHUNKS, toInt)
  await expectMatch('AP_ACK_TIMEOUT_MS', constants.ACK_TIMEOUT_MS, toInt)
  await expectMatch('AP_ACK_MAX_RETRIES', constants.ACK_MAX_RETRIES, toInt)
  await expectMatch('AP_HEARTBEAT_INTERVAL_MS', constants.HEARTBEAT_INTERVAL_MS, toInt)
  await expectMatch('AP_HEARTBEAT_MISS_LIMIT', constants.HEARTBEAT_MISS_LIMIT, toInt)
})

test('通道号与分片标志一致', async () => {
  await expectMatch('AP_CH_CONTROL', constants.CHANNEL.CONTROL, toInt)
  await expectMatch('AP_CH_VOICE', constants.CHANNEL.VOICE, toInt)
  await expectMatch('AP_CH_HEARTBEAT', constants.CHANNEL.HEARTBEAT, toInt)
  await expectMatch('AP_CH_LOG', constants.CHANNEL.LOG, toInt)
  await expectMatch('AP_FLAG_FIRST', constants.FLAG.FIRST, toInt)
  await expectMatch('AP_FLAG_LAST', constants.FLAG.LAST, toInt)
  await expectMatch('AP_FLAG_ACK_REQ', constants.FLAG.ACK_REQ, toInt)
})

test('消息类型字符串逐条一致（错一个字符就静默不通）', async () => {
  // JS 常量名 → C 宏名。这里显式列出而不是自动推导：
  // 自动推导会把"漏抄一条"变成"检查通过"，而漏抄正是最可能发生的错误。
  const mapping = {
    HELLO: 'AP_MSG_HELLO',
    HELLO_ACK: 'AP_MSG_HELLO_ACK',
    PING: 'AP_MSG_PING',
    PONG: 'AP_MSG_PONG',
    ACK: 'AP_MSG_ACK',
    NACK: 'AP_MSG_NACK',
    TASK_STATE: 'AP_MSG_TASK_STATE',
    DEBUG_KEY: 'AP_MSG_DEBUG_KEY',
    APPROVE_REQ: 'AP_MSG_APPROVE_REQ',
    APPROVE: 'AP_MSG_APPROVE',
    APPROVE_RESULT: 'AP_MSG_APPROVE_RESULT',
    QUESTION_REQ: 'AP_MSG_QUESTION_REQ',
    QUESTION_NAV: 'AP_MSG_QUESTION_NAV',
    QUESTION_PICK: 'AP_MSG_QUESTION_PICK',
    QUESTION_ANSWER: 'AP_MSG_QUESTION_ANSWER',
    QUESTION_DONE: 'AP_MSG_QUESTION_DONE',
    BALANCE_REQ: 'AP_MSG_BALANCE_REQ',
    BALANCE: 'AP_MSG_BALANCE',
    VOICE_BEGIN: 'AP_MSG_VOICE_BEGIN',
    VOICE_END: 'AP_MSG_VOICE_END',
    VOICE_RESULT: 'AP_MSG_VOICE_RESULT',
    VOICE_ERROR: 'AP_MSG_VOICE_ERROR',
    VOICE_ACTION: 'AP_MSG_VOICE_ACTION',
    TOAST: 'AP_MSG_TOAST',
    CONFIG: 'AP_MSG_CONFIG',
    // 配对（阶段 C）：设备屏幕显示 6 位码，主机输码换 token
    PAIR_BEGIN: 'AP_MSG_PAIR_BEGIN',
    PAIR_OK: 'AP_MSG_PAIR_OK',
    PAIR_FAILED: 'AP_MSG_PAIR_FAILED',
    PAIR_REQUIRED: 'AP_MSG_PAIR_REQUIRED',
    PAIR_RESET: 'AP_MSG_PAIR_RESET',
  }

  const table = await getDefines()
  for (const [jsKey, macro] of Object.entries(mapping)) {
    const jsValue = constants.MSG[jsKey]
    assert.ok(jsValue !== undefined, `JS 侧 MSG 缺少 ${jsKey}`)
    await expectMatch(macro, jsValue)
  }

  // 反向检查：C 里定义的 AP_MSG_* 都必须在这个映射里，
  // 否则"设备认识但主机不认"的消息会在运行期变成谜案。
  const cMacros = [...table.keys()].filter((key) => key.startsWith('AP_MSG_'))
  const covered = new Set(Object.values(mapping))
  const uncovered = cMacros.filter((macro) => !covered.has(macro))
  assert.deepEqual(uncovered, [], `app_proto.h 里有未纳入比对的消息宏：${uncovered.join(', ')}`)

  // 顺带确认 JS 侧的 MSG 表没有漏掉我们的映射
  const jsKeys = Object.keys(constants.MSG)
  const unmapped = jsKeys.filter((key) => !(key in mapping))
  assert.deepEqual(unmapped, [], `JS 侧 MSG 有未纳入比对的键：${unmapped.join(', ')}`)
})

test('广播厂商标签一致（识别设备的兜底条件）', async () => {
  await expectMatch('AP_ADV_MFG_TAG', constants.ADV.MFG_TAG)
})

test('任务状态与审批决定一致', async () => {
  await expectMatch('AP_STATUS_IDLE', constants.TASK_STATUS.IDLE)
  await expectMatch('AP_STATUS_RUNNING', constants.TASK_STATUS.RUNNING)
  await expectMatch('AP_STATUS_DONE', constants.TASK_STATUS.DONE)
  await expectMatch('AP_STATUS_ERROR', constants.TASK_STATUS.ERROR)
  await expectMatch('AP_STATUS_ABORTED', constants.TASK_STATUS.ABORTED)
  await expectMatch('AP_STATUS_WAITING', constants.TASK_STATUS.WAITING)
  await expectMatch('AP_DECISION_ALLOW', constants.DECISION.ALLOW)
  await expectMatch('AP_DECISION_DENY', constants.DECISION.DENY)
})

test('音频参数一致', async () => {
  await expectMatch('AP_AUDIO_SAMPLE_RATE', constants.AUDIO.SAMPLE_RATE, toInt)
  await expectMatch('AP_AUDIO_FALLBACK_SAMPLE_RATE', constants.AUDIO.FALLBACK_SAMPLE_RATE, toInt)
  await expectMatch('AP_AUDIO_BITS', constants.AUDIO.BITS, toInt)
  await expectMatch('AP_AUDIO_CHANNELS', constants.AUDIO.CHANNELS, toInt)
  await expectMatch('AP_AUDIO_MAX_SECONDS', constants.AUDIO.MAX_SECONDS, toInt)
  // 旧版还有 AP_AUDIO_SILENCE_STOP_MS（静音自动结束门限）。该功能已删除，
  // 设备端与 JS 两侧的宏/常量都一并移除，parity 断言也随之删除 ——
  // 不要再加回来，否则等于把一个已废弃的行为写回协议契约。
})

test('设备名与厂商标识一致', async () => {
  await expectMatch('AP_DEVICE_NAME', constants.DEVICE_NAME)
  // 广播短名必须两端一致：它进了广播包（≤8 字符，见 app_proto.h 的字节账），
  // 主机侧按它 + 服务 UUID 双重识别设备。
  await expectMatch('AP_DEVICE_NAME_SHORT', constants.SHORT_DEVICE_NAME)
  await expectMatch('AP_MANUFACTURER_ID', constants.MANUFACTURER_ID, toInt)
})

test('单条消息载荷上限两端一致，且设备接收缓冲不小于它', async () => {
  // 这条用例是**真实缺陷**抓出来的：最初主机侧只按 MAX_CHUNKS×MAX_CHUNK_PAYLOAD
  // （8192）校验，而设备缓冲只有 2048。差额不会报错，只会让任务列表静默截断。
  const table = await getDefines()
  const rxBuffer = toIntResolved(table, 'AP_RX_BUFFER_BYTES')
  const maxPayload = toIntResolved(table, 'AP_MAX_PAYLOAD_BYTES')

  await expectMatch('AP_MAX_PAYLOAD_BYTES', constants.MAX_PAYLOAD_BYTES, toInt)
  assert.ok(
    rxBuffer >= maxPayload,
    `设备接收缓冲 ${rxBuffer} 小于约定的载荷上限 ${maxPayload}`,
  )
  // 上限必须真的比"理论最大"小，否则等于没设限
  assert.ok(
    maxPayload <= constants.MAX_CHUNKS * constants.MAX_CHUNK_PAYLOAD,
    '载荷上限不应超过分片机制的理论最大',
  )
})
