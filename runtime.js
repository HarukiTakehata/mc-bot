// 取消只阻止后续副作用；已经发给服务器的操作无法撤回。
const { AsyncLocalStorage } = require('node:async_hooks')

class CancelledError extends Error {
  constructor(message = '任务已取消') { super(message); this.name = 'CancelledError' }
}

function createRuntime({ timeoutMs = 180_000, onTimeout = () => {} } = {}) {
  const storage = new AsyncLocalStorage()
  let epoch = 0
  let controller = new AbortController()
  let pending = null
  let serial = 0
  const isActive = () => {
    const s = storage.getStore()
    return !s || (s.epoch === epoch && !s.signal.aborted)
  }
  const assertActive = () => { if (!isActive()) throw new CancelledError() }
  const unscoped = (fn) => storage.run(undefined, fn)
  const scope = (fn) => storage.run(storage.getStore() || { epoch, signal: controller.signal }, fn)
  const cancel = (reason = '任务已取消') => {
    controller.abort(new CancelledError(reason))
    epoch++
    controller = new AbortController()
  }
  const delay = (ms) => {
    assertActive()
    const signal = storage.getStore()?.signal
    return new Promise((resolve, reject) => {
      const done = () => { signal?.removeEventListener('abort', abort); resolve() }
      const timer = setTimeout(done, ms)
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new CancelledError()) }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
  async function runTask(name, fn, maxMs = timeoutMs) {
    assertActive()
    if (pending) throw new Error(`正在收尾或执行 ${pending.name}，请稍等`)
    const token = { id: ++serial, name, epoch, startedAt: Date.now() }
    pending = token
    const timer = setTimeout(() => unscoped(() => {
      if (pending !== token) return
      cancel('任务超时')
      onTimeout(token)
    }), maxMs)
    try {
      return await scope(async () => { const result = await fn(); assertActive(); return result })
    } finally {
      clearTimeout(timer)
      if (pending === token) pending = null
    }
  }
  function guard(target, names) {
    for (const name of names) {
      if (typeof target?.[name] !== 'function') continue
      const original = target[name]
      target[name] = function (...args) { assertActive(); return original.apply(this, args) }
    }
  }
  function guardResource(result) {
    if (!isActive()) { result?.close?.(); throw new CancelledError() }
    guard(result, ['putFuel', 'putInput', 'takeOutput', 'takeInput', 'takeFuel', 'deposit', 'withdraw'])
    return result
  }
  function guardBot(bot) {
    // Mineflayer 的容器/合成实现会直接调用内部闭包，再写协议包；
    // 只拦 bot.clickWindow 等公开方法无法覆盖这些 await 后的续操作。
    if (typeof bot._client?.write === 'function') {
      const original = bot._client.write
      const cleanup = new Set(['close_window', 'keep_alive', 'pong', 'teleport_confirm'])
      bot._client.write = function (name, ...args) {
        // 某些库调用 fire-and-forget activateBlock；这里抛错会成为未处理拒绝。
        // 丢弃旧上下文的包，外层任务通过取消检查/库的有界等待收尾。
        if (!cleanup.has(name) && !isActive()) return
        return original.call(this, name, ...args)
      }
    }
    guard(bot, ['equip', 'craft', 'toss', 'tossStack', 'consume', 'sleep', 'placeBlock', 'dig',
      'attack', 'activateItem', 'elytraFly', 'clickWindow', 'transfer', 'moveSlotItem'])
    guard(bot.pathfinder, ['goto', 'setGoal', 'setMovements'])
    guard(bot.collectBlock, ['collect'])
    guard(bot.pvp, ['attack'])
    guard(bot.hawkEye, ['oneShot', 'autoAttack'])
    for (const name of ['openContainer', 'openFurnace']) {
      const original = bot[name]
      if (!original) continue
      bot[name] = function (...args) {
        assertActive()
        return Promise.resolve(original.apply(this, args)).then(guardResource)
      }
    }
  }
  return { scope, unscoped, assertActive, isActive, cancel, delay, runTask, guardBot,
    busy: () => !!pending, generation: () => epoch,
    signal: () => storage.getStore()?.signal || controller.signal,
    status: () => pending ? { ...pending, cancelling: pending.epoch !== epoch } : null }
}

module.exports = { createRuntime, CancelledError }
