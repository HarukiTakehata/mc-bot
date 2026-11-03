const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRuntime, CancelledError, BusyError, PRIORITIES } = require('../runtime')
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

test('高优先级抢占低优先级：低优先级收到 CancelledError，原因记为 preempted', async () => {
  const runtime = createRuntime()
  const gen = runtime.generation()
  let interrupted = null
  const low = runtime.runTask('mine', async () => {
    try {
      await runtime.delay(5000)
    } catch (err) {
      interrupted = err
      throw err
    }
  }, { priority: PRIORITIES.routine })
  await tick()
  assert.equal(runtime.busy(), true)

  const high = runtime.runTask('come', async () => 'done', { priority: PRIORITIES.player })
  assert.equal(await high, 'done')
  await assert.rejects(low, CancelledError)
  assert.ok(interrupted instanceof CancelledError)
  assert.equal(runtime.cancelCode(gen), 'preempted')
  assert.equal(runtime.busy(), false)
})

test('低优先级不能顶掉正在执行的高优先级，拿到 BUSY', async () => {
  const runtime = createRuntime()
  const high = runtime.runTask('come', () => runtime.delay(150), { priority: PRIORITIES.player })
  await tick()
  await assert.rejects(runtime.runTask('idle', async () => {}, { priority: PRIORITIES.idle }), (err) => {
    assert.ok(err instanceof BusyError)
    assert.equal(err.code, 'BUSY')
    assert.match(err.message, /收尾|执行/)
    return true
  })
  await high
})

test('同优先级仍然互斥，不抢占', async () => {
  const runtime = createRuntime()
  const first = runtime.runTask('a', () => runtime.delay(120), { priority: PRIORITIES.routine })
  await tick()
  await assert.rejects(runtime.runTask('b', async () => {}, { priority: PRIORITIES.routine }), BusyError)
  await first
})

test('抢占后高优先级正常结束，低优先级才能再进来', async () => {
  const runtime = createRuntime()
  const order = []
  const low = runtime.runTask('mine', async () => {
    try { await runtime.delay(5000) } catch (err) { order.push('preempted'); throw err }
  }, { priority: PRIORITIES.routine }).catch(() => {})
  await tick()
  await runtime.runTask('come', async () => { order.push('come') }, { priority: PRIORITIES.player })
  await low
  assert.deepEqual(order, ['preempted', 'come'])
  assert.equal(runtime.busy(), false)
})

test('数字超时参数保持兼容', async () => {
  const runtime = createRuntime()
  assert.equal(await runtime.runTask('old-style', async () => 42, 1000), 42)
})

test('玩家 stop 与抢占的取消原因区分开', async () => {
  const runtime = createRuntime()
  const gen = runtime.generation()
  const task = runtime.runTask('mine', () => runtime.delay(5000), { priority: PRIORITIES.routine })
  await tick()
  runtime.cancel('停下了', 'stop')
  await assert.rejects(task, CancelledError)
  assert.equal(runtime.cancelCode(gen), 'stop')
})
