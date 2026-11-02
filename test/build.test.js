const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { createBuilder } = require('../build')

// 1x1 垫高的最小世界：只记方块和放置请求，跳跃时直接把脚抬到最高点。
function world(feetY, blocks) {
  const map = new Map(Object.entries(blocks))
  const placed = []
  let jumping = false
  const bot = {
    entity: { position: new Vec3(0.5, feetY, 0.5), yaw: 0 },
    heldItem: { name: 'dirt' },
    inventory: { items: () => [{ name: 'dirt', count: 16 }] },
    blockAt: (p) => {
      const name = map.get(`${p.x},${p.y},${p.z}`) ?? 'air'
      const boundingBox = name === 'air' ? 'empty' : 'block'
      return { name, boundingBox, position: new Vec3(p.x, p.y, p.z) }
    },
    look: async () => {},
    equip: async () => {},
    setControlState: (control, on) => { if (control === 'jump') jumping = on },
    waitForTicks: async () => { if (jumping) bot.entity.position.y = Math.floor(bot.entity.position.y) + 2.2 },
    _placeBlockWithOptions: async (ref, face) => {
      const at = ref.position.plus(face)
      if (map.get(`${at.x},${at.y},${at.z}`)) throw new Error(`Server refused to place dirt at (${at.x}, ${at.y}, ${at.z}): the block is still ${map.get(`${at.x},${at.y},${at.z}`)}`)
      map.set(`${at.x},${at.y},${at.z}`, 'dirt')
      placed.push(at)
      bot.entity.position.y = at.y + 1
    },
  }
  const said = []
  const ctx = { say: (s) => said.push(s), runTask: (_name, fn) => fn(), sleepMs: async () => {}, fmt: String, assertActive() {}, log() {} }
  return { builder: createBuilder(bot, ctx), placed, said }
}

test('站在耕地上垫高：往耕地顶上放，而不是往耕地本身的格子放', async () => {
  // 耕地高 15/16：脚在 y=75.9375，取整后 75 就是耕地这一格
  const { builder, placed, said } = world(75.9375, { '0,74,0': 'dirt', '0,75,0': 'farmland' })
  await builder.commands.pillar('u', ['2'])
  assert.deepEqual(placed.map((p) => p.y), [76, 77])
  assert.match(said.at(-1), /垫高了 2 格/)
})

test('站在整方块上垫高仍从脚下那格往上放', async () => {
  const { builder, placed } = world(64, { '0,63,0': 'stone' })
  await builder.commands.pillar('u', ['3'])
  assert.deepEqual(placed.map((p) => p.y), [64, 65, 66])
})

test('垫高前按实际落脚方块检查头顶', async () => {
  // 站在耕地上时，放一块后脚在 76、头在 77，要看的是 78 而不是 77
  const { builder, placed, said } = world(75.9375, { '0,74,0': 'dirt', '0,75,0': 'farmland', '0,78,0': 'stone' })
  await builder.commands.pillar('u', ['3'])
  assert.deepEqual(placed, [])
  assert.match(said.at(-1), /头顶被挡住了/)
})
