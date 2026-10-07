/**
 * 插件配置：声明 schema 并在加载时做一次防御性归一化。
 *
 * 为什么要归一到"全字段都有默认值"：
 * 配置来自 loader 的 YAML/JSON，用户可能只写一个 `transport`，也可能整段留空；
 * 后续代码里到处写 `config.panel?.enabled ?? true` 会把默认值散落到十几个地方，
 * 改一处默认值就要翻遍全部调用点。这里收口成一次解析，之后所有代码都拿到完整对象。
 *
 * schema 优先用 DSH 自带的 schemastery（这样在设置界面里能渲染出表单）；
 * 拿不到时退回普通对象，**不影响功能**，只是没有表单校验。
 */

/** 传输实现可选值。顺序即面板下拉的推荐顺序。 */
export const TRANSPORT_KINDS = ['bridge', 'mock', 'noble']

const DEFAULTS = Object.freeze({
  transport: 'bridge',
  targetDeviceId: '',
  autoReconnect: true,
  // 见 cordis.patch.yml 的说明：绝不在宿主启动路径上 spawn 子进程。
  autoConnect: false,
  mtuPayload: 244,
  panel: Object.freeze({ enabled: true }),
  tasks: Object.freeze({ maxItems: 20, maskTitles: false }),
  notify: Object.freeze({ sound: true, backlightPulse: true }),
  voice: Object.freeze({
    enabled: true,
    // 设备识别结果卡的"双击直发"（setDraft 整段替换 + submit）。见 docs/06 §2。
    // 取代旧 autoSend（它走的 domains.tasks 已在精简时删除，是死代码）。
    directSend: true,
    // 双击发送后 800ms 内没有挂件认领时，降级 sessionController.prompt 直发。
    fallbackPrompt: true,
    providerId: '',
    language: 'zh',
    maxSeconds: 15,
    // 音频归档（用户决策：**默认开启**）：每次成功解码的录音写一组 .wav + .adpcm
    // 到 audioDir（空 = 挂件目录下的 audio/），并按 audioKeepFiles 自动清理最旧的若干组。
    // 上限可控：默认 20 组 ≈ 2.7MB（一组约 108KB wav + 27KB adpcm）。
    keepAudio: true,
    audioDir: '',
    audioKeepFiles: 20,
  }),
  approval: Object.freeze({
    enabled: true,
    // ★ 审批**默认不超时**（用户要求：设备端不再倒计时，一直等到电脑端或设备端作答）。
    //   0 = 一直等；正数 = 到点交回电脑端（回退开关，下限 5 秒、上限 10 分钟）。
    timeoutMs: 0,
    // ★ 默认 false：**所有**审批都送到设备（真机返工记录"审批没有任何弹窗"）。
    //   之前默认 true（只读工具才上设备），写操作被静默交回电脑端 ——
    //   用户在设备上什么都看不到，以为审批功能没实现。
    //   设备端的审批 UX 本身是安全的：上/下选择、单击即执行、无倒计时，
    //   默认光标停在「允许一次」；不做决定就一直等（超时按拒绝的老行为已按用户要求取消）。
    readOnlyToolsOnDevice: false,
  }),
  // 追问/计划评审（docs/06 §3/§4）。超时无作答一律交回电脑端，绝不悬挂。
  questions: Object.freeze({ enabled: true, timeoutMs: 120000 }),
  logLevel: 'info',
})

