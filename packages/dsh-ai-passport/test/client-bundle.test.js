/**
 * 客户端 bundle 的离线校验。
 *
 * 为什么必须专门测这一层：客户端半区是**预先构建的浏览器 bundle**，由 DSH 的
 * `client-modules` 直接拼接下发。它的错误只在 DSH 启动时才暴露，而且一旦出错
 * （包名对不上、导出的东西不对、require 了不存在的模块）会让整个 client 包组合失败，
 * 表现为"客户端整个起不来"——排查成本极高。
 *
 * 这个测试用一个假的 `window.__ModuleLoader__` 与假的 `require` 把 bundle 跑一遍，
 * 把上面那些问题在毫秒级、无副作用地抓出来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_BUNDLE = path.join(PACKAGE_ROOT, 'lib', 'client.js')
const PACKAGE_NAME = 'dsh-ai-passport'

/** 一个够用的 React 替身：bundle 在模块顶层只会用到 createElement 等少量 API。 */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  Fragment: Symbol('Fragment'),
}

/**
 * 把 bundle 在受控环境里执行一次。
 *
 * @returns {{exports: object, registered: object[], required: string[], calls: object[]}}
 */
async function runClientBundle() {
  const source = await readFile(CLIENT_BUNDLE, 'utf8')
  const registered = []
  const required = []
  const calls = []

  // bundle 里会往 document.head 插样式，给一个最小替身
  const fakeDocument = {
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
    hidden: false,
  }

  const loader = {
    load(definition) {
      registered.push(definition)
      const module = { exports: {} }
      const require = (name) => {
        required.push(name)
        if (name === 'react') return fakeReact
        if (name === 'react/jsx-runtime') {
          return {
            jsx: (type, props) => ({ type, props }),
            jsxs: (type, props) => ({ type, props }),
          }
        }
        if (name === '@deepseek-ai/dsh-client-ui-primitives') {
          // 只用到少数几个图标/按钮；给一个 Proxy 让任何名字都能取到
          return new Proxy({}, { get: () => () => null })
        }
        throw new Error(`客户端 bundle require 了未提供的模块：${name}`)
      }
      const result = definition.factory(require)
      Object.assign(module.exports, result)
      return module.exports
    },
  }

  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = { __ModuleLoader__: loader }
  // document 必须一直留到 apply() 跑完：`apply()` 里会往 document.head 插样式。
  // （最初的写法在这里就把 document 还回去了，导致样式 effect 被 catch 静默跳过，
  //   测试于是看到一个"缺少样式 effect"的假失败——正是这类测试要抓的那种环境差异。）
  globalThis.document = fakeDocument

  try {
    // bundle 是普通脚本（非 ESM），用间接 eval 在全局作用域执行
    // eslint-disable-next-line no-eval
    ;(0, eval)(source)
  } finally {
    globalThis.window = previousWindow
  }

  assert.equal(registered.length, 1, 'bundle 必须恰好注册一次')
  const definition = registered[0]

  // 用假的 ctx 跑 apply()，抓出注册期的问题
  /** 每次 ctx.effect 的 label 与其回调返回值（只有样式 effect 会返回清理函数）。 */
  const effects = []
  const slotInjections = []
  const ctx = {
    effect: (callback, label) => {
      const cleanup = callback()
      effects.push({ label: label ?? '(无标签)', cleanup: typeof cleanup === 'function' ? cleanup : null })
      return () => {}
    },
    slots: {
      inject: (key, callback) => {
        slotInjections.push({ key, registrations: [] })
        const result = callback()
        return typeof result === 'function' ? result : () => {}
      },
      register: (options, component) => {
        const last = slotInjections[slotInjections.length - 1]
        last?.registrations.push({ options, component })
        calls.push({ kind: 'register', options, component })
        return () => {}
      },
    },
  }

  const exports = loader.load(definition)
  try {
    exports.apply(ctx)
  } finally {
    globalThis.document = previousDocument
  }

  return { definition, exports, required, calls, slotInjections, effects }
}

test('bundle 用 __ModuleLoader__.load 注册，且 id 严格等于包名', async () => {
  const { definition } = await runClientBundle()
  // id 与包名不一致会被 client-modules 组合成一个启动期错误，这里必须卡死
  assert.equal(definition.id, PACKAGE_NAME)
  assert.equal(typeof definition.factory, 'function')
})

test('bundle 不 require 任何未提供的模块', async () => {
  const { required } = await runClientBundle()
  // 只允许这两个（这也是其它官方客户端 bundle 实际用到的）
  const allowed = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'])
  for (const name of required) {
    assert.ok(allowed.has(name), `不允许 require ${name}`)
  }
})

