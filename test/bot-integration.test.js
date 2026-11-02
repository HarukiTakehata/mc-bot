// 执行真实 bot.js 的入口与调度代码，所有网络/游戏/存储边界均为替身。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(setImmediate) }

function harness({ ask = async () => ({ reply: '', actions: [], done: false }), taskWait, flightWait, routeHook, fastGoalDelays = false } = {}) {
  const sent = [], marks = [], calls = [], logs = []
  const engines = []
  const bot = new EventEmitter()
  const pos = { x: 1, y: 64, z: 2, clone() { return { ...this } } }
  Object.assign(bot, {
    username: 'UnitBot', entity: { position: pos }, entities: {}, players: {}, health: 20, food: 20,
    game: { dimension: 'overworld' },
    registry: { itemsByName: {}, blocksByName: {}, blocksArray: [] }, inventory: { items: () => [] },
    chat: (s) => sent.push(s), loadPlugin() {}, findBlocks: () => [], nearestEntity: () => null,
    pvp: { stop() {}, attack() {} }, hawkEye: { stop() {} }, collectBlock: { cancelTask: async () => {} },
    pathfinder: { setMovements() {}, setGoal(g) { this.goal = g; calls.push(['goal', g]) }, isMoving: () => false, goto: async () => {} },
    stopDigging() {}, clearControlStates() {}, equip: () => calls.push('equip'), quit() {},
    look: async (...args) => calls.push(['look', ...args]), elytraFly: async () => calls.push('glide'),
  })
  class Movements {
    constructor() { this.blocksCantBreak = new Set(); this.exclusionAreasPlace = []; this.scafoldingBlocks = []; this.liquids = new Set() }
    getNeighbors() { return [] }
    getBlock() { return {} }
    getMoveForward() {}
  }
  const mods = {
    mineflayer: { createBot: () => bot },
    'mineflayer-pathfinder/lib/move': class {},
    'mineflayer-pathfinder': { pathfinder() {}, Movements, goals: { GoalNear: class {}, GoalFollow: class {} } },
    'mineflayer-collectblock': { plugin() {} }, 'mineflayer-tool': { plugin() {} }, 'mineflayer-pvp': { plugin() {} },
    minecrafthawkeye: { default() {} }, './fabric': { setupFabric() {}, MODDED_BLOCK_ID: 100000 },
    './modes': { createModes: () => ({ list() {}, describe: () => [], set: () => true }) },
    './combat': { createCombat: () => ({ stop() {}, active: () => false, equipWeapon() {} }) },
    './memory': { list: () => [], add() {} },
    './storage': { readJSON: (_file, fallback) => fallback, writeJSON() {} }, // 别把测试目标写进真实 data/goal.json
    './ai': { createAI: () => ({ ask: (...args) => { calls.push(['ask', args[0]]); return ask(...args) }, cancel() {}, statistics: () => ({}) }) },
    './skills': { createSkills: (_bot, ctx) => ({
      commands: {
        mark: (u, args) => marks.push([u, ...args]),
        smelt: () => ctx.runTask('test', async () => { await taskWait.promise; bot.equip() }),
        go: (_u, [name], options = {}) => ctx.runTask(`去${name}`, () => ctx.travelTo({ x: 80, y: 64, z: 0 }, { range: 1, ...options })),
      }, places: { 家: { x: 80, y: 64, z: 0, dim: 'overworld' } }, describePlaces: () => '',
    }) },
  }
  if (routeHook) mods['./auto-travel'] = { createAutoTravel: (_bot, ctx) => ({
    travelTo: async (target, options) => { calls.push(['travelTo', target, options]); return routeHook(target, options, ctx) },
    describe: () => '胸槽elytra，烟花16，近路步行/远路核验后飞行', status: () => ({ active: false }),
  }) }
  if (flightWait) mods['./flight'] = { createFlight: (_bot, ctx) => {
    let active = false, phase = 'IDLE'
    const engine = {
      launchSite: () => ({ here: true }),
      async fly(target) { active = true; phase = 'CLIMB'; calls.push(['fly', target, bot.pathfinder.goal]); const result = await flightWait.promise; active = false; phase = 'IDLE'; return result },
      active: () => active, status: () => ({ phase }),
      requestLand() { if (active) phase = 'LANDING' }, dispose() { active = false; phase = 'DISPOSED' },
    }
    engines.push({ engine, ctx })
    return engine
  } }
  const root = path.resolve(__dirname, '..')
  const context = vm.createContext({
    require: (name) => mods[name] || (name === 'vec3' || require('node:module').isBuiltin(name) ? require(name) : require(path.resolve(root, name))),
    console: { log: (...args) => logs.push(args.join(' ')) },
    process: { env: { DEEPSEEK_API_KEY: 'unit-test-placeholder' }, on() {}, exit() { throw new Error('unexpected process exit') } },
    setTimeout: (fn, ms) => fastGoalDelays && ms === 1000 ? setImmediate(fn) : 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, Date, Promise, Buffer, __dirname: root,
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'bot.js'), 'utf8'), context, { filename: 'bot.js' })
  bot.emit('spawn')
  sent.length = 0
  return { bot, sent, marks, calls, logs, engines, readGoal: () => vm.runInContext('goal', context) }
}

