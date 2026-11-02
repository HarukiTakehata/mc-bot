'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { planRoute, airControl } = require('../parkour')

// 字符画世界：'#' 石头，'.' 空气，'L' 岩浆，'W' 水，'H' 梯子。列出的 y 从 layers[0] 对应 y=0 开始，横向 x，z 固定 0。
const AIR = { known: true, name: 'air', passable: true, solid: false, standable: false, danger: false, water: false, climb: false, top: 0 }
const STONE = { known: true, name: 'stone', passable: false, solid: true, standable: true, danger: false, water: false, climb: false, top: 1 }
const LAVA = { known: true, name: 'lava', passable: false, solid: false, standable: false, danger: true, water: false, climb: false, top: 0 }
const WATER = { known: true, name: 'water', passable: true, solid: false, standable: false, danger: false, water: true, climb: false, top: 0 }
const LADDER = { known: true, name: 'ladder', passable: true, solid: false, standable: false, danger: false, water: false, climb: true, top: 0 }
const UNLOADED = { known: false, passable: false, solid: false, standable: false, danger: false, water: false, climb: false, top: 0 }
const CELL = { '#': STONE, '.': AIR, L: LAVA, W: WATER, H: LADDER }
const world = (rows, { void: hasVoid = false } = {}) => (x, y, z) => {
  if (z !== 0) return STONE // 一格宽的走廊，绕不过去
  if (y < 0) return hasVoid ? AIR : STONE
  const row = rows[rows.length - 1 - y]
  if (row === undefined) return AIR
  const c = row[x]
  return c === undefined ? AIR : CELL[c]
}
const kinds = (r) => r.moves.map((m) => m.kind + (m.gap ? m.gap : ''))

test('平路直接走，不跳', () => {
  const at = world(['......', '......', '......', '######'])
  const r = planRoute(at, { x: 0, y: 1, z: 0 }, { x: 4, y: 1, z: 0 })
  assert.ok(r.ok)
  assert.ok(r.moves.every((m) => m.kind === 'walk'))
})

test('1/2/3 格沟都能规划', () => {
  for (const [row, gap] of [['##.###', 1], ['##..##', 2], ['##...##', 3]]) {
    // 沟底是水：跳过去比下水便宜，掉下去也安全
    const at = world(['.......', '.......', '.......', row, row.replaceAll('.', 'W'), '#######'])
    const start = { x: 1, y: 3, z: 0 }
    const goal = { x: row.lastIndexOf('#'), y: 3, z: 0 }
    const r = planRoute(at, start, goal)
    assert.ok(r.ok, row)
    assert.equal(r.moves.filter((m) => m.kind === 'jump')[0].gap, gap)
  }
})

test('4 格沟跳不过去，也不会硬规划', () => {
  const at = world(['.........', '.........', '.........', '##....###'], { void: true })
  const r = planRoute(at, { x: 1, y: 1, z: 0 }, { x: 7, y: 1, z: 0 })
  assert.equal(r.ok, false)
})

test('沟下是岩浆、虚空或未加载：默认和 risk 都拒绝', () => {
  const lavaBelow = world(['.....', '.....', '.....', '##.##', '##L##'])
  assert.equal(planRoute(lavaBelow, { x: 1, y: 2, z: 0 }, { x: 3, y: 2, z: 0 }).ok, false)
  assert.equal(planRoute(lavaBelow, { x: 1, y: 2, z: 0 }, { x: 3, y: 2, z: 0 }, { risk: true }).ok, false)
  const hole = world(['.....', '.....', '.....', '##.##'], { void: true })
  assert.equal(planRoute(hole, { x: 1, y: 1, z: 0 }, { x: 3, y: 1, z: 0 }, { risk: true }).ok, false)
  const unloaded = (x, y, z) => (y < 0 ? UNLOADED : world(['.....', '.....', '.....', '##.##'])(x, y, z))
  assert.equal(planRoute(unloaded, { x: 1, y: 1, z: 0 }, { x: 3, y: 1, z: 0 }, { risk: true }).ok, false)
})

test('沟下太深默认不跳，risk 才跳；水面下多深都算安全', () => {
  const deep = world(['.....', '.....', '.....', '##.##', '##.##', '##.##', '##.##', '##.##', '#####'])
  assert.equal(planRoute(deep, { x: 1, y: 6, z: 0 }, { x: 3, y: 6, z: 0 }).ok, false)
  assert.ok(planRoute(deep, { x: 1, y: 6, z: 0 }, { x: 3, y: 6, z: 0 }, { risk: true }).ok)
  const water = world(['.....', '.....', '.....', '##.##', '##.##', '##.##', '##.##', '##W##', '#####'])
  assert.ok(planRoute(water, { x: 1, y: 6, z: 0 }, { x: 3, y: 6, z: 0 }).ok)
})

test('物理模拟否决后不走这一跳', () => {
  const at = world(['.....', '.....', '.....', '##.##', '#####'])
  const r = planRoute(at, { x: 1, y: 2, z: 0 }, { x: 3, y: 2, z: 0 }, { canJump: () => false })
  // 沟下一格有地，可以走下去再上来
  assert.ok(r.ok)
  assert.ok(r.moves.every((m) => m.kind !== 'jump'))
  assert.deepEqual(kinds(r), ['drop', 'step'])
})

test('头顶被挡不能起跳', () => {
  const at = world(['#.....', '......', '......', '##.###'], { void: true })
  assert.equal(planRoute(at, { x: 1, y: 1, z: 0 }, { x: 3, y: 1, z: 0 }).ok, false)
})

test('跳上一格、爬梯子都能规划', () => {
  const up = world(['......', '......', '...###', '##.###', '######'])
  const r = planRoute(up, { x: 1, y: 2, z: 0 }, { x: 3, y: 3, z: 0 })
  assert.ok(r.ok)
  const lad = world(['#.....', '#H....', '#H....', '#H....', '.H....', '######'])
  const c = planRoute(lad, { x: 1, y: 1, z: 0 }, { x: 1, y: 4, z: 0 })
  assert.ok(c.ok)
  assert.ok(c.moves.every((m) => m.kind === 'climb'))
})

test('搜索有时限：每一跳都很慢时也会按时放弃，不把主线程卡到被服务器踢', () => {
  const flat = (x, y) => (y < 0 ? STONE : AIR)
  const slow = () => { const end = Date.now() + 2; while (Date.now() < end); return true }
  const started = Date.now()
  const r = planRoute(flat, { x: 0, y: 0, z: 0 }, { x: 5000, y: 0, z: 5000 }, { canJump: slow, budgetMs: 100 })
  assert.equal(r.exhausted, true)
  assert.ok(Date.now() - started < 2000)
})

test('搜索有上限，复杂地形不会卡死主线程', () => {
  const flat = (x, y) => (y < 0 ? STONE : AIR)
  const started = Date.now()
  const r = planRoute(flat, { x: 0, y: 0, z: 0 }, { x: 5000, y: 0, z: 5000 }, { maxNodes: 2000 })
  assert.equal(r.ok, false)
  assert.equal(r.exhausted, true)
  assert.ok(Date.now() - started < 5000)
})

test('空中控制：不够远继续推，会冲过头就往回拉，差不多就松手', () => {
  assert.equal(airControl(0.5, 0.05, 3, 0.5, 0.1), 'forward')
  assert.equal(airControl(2.5, 0.3, 3, 1, 0.2), 'back')
  // 再滑 0.5 格正好落点
  assert.equal(airControl(2.5, 0.2, 2.5 + 0.2 * (1 - 0.91 ** 3) / 0.09, 0.4, -0.05), 'none')
})
