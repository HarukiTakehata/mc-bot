const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { createCompanion } = require('../companion')

function harness() {
  let time = 0, follow = { name: 'Alice', distance: 4 }, paused = false
  const messages = [], bound = [], cleared = []
  const bot = Object.assign(new EventEmitter(), { entity: { position: new Vec3(0, 64, 0) },
    game: { dimension: 'overworld' }, health: 20, food: 20, time: { timeOfDay: 0 },
    players: {}, registry: { foodsByName: { bread: {} } },
    inventory: { items: () => [{ name: 'bread', count: 8 }, { name: 'stone_pickaxe', count: 1 }], slots: [], emptySlotCount: () => 20 } })
  bot.inventory.slots[6] = { name: 'iron_chestplate' }
  const companion = createCompanion(bot, { manualTick: true, now: () => time, say: (s) => messages.push(s),
    getFollow: () => follow, paused: () => paused, followEntity: (e, d) => bound.push([e.id, d]), pauseFollow: () => cleared.push('pause'),
    clearFollow: (s) => { cleared.push(s); follow = null } })
  return { bot, companion, messages, bound, cleared, advance: (n) => { time += n }, pause: (v) => { paused = v }, stop: () => { follow = null } }
}
test('跟随实体被替换时换绑，失联只提醒一次，重新捕获后恢复', () => {
  const h = harness()
  h.bot.players.Alice = { entity: { id: 1, position: new Vec3(3, 64, 0) } }
  h.companion.tick(); h.companion.tick()
  assert.deepEqual(h.bound, [[1, 4]])
  h.bot.players.Alice.entity = { id: 2, position: new Vec3(4, 64, 0) }
  h.companion.tick()
  assert.deepEqual(h.bound, [[1, 4], [2, 4]])
  h.bot.players.Alice.entity = { id: 2, position: new Vec3(5, 64, 0) }
  h.companion.tick()
  assert.equal(h.bound.length, 3) // 相同网络ID但对象替换也需要换绑。
  delete h.bot.players.Alice.entity
  h.companion.tick(); h.companion.tick()
  assert.equal(h.messages.length, 1)
  h.advance(30_000)
  h.bot.players.Alice.entity = { id: 3, position: new Vec3(4, 64, 0) }
  h.companion.tick()
  assert.deepEqual(h.bound.at(-1), [3, 4])
  assert.equal(h.messages.length, 2)
  h.companion.dispose()
})
test('60秒失联、维度变化和stop后旧回调不恢复跟随', () => {
  const h = harness()
  h.companion.tick(); h.advance(60_000); h.companion.tick()
  assert.equal(h.companion.status(), null)
  h.bot.players.Alice = { entity: { id: 9, position: new Vec3(2, 64, 0) } }
  h.companion.tick()
  assert.equal(h.bound.length, 0)
  h.companion.dispose()
  const second = harness()
  second.companion.tick(); second.bot.game.dimension = 'the_nether'; second.companion.tick()
  assert.match(second.cleared.at(-1), /维度/)
  second.stop(); second.companion.tick()
  assert.equal(second.companion.status(), null)
  second.companion.dispose()
})
test('任务/飞行暂停不抢寻路，观察与建议只读，死亡记录保留真实坐标', () => {
  const h = harness()
  h.pause(true); h.companion.tick()
  assert.deepEqual(h.cleared, [])
  assert.match(h.companion.scan(), /Alice/)
  assert.equal(h.companion.advice(), '当前补给和状态没有明显缺口')
  h.bot.food = 12; h.bot.health = 8
  assert.match(h.companion.advice(), /血量偏低/)
  assert.match(h.companion.lastDeath(), /没有死亡/)
  h.bot.emit('death'); h.bot.entity.position = new Vec3(100, 70, 100)
  assert.match(h.companion.lastDeath(), /0 64 0/)
  h.companion.dispose()
  h.bot.emit('death')
  assert.match(h.companion.lastDeath(), /0 64 0/)
})