test('真实聊天入口拒绝原型名、保护最终片段，之后合法玩家仍可控制', async () => {
  const h = harness()
  h.bot.emit('chat', 'Anyone', 'bot __proto__')
  await flush()
  h.bot.emit('chat', 'Anyone', 'bot say /op Someone')
  await flush()
  h.bot.emit('chat', 'AnotherPlayer', 'bot say ' + 'x'.repeat(180) + '/op Someone')
  await flush()
  h.bot.emit('chat', 'AnotherPlayer', 'bot mark 家')
  await flush()
  assert.ok(h.sent.some((s) => s.includes('/op')))
  assert.ok(h.sent.every((s) => !s.startsWith('/') && !s.includes('\n')))
  assert.deepEqual(h.marks, [['AnotherPlayer', '家']])
  assert.equal(h.calls.length, 0)
})

test('stop 在模型响应前到达时，真实调度器不执行旧回复或旧动作', async () => {
  const wait = deferred()
  const h = harness({ ask: () => wait.promise })
  h.bot.emit('chat', 'Player', 'bot 帮我记地点')
  await flush()
  h.bot.emit('chat', 'Player', 'bot stop')
  await flush()
  wait.resolve({ reply: 'stale-reply', actions: [{ cmd: 'mark', args: ['旧地点'] }], done: false })
  await flush()
  assert.deepEqual(h.marks, [])
  assert.equal(h.sent.includes('stale-reply'), false)
  h.bot.emit('chat', 'NewPlayer', 'bot mark 新地点')
  await flush()
  assert.deepEqual(h.marks, [['NewPlayer', '新地点']])
})

test('模型替身返回畸形动作不会逃逸异常；真实目标保留发起人', async () => {
  let malformed = true
  const h = harness({ ask: async () => malformed ? { reply: 'invalid', actions: [null] } : { reply: '完成', actions: [{ cmd: 'mark', args: ['基地'] }], done: true } })
  h.bot.emit('chat', 'Player', 'bot hello')
  await flush()
  assert.deepEqual(h.marks, [])
  malformed = false
  h.bot.emit('chat', 'Starter', 'bot goal 记下基地')
  await flush()
  assert.deepEqual(h.marks, [['Starter', '基地']])
  assert.ok(h.calls.some((c) => Array.isArray(c) && c[1] === 'Starter'))
})

test('stop 后旧任务未收尾前拒绝新工作，旧清理不影响后续新任务', async () => {
  const wait = deferred()
  const h = harness({ taskWait: wait })
  h.bot.emit('chat', 'Player', 'bot smelt raw_iron 1')
  await flush()
  h.bot.emit('chat', 'Player', 'bot stop')
  await flush()
  h.bot.emit('chat', 'Player', 'bot mark too_early')
  await flush()
  assert.deepEqual(h.marks, [])
  wait.resolve()
  await flush()
  assert.equal(h.calls.includes('equip'), false)
  h.bot.emit('chat', 'Player', 'bot mark ready')
  await flush()
  assert.deepEqual(h.marks, [['Player', 'ready']])
})

test('真实fly入口清除旧跟随目标，停止后持锁降落，旧实例不能借新降落权限', async () => {
  const wait = deferred(), h = harness({ flightWait: wait })
  h.bot.pathfinder.goal = { staleFollow: true }
  h.bot.emit('chat', 'Player', 'bot fly 家')
  await flush()
  const call = h.calls.find((c) => Array.isArray(c) && c[0] === 'fly')
  assert.deepEqual(JSON.parse(JSON.stringify(call[1])), { x: 80, y: 64, z: 0 })
  assert.equal(call[2], null)
  h.bot.emit('chat', 'Player', 'bot stop')
  await flush()
  h.bot.emit('chat', 'Player', 'bot mark premature')
  await flush()
  assert.deepEqual(h.marks, [])
  await h.engines[0].ctx.safetyLook(1, 1)
  assert.equal(h.calls.filter((c) => Array.isArray(c) && c[0] === 'look').length, 0)
  await h.engines.at(-1).ctx.safetyLook(1, 1)
  assert.equal(h.calls.filter((c) => Array.isArray(c) && c[0] === 'look').length, 1)
  wait.resolve({ ok: false, reached: false, landed: true, position: { x: 10, y: 64, z: 0 }, reason: 'stop', rocketsUsed: 1 })
  await flush()
  assert.ok(h.sent.some((s) => /落地前/.test(s)))
  assert.equal(h.sent.some((s) => /已飞抵/.test(s)), false)
  h.bot.emit('chat', 'Player', 'bot mark after_landing')
  await flush()
  assert.deepEqual(h.marks, [['Player', 'after_landing']])
})

