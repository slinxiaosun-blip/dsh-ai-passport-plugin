/**
 * AI Passport ⇄ DSH 协议常量。
 *
 * 设计目标：一套常量同时被两端引用（主机侧 JS：macOS / Windows；设备侧 C）。
 * 设备侧对应文件：firmware/main/app_proto.h —— 任何改动必须两边同步，
 * 并由 lib/protocol/chunk.test.js 与 tests/ 里的 C 侧用例共同守住。
 */

/** 协议版本。两端取较小值运行；设备屏幕在版本不匹配时必须显式提示而不是静默失败。 */
export const PROTOCOL_VERSION = 1

/** 广播名。主机侧按名字 + Manufacturer Data 双重过滤，避免连到同名设备。 */
export const DEVICE_NAME = 'FoloPassport-DSH'

/**
 * 广播包里的**短名字**（设备侧 AP_DEVICE_NAME_SHORT，必须逐字一致）。
 *
 * 为什么需要它：广播包只有 31 字节，Flags(3) + 128 位服务 UUID(18) 之后只剩
 * 10 字节，等于最多 8 个字符的名字。完整名放不进广播包。
 *
 * 为什么名字必须进广播包而不只放 scan response：macOS 不保证把 scan response
 * 合并进 CoreBluetooth 的 advertisementData，那样 localName 为空，
 * 按名字过滤的客户端就"扫不到设备"（实测正是如此）。
 */
export const SHORT_DEVICE_NAME = 'Folo-PSP'

/** Manufacturer Data 里的公司标识（自定义，仅用于识别本协议，不是真实注册的 Bluetooth SIG ID）。 */
export const MANUFACTURER_ID = 0xffff

/**
 * GATT UUID（128 位）。值取自**真机实测**（noble 返回的字符串，逐字复制、无推导）。
 *
 * ── 四个坑，都在真机上踩过，改之前务必读完 ──
 *
 * 【坑 1：不要推导，直接存实测值】
 * 我先写过三版"推导"出来的 UUID（手算字节序、按 CBUUID 变换、两种反序规则），
 * 全都匹配不上。UUID 要么读真机的实际值，要么用 `[CBUUID UUIDWithString:]` 实测校验，
 * 凭规则推导一定会错在某一步。
 *
 * 【坑 2：角色要靠“属性”判定，不要靠编号猜】
 * 我一度把 02 当成 TX —— 那只是"编号顺序看起来应该如此"的想当然。
 * 真机实测的属性才是唯一依据：
 *     02 → write    03 → notify    04 → notify    05 → read
 * 映射错了的后果很隐蔽：连接与订阅都"成功"，但设备发来的 hello 永远收不到，
 * 表现为"能连上但握手超时"，很容易误判成固件没实现握手。
 * 校验办法：连上后 discoverAll，打印每个特征的 properties 对照本文件。
 *
 * 【坑 3：带 UUID 过滤的服务发现会静默失败】
 * @stoprocent/noble 在 macOS 上，只要给 discoverSomeServicesAndCharacteristics
 * 传了服务或特征 UUID 过滤，回调就永远不返回有效结果（err 连 message 都是 undefined）；
 * 换 4 位短 UUID、32 位无连字符、大写等任何写法都一样失败，**不传过滤则立刻成功**。
 * 因此 bridge-worker 用全量发现 + 在 JS 里自己匹配。
 *
 * 【坑 4：保留占位模式会被 CoreBluetooth 拒绝】
 * 早期取值还原后形如 xxxxxxxx-0000-xxxx-...，落在蓝牙规范给 16 位 UUID 缩写保留的
 * 模式里；CBUUID 对此强制校验，抛 NSInternalInconsistencyException 且**直接终止进程**。
 *
 * 匹配一律走 normalizeUuid（小写 + 去连字符）。
 * 设备侧对应 main/app_proto.h 的 AP_UUID_*，由 protocol-parity 测试卡住。
 */
export const UUID = Object.freeze({
  SERVICE: '0000a900a90050415353544f524f5350',
  RX: 'a90050415353544f524f5350f0a90002', // write  → 主机发给设备（Write Without Response）
  TX: 'a90050415353544f524f5350f0a90003', // notify → 设备发给主机（JSON 控制，含 hello 握手）
  VOICE: 'a90050415353544f524f5350f0a90004', // notify → 设备发给主机（音频）
  CTRL: 'a90050415353544f524f5350f0a90005', // read   → 能力/版本/电量
})

