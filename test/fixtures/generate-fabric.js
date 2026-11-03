// 合成 Fabric 注册表：公开的原版数据 + 少量示例条目，不读取任何服务器。
// 在仓库根目录运行 node test/fixtures/generate-fabric.js 可重建 .bin / .json。
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const data = require('minecraft-data')('26.1')

function vi(n) {
  const bytes = []
  do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; bytes.push(b) } while (n)
  return Buffer.from(bytes)
}
const str = (s) => Buffer.concat([vi(Buffer.byteLength(s)), Buffer.from(s)])
const vanilla = (entries) => [...entries].sort((a, b) => a.id - b.id).map((e) => e.name)
const components = Object.entries(data.protocol.types.SlotComponentType[1].mappings)
  .sort(([a], [b]) => Number(a) - Number(b)).map(([, name]) => name)

const registries = {
  item: { minecraft: vanilla(data.itemsArray), waystones: ['waystone'], refinedstorage: ['controller'] },
  block: { minecraft: vanilla(data.blocksArray), waystones: ['waystone'], refinedstorage: ['controller'] },
  data_component_type: { minecraft: components, waystones: ['description', 'waystone'], refinedstorage: ['energy', 'pattern_state'] },
}

function generate() {
  const parts = [vi(1), str(''), vi(Object.keys(registries).length)]
  for (const [name, groups] of Object.entries(registries)) {
    parts.push(str(name), vi(0), vi(Object.keys(groups).length))
    for (const [namespace, entries] of Object.entries(groups)) {
      parts.push(str(namespace === 'minecraft' ? '' : namespace), vi(1), vi(0), vi(entries.length), ...entries.map(str))
    }
  }
  const buffer = Buffer.concat(parts)
  const count = (name) => Object.values(registries[name]).reduce((n, entries) => n + entries.length, 0)
  const metadata = {
    source: 'Synthetic: public minecraft-data 26.1 registries with illustrative Waystones and Refined Storage entries; no server capture',
    generator: 'test/fixtures/generate-fabric.js',
    minecraft_version: '26.1',
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    registry_count: Object.keys(registries).length,
    item_count: count('item'),
    block_count: count('block'),
    component_count: count('data_component_type'),
  }
  return { buffer, metadata }
}

if (require.main === module) {
  const { buffer, metadata } = generate()
  fs.writeFileSync(path.join(__dirname, 'fabric-26.1.bin'), buffer)
  fs.writeFileSync(path.join(__dirname, 'fabric-26.1.json'), JSON.stringify(metadata, null, 2) + '\n')
  console.log(`Generated synthetic Fabric fixture (${buffer.length} bytes)`)
}

module.exports = { generate }
