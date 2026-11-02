const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { installProtocolCompat } = require('../protocol-compat')

test('实际Mineflayer原生起飞和疾跑接口输出26.1协议中的正确动作', async () => {
  const registry = require('prismarine-registry')('26.1')
  const packets = [], bot = new EventEmitter(), client = new EventEmitter()
  client.write = (name, params) => packets.push({ name, params })
  Object.assign(bot, { version: '26.1', registry, supportFeature: (name) => registry.supportFeature(name),
    _client: client, entity: { id: 7, onGround: false, isInWater: false, effects: {} },
    inventory: { slots: [] }, getEquipmentDestSlot: () => 6, blockAt: () => null })
  bot.inventory.slots[6] = { name: 'elytra' }
  require('../node_modules/mineflayer/lib/plugins/physics')(bot, {})
  await bot.elytraFly()
  assert.equal(packets.at(-1).params.actionId, 8) // 复现上游实际接口的旧编号。
  assert.equal(installProtocolCompat(bot), true)
  await bot.elytraFly()
  assert.deepEqual(packets.at(-1), { name: 'entity_action', params: { entityId: 7, actionId: 'start_fall_flying', jumpBoost: 0 } })
  bot.setControlState('sprint', true)
  assert.equal(packets.at(-1).params.actionId, 'start_sprinting')
  bot.setControlState('sprint', false)
  assert.equal(packets.at(-1).params.actionId, 'stop_sprinting')
  assert.equal(bot.supportFeature('newPlayerInputPacket'), registry.supportFeature('newPlayerInputPacket'))
  assert.equal(installProtocolCompat(bot), false)
  bot.emit('end')
})

test('其他版本不套用26.1映射，兼容层也不绕过最终取消写包门', async () => {
  const { createRuntime } = require('../runtime')
  const writes = []
  const bot = Object.assign(new EventEmitter(), { version: '1.21.11', supportFeature: () => false, _client: Object.assign(new EventEmitter(), { write: (n, p) => writes.push([n, p]) }) })
  assert.equal(installProtocolCompat(bot), false)
  bot.version = '26.1'
  installProtocolCompat(bot)
  const runtime = createRuntime()
  runtime.guardBot(bot)
  await runtime.scope(async () => {
    runtime.cancel()
    bot._client.write('entity_action', { actionId: 'start_elytra_flying' })
  })
  assert.deepEqual(writes, [])
})

test('26.1 工具等级标签不再拖慢挖掘：钻石镐挖黑曜石 9.4 秒，铁镐挖钻石矿不到 1 秒，徒手不变', () => {
  const { fixToolMaterials } = require('../protocol-compat')
  const reg = require('prismarine-registry')('26.1')
  const Block = require('prismarine-block')(reg)
  assert.ok(fixToolMaterials(reg) > 10)
  const dig = (name, tool) => Block.fromStateId(reg.blocksByName[name].defaultState, 0).digTime(tool ? reg.itemsByName[tool].id : null, false, false, false, [], {})
  assert.ok(dig('obsidian', 'diamond_pickaxe') < 10_000)
  assert.ok(dig('diamond_ore', 'iron_pickaxe') < 1000)
  assert.ok(dig('obsidian') > 200_000)
})

test('26.1 附魔组件换算成库约定的 [{name,lvl}]，手上有附魔不会让挖掘抛错', () => {
  const { normalizeEnchants, fixItemEnchants } = require('../protocol-compat')
  const registry = { enchantments: { 8: { name: 'efficiency' }, 0: { name: 'aqua_affinity' } } }
  assert.deepEqual(normalizeEnchants({ enchantments: [{ id: 8, level: 5 }] }, registry), [{ name: 'efficiency', lvl: 5 }])
  assert.deepEqual(normalizeEnchants(undefined, registry), [])
  assert.deepEqual(normalizeEnchants({ enchantments: [{ id: 999, level: 1 }] }, registry), [])
  class Item { get enchants () { return this.componentMap.get('enchantments').data } }
  const held = new Item(); held.componentMap = new Map([['enchantments', { data: { enchantments: [{ id: 8, level: 3 }] } }]])
  const helmet = new Item(); helmet.componentMap = new Map([['enchantments', { data: { enchantments: [{ id: 0, level: 1 }] } }]])
  fixItemEnchants(held, registry)
  assert.deepEqual(held.enchants.concat(helmet.enchants), [{ name: 'efficiency', lvl: 3 }, { name: 'aqua_affinity', lvl: 1 }])
})

test('贴墙坐标往外让一点，物理库的碰撞才不会被浮点误差穿过去', () => {
  const { moveOffWallEdge } = require('../protocol-compat')
  const AABB = require('prismarine-physics/lib/aabb')
  const wall = new AABB(45, 122, -2, 46, 123, -1)
  const playerAt = (z) => new AABB(45.4, 121, z - 0.3, 46, 122.8, z + 0.3)
  assert.equal(wall.computeOffsetZ(playerAt(-2.3), 0.02), 0.02) // 复现：-2.3 贴墙时挡不住
  const p = { x: 45.7, y: 121, z: -2.3 }
  moveOffWallEdge(p)
  assert.ok(wall.computeOffsetZ(playerAt(p.z), 0.02) < 0.001)
  assert.ok(p.x < 45.7 && p.z < -2.3 && p.y === 121)
  const away = { x: 10.5, y: 64, z: -3.31 }
  moveOffWallEdge(away)
  assert.deepEqual(away, { x: 10.5, y: 64, z: -3.31 })
})
