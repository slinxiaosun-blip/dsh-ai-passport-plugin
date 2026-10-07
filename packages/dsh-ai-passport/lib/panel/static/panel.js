/**
 * 控制面板前端（原生 ES 模块，无构建步骤）。
 *
 * 数据来源两条：
 *   - SSE /dsh-passport/events：实时增量（状态变化、任务更新、审批请求）
 *   - POST /dsh-passport/action：所有写操作
 * SSE 断线时自动降级为轮询 /state.json，保证面板不会"看起来死了"。
 */

const els = {
  linkDot: document.getElementById('link-dot'),
  linkState: document.getElementById('link-state'),
  deviceName: document.getElementById('device-name'),
  connect: document.getElementById('btn-connect'),
  disconnect: document.getElementById('btn-disconnect'),
  banner: document.getElementById('banner'),
  deviceInfo: document.getElementById('device-info'),
  linkStats: document.getElementById('link-stats'),
  taskList: document.getElementById('task-list'),
  taskCount: document.getElementById('task-count'),
  approvalList: document.getElementById('approval-list'),
  approvalCount: document.getElementById('approval-count'),
  balanceValue: document.getElementById('balance-value'),
  balanceDetail: document.getElementById('balance-detail'),
  balanceHint: document.getElementById('balance-hint'),
  speechInfo: document.getElementById('speech-info'),
  voiceLog: document.getElementById('voice-log'),
  eventLog: document.getElementById('event-log'),
}

const STATE_LABEL = {
  idle: '未连接',
  scanning: '扫描中',
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  failed: '链路异常',
}

const STATUS_LABEL = {
  idle: 'IDLE',
  running: 'RUN',
  done: 'DONE',
  error: 'ERR',
  aborted: 'STOP',
  waiting: 'WAIT',
}

let lastState = null
let eventSource = null
let pollTimer = null

// —— 动作 ——

async function act(action, payload = {}) {
  try {
    const response = await fetch('/dsh-passport/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload }),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || !body?.ok) {
      showBanner(body?.message ?? `操作失败（HTTP ${response.status}）`, 'error')
      return null
    }
    if (body.result?.state) applyState(body.result.state)
    if (body.result?.message) showBanner(body.result.message, 'info')
    return body.result
  } catch (error) {
    showBanner(`无法连接面板后端：${error.message}`, 'error')
    return null
  }
}

function showBanner(text, kind = 'info', timeoutMs = 6000) {
  els.banner.textContent = text
  els.banner.className = `banner${kind === 'error' ? ' error' : kind === 'warn' ? ' warn' : ''}`
  if (timeoutMs > 0) {
    clearTimeout(showBanner.timer)
    showBanner.timer = setTimeout(() => els.banner.classList.add('hidden'), timeoutMs)
  }
}

// —— 渲染 ——

function applyState(state) {
  if (!state) return
  lastState = state
  const link = state.link ?? {}
  const transportState = link.state ?? 'idle'

  els.linkDot.className = `dot ${transportState}`
  els.linkState.textContent = STATE_LABEL[transportState] ?? transportState
  els.deviceName.textContent = link.device?.name ?? '—'

  els.connect.disabled = transportState === 'connected' || transportState === 'scanning' || transportState === 'connecting'
  els.disconnect.disabled = transportState !== 'connected'

  renderDevice(link)
  renderTasks(state.tasks ?? [])
  renderApprovals(state.approvals ?? [])
  renderBalance(state.balance, state.balanceError)
  renderSpeech(state.speech, state.speechError)
}

