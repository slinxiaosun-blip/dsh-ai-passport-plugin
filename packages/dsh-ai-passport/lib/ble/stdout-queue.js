/**
 * 桥进程 stdout 的发送队列（真背压）。
 *
 * 为什么值得单独成模块：
 *   1. 它是"语音上行期间桥进程被 OOM 杀掉"这条真实故障的修复点，必须有单测钉住；
 *   2. 塞在 bridge-worker.js 里既测不到（那个文件 import 即连 stdin），
 *      也太容易被下次重构顺手简化成"只记一个布尔标志"——旧版就是这么退化的。
 *
 * 语义（与 Node 的 Writable 背压契约一致）：
 *   · `write()` 返回 true  → 直接写，不进队列；
 *   · 返回 false           → 这一行**已经被流接下了**（Node 的 write 总是先缓冲再
 *     返回水位信号，不是"拒收"），只是要求我们停止继续写；此时记 blocked、
 *     注册一次 drain，后续行全部入队；
 *   · drain 触发           → 按入队顺序补写，直到再次写不动。
 *
 * 溢出策略：队列到上限时，**只淘汰 `data` 帧**（语音/控制数据帧本来就允许丢），
 * 命令回执（`{id, ok}`）与错误（`{id, ok:false}`）永远保留 ——
 * 丢了它们，主机侧会一直挂到超时，比丢一帧音频严重得多。
 */

/**
 * @param {object} options
 * @param {(line:string)=>boolean} options.write 写一行（返回值同 Node 的 write）
 * @param {(cb:()=>void)=>void} options.onDrain 注册一次 drain 回调
 * @param {(level:string, message:string)=>void} [options.log]
 * @param {number} [options.limit] 队列行数上限
 */
export function createStdoutQueue(options) {
  const { write, onDrain, log = () => {}, limit = 512 } = options
  if (typeof write !== 'function') throw new TypeError('createStdoutQueue 需要 write')
  if (typeof onDrain !== 'function') throw new TypeError('createStdoutQueue 需要 onDrain')

  /** @type {Array<{line:string, droppable:boolean}>} */
  const queue = []
  let blocked = false
  let dropped = 0

  function armDrain() {
    onDrain(onStdoutDrain)
  }

  function onStdoutDrain() {
    if (!blocked) return
    blocked = false
    log('debug', `stdout 已恢复（积压 ${queue.length} 行，期间丢弃 ${dropped} 帧）`)
    dropped = 0
    while (queue.length > 0) {
      const item = queue.shift()
      if (!write(item.line)) {
        blocked = true
        armDrain()
        return
      }
    }
  }

  function writeNow(line) {
    if (write(line)) return
    if (!blocked) {
      blocked = true
      log('warn', `stdout 背压，后续消息进入队列（上限 ${limit} 行）`)
    }
    armDrain()
  }

  function send(payload) {
    const line = `${JSON.stringify(payload)}\n`
    // 只有 data 帧可丢：BLE 数据本身就不保证送达，丢一帧不会让上层卡住。
    const droppable = payload?.event === 'data'

    if (!blocked) {
      writeNow(line)
      return
    }

    if (queue.length >= limit) {
      const index = queue.findIndex((item) => item.droppable)
      if (index >= 0) {
        queue.splice(index, 1)
        dropped += 1
      } else if (droppable) {
        dropped += 1
        return
      }
    }
    queue.push({ line, droppable })
  }

  return {
    send,
    get blocked() {
      return blocked
    },
    get length() {
      return queue.length
    },
    get dropped() {
      return dropped
    },
  }
}
