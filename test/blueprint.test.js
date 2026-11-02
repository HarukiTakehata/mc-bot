'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const nbt = require('prismarine-nbt')
const BP = require('../blueprint')
const { traceWire, diagnose } = require('../redstone')

test('属性解析与非法写法', () => {
  assert.deepEqual(BP.parseSpec('minecraft:oak_stairs[facing=east,half=top]'), { name: 'oak_stairs', props: { facing: 'east', half: 'top' } })
  assert.deepEqual(BP.parseSpec('stone'), { name: 'stone', props: {} })
  assert.throws(() => BP.parseSpec('Stone Block'))
  assert.throws(() => BP.parseSpec('oak_stairs[facing]'))
})

test('旋转：坐标和朝向一起转，转一圈复原', () => {
  const blocks = [{ x: 2, y: 1, z: -3, name: 'oak_stairs', props: { facing: 'north', half: 'bottom' } }, { x: 0, y: 0, z: -1, name: 'oak_log', props: { axis: 'x' } }]
  const east = BP.place(blocks, { x: 10, y: 60, z: 20 }, 'east')
  assert.deepEqual([east[0].x, east[0].y, east[0].z], [13, 61, 22])
  assert.equal(east[0].props.facing, 'east')
  assert.equal(east[1].props.axis, 'z')
  const south = BP.place(blocks, { x: 0, y: 0, z: 0 }, 'south')
  assert.equal(south[0].props.facing, 'south')
  assert.deepEqual([south[0].x, south[0].z], [-2, 3])
  const west = BP.place(blocks, { x: 0, y: 0, z: 0 }, 'west')
  assert.deepEqual([west[0].x, west[0].z], [-3, -2])
  assert.equal(west[0].props.facing, 'west')
  assert.throws(() => BP.place(blocks, { x: 0, y: 0, z: 0 }, 'up'))
})

test('材料：门上半、床头不算；墙上火把算火把；双层半砖算 2', () => {
  const need = BP.materials([
    { name: 'oak_door', props: { half: 'lower' } }, { name: 'oak_door', props: { half: 'upper' } },
    { name: 'red_bed', props: { part: 'foot' } }, { name: 'red_bed', props: { part: 'head' } },
    { name: 'wall_torch', props: { facing: 'north' } }, { name: 'redstone_wire', props: {} }, { name: 'redstone_wall_torch', props: {} },
    { name: 'stone_slab', props: { type: 'double' } },
  ])
  assert.deepEqual(need, { oak_door: 1, red_bed: 1, torch: 1, redstone: 1, redstone_torch: 1, stone_slab: 2 })
})

test('校验：破坏性方块、AI 用稀有材料、重复位置、超限都拒绝', () => {
  const one = (name) => [{ x: 0, y: 0, z: 0, name, props: {} }]
  for (const bad of ['tnt', 'lava', 'fire', 'command_block', 'bedrock', 'end_crystal']) assert.throws(() => BP.validate(one(bad)), /不放/)
  assert.ok(BP.validate(one('diamond_block')))
  assert.throws(() => BP.validate(one('diamond_block'), { ai: true }), /稀有/)
  assert.throws(() => BP.validate([...one('stone'), ...one('dirt')]), /重复/)
  assert.throws(() => BP.validate([]), /空/)
  assert.throws(() => BP.fillBox({ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 100 }, 'stone'), /上限/)
})

test('所有模板和电路：能展开、四向都不重复、没有禁用方块、尺寸参数有上限', () => {
  for (const [name, t] of Object.entries(BP.TEMPLATES)) {
    for (const f of BP.HORIZONTAL) BP.validate(BP.place(t.build({}), { x: 0, y: 64, z: 0 }, f))
    assert.ok(t.desc, name)
  }
  assert.throws(() => BP.TEMPLATES.wall.build({ w: '9999' }))
  assert.throws(() => BP.TEMPLATES.tower.build({ h: '-1' }))
  for (const [name, c] of Object.entries(BP.CIRCUITS)) {
    for (const f of BP.HORIZONTAL) BP.validate(BP.place(c.blocks(), { x: 0, y: 64, z: 0 }, f))
    const coords = new Set(c.blocks().map((b) => `${b.x},${b.y},${b.z}`))
    for (const step of c.test || []) if (step.press) assert.ok(coords.has(step.press.join(',')), `${name} 自检按的位置不在蓝图里`)
  }
})

test('门有上半部分时只放下半，放置顺序：普通方块先于依附类', () => {
  assert.equal(BP.isSecondaryPart({ name: 'oak_door', props: { half: 'upper' } }), true)
  assert.equal(BP.isSecondaryPart({ name: 'oak_door', props: { half: 'lower' } }), false)
  assert.ok(BP.phase({ name: 'stone', props: {} }) < BP.phase({ name: 'wall_torch', props: {} }))
  assert.ok(BP.phase({ name: 'redstone_wire', props: {} }) < BP.phase({ name: 'lever', props: {}, seq: 1 }))
})