test('AI goto与命名go/come共用自动交通，walk明确保留步行偏好', async () => {
  const hook = async (target, options) => ({ kind: 'travel', ok: true, reached: true, target, position: target,
    transport: options.mode === 'walk' ? 'walk' : 'fly', modeChosen: 'fly', reason: 'test', rocketsUsed: 1 })
  const h = harness({ ask: async () => ({ reply: '去目的地', actions: [{ cmd: 'goto', args: ['300', '64', '0'] }], done: true }), routeHook: hook })
  h.bot.emit('chat', 'Player', 'bot 带我去远处')
  await flush()
  const first = h.calls.find((c) => Array.isArray(c) && c[0] === 'travelTo')
  assert.deepEqual(JSON.parse(JSON.stringify(first.slice(1))), [{ x: 300, y: 64, z: 0 }, { range: 1 }])
  h.bot.emit('chat', 'Player', 'bot go 家'); await flush()
  h.bot.players.Player = { entity: { position: { x: 180, y: 64, z: 0 } } }
  h.bot.emit('chat', 'Player', 'bot come'); await flush()
  const all = h.calls.filter((c) => Array.isArray(c) && c[0] === 'travelTo')
  assert.equal(all[1][1].x, 80)
  assert.equal(all[2][2].range, 2)
  h.bot.emit('chat', 'Player', 'bot walk 家'); await flush()
  const walking = h.calls.filter((c) => Array.isArray(c) && c[0] === 'travelTo').at(-1)
  assert.equal(walking[2].mode, 'walk')
})

test('交通已经降级步行成功时，不因聊天包含失败字样重规划或阻断后续AI动作', async () => {
  const h = harness({ ask: async () => ({ reply: '过去看看', actions: [{ cmd: 'goto', args: ['300', '64', '0'] }, { cmd: 'mark', args: ['已到'] }], done: true }),
    routeHook: async (target, _options, ctx) => {
      ctx.say('起飞预检失败，已用步行到达')
      return { kind: 'travel', ok: true, reached: true, target, position: target, transport: 'walk', reason: 'long_distance', fallbackReason: 'launch_blocked', rocketsUsed: 0 }
    } })
  h.bot.emit('chat', 'Player', 'bot 去远处并记下位置')
  await flush()
  assert.deepEqual(h.marks, [['Player', '已到']])
  assert.equal(h.calls.filter((c) => Array.isArray(c) && c[0] === 'ask').length, 1)
})

test('AI不能先equip鞘翅绕过自动赶路胸甲保护，玩家显式装备仍可使用', async () => {
  const h = harness({ ask: async () => ({ reply: '过去', actions: [{ cmd: 'equip', args: ['elytra'] }, { cmd: 'goto', args: ['300', '64', '0'] }], done: false }),
    routeHook: async () => { throw new Error('不能越过装备保护') } })
  h.bot.inventory.slots = []
  h.bot.inventory.slots[6] = { name: 'iron_chestplate' }
  h.bot.emit('chat', 'Player', 'bot 去远处')
  await flush()
  assert.equal(h.calls.includes('equip'), false)
  assert.equal(h.calls.some((c) => Array.isArray(c) && c[0] === 'travelTo'), false)
  assert.equal(h.bot.inventory.slots[6].name, 'iron_chestplate')
})

test('长期目标连续两轮交通失败被计入失败记忆', async () => {
  const waiting = deferred()
  let requests = 0
  const h = harness({ fastGoalDelays: true, ask: async () => ++requests > 2 ? waiting.promise : { reply: '', actions: [{ cmd: 'goto', args: ['300', '64', '0'] }], done: false },
    routeHook: async (target) => ({ kind: 'travel', ok: false, reached: false, target, position: { x: 1, y: 64, z: 2 }, transport: 'walk', reason: 'NoPath', rocketsUsed: 0 }) })
  h.bot.emit('chat', 'Player', 'bot goal 去远处坐标')
  const deadline = Date.now() + 5000
  while (requests < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(h.readGoal()?.failures['goto 300 64 0'], 2)
  h.bot.emit('chat', 'Player', 'bot stop')
  waiting.resolve({ reply: '', actions: [], done: false })
  await flush()
})

test('显式walk失败不自动交给AI改成飞行', async () => {
  const h = harness({ ask: async () => { throw new Error('不该改成AI交通') },
    routeHook: async (target) => ({ kind: 'travel', ok: false, reached: false, target, position: target, transport: 'walk', reason: 'NoPath', rocketsUsed: 0 }) })
  h.bot.emit('chat', 'Player', 'bot walk 300 64 0')
  await flush()
  assert.equal(h.calls.some((c) => Array.isArray(c) && c[0] === 'ask'), false)
})

test('玩家明确不要飞时，AI误给goto也保持步行偏好', async () => {
  const h = harness({ ask: async () => ({ reply: '过去', actions: [{ cmd: 'goto', args: ['300', '64', '0'] }], done: true }),
    routeHook: async (target, options) => ({ kind: 'travel', ok: true, reached: true, target, position: target, transport: options.mode, reason: 'forced_walk', rocketsUsed: 0 }) })
  h.bot.emit('chat', 'Player', 'bot 全程步行去远处，不要飞')
  await flush()
  const route = h.calls.find((c) => Array.isArray(c) && c[0] === 'travelTo')
  assert.equal(route[2].mode, 'walk')
})
