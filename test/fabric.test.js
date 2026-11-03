const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { parseRegistrySync, setupFabric } = require('../fabric')
const vi = (n) => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b) } while (n); return Buffer.from(out) }
const str = (s) => Buffer.concat([vi(Buffer.byteLength(s)), Buffer.from(s)])
const valid = Buffer.concat([vi(1), str(''), vi(1), str('item'), vi(0), vi(1), str(''), vi(1), vi(0), vi(2), str('stone'), str('dirt')])

test('合法Fabric同步保持顺序并使用无原型映射', () => {
  const result = parseRegistrySync(valid)
  assert.deepEqual(result.item, ['minecraft:stone', 'minecraft:dirt'])
  assert.equal(Object.getPrototypeOf(result), null)
})
test('实际26.1模组服注册表样本的哈希、完整解析和数量均匹配', () => {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures/fabric-26.1.bin'))
  const meta = require('./fixtures/fabric-26.1.json')
  assert.equal(createHash('sha256').update(buf).digest('hex'), meta.sha256)
  assert.equal(buf.length, meta.bytes)
  const result = parseRegistrySync(buf)
  assert.equal(Object.keys(result).length, meta.registry_count)
  assert.equal(result.item.length, meta.item_count)
  assert.equal(result.block.length, meta.block_count)
  assert.equal(result.data_component_type.length, meta.component_count)
})
test('截断、超长VarInt、非法UTF8、尾随数据和声明放大快速拒绝', () => {
  for (let n = 0; n < valid.length; n++) assert.throws(() => parseRegistrySync(valid.subarray(0, n)))
  for (const buf of [Buffer.from([128, 128, 128, 128, 128, 0]), Buffer.from([1, 1, 255]), Buffer.concat([valid, vi(0)]), Buffer.from([255, 255, 255, 255, 7]), Buffer.alloc(2 * 1024 * 1024 + 1)]) {
    assert.throws(() => parseRegistrySync(buf))
  }
})
test('畸形同步不发送成功确认并关闭配置连接', () => {
  const client = new EventEmitter(), bot = new EventEmitter()
  const writes = [], ends = []
  client.write = (...args) => writes.push(args)
  client.end = (reason) => ends.push(reason)
  bot._client = client
  setupFabric(bot, { version: '26.1' })
  client.emit('packet', { channel: 'fabric:registry/sync', data: Buffer.from([128]) }, { state: 'configuration', name: 'custom_payload' })
  assert.equal(writes.length, 0)
  assert.equal(ends.length, 1)
})

test('真实注册表：内置扩展按命名空间启用，并只登记它们声明的组件编码', () => {
  const { createMods } = require('../mods')
  const { namespacesOf, patchComponents } = require('../fabric')
  const types = require('minecraft-data')('26.1').protocol.types
  const parsed = parseRegistrySync(fs.readFileSync(path.join(__dirname, 'fixtures/fabric-26.1.bin')))
  const ns = namespacesOf(parsed)
  assert.ok(ns.has('refinedstorage') && ns.has('waystones') && !ns.has('minecraft'))
  const mods = createMods({ userDir: '/nonexistent', log: () => {} })
  const ids = mods.activate(ns).map((d) => d.id)
  assert.ok(ids.includes('refinedstorage') && ids.includes('waystones') && !ids.includes('shared-world'))
  const logs = []
  const log = console.log
  console.log = (...a) => logs.push(a.join(' '))
  try { patchComponents('26.1', parsed.data_component_type, mods.componentCodecs()) } finally { console.log = log }
  assert.ok(logs.some((l) => /认识 15 个，不认识 9 个/.test(l)), logs.join('\n'))
  assert.equal(types.SlotComponent[1][1].type[1].fields['waystones:waystone'], 'anonymousNbt')
  assert.equal(types.SlotComponent[1][1].type[1].fields['refinedstorage:pattern_state'], undefined)
})

test('NeoForge 服：只答 ping、不回频道表，以原版客户端身份进入', () => {
  const client = new EventEmitter(), bot = new EventEmitter()
  const writes = []
  client.write = (...args) => writes.push(args)
  client.end = () => {}
  bot._client = client
  const logs = []
  const log = console.log
  console.log = (...a) => logs.push(a.join(' '))
  const cfg = (name, data) => client.emit('packet', data, { state: 'configuration', name })
  try {
    setupFabric(bot)
    cfg('custom_payload', { channel: 'minecraft:register', data: Buffer.from('minecraft:register\0neoforge:register\0c:version') })
    cfg('custom_payload', { channel: 'neoforge:register', data: Buffer.alloc(1) })
    cfg('custom_payload', { channel: 'c:version', data: Buffer.from([1]) })
    cfg('ping', { id: 7 })
    cfg('custom_payload', { channel: 'minecraft:brand', data: Buffer.from([8, ...Buffer.from('neoforge')]) })
  } finally { console.log = log }
  assert.deepEqual(writes, [['pong', { id: 7 }]])
  // mineflayer 已经在答 ping 时不重复答
  writes.length = 0
  client.on('ping', () => {})
  cfg('ping', { id: 8 })
  assert.deepEqual(writes, [])
  assert.equal(logs.filter((l) => /服务器是 NeoForge，以原版客户端身份进入/.test(l)).length, 1)
  assert.ok(logs.some((l) => l === '[loader] 服务器类型 neoforge'))
})

test('Fabric 服仍然回频道表', () => {
  const client = new EventEmitter(), bot = new EventEmitter()
  const writes = []
  client.write = (...args) => writes.push(args)
  bot._client = client
  setupFabric(bot)
  client.emit('packet', { channel: 'minecraft:register', data: Buffer.from('fabric:registry/sync\0c:version') }, { state: 'configuration', name: 'custom_payload' })
  assert.equal(writes[0][1].channel, 'minecraft:register')
})

test('brand 解析：限长、只留可打印字符', () => {
  const { readBrand } = require('../fabric')
  assert.equal(readBrand(Buffer.from([5, ...Buffer.from('Paper')])), 'Paper')
  assert.equal(readBrand(Buffer.from([3, 0x1b, 0x5b, 0x41])), '?[A')
  assert.equal(readBrand(Buffer.from([200, 1, ...Buffer.alloc(300, 0x61)])).length, 64)
})