/** 规范化用户配置：逐段合并默认值，并对越界值做钳制。 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const transport = TRANSPORT_KINDS.includes(input.transport) ? input.transport : DEFAULTS.transport

  return {
    transport,
    targetDeviceId: str(input.targetDeviceId, DEFAULTS.targetDeviceId).trim(),
    autoReconnect: bool(input.autoReconnect, DEFAULTS.autoReconnect),
    autoConnect: bool(input.autoConnect, DEFAULTS.autoConnect),
    // ATT 载荷下限 20（BLE 规范的最小可用值），上限 512（BLE 5 常见上限）
    mtuPayload: clamp(int(input.mtuPayload, DEFAULTS.mtuPayload), 20, 512),
    panel: {
      enabled: bool(input.panel?.enabled, DEFAULTS.panel.enabled),
    },
    tasks: {
      // 设备屏幕只有 240×320，列表超过 50 条没有意义，反而拖慢 BLE 传输
      maxItems: clamp(int(input.tasks?.maxItems, DEFAULTS.tasks.maxItems), 1, 50),
      maskTitles: bool(input.tasks?.maskTitles, DEFAULTS.tasks.maskTitles),
    },
    notify: {
      sound: bool(input.notify?.sound, DEFAULTS.notify.sound),
      backlightPulse: bool(input.notify?.backlightPulse, DEFAULTS.notify.backlightPulse),
    },
    voice: {
      enabled: bool(input.voice?.enabled, DEFAULTS.voice.enabled),
      directSend: bool(input.voice?.directSend, DEFAULTS.voice.directSend),
      fallbackPrompt: bool(input.voice?.fallbackPrompt, DEFAULTS.voice.fallbackPrompt),
      providerId: str(input.voice?.providerId, DEFAULTS.voice.providerId).trim(),
      language: str(input.voice?.language, DEFAULTS.voice.language) || 'zh',
      maxSeconds: clamp(int(input.voice?.maxSeconds, DEFAULTS.voice.maxSeconds), 1, 120),
      keepAudio: bool(input.voice?.keepAudio, DEFAULTS.voice.keepAudio),
      audioDir: str(input.voice?.audioDir, DEFAULTS.voice.audioDir).trim(),
      audioKeepFiles: clamp(int(input.voice?.audioKeepFiles, DEFAULTS.voice.audioKeepFiles), 1, 500),
    },
    approval: {
      enabled: bool(input.approval?.enabled, DEFAULTS.approval.enabled),
      // 审批超时下限 5 秒（再短用户来不及看清），上限 10 分钟
      // 0 原样保留（不超时）；正数才夹到 [5s, 10min]
      timeoutMs: (() => {
        const raw = int(input.approval?.timeoutMs, DEFAULTS.approval.timeoutMs)
        return raw === 0 ? 0 : clamp(raw, 5000, 600000)
      })(),
      readOnlyToolsOnDevice: bool(
        input.approval?.readOnlyToolsOnDevice,
        DEFAULTS.approval.readOnlyToolsOnDevice,
      ),
    },
    questions: {
      enabled: bool(input.questions?.enabled, DEFAULTS.questions.enabled),
      // 超时下限 10 秒（看清一道题的时间），上限 10 分钟；到点交回电脑端
      timeoutMs: clamp(int(input.questions?.timeoutMs, DEFAULTS.questions.timeoutMs), 10000, 600000),
    },
    logLevel: ['debug', 'info', 'warn', 'error'].includes(input.logLevel) ? input.logLevel : DEFAULTS.logLevel,
  }
}

/** 默认值导出，供面板展示"恢复默认"与文档使用。 */
export const CONFIG_DEFAULTS = DEFAULTS

/**
 * 尝试构造 schemastery schema。
 *
 * 用 try/catch 包住 import：schemastery 由 DSH 宿主提供，在插件被单测直接导入
 * （没有宿主）时它不可解析。此时返回 null，由调用方退回普通对象，
 * **功能不受影响**——只是设置界面拿不到表单校验。
 */
export async function loadConfigSchema() {
  try {
    const module = await import('@deepseek-ai/schemastery')
    const z = module.default ?? module
    if (!z?.object) return null
    return z.object({
      transport: z.union(TRANSPORT_KINDS.map((kind) => z.const(kind))).default(DEFAULTS.transport),
      targetDeviceId: z.string().default(DEFAULTS.targetDeviceId),
      autoReconnect: z.boolean().default(DEFAULTS.autoReconnect),
      autoConnect: z.boolean().default(DEFAULTS.autoConnect),
      mtuPayload: z.natural().min(20).max(512).default(DEFAULTS.mtuPayload),
      panel: z.object({ enabled: z.boolean().default(true) }).default({}),
      tasks: z
        .object({
          maxItems: z.natural().min(1).max(50).default(DEFAULTS.tasks.maxItems),
          maskTitles: z.boolean().default(false),
        })
        .default({}),
      notify: z
        .object({
          sound: z.boolean().default(true),
          backlightPulse: z.boolean().default(true),
        })
        .default({}),
      voice: z
        .object({
          enabled: z.boolean().default(true),
          directSend: z.boolean().default(true),
          fallbackPrompt: z.boolean().default(true),
          providerId: z.string().default(''),
          language: z.string().default('zh'),
          maxSeconds: z.natural().min(1).max(120).default(15),
          keepAudio: z.boolean().default(true),
          audioDir: z.string().default(''),
          audioKeepFiles: z.natural().min(1).max(500).default(20),
        })
        .default({}),
      approval: z
        .object({
          enabled: z.boolean().default(true),
          // 允许 0（不超时）；正数下限 5 秒由 normalizeConfig 夹取
          timeoutMs: z.natural().min(0).max(600000).default(DEFAULTS.approval.timeoutMs),
          readOnlyToolsOnDevice: z.boolean().default(false),
        })
        .default({}),
      questions: z
        .object({
          enabled: z.boolean().default(true),
          timeoutMs: z.natural().min(10000).max(600000).default(DEFAULTS.questions.timeoutMs),
        })
        .default({}),
      logLevel: z.union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')]).default('info'),
    })
  } catch {
    return null
  }
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function int(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

function str(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