/** 分片头长度（字节）。头 + 载荷构成一个 ATT 通知/写入。 */
export const HEADER_BYTES = 4

/**
 * 通道号。音频与控制分通道，避免大段音频把控制消息堵在队列里。
 */
/**
 * 广播里的厂商数据标签（与固件 AP_ADV_MFG_TAG 逐字节一致）。
 *
 * ★ 主机识别设备时必须**校验这个标签的内容**，不能"有厂商数据就算"——
 *   后者会把耳机/手表/邻居的任何蓝牙设备都当成候选（真机返工记录：
 *   断链重连连到陌生设备、无限报"找不到控制特征"）。
 */
export const ADV = Object.freeze({
  MFG_TAG: 'FAP1',
})

export const CHANNEL = Object.freeze({
  CONTROL: 0, // UTF-8 JSON
  VOICE: 1, // ADPCM 字节流
  HEARTBEAT: 2, // 极短 JSON（ping/pong）
  LOG: 3, // 设备日志上行，仅诊断用
})

/** 分片标志位。 */
export const FLAG = Object.freeze({
  FIRST: 0b0001,
  LAST: 0b0010,
  ACK_REQ: 0b0100,
})

/**
 * 单个消息最多 16 片（msgId 12bit + seq 4bit）。
 * 因此单消息上限 = 16 × 载荷上限；音频侧够用（ADPCM 8KB/s，2s 一片）。
 */
export const MAX_CHUNKS = 16

/**
 * ★ 单条消息的**载荷**上限（字节）。两端必须一致，由 protocol-parity 测试卡死。
 *
 * 为什么不是 MAX_CHUNKS × MAX_CHUNK_PAYLOAD（=8192）：设备无 PSRAM，不可能为
 * 一条消息留 8KB 缓冲。主机按 8192 发、设备只收 2048 的后果是**静默截断**——
 * 表现为"任务列表永远显示不全"，不报错、极难查。
 *
 * 发送方在编码前必须校验：超过此值就要自己裁剪（见 bridge/state.js 的标题长度限制）。
 */
export const MAX_PAYLOAD_BYTES = 2048

/** 默认 ATT 载荷上限。协商到更大 MTU 时可上调，见 ble/transport.js 的 negotiateMtu。 */
export const DEFAULT_MTU = 244

/** 单次消息载荷上限（保守取 512B，实测 MTU 后由 transport 调整）。 */
export const MAX_CHUNK_PAYLOAD = 512

/** 控制通道重传：超过该次数判定链路异常，触发重连。 */
export const ACK_TIMEOUT_MS = 400
export const ACK_MAX_RETRIES = 3

/** 心跳间隔。设备侧同一常量见 app_proto.h，改一处必须改两处。 */
export const HEARTBEAT_INTERVAL_MS = 5000
/** 连续丢失多少个心跳判定掉线。 */
// ★ 从 3 放宽到 6（与设备侧 AP_HEARTBEAT_MISS_LIMIT 一致）：语音上行期间音频通知
//   会把控制通道挤拥塞，ping/pong 可能丢；3 次丢失就判掉线太紧，是"识别后有时
//   自己断开连接"的原因之一。设备侧收到任何控制消息都会重置计时，见 app_link.c。
export const HEARTBEAT_MISS_LIMIT = 6

/** 设备能力位。设备在 hello / CTRL 上报，主机侧据此决定是否显示对应入口。 */
export const CAPABILITY = Object.freeze({
  DISPLAY: 1 << 0,
  BUTTONS: 1 << 1,
  MIC: 1 << 2,
  SPEAKER: 1 << 3,
  BATTERY: 1 << 4,
  NOTIFY_LED: 1 << 5,
})

/** 音频参数。两端必须一致；采样率降级时以 hello 协商结果为准。 */
export const AUDIO = Object.freeze({
  SAMPLE_RATE: 16000,
  FALLBACK_SAMPLE_RATE: 8000,
  BITS: 16,
  CHANNELS: 1,
  /** IMA-ADPCM 4:1，16k/16bit/mono 从 32KB/s 压到 8KB/s。 */
  CODEC: 'ima-adpcm',
  BLOCK_ALIGN: 256,
  /** 单次录音上限（秒）。设备侧同一上限见 app_voice.c。 */
  MAX_SECONDS: 15,
  /** 静音自动结束门限（毫秒）。 */
  SILENCE_STOP_MS: 1200,
})