function renderDevice(link) {
  const info = link.deviceInfo ?? {}
  const rows = [
    ['链路实现', link.transport ?? '—'],
    ['状态', STATE_LABEL[link.state] ?? link.state ?? '—'],
    ['握手', link.handshakeComplete ? '已完成' : '未完成'],
    ['固件', info.firmware ?? '—'],
    ['协议版本', info.protocolVersion ?? '—'],
    // != null：0% 显示 "0%"；只有设备没上报（老固件/电量计缺失）才是 "—"
    ['设备电量', info.batteryPercent != null ? `${info.batteryPercent}%` : '—'],
    ['ATT 载荷', link.mtuPayload ? `${link.mtuPayload} B` : '—'],
    ['信号', link.device?.rssi != null ? `${link.device.rssi} dBm` : '—'],
  ]
  els.deviceInfo.replaceChildren(...rows.flatMap(([key, value]) => {
    const dt = document.createElement('dt')
    dt.textContent = key
    const dd = document.createElement('dd')
    dd.textContent = String(value)
    return [dt, dd]
  }))
  els.linkStats.textContent = JSON.stringify(link.stats ?? {}, null, 2)

  if (link.lastError) {
    showBanner(`${link.lastError.message}${link.lastError.hint ? ` —— ${link.lastError.hint}` : ''}`, 'error', 0)
  }
}

function renderTasks(tasks) {
  els.taskCount.textContent = String(tasks.length)
  if (tasks.length === 0) {
    els.taskList.replaceChildren(Object.assign(document.createElement('li'), {
      className: 'empty',
      textContent: '暂无任务。连接设备后会自动拉取。',
    }))
    return
  }
  els.taskList.replaceChildren(...tasks.map((task) => {
    const li = document.createElement('li')

    const title = document.createElement('div')
    title.className = 'title'
    const status = document.createElement('span')
    status.className = `status ${task.status ?? 'idle'}`
    status.textContent = STATUS_LABEL[task.status] ?? String(task.status ?? '?').toUpperCase()
    const name = document.createElement('span')
    name.textContent = task.title ?? '(无标题)'
    title.append(status, name)

    const meta = document.createElement('div')
    meta.className = 'meta'
    const parts = []
    if (task.sessionId) parts.push(task.sessionId.slice(0, 12))
    if (task.step != null) parts.push(`step ${task.step}`)
    if (task.tool) parts.push(task.tool)
    if (task.updatedAt) parts.push(new Date(task.updatedAt).toLocaleTimeString())
    meta.textContent = parts.join(' · ')

    li.append(title, meta)
    return li
  }))
}

function renderApprovals(approvals) {
  els.approvalCount.textContent = String(approvals.length)
  if (approvals.length === 0) {
    els.approvalList.replaceChildren(Object.assign(document.createElement('li'), {
      className: 'empty',
      textContent: '没有等待中的审批。',
    }))
    return
  }
  els.approvalList.replaceChildren(...approvals.map((item) => {
    const li = document.createElement('li')

    const tool = document.createElement('div')
    tool.className = 'tool'
    tool.textContent = item.toolName ?? '(未知工具)'

    const reason = document.createElement('div')
    reason.className = 'reason'
    reason.textContent = item.displayReason ?? item.reason ?? '未提供原因'

    const actions = document.createElement('div')
    actions.className = 'actions'
    const allow = document.createElement('button')
    allow.className = 'btn small'
    allow.textContent = '允许一次'
    allow.addEventListener('click', () => act('approval.decide', { id: item.id, decision: 'allow' }))
    const deny = document.createElement('button')
    deny.className = 'btn small ghost'
    deny.textContent = '拒绝'
    deny.addEventListener('click', () => act('approval.decide', { id: item.id, decision: 'deny' }))
    actions.append(allow, deny)

    li.append(tool, reason, actions)
    return li
  }))
}

function renderBalance(balance, error) {
  if (error) {
    els.balanceValue.textContent = '—'
    els.balanceHint.textContent = error
    els.balanceDetail.replaceChildren()
    return
  }
  if (!balance) {
    els.balanceValue.textContent = '—'
    els.balanceHint.textContent = '尚未获取。点击「刷新余额」或等待设备请求。'
    els.balanceDetail.replaceChildren()
    return
  }
  els.balanceValue.textContent = `${balance.totalBalance?.toFixed?.(2) ?? balance.totalBalance} ${balance.currency ?? 'CNY'}`
  const rows = [
    ['充值余额', balance.rechargeBalance],
    ['赠送余额', balance.bonusBalance],
    ['今日已用', balance.todayUsed],
    ['更新于', balance.fetchedAt ? new Date(balance.fetchedAt).toLocaleTimeString() : '—'],
  ]
  els.balanceDetail.replaceChildren(...rows.flatMap(([key, value]) => {
    const dt = document.createElement('dt')
    dt.textContent = key
    const dd = document.createElement('dd')
    dd.textContent = value == null ? '—' : String(value)
    return [dt, dd]
  }))
  els.balanceHint.textContent = balance.note ?? ''
}