test('红石线：每 14 格加中继器，朝向对着来路，拐弯处不放', () => {
  const line = BP.wirePath({ x: 0, y: 64, z: 0 }, { x: 30, y: 64, z: 0 })
  const reps = line.filter((b) => b.name === 'repeater')
  assert.deepEqual(reps.map((r) => r.x), [14, 28])
  assert.ok(reps.every((r) => r.props.facing === 'west')) // 信号往东走，输入端在西
  const back = BP.wirePath({ x: 30, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }).filter((b) => b.name === 'repeater')
  assert.ok(back.every((r) => r.props.facing === 'east'))
  const corner = BP.wirePath({ x: 0, y: 64, z: 0 }, { x: 14, y: 64, z: 5 })
  assert.equal(corner[14].name, 'redstone_wire')
  assert.throws(() => BP.wirePath({ x: 0, y: 64, z: 0 }, { x: 5, y: 65, z: 0 }), /同一高度/)
  assert.throws(() => BP.wirePath({ x: 0, y: 64, z: 0 }, { x: 999, y: 64, z: 0 }), /太长/)
})

test('.schem v2/v3 解析，且会拒绝损坏文件', async () => {
  const palette = { 'minecraft:air': { type: 'int', value: 0 }, 'minecraft:stone': { type: 'int', value: 1 }, 'minecraft:oak_stairs[facing=east,half=bottom]': { type: 'int', value: 2 } }
  const v2 = { type: 'compound', name: 'Schematic', value: {
    Width: { type: 'short', value: 2 }, Height: { type: 'short', value: 1 }, Length: { type: 'short', value: 2 },
    Palette: { type: 'compound', value: palette },
    BlockData: { type: 'byteArray', value: [0, 1, 2, 1] },
  } }
  const parsed = await BP.parseSchem(nbt.writeUncompressed(v2))
  assert.equal(parsed.length, 3)
  assert.deepEqual(parsed.find((b) => b.name === 'oak_stairs').props, { facing: 'east', half: 'bottom' })
  const v3 = { type: 'compound', name: '', value: { Schematic: { type: 'compound', value: {
    Width: { type: 'short', value: 1 }, Height: { type: 'short', value: 1 }, Length: { type: 'short', value: 1 },
    Blocks: { type: 'compound', value: { Palette: { type: 'compound', value: palette }, Data: { type: 'byteArray', value: [1] } } },
  } } } }
  assert.equal((await BP.parseSchem(nbt.writeUncompressed(v3))).length, 1)
  const truncated = JSON.parse(JSON.stringify(v2))
  truncated.value.BlockData.value = [1]
  await assert.rejects(BP.parseSchem(nbt.writeUncompressed(truncated)), /长度/)
  await assert.rejects(BP.parseSchem(Buffer.from('not nbt')))
})

// ---- 红石读线 ----
function grid(map) {
  return (x, y, z) => map[`${x},${y},${z}`] || { name: 'air', props: {}, solid: false }
}
const dust = (power = 0) => ({ name: 'redstone_wire', props: { power: String(power) }, solid: false })

test('追踪：拉杆经红石线到灯；中继器单向', () => {
  const at = grid({
    '0,0,0': { name: 'lever', props: { powered: 'true' } },
    '1,0,0': dust(15), '2,0,0': dust(14),
    '3,0,0': { name: 'repeater', props: { facing: 'west', delay: '1' } },
    '4,0,0': dust(15),
    '5,0,0': { name: 'redstone_lamp', props: { lit: 'true' } },
  })
  const t = traceWire(at, { x: 1, y: 0, z: 0 })
  assert.equal(t.sources[0].name, 'lever')
  assert.equal(t.loads[0].name, 'redstone_lamp')
  assert.equal(t.cells.length, 4)
  // 从中继器输出端往回走，过不去
  const back = traceWire(at, { x: 4, y: 0, z: 0 })
  assert.ok(!back.cells.some((c) => c.x === 2))
})

test('追踪：台阶被实心方块盖住就断开；断头报出来', () => {
  const open = grid({ '0,0,0': dust(), '1,1,0': dust(), '0,1,0': { name: 'air', props: {}, solid: false } })
  assert.equal(traceWire(open, { x: 0, y: 0, z: 0 }).cells.length, 2)
  const capped = grid({ '0,0,0': dust(), '1,1,0': dust(), '0,1,0': { name: 'stone', props: {}, solid: true } })
  const t = traceWire(capped, { x: 0, y: 0, z: 0 })
  assert.equal(t.cells.length, 1)
  assert.deepEqual(t.ends, [{ x: 0, y: 0, z: 0 }])
})

test('排错：说清有没有信号送到', () => {
  const at = grid({ '0,0,0': { name: 'redstone_lamp', props: { lit: 'false' } }, '1,0,0': dust(0) })
  assert.match(diagnose(at, { x: 0, y: 0, z: 0 }), /没有信号送到/)
  const on = grid({ '0,0,0': { name: 'redstone_lamp', props: {} }, '-1,0,0': { name: 'repeater', props: { facing: 'west', powered: 'true' } } })
  assert.match(diagnose(on, { x: 0, y: 0, z: 0 }), /有信号送到/)
  const away = grid({ '0,0,0': { name: 'redstone_lamp', props: {} }, '-1,0,0': { name: 'repeater', props: { facing: 'east', powered: 'true' } } })
  assert.match(diagnose(away, { x: 0, y: 0, z: 0 }), /没指向这里/)
  assert.match(diagnose(grid({ '0,0,0': { name: 'redstone_lamp', props: {} } }), { x: 0, y: 0, z: 0 }), /缺信号来源/)
  assert.match(diagnose(grid({ '0,0,0': { name: 'stone', props: {} } }), { x: 0, y: 0, z: 0 }), /不是红石负载/)
})