/**
 * 消息类型表。
 *
 * 命名约定：`域.动作[.方向]`，方向缺省为请求。`_ACK` 后缀表示应答。
 * 这里保持单一事实来源，两端都从这里/对应头文件取字符串常量。
 */
export const MSG = Object.freeze({
  // —— 握手 ——
  HELLO: 'hello', // 设备 → Mac
  HELLO_ACK: 'hello.ack', // Mac → 设备
  PING: 'ping',
  PONG: 'pong',
  ACK: 'ack', // {msgId}
  NACK: 'nack', // {msgId, reason}

  // —— 任务域 ——
  TASK_STATE: 'task.state',      // 主机聚合后的整体状态（精简版核心消息）

  // —— 审批域 ——
  APPROVE_REQ: 'approve.req', // Mac → 设备
  APPROVE: 'approve', // 设备 → Mac
  APPROVE_RESULT: 'approve.result', // Mac → 设备
  QUESTION_REQ: 'question.req', // Mac → 设备（逐题下发：choice / plan）
  QUESTION_NAV: 'question.nav', // 设备 → Mac（上/下一题，主机回 question.req）
  QUESTION_PICK: 'question.pick', // 设备 → Mac（本题选择增量，主机累计整批）
  QUESTION_ANSWER: 'question.answer', // 设备 → Mac（{action:'submit'|'cancel'}）
  QUESTION_DONE: 'question.done', // Mac → 设备（整批结束：采纳/已被电脑回答/超时）

  // —— 余额 ——
  BALANCE_REQ: 'balance.req',
  BALANCE: 'balance',

  // —— 语音 ——
  VOICE_BEGIN: 'voice.begin', // 设备 → Mac
  VOICE_END: 'voice.end', // 设备 → Mac
  VOICE_RESULT: 'voice.result', // Mac → 设备
  VOICE_ERROR: 'voice.error', // Mac → 设备
  VOICE_ACTION: 'voice.action', // 设备 → Mac（识别结果卡：fill=填入 / send=发送 / redo=重录）

  // —— 配对（认领 / 信任握手；与设备端 app_proto.h 逐条对应，见 docs/06 §9.14）——
  PAIR_BEGIN: 'pair.begin', // Mac → 设备：{code, host}
  PAIR_OK: 'pair.ok', // 设备 → Mac：{deviceId, token}
  PAIR_FAILED: 'pair.failed', // 设备 → Mac：{reason, remaining}
  PAIR_REQUIRED: 'pair.required', // 设备 → Mac：未配对期间拒绝业务消息
  PAIR_RESET: 'pair.reset', // Mac → 设备：解除配对（清 token）

  // —— 通用 ——
  TOAST: 'toast', // Mac → 设备
  CONFIG: 'config',
  /** 调试：把一次按键事件喂给设备，走与真实按键相同的队列（见 app.c）。 */
  DEBUG_KEY: 'debug.key', // Mac → 设备（提醒开关、免确认、脱敏等）
})

/** 任务状态。设备屏幕上的状态胶囊直接映射这些值。 */
export const TASK_STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  DONE: 'done',
  ERROR: 'error',
  ABORTED: 'aborted',
  WAITING: 'waiting', // 等待审批或用户输入
})

/** 审批决定。`allow-once` 是 DSH 侧唯一表示"放行"的结果。 */
export const DECISION = Object.freeze({
  ALLOW: 'allow',
  DENY: 'deny',
})

/**
 * 设备端状态（精简版）。
 *
 * ★ 与 TASK_STATUS 的区别：TASK_STATUS 是**单个会话**的执行状态
 *   （idle/running/done/error/aborted/waiting），而这里的四态是
 *   **主机聚合后的整体状态**，设备只显示其中之一。
 *   两者不可混用：设备不持有会话，也就无法理解单会话状态。
 */
export const TASK_STATE = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting_approval',
  COMPLETED: 'completed',
})

/** 审批范围。ONCE=只这一次（"运行一次"）；ALWAYS=以后同类不再询问（"总是运行"）。 */
export const APPROVE_SCOPE = Object.freeze({
  ONCE: 'once',
  ALWAYS: 'always',
})

/** 设备侧默认配置。Mac 可通过 CONFIG 消息覆盖（不持久化在设备上，避免 NVS 磨损与状态分叉）。 */
export const DEVICE_DEFAULT_CONFIG = Object.freeze({
  soundEnabled: true,
  backlightPulse: true,
  maskTitles: false,
  voiceAutoSend: false,
  maxTasks: 20,
})
