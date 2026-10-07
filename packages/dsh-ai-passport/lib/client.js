/**
 * dsh-ai-passport —— 客户端半区（DSH 桌面客户端里的那个小挂件）。
 *
 * 这个文件**必须保持为预先构建好的浏览器 bundle**，不能被 DSH 现场编译。
 * 格式由 `@deepseek-ai/dsh-client-modules` 规定：
 *
 *   1. 文件是一个 `window.__ModuleLoader__.load({ id, factory })` 调用；
 *   2. `id` 必须**严格等于包名**（对不上会在启动时被组合成一个响亮的错误）；
 *   3. factory 里用注入的 `require` 取共享依赖（React、DSH 的 UI primitives）；
 *   4. 导出 `apply(ctx)` 与 `inject`（硬依赖的服务名数组）。
 *
 * 因此这里刻意**不写 JSX**：没有构建步骤，就用 `React.createElement`。
 *
 * 与宿主半区的通信：走**同源 HTTP**，而不是 Remote。
 * 原因：`ctx.remote.*` 那些命名空间由宿主侧 `@Remote` 装饰器在 DSH 自己的构建期生成，
 * 外部包无法注册自己的命名空间。而宿主半区已经用 `ctx.webServer.register()` 挂了
 * `/dsh-passport/*` 路由，客户端与页面同源，直接 fetch 即可——
 * 面板页用的就是同一组接口，两边共用一套鉴权与数据源。
 */