test('导出 apply 与 inject，inject 只声明 slots', async () => {
  const { exports } = await runClientBundle()
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject))
  assert.deepEqual(exports.inject, ['slots'])
})

test('apply() 在 conversation.input.activity 槽位注册了挂件', async () => {
  const { slotInjections, calls } = await runClientBundle()
  assert.equal(slotInjections.length, 1)
  assert.equal(slotInjections[0].key, 'conversation.input.activity')

  const registration = calls.find((call) => call.kind === 'register')
  assert.ok(registration, '应当注册一个槽位条目')
  assert.equal(registration.options.name, 'conversation.input.activity')
  assert.equal(typeof registration.component, 'function', '组件必须是可渲染的 React 组件')
  // order 决定它在工具行里的位置；显式断言避免以后被误改到奇怪的位置
  assert.equal(typeof registration.options.order, 'number')
})

test('apply() 注册了样式，且样式 effect 返回清理函数（不留孤儿 style 标签）', async () => {
  const { effects } = await runClientBundle()

  const labels = effects.map((entry) => entry.label)
  assert.ok(labels.includes('dsh-ai-passport: composer widget'), `缺少挂件 effect，实际：${labels.join(', ')}`)
  assert.ok(labels.includes('dsh-ai-passport: styles'), `缺少样式 effect，实际：${labels.join(', ')}`)

  // 槽位 effect 不需要返回清理函数：`ctx.slots.inject` 返回的注销函数由它自己管理。
  // 真正必须自带清理的是样式 effect —— 否则 fiber 卸载后 <style> 会永远留在页面里，
  // 热重载几次就会堆出一串重复样式。
  const styleEffect = effects.find((entry) => entry.label === 'dsh-ai-passport: styles')
  assert.equal(typeof styleEffect.cleanup, 'function', '样式 effect 必须返回清理函数')
  assert.doesNotThrow(() => styleEffect.cleanup())
})

test('挂件在没有任何状态时也能渲染（首屏不能崩）', async () => {
  const { calls } = await runClientBundle()
  const component = calls.find((call) => call.kind === 'register')?.component
  assert.ok(component)

  // 用 React 的替身直接把组件当函数调用：这能验证渲染路径不依赖 hooks 的顺序，
  // 也覆盖"后端还没起来、state 为 null"这个最常见的首屏状态。
  assert.doesNotThrow(() => {
    const element = component({})
    assert.ok(element, '应当返回一个元素')
  })
})

test('挂件在拿到完整状态时也能渲染，且不抛错', async () => {
  const { calls } = await runClientBundle()
  const component = calls.find((call) => call.kind === 'register')?.component
  // 由于 useApiState 用的是假 React（useState 返回固定值），这里直接验证组件体不崩
  assert.doesNotThrow(() => component({ inputActions: { captureInsertion: () => ({}), insertText: () => true } }))
})

test('挂件接受 useInput 与 setDraft/submit 动词（语音直发消费链的 props 契约）', async () => {
  const { calls } = await runClientBundle()
  const component = calls.find((call) => call.kind === 'register')?.component
  // docs/06 §2 的双击发送用到 setDraft + submit，并从 useInput 读旧草稿。
  // 这里锁住"这些 props 存在时渲染不崩"，防止以后把它们改成必选却忘了容错。
  const props = {
    inputActions: {
      captureInsertion: () => ({}),
      insertText: () => true,
      setDraft: () => {},
      submit: () => {},
    },
    useInput: (selector) => selector({ draft: '旧草稿' }),
  }
  assert.doesNotThrow(() => component(props))
  // useInput 缺失时也必须能渲染（老宿主/别的槽位宿主）
  assert.doesNotThrow(() => component({ inputActions: props.inputActions }))
})

test('语音区：已启用时不显示「准备模型」按钮', async () => {
  const { exports } = await runClientBundle()
  const view = exports.speechViewFor({ speech: { ready: true, providerId: 'sensevoice', providerName: 'SenseVoice' } })
  assert.equal(view.text, '已启用')
  assert.equal(view.showPrepare, false, '已启用就不该再给"准备模型"')
})

test('语音区：有识别提供者但未就绪 → 显示「准备模型」', async () => {
  const { exports } = await runClientBundle()
  const view = exports.speechViewFor({ speech: { ready: false, providerId: 'sensevoice', detail: '下载中 20%' } })
  assert.equal(view.text, '未启用')
  assert.equal(view.showPrepare, true)
})

test('语音区：standby（已装未预热）显示已启用、不给按钮', async () => {
  const { exports } = await runClientBundle()
  const view = exports.speechViewFor({
    speech: { ready: true, phase: 'standby', providerId: 'sensevoice-local', needsPreparation: false },
  })
  assert.equal(view.text, '已启用')
  assert.equal(view.showPrepare, false)
})