function renderSpeech(speech, error) {
  const rows = []
  if (error) rows.push(['状态', error])
  else if (!speech) rows.push(['状态', '未知'])
  else {
    rows.push(['提供者', speech.providerName ?? '未启用'])
    rows.push(['就绪', speech.ready ? '是' : '否'])
    if (speech.phase) rows.push(['阶段', speech.phase])
    if (speech.detail) rows.push(['详情', speech.detail])
  }
  els.speechInfo.replaceChildren(...rows.flatMap(([key, value]) => {
    const dt = document.createElement('dt')
    dt.textContent = key
    const dd = document.createElement('dd')
    dd.textContent = String(value)
    return [dt, dd]
  }))
}

function pushEvent(event) {
  const li = document.createElement('li')
  const time = document.createElement('span')
  time.className = 'time'
  time.textContent = new Date().toLocaleTimeString()
  const type = document.createElement('span')
  type.className = 'type'
  type.textContent = event.type ?? '?'
  const body = document.createElement('span')
  body.className = 'body'
  const { type: _t, state: _s, ...rest } = event
  body.textContent = JSON.stringify(rest)
  li.append(time, type, body)
  els.eventLog.prepend(li)
  while (els.eventLog.children.length > 200) els.eventLog.lastElementChild.remove()
}

function pushVoice(entry) {
  const li = document.createElement('li')
  li.textContent = `${new Date().toLocaleTimeString()}  ${entry.text ?? entry.error ?? ''}`
  els.voiceLog.prepend(li)
  while (els.voiceLog.children.length > 30) els.voiceLog.lastElementChild.remove()
}

// —— 实时通道 ——

function connectEvents() {
  if (typeof EventSource === 'undefined') {
    startPolling()
    return
  }
  eventSource = new EventSource('/dsh-passport/events')
  eventSource.onmessage = (message) => {
    let event
    try {
      event = JSON.parse(message.data)
    } catch {
      return
    }
    if (event.type === 'snapshot' && event.state) {
      stopPolling()
      applyState(event.state)
      return
    }
    pushEvent(event)
    if (event.state) applyState(event.state)
    if (event.type === 'voice.result' || event.type === 'voice.error') pushVoice(event)
  }
  eventSource.onerror = () => {
    // SSE 断了：不弹错，静默降级到轮询，避免"面板看起来坏了"
    eventSource?.close()
    eventSource = null
    startPolling()
    setTimeout(connectEvents, 5000)
  }
}

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(async () => {
    try {
      const response = await fetch('/dsh-passport/state.json')
      const body = await response.json()
      if (body?.ok) applyState(body.state)
    } catch {
      // 后端还没起来，下个周期再试
    }
  }, 2000)
}

function stopPolling() {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

// —— 事件绑定 ——

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]')
  if (!button) return
  const payload = button.dataset.payload ? JSON.parse(button.dataset.payload) : {}
  void act(button.dataset.action, payload)
})

els.connect.addEventListener('click', () => act('device.connect'))
els.disconnect.addEventListener('click', () => act('device.disconnect'))
document.getElementById('btn-clear-events').addEventListener('click', () => els.eventLog.replaceChildren())

// —— 启动 ——

void (async () => {
  try {
    const response = await fetch('/dsh-passport/state.json')
    const body = await response.json()
    if (body?.ok) applyState(body.state)
  } catch {
    showBanner('无法读取初始状态，后端可能还在启动。', 'warn')
  }
  connectEvents()
})()
