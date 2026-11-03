// 只完成 Fabric 配置阶段探测，拿到注册表后断开，不进入游戏、不执行动作。
const { createClient } = require('minecraft-protocol')
const { parseRegistrySync } = require('../fabric')
const fs = require('node:fs')
const version = process.env.MC_VERSION || false // 不填就自动检测
const client = createClient({ host: process.env.MC_HOST || '127.0.0.1', port: Number(process.env.MC_PORT || 25565),
  username: 'RegistryProbe', auth: 'offline', version })
const channels = ['c:register', 'c:version', 'fabric:registry/sync/direct', 'fabric:registry/sync']
let success = false
const timer = setTimeout(() => { console.error('Registry probe timed out'); client.end(); process.exitCode = 1 }, 20_000)
client.on('packet', (data, meta) => {
  if (meta.state !== 'configuration') return
  if (meta.name === 'ping') return client.write('pong', { id: data.id })
  if (meta.name !== 'custom_payload') return
  if (data.channel === 'minecraft:register') {
    client.write('custom_payload', { channel: data.channel, data: Buffer.from(channels.join('\0')) })
  } else if (['c:register', 'c:version'].includes(data.channel)) {
    client.write('custom_payload', { channel: data.channel, data: Buffer.from(data.data) })
  } else if (data.channel.startsWith('fabric:registry/sync')) {
    try {
      const buf = Buffer.from(data.data)
      const parsed = parseRegistrySync(buf)
      if (process.env.REGISTRY_FIXTURE_PATH) fs.writeFileSync(process.env.REGISTRY_FIXTURE_PATH, buf, { mode: 0o600, flag: 'wx' })
      console.log(JSON.stringify({ ok: true, version, bytes: buf.length, registries: Object.keys(parsed).length,
        items: parsed.item?.length, blocks: parsed.block?.length, components: parsed.data_component_type?.length }))
      success = true
    } catch (err) { console.error(err.message); process.exitCode = 1 }
    client.end('Configuration-only registry probe complete')
  }
})
client.on('error', (err) => { console.error(err.message); process.exitCode = 1 })
client.on('end', () => { clearTimeout(timer); if (!success) process.exitCode = 1 })