test('语音区：正在下载/加载时显示进度说明，而不是「准备模型」', async () => {
  const { exports } = await runClientBundle()
  const view = exports.speechViewFor({
    speech: { ready: false, providerId: 'sensevoice-local', preparing: true, needsPreparation: false, detail: '正在下载模型 120/240 MB' },
  })
  assert.equal(view.showPrepare, false, '下载中不该再给按钮')
  assert.match(view.hint ?? '', /正在下载模型/)
})

test('语音区：没有识别提供者时不显示「准备模型」（prepare 必然抛错）', async () => {
  const { exports } = await runClientBundle()
  const view = exports.speechViewFor({
    speech: { ready: false, providerId: null },
    speechError: '没有可用的识别提供者。请在 DSH 里启用本地语音识别（SenseVoice）或安装一个识别插件。',
  })
  assert.equal(view.showPrepare, false, '没有提供者时不给做不到的按钮')
  assert.match(view.hint ?? '', /没有可用的识别提供者/)
})

test('语音区：宿主没有语音服务时也只说明、不给按钮', async () => {
  const { exports } = await runClientBundle()
  const view = exports.speechViewFor({ speech: null, speechError: '当前 DSH 没有启用语音识别服务（ctx.speechToText 不存在）' })
  assert.equal(view.text, '未启用')
  assert.equal(view.showPrepare, false)
  assert.ok(view.hint)
})

test('挂件不再包含任务区与旧的语音列表（源码级回归钉子）', async () => {
  const source = await readFile(path.join(PACKAGE_ROOT, 'lib/client.js'), 'utf8')
  for (const gone of ['刷新任务', '刷新状态', '暂无任务', 'TASK_TAG', 'ap-row-task', 'ap-voice']) {
    assert.ok(!source.includes(gone), `挂件里不应再出现 ${gone}`)
  }
  // 位置：弹窗改为右对齐 + 可调左移量（用户要求"向左移动一些"）
  assert.ok(source.includes('right:var(--ap-pop-x'), '弹窗必须右对齐并使用可调偏移量')
})

test('package.json 的 dsh.client 与 exports["./client"] 都已声明', async () => {
  const pkg = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.dsh?.client, '必须声明 dsh.client，否则 client-modules 不扫描')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject))
  // client-modules 通过 exports["./client"] 定位 bundle，缺失会让整个组合失败
  const clientExport = pkg.exports?.['./client']
  const resolved = typeof clientExport === 'string' ? clientExport : clientExport?.default
  assert.equal(resolved, './lib/client.js')

  // 声明的路径必须真实存在
  const target = path.join(PACKAGE_ROOT, resolved)
  await assert.doesNotReject(() => readFile(target), `客户端 bundle 不存在：${target}`)
})

test('挂件配对视图：未配对给输入入口、已配对给解除按钮、失败文案可读', async () => {
  const { exports } = await runClientBundle()
  const view = exports.pairingViewFor

  assert.equal(view(null).show, false, '没有配对状态就不显示这一区')

  const needed = view({ pairing: { needed: true, paired: false, deviceId: 'a1b2c3', error: null } })
  assert.equal(needed.show, true)
  assert.equal(needed.needed, true)
  assert.equal(needed.error, null)

  const limited = view({ pairing: { needed: true, paired: false, error: 'rate-limited', remaining: 0 } })
  assert.match(limited.error, /一分钟/)
  assert.equal(limited.remaining, 0)

  const badCode = view({ pairing: { needed: true, paired: false, error: 'bad-code' } })
  assert.match(badCode.error, /配对码不对/)

  const paired = view({ pairing: { needed: false, paired: true, deviceId: 'a1b2c3' } })
  assert.equal(paired.paired, true)
  assert.equal(paired.deviceId, 'a1b2c3')
})

test('挂件源码：配对区必须带输入框与两个动作（防止回退成只显示文字）', async () => {
  const src = await readFile(CLIENT_BUNDLE, 'utf8')
  assert.match(src, /pair\.submit/, '缺少提交配对码的动作')
  assert.match(src, /pair\.unpair/, '缺少解除配对的动作')
  assert.match(src, /ap-input/, '缺少配对码输入框样式')
})

test('挂件：配对状态变化时会清掉过渡提示（不再挂着"等待设备确认…"）', async () => {
  const src = await readFile(CLIENT_BUNDLE, 'utf8')
  // 源码级钉子：必须有"依赖配对状态、清 notice"的副作用
  assert.match(src, /pairingKey/, '缺少配对状态键')
  assert.match(src, /useEffect\(\(\) => \{\s*setNotice\(''\)\s*\}, \[pairingKey\]\)/,
    '配对状态变化必须清掉 notice，否则过渡文案会一直挂着')
})
