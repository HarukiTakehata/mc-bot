const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validate, loadWorkflows, createRunner, LIMITS } = require('../workflows')

const wf = (over = {}) => ({ id: 'wood', steps: [{ do: 'chop', args: ['8'] }], ...over })

test('合法工作流：参数按玩家指令规则规整，默认手动触发、失败就停', () => {
  const w = validate(wf({ steps: [{ do: 'chop' }, { do: 'craft', args: ['minecraft:chest'] }, { say: '好了' }, { wait: 2 }, { if: { has: 'oak_log', lt: 4 }, do: 'chop', args: ['4'] }] }))
  assert.deepEqual(w.steps[0], { do: 'chop', args: ['4'] })
  assert.deepEqual(w.steps[1], { do: 'craft', args: ['chest', '1'] })
  assert.equal(w.trigger.on, 'manual')
  assert.equal(w.onFail, 'stop')
  assert.equal(w.size, 5)
})

test('边界：不许套娃、未知字段、坏参数、超长展开、AI 工作流的越权指令和 ask', () => {
  const bad = [
    [wf({ steps: [{ do: 'run', args: ['wood'] }] }), /不能用 run/],
    [wf({ steps: [{ do: 'goal', args: ['x'] }] }), /不能用 goal/],
    [wf({ steps: [{ do: 'mine', args: ['stone', '9999'] }] }), /数量/],
    [wf({ steps: [{ do: 'chop', extra: 1 }] }), /多了字段/],
    [wf({ steps: [{ do: 'chop', say: 'x' }] }), /只能有/],
    [wf({ steps: [{ wait: 601 }] }), /wait/],
    [wf({ steps: [{ repeat: 16, steps: [{ repeat: 16, steps: [{ wait: 1 }] }] }] }), /超过 200 步/],
    [wf({ steps: [{ repeat: 2, steps: [{ repeat: 2, steps: [{ repeat: 2, steps: [{ wait: 1 }] }] }] }] }), /嵌套/],
    [wf({ ai: true, steps: [{ do: 'drop', args: ['dirt'] }] }), /AI/],
    [wf({ ai: true, steps: [{ ask: '做点什么' }] }), /不能用 ask/],
    [wf({ trigger: { on: 'interval', every: 10 } }), /every/],
    [wf({ trigger: { on: 'idle', every: 100 } }), /只有 interval/],
    [wf({ trigger: { on: 'whenever' } }), /trigger.on/],
    [wf({ steps: [{ if: { has: 'oak_log' }, do: 'chop' }] }), /has 条件/],
    [wf({ steps: [{ if: { weather: 'rain' }, do: 'chop' }] }), /不认识的条件/],
    [wf({ id: 'Bad Name' }), /id/],
    [wf({ hack: true }), /不认识的字段/],
    [wf({ steps: [{ say: '换行\n注入' }] }), /单行/],
    [wf({ steps: [] }), /steps/],
  ]
  for (const [raw, re] of bad) assert.throws(() => validate(raw), re, JSON.stringify(raw).slice(0, 80))
})

test('扩展指令只有在已注册时才能用，参数只做边界检查', () => {
  const ext = new Map([['ping', {}]])
  assert.equal(validate(wf({ steps: [{ do: 'ping', args: ['a'] }] }), { extensionCommands: ext }).steps[0].extension, true)
  assert.throws(() => validate(wf({ steps: [{ do: 'ping' }] })), /未知指令/)
  assert.throws(() => validate(wf({ ai: true, steps: [{ do: 'ping' }] }), { extensionCommands: ext }), /扩展指令/)
})

test('读目录：坏文件跳过，重复 id 跳过，符号链接不读', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'))
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(wf()))
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(wf()))
  fs.writeFileSync(path.join(dir, 'c.json'), '{oops')
  fs.symlinkSync(path.join(dir, 'a.json'), path.join(dir, 'd.json'))
  const logs = []
  const all = loadWorkflows(dir, { log: (l) => logs.push(l) })
  assert.deepEqual([...all.keys()], ['wood'])
  for (const re of [/b.json: id wood 重复/, /c.json/, /d.json.*符号链接/]) assert.ok(logs.some((l) => re.test(l)), re)
})

function runnerWith(over = {}) {
  const calls = []
  let cancelled = false
  const deps = {
    exec: async (cmd, args) => { calls.push([cmd, ...args]); return over.exec?.(cmd, args) ?? { ok: true } },
    ask: async (t) => { calls.push(['ask', t]); return { ok: true } },
    say: (t) => calls.push(['say', t]), sleep: async (ms) => calls.push(['wait', ms]),
    inventoryCount: (n) => (over.inv || {})[n] || 0, isNight: () => !!over.night, health: () => 20, food: () => 20,
    isCancelled: () => cancelled,
  }
  return { run: createRunner(deps), calls, cancel: () => { cancelled = true } }
}

test('执行：条件、重复、失败即停、continue 继续', async () => {
  const w = validate(wf({ steps: [
    { if: { has: 'oak_log', lt: 8 }, do: 'chop', args: ['8'] },
    { if: { time: 'night' }, say: '天黑了' },
    { repeat: 2, steps: [{ do: 'fish', args: ['1'] }] },
    { wait: 1 },
  ] }))
  const a = runnerWith({ inv: { oak_log: 10 }, night: true })
  const r = await a.run(w)
  assert.equal(r.ok, true)
  assert.deepEqual(a.calls, [['say', '天黑了'], ['fish', '1'], ['fish', '1'], ['wait', 1000]])

  const failing = validate(wf({ steps: [{ do: 'chop' }, { do: 'craft', args: ['chest'] }] }))
  const b = runnerWith({ exec: (cmd) => (cmd === 'chop' ? { ok: false, error: '找不到树' } : { ok: true }) })
  const rb = await b.run(failing)
  assert.equal(rb.ok, false)
  assert.deepEqual(b.calls, [['chop', '4']])
  assert.match(rb.failures[0], /找不到树/)

  const c = runnerWith({ exec: (cmd) => (cmd === 'chop' ? { ok: false } : { ok: true }) })
  const rc = await c.run({ ...failing, onFail: 'continue' })
  assert.deepEqual(c.calls.map((x) => x[0]), ['chop', 'craft'])
  assert.equal(rc.ok, false)
})

test('执行：被 stop 后不再做下一步', async () => {
  const w = validate(wf({ steps: [{ do: 'chop' }, { do: 'craft', args: ['chest'] }] }))
  const h = runnerWith({ exec: () => { h.cancel(); return { ok: true } } })
  const r = await h.run(w)
  assert.equal(r.stopped, true)
  assert.equal(h.calls.length, 1)
})

test('仓库自带的示例工作流全部合法', () => {
  const logs = []
  const all = loadWorkflows(path.join(__dirname, '..', 'workflows'), { log: (l) => logs.push(l) })
  assert.deepEqual(logs, [])
  assert.ok(all.size >= 1)
})
