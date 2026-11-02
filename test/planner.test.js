const test = require('node:test')
const assert = require('node:assert/strict')
const { makePlan, registryInfo } = require('../planner')
const registry = require('minecraft-data')('26.1')
const info = registryInfo(registry)
const env = (inv = {}, world = ['oak_log', 'stone', 'iron_ore', 'coal_ore', 'sand']) => ({
  info, have: (n) => inv[n] || 0, nearby: (blocks) => blocks.some((b) => world.includes(b)),
  logName: () => (world.includes('oak_log') ? 'oak_log' : null), woodItems: () => Object.keys(inv),
})
const ops = (steps) => steps.map((s) => `${s.op}:${s.item}`)

test('从空背包规划铁镐：先木镐、石镐，再挖铁烧铁，同种原料合并成一趟', () => {
  const steps = makePlan('iron_pickaxe', 1, env())
  const o = ops(steps)
  const at = (x) => o.indexOf(x)
  assert.ok(at('craft:wooden_pickaxe') < at('mine:cobblestone'))
  assert.ok(at('craft:stone_pickaxe') < at('mine:raw_iron'))
  assert.ok(at('mine:raw_iron') < at('smelt:iron_ingot'))
  assert.equal(o.at(-1), 'craft:iron_pickaxe')
  assert.equal(o.filter((x) => x === 'mine:oak_log').length, 1)
})

test('背包够了就不做事；不认识来源或附近没有时给出明确原因', () => {
  assert.deepEqual(makePlan('stick', 4, env({ stick: 4 })), [])
  assert.throws(() => makePlan('diamond_pickaxe', 1, env()), /diamond_ore/)
  assert.throws(() => makePlan('bread', 1, env()), /bot farm/)
  assert.throws(() => makePlan('stick', 1, env({}, [])), /原木|找不到/)
})

test('烧木炭时原木不会同时被算成燃料；已有材料直接合成', () => {
  const steps = makePlan('charcoal', 2, env())
  const logs = steps.find((s) => s.op === 'mine' && s.item === 'oak_log')
  assert.ok(logs.count >= 4) // 2 个原料 + 至少 2 个当燃料（还要做镐和熔炉的木头）
  assert.deepEqual(ops(makePlan('iron_sword', 1, env({ iron_ingot: 2, stick: 1, crafting_table: 0 }))).at(-1), 'craft:iron_sword')
})

test('只把天然方块当原料来源，不会去拆木板、羊毛这类可能是建筑的方块', () => {
  assert.deepEqual(info.dropping('oak_planks'), [])
  assert.deepEqual(info.dropping('white_wool'), [])
  assert.ok(info.dropping('cobblestone').includes('stone'))
})