window.__ModuleLoader__.load({
  id: 'dsh-ai-passport',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useState, useEffect, useRef, useCallback } = React

    /** 面板接口前缀，与宿主半区 `lib/panel/index.js` 注册的路径一致。 */
    const API = '/dsh-passport'

    const NS = 'aiPassport'
    /** 挂件自己的样式；用 CSS 变量取主题色，深浅色模式都能跟随。 */
    const CSS = `
.ap-widget{display:flex;align-items:center;gap:6px;position:relative}
.ap-pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28));border-radius:8px;background:transparent;color:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;font-family:inherit}
.ap-pill:hover{background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1))}
.ap-pill[data-state="connected"]{border-color:color-mix(in srgb, #16a34a 45%, transparent)}
.ap-dot{width:7px;height:7px;border-radius:50%;background:#9aa1ab;flex:none}
.ap-dot[data-state="connected"]{background:#16a34a}
.ap-dot[data-state="scanning"],.ap-dot[data-state="connecting"],.ap-dot[data-state="reconnecting"]{background:#d97706}
.ap-dot[data-state="failed"]{background:#dc2626}
.ap-dot[data-state="running"]{background:#4d6bfe;animation:ap-pulse 1.2s ease-in-out infinite}
@keyframes ap-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.ap-badge{min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#dc2626;color:#fff;font-size:10px;font-weight:600;display:inline-flex;align-items:center;justify-content:center}
.ap-pop{position:absolute;bottom:calc(100% + 8px);right:var(--ap-pop-x, 24px);left:auto;width:180px;max-width:min(180px, calc(100vw - 24px));max-height:420px;overflow-y:auto;z-index:60;padding:12px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28));border-radius:12px;background:var(--dsw-alias-bg-layer-1, #fff);box-shadow:0 8px 28px rgba(0,0,0,.16);font-size:12px;color:var(--dsw-alias-text-l1, inherit)}
.ap-sect{margin-bottom:12px}
.ap-sect:last-child{margin-bottom:0}
.ap-h{display:flex;align-items:center;justify-content:flex-start;gap:8px;margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.03em;color:var(--dsw-alias-text-l3, #6b7280);text-transform:uppercase}
.ap-row{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.14))}
.ap-row:last-child{border-bottom:none}
.ap-row .ap-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 键值行（含 .ap-val）：标签收成自然宽度、值靠左紧跟其后。
   用 :has() 只作用于带值的行，不影响任务/语音那些靠 flex:1 做省略号的行。 */
.ap-row:has(.ap-val) .ap-name{flex:none}
.ap-row .ap-val{flex:1;min-width:0;text-align:left;white-space:nowrap;font-variant-numeric:tabular-nums}
/* 电量+信号合并行：一行两半，每半「标签+值」同一行内联，值靠左。 */
.ap-row.ap-duo{gap:0;align-items:center}
.ap-duo-half{display:flex;flex:1;min-width:0;align-items:center;justify-content:flex-start;gap:5px;padding:0}
.ap-duo-half .ap-name,.ap-duo-half .ap-val{flex:none;text-align:left}
.ap-duo-half + .ap-duo-half{border-left:1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.14))}
/* 区块标题里的计数紧跟标题（靠左），不推到最右。 */
.ap-h .ap-state{margin-left:6px;font-weight:400;text-transform:none;letter-spacing:0}
.ap-h .ap-state[data-on="1"]{color:#16a34a}
.ap-h .ap-state[data-on="0"]{color:var(--dsw-alias-text-l3, #6b7280)}
/* 标题行内的小按钮（如语音的「准备模型」）：紧跟在状态文字右边，不吃整行 */
.ap-h .ap-btn{margin-left:6px;padding:1px 6px;font-size:10px;font-weight:400;text-transform:none;letter-spacing:0}
/* ── 设备区重设计：标题行放设备名，信息用紧凑网格，按钮收成一条 ── */
/* 标题行：左侧状态点+设备名（替代"设备"二字，信息量更大），计数/状态靠右省空间 */
.ap-h .ap-devname{display:flex;align-items:center;gap:6px;min-width:0;font-weight:600;color:var(--dsw-alias-text-l1, inherit);text-transform:none;letter-spacing:0}
.ap-h .ap-devname .ap-dot{width:7px;height:7px;border-radius:50%;background:#9aa1ab;flex:none}
.ap-h .ap-devname .ap-dot[data-state="connected"]{background:#16a34a}
.ap-h .ap-devname span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 紧凑信息网格：2 列，标签上值下，压掉"标签值一大行"的横向浪费 */
.ap-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--dsw-alias-border-l3, rgba(128,128,128,.14));border:1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.14));border-radius:6px;overflow:hidden}
.ap-cell{background:var(--dsw-alias-bg-layer-1, #fff);padding:5px 8px;min-width:0}
.ap-cell .k{display:block;font-size:10px;color:var(--dsw-alias-text-l3, #6b7280);line-height:1.3}
.ap-cell .v{display:block;font-size:12px;font-weight:600;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
/* 按钮条：一行放三个按钮，靠左排 */
.ap-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.ap-input{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28));background:transparent;color:inherit;border-radius:6px;padding:3px 6px;font-size:12px;font-family:ui-monospace, SFMono-Regular, Menlo, monospace;letter-spacing:2px}
.ap-input:focus{outline:1px solid #4d6bfe;border-color:#4d6bfe}
.ap-btn{border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28));background:transparent;color:inherit;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;font-family:inherit}
.ap-btn:hover{background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1))}
.ap-btn.primary{background:#4d6bfe;border-color:#4d6bfe;color:#fff}
.ap-btn.primary:hover{filter:brightness(1.08)}
.ap-muted{color:var(--dsw-alias-text-l3, #6b7280)}
.ap-err{color:#dc2626;font-size:11px;line-height:1.4}
`

    /**
     * 语音区显示决策（纯函数，便于单测）。
     *
     * 规则与主机 voice.prepare() 的前置条件严格对齐 —— 不给做不到的按钮：
     *   · 已就绪            → 「已启用」，不显示按钮
     *   · 有识别提供者未就绪 → 「未启用」，显示「准备模型」
     *   · 无提供者 / 无服务  → 「未启用」，不显示按钮（此时 prepare() 必然抛错）
     */
    function speechViewFor(state) {
      const speech = state?.speech ?? null
      const ready = speech?.ready === true
      // 「准备模型」只在"确实没装 / 上次准备失败"时出现（主机给 needsPreparation）。
      // 老宿主没有该字段时退化为旧规则，避免新旧半区搭配时按钮整个消失。
      const needsPreparation = speech?.needsPreparation === true
        || (speech?.needsPreparation === undefined && Boolean(speech?.providerId) && !ready)
      return {
        ready,
        text: ready ? '已启用' : '未启用',
        // 说明行只用于必须解释的状态：出错、或正在准备（下载/加载进度）
        hint: state?.speechError
          ? String(state.speechError)
          : (speech?.preparing === true && speech?.detail ? String(speech.detail) : null),
        showPrepare: needsPreparation && !ready,
      }
    }

    const STATE_TEXT = {
      idle: '未连接',
      scanning: '扫描中',
      connecting: '连接中',
      connected: '已连接',
      reconnecting: '重连中',
      failed: '异常',
    }

    /** 面板接口调用。失败一律吞掉并返回 null——挂件不该因为后端没起来就报错刷屏。 */
    async function callApi(path, init) {
      try {
        const response = await fetch(`${API}${path}`, init)
        if (!response.ok) return null
        return await response.json()
      } catch {
        return null
      }
    }

    /**
     * 配对区的视图模型（纯函数，便于测试）：
     *   needed=true  → 显示 6 位码输入框 + 「配对」按钮
     *   已配对       → 显示设备 ID + 「解除配对」
     *   error        → 失败原因（码错/限流/发送失败）
     */
    function pairingViewFor(state) {
      const pairing = state?.pairing
      if (!pairing) return { show: false }
      const errText = {
        'bad-code': '配对码不对，请照设备屏幕重输',
        'rate-limited': '尝试太频繁，请等一分钟再试',
        'send-failed': '发送失败，请检查蓝牙连接',
        'bad-input': '请输入 6 位数字',
        'token-mismatch': '本机未被该设备信任，需要重新配对',
        'empty-token': '设备返回的 token 为空，配对失败',
      }[pairing.error] ?? null
      return {
        show: true,
        needed: Boolean(pairing.needed),
        paired: Boolean(pairing.paired),
        deviceId: pairing.deviceId ?? null,
        hostName: pairing.hostName ?? null,
        remaining: pairing.remaining ?? null,
        error: errText,
      }
    }

    function act(action, payload) {
      return callApi('/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload: payload ?? {} }),
      })
    }

    /**
     * 轮询状态。
     *
     * 为什么不用 SSE：挂件是常驻的、每个窗口一份，SSE 连接会一直占着；
     * 而挂件需要的信息量很小（几百字节），2 秒轮询在桌面上完全无感。
     * 真正需要实时性的审批，由宿主半区主动推给设备，挂件迟 2 秒看到不影响正确性。
     * 标签页隐藏时自动停轮询，避免后台空转。
     */
    function useApiState(intervalMs) {
      const [state, setState] = useState(null)
      useEffect(() => {
        let alive = true
        let timer = null
        const tick = async () => {
          const body = await callApi('/state.json')
          if (!alive) return
          if (body?.ok) setState(body.state)
          // 有待消费的识别结果时加密轮询：设备端"双击发送"到输入框出现文字，
          // 2 秒延迟会让人以为没按上（docs/06 §2.1）。其余时间保持原间隔。
          const urgent = Boolean(body?.state?.voice?.pending)
          // 配对待确认/刚提交时也快轮询：设备回 pair.ok 到挂件刷新原本要等一整个
          // 轮询周期，"已提交配对码，等待设备确认…"会一直挂着（用户反馈不实时）。
          const pairingBusy = Boolean(body?.state?.pairing?.needed)
          timer = setTimeout(
            tick,
            document.hidden ? intervalMs * 5 : urgent || pairingBusy ? 500 : intervalMs,
          )
        }
        void tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [intervalMs])
      return state
    }

    /** 没有 useInput 时的占位选择器：保持 hook 调用恒定（React 规则）。 */
    const NO_INPUT = () => null

    /** 挂件主体。 */
    function PassportWidget(props) {
      // inputActions 由 conversation.input.activity 槽位的宿主（ui-conversation）提供，
      // 这是官方语音输入插件用的同一套动词：captureInsertion / insertText / setDraft / submit。
      const inputActions = props?.inputActions
      // useInput 是标准 props 里的 InputState 选择器；读它是为了发送前拿到当前草稿
      // （双击发送会整段替换草稿，旧草稿要带回 host 存档，见 docs/06 §2.3）。
      const useInput = props?.useInput ?? NO_INPUT
      const inputState = useInput((s) => s)
      const [open, setOpen] = useState(false)
      const [pairCode, setPairCode] = useState('')
      const [busy, setBusy] = useState(false)
      const state = useApiState(2000)
      const rootRef = useRef(null)

      const link = state?.link ?? {}
      const linkState = link.state ?? 'idle'
      const approvals = state?.approvals ?? []
      const speechView = speechViewFor(state)
      const pairingView = pairingViewFor(state)

      /**
       * 语音状态保鲜：打开弹窗时刷一次；未就绪期间每 5 秒再刷。
       *
       * 「准备模型」是异步的（SenseVoice 首次约 240MB 下载），没有这一步的话状态会
       * 一直停在"未启用"、按钮永远挂着 —— 而我们已经去掉了手动刷新按钮，
       * 所以必须自己能更新。只在"弹窗打开 + 未就绪 + 标签页可见"时轮询，关闭即停。
       */
      useEffect(() => {
        if (!open) return undefined
        let alive = true
        const ping = () => {
          if (!alive || document.hidden) return
          void act('speech.refresh').catch(() => {})
        }
        ping()
        if (speechView.ready) return () => { alive = false }
        const timer = setInterval(ping, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [open, speechView.ready])

      // 点挂件外面就收起
      useEffect(() => {
        if (!open) return
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open])

      /**
       * 执行面板动作。
       *
       * ★ 必须把结果回显出来。最初的实现只 await，不看返回值 ——
       * 于是"点了连接没反应"既可能是请求失败、也可能是请求成功但没连上，
       * 用户和我都无法区分。现在无论成败都在面板里给一行文字。
       */
      const [notice, setNotice] = useState('')
      // ★ 配对这类"提交后等设备回话"的动作，结果消息会在下一轮询里被状态取代：
      //   配对成功后仍挂着"已提交配对码，等待设备确认…"就是在骗用户（真机反馈）。
      //   所以只要配对状态变了，就把那条过渡性提示清掉。
      const pairingKey = `${state?.pairing?.paired ? 1 : 0}:${state?.pairing?.needed ? 1 : 0}`
      useEffect(() => {
        setNotice('')
      }, [pairingKey])
      const run = useCallback(async (action, payload) => {
        setBusy(true)
        setNotice('')
        try {
          const body = await act(action, payload)
          const text = body?.result?.message
            ?? (body?.ok === false ? (body.message ?? '操作失败') : '已完成')
          setNotice(text)
        } catch (error) {
          setNotice(`请求失败：${error?.message ?? error}`)
        } finally {
          setBusy(false)
        }
      }, [])

      /**
       * 识别结果卡的消费（docs/06 §2）。
       *
       * 设备按下"填入/发送"→ host 登记 pending → 这里认领（voice.take，多窗口
       * 先到先得）并执行 inputActions → voice.ack 回执 → host toast 反馈设备。
       *
       * 双击发送 = **整段替换**（用户拍板的决策 1）：setDraft(text) + submit()，
       * 设备上看到什么就发什么。替换掉的旧草稿随 ack 带回 host 存档（可找回），
       * 把"静默丢失"降级为"可找回"——这是接受该决策时约定的缓解措施。
       */
      const pending = state?.voice?.pending ?? null
      useEffect(() => {
        const current = pending
        if (!current?.resultId) return
        let alive = true
        void (async () => {
          const claim = await act('voice.take', { resultId: current.resultId })
          if (!alive || !claim?.result?.taken) return
          const mode = claim.result.mode
          const text = claim.result.text ?? current.text ?? ''
          const actions = inputActions ?? {}
          let ok = false
          let reason = ''
          let replacedDraft = ''
          if (mode === 'send') {
            if (typeof actions.setDraft === 'function' && typeof actions.submit === 'function') {
              replacedDraft = typeof inputState?.draft === 'string' ? inputState.draft : ''
              try {
                actions.setDraft(text)
                actions.submit()
                ok = true
              } catch (error) {
                reason = `发送失败：${error?.message ?? error}`
              }
            } else if (typeof actions.setDraft === 'function') {
              replacedDraft = typeof inputState?.draft === 'string' ? inputState.draft : ''
              try {
                actions.setDraft(text)
                ok = true
                reason = '已填入（该版本输入框不支持自动发送）'
              } catch (error) {
                reason = `填入失败：${error?.message ?? error}`
              }
            } else {
              reason = '输入框不可用，文本已保留在语音列表'
            }
          } else {
            if (typeof actions.insertText === 'function') {
              const span = actions.captureInsertion?.()
              if (span) ok = actions.insertText(text, span) === true
              if (!ok) reason = '输入框忙，文本已保留在语音列表'
            } else {
              reason = '输入框不可用，文本已保留在语音列表'
            }
          }
          if (!alive) return
          await act('voice.ack', { resultId: current.resultId, ok, reason, replacedDraft })
        })()
        return () => {
          alive = false
        }
        // 只认 resultId 变化：同一个结果只消费一次，轮询重复渲染不会重复执行。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pending?.resultId])

      // 胶囊只反映链路状态（"运行中任务"指示已按用户要求移除）
      const dotState = linkState
      const label = STATE_TEXT[linkState] ?? linkState

      // 余额区、审批区、任务区均已移除：余额由设备端长按下键查看，审批由设备端审批页处理，
      // 任务列表与刷新按钮用户明确不要；插件只保留"连接状态 + 语音是否启用"。
      return h(
        'div',
        { className: 'ap-widget', ref: rootRef },

        h(
          'button',
          {
            className: 'ap-pill',
            type: 'button',
            'data-state': linkState,
            title: link.device ? `${link.device.name} · ${STATE_TEXT[linkState] ?? linkState}` : 'AI Passport',
            onClick: () => setOpen((value) => !value),
          },
          h('span', { className: 'ap-dot', 'data-state': dotState }),
          h('span', null, label),
          approvals.length > 0 ? h('span', { className: 'ap-badge' }, String(approvals.length)) : null,
        ),

        open
          ? h(
              'div',
              { className: 'ap-pop' },

              // 动作结果提示：成功也给一行，避免"点了没反应"的错觉
              notice
                ? h(
                    'div',
                    {
                      style: {
                        marginBottom: 8,
                        padding: '5px 7px',
                        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
                        borderRadius: 6,
                        fontSize: 11,
                        lineHeight: 1.4,
                        wordBreak: 'break-word',
                      },
                    },
                    notice,
                  )
                : null,

              // —— 设备 ——
              h(
                'div',
                { className: 'ap-sect' },
                // 标题行直接放设备名（比"设备"二字信息量大），带链路状态点
                h(
                  'div',
                  { className: 'ap-h' },
                  h(
                    'span',
                    { className: 'ap-devname' },
                    h('span', { className: 'ap-dot', 'data-state': linkState }),
                    h('span', { title: link.device?.name ?? '' }, link.device?.name ?? 'AI Passport'),
                  ),
                ),
                linkState === 'connected'
                  ? h(
                      'div',
                      null,
                      // 紧凑信息网格：固件 / 电量 / 信号 / 链路 四格，2 列排布不浪费横向空间
                      h(
                        'div',
                        { className: 'ap-grid' },
                        h('div', { className: 'ap-cell' }, h('span', { className: 'k' }, '固件'), h('span', { className: 'v' }, link.deviceInfo?.firmware ?? '—')),
                        h('div', { className: 'ap-cell' }, h('span', { className: 'k' }, '电量'), h('span', { className: 'v' }, link.deviceInfo?.batteryPercent != null ? `${link.deviceInfo.batteryPercent}%` : '—')),
                        h('div', { className: 'ap-cell' }, h('span', { className: 'k' }, '信号'), h('span', { className: 'v' }, link.device?.rssi != null ? `${link.device.rssi} dBm` : '—')),
                        h('div', { className: 'ap-cell' }, h('span', { className: 'k' }, '握手'), h('span', { className: 'v' }, link.handshakeComplete ? '完成' : '进行中')),
                      ),
                      // 按钮收成一条（放不下自动换行）
                      h(
                        'div',
                        { className: 'ap-actions' },
                        h('button', { className: 'ap-btn', type: 'button', disabled: busy, onClick: () => run('device.disconnect') }, '断开'),
                        h('button', { className: 'ap-btn', type: 'button', disabled: busy, onClick: () => run('device.diagnose') }, '诊断蓝牙'),
                      ),
                    )
                  : h(
                      'div',
                      null,
                      h('div', { className: 'ap-muted', style: { marginBottom: 6 } }, STATE_TEXT[linkState] ?? linkState),
                      link.lastError ? h('div', { className: 'ap-err' }, link.lastError.message) : null,
                      link.lastError?.hint ? h('div', { className: 'ap-err ap-muted' }, link.lastError.hint) : null,
                      h(
                        'div',
                        { style: { display: 'flex', gap: 6, marginTop: 6 } },
                        h('button', { className: 'ap-btn primary', type: 'button', disabled: busy, onClick: () => run('device.connect') }, busy ? '连接中…' : '扫描并连接'),
                        h('button', { className: 'ap-btn', type: 'button', disabled: busy, onClick: () => run('device.diagnose') }, '诊断蓝牙'),
                      ),
                      state?.diagnose
                        ? h(
                            'div',
                            { className: 'ap-muted', style: { marginTop: 8, fontSize: 11, lineHeight: 1.5 } },
                            `适配器 ${state.diagnose.adapterState ?? '未上报'} · 桥进程 ${state.diagnose.childRunning ? '运行中' : '未运行'} · noble ${state.diagnose.noble ?? '未加载'}`,
                          )
                        : null,
                    ),
              ),

              // 审批区已移除：审批由 AI Passport 设备端处理（设备有审批页 + 按键交互），
              // 插件不再重复显示，避免两处操作不同步。
              // 余额区已移除：余额改由设备端长按下键查看。

              // —— 配对（未配对时：照着设备屏幕输入 6 位码）——
              pairingView.show
                ? h(
                    'div',
                    { className: 'ap-sect' },
                    h(
                      'div',
                      { className: 'ap-h' },
                      h('span', null, '配对'),
                      h('span', { className: 'ap-state' + (pairingView.paired ? ' on' : '') },
                        pairingView.paired ? '已配对' : '未配对'),
                    ),
                    pairingView.paired
                      ? h(
                          'div',
                          { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 } },
                          h('span', { className: 'ap-muted' },
                            pairingView.deviceId ? `设备 ${pairingView.deviceId}` : '设备已信任本机'),
                          h('button', {
                            className: 'ap-btn', type: 'button', disabled: busy,
                            onClick: () => run('pair.unpair'),
                          }, '解除配对'),
                        )
                      : h(
                          'div',
                          null,
                          h('div', { className: 'ap-muted', style: { marginTop: 4 } },
                            '设备屏幕上的 6 位配对码：'),
                          h(
                            'div',
                            { style: { display: 'flex', gap: 6, marginTop: 6 } },
                            h('input', {
                              className: 'ap-input',
                              type: 'text',
                              inputMode: 'numeric',
                              maxLength: 6,
                              placeholder: '6 位数字',
                              value: pairCode,
                              onInput: (event) => setPairCode(event.target.value.replace(/\D/g, '').slice(0, 6)),
                              onKeyDown: (event) => {
                                if (event.key === 'Enter' && pairCode.length === 6) void run('pair.submit', { code: pairCode })
                              },
                            }),
                            h('button', {
                              className: 'ap-btn primary', type: 'button',
                              disabled: busy || pairCode.length !== 6,
                              onClick: () => run('pair.submit', { code: pairCode }),
                            }, '配对'),
                          ),
                          pairingView.remaining != null && pairingView.remaining <= 1
                            ? h('div', { className: 'ap-err ap-muted' }, `剩余尝试次数：${pairingView.remaining}`)
                            : null,
                        ),
                    pairingView.error ? h('div', { className: 'ap-err' }, pairingView.error) : null,
                  )
                : null,

              // —— 语音（只显示是否启用；未就绪且存在识别提供者时才给"准备模型"）——
              h(
                'div',
                { className: 'ap-sect' },
                h(
                  'div',
                  { className: 'ap-h' },
                  h('span', null, '语音'),
                  // 状态跟在「语音」右边（用户要求），不再单独占一行
                  h('span', { className: 'ap-state', 'data-on': speechView.ready ? '1' : '0' }, speechView.text),
                  // 「准备模型」紧贴在状态右边（用户要求），也不单独占一行
                  speechView.showPrepare
                    ? h(
                        'button',
                        { className: 'ap-btn', type: 'button', disabled: busy, onClick: () => run('speech.prepare') },
                        '准备模型',
                      )
                    : null,
                ),
                speechView.hint ? h('div', { className: 'ap-err' }, speechView.hint) : null,
              ),
            )
          : null,
      )
    }

    /** 硬依赖：只有槽位注册表。locale 用 DSH 的默认语言即可，不额外注册字典。 */
    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(() => {
        ctx.slots.inject('conversation.input.activity', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.activity',
              // 放在模型选择器之后、提交按钮之前，与官方语音输入并排
              order: 40,
              locale: NS,
              inject: () => ({}),
            },
            PassportWidget,
          ),
        )
      }, 'dsh-ai-passport: composer widget')

      // 样式只插一次，随 fiber 一起清理
      try {
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.pluginCss = 'dsh-ai-passport'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'dsh-ai-passport: styles')
      } catch {
        // 没有 document 的环境（理论上不会发生）就跳过样式
      }
    }

    // speechViewFor 一并导出：纯函数，单测直接钉住『已启用就不显示准备模型』这条要求。
    return { apply, inject, name: 'dsh-ai-passport-client', speechViewFor, pairingViewFor }
  },
})
