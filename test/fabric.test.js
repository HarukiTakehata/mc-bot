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
  setupFabric(bot, '26.1')
  client.emit('packet', { channel: 'fabric:registry/sync', data: Buffer.from([128]) }, { state: 'configuration', name: 'custom_payload' })
  assert.equal(writes.length, 0)
  assert.equal(ends.length, 1)
})
