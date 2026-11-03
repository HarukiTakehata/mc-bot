// 让机器人能进 Fabric 模组服，并认识模组的物品、方块和物品组件。
//
// 1. 握手：假装装了 Fabric API（登记注册表同步频道、回 c:version / c:register）。
// 2. 注册表：解析服务器发来的 fabric:registry/sync，给模组物品补上名字。
// 3. 方块：模组方块的状态 ID 排在原版之后，但不知道每个方块有几个状态，
//    统一当成"实心、不可挖"的 modded_block，寻路会绕开，不会挖坏别人的机器。
// 4. 物品组件：模组组件没有长度前缀，必须知道编码才能跳过。编码由各模组扩展（mods/、extensions/）提供，
//    没人声明的保持未知：带这种组件的物品解析失败，而不是读歪后面的数据。
// 原版服、Paper/Spigot 不会发这些包，这里什么都不做。
const mcData = require('minecraft-data')

const CHANNELS = ['c:register', 'c:version', 'fabric:registry/sync/direct', 'fabric:registry/sync']
// 这些加载器的握手完全不同，装作原版进不去，至少把原因说清楚
const OTHER_LOADERS = [[/^(neoforge|fml):/, 'NeoForge'], [/^(forge|fml):/, 'Forge']]

const MODDED_BLOCK_ID = 100000

// fabric:registry/sync 格式：
//   varint 命名空间组数 { string 命名空间("" = minecraft), varint 注册表数
//     { string 注册表名, varint 标志, varint 条目命名空间数
//       { string 命名空间, varint 段数 { varint 偏移, varint 条数 { string 名字 } } } } }
// 网络 ID 就是条目的出现顺序。
function parseRegistrySync(buf) {
  if (!Buffer.isBuffer(buf) || buf.length > 2 * 1024 * 1024) throw new Error('注册表包过大或类型错误')
  let i = 0
  let totalEntries = 0
  const need = (n) => { if (n < 0 || n > buf.length - i) throw new Error('注册表数据截断') }
  const varint = () => {
    let r = 0
    for (let byte = 0; byte < 5; byte++) {
      need(1)
      const b = buf[i++]
      if (byte === 4 && (b & 0xf8)) throw new Error('注册表 VarInt 溢出')
      r += (b & 0x7f) * 2 ** (7 * byte)
      if (!(b & 0x80)) return r
    }
    throw new Error('注册表 VarInt 过长')
  }
  const count = (max = 65_536) => {
    const n = varint()
    if (n > max || n > buf.length - i) throw new Error('注册表声明计数超限')
    return n
  }
  const str = () => {
    const n = varint()
    if (n > 512) throw new Error('注册表名称过长')
    need(n)
    const s = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(i, i + n))
    i += n
    if (s && !/^[a-z0-9_./:-]+$/.test(s)) throw new Error('注册表名称非法')
    return s
  }
  const registries = Object.create(null)
  for (let g = count(4096); g > 0; g--) {
    str()
    for (let r = count(4096); r > 0; r--) {
      const name = str()
      if (!name || Object.hasOwn(registries, name)) throw new Error('注册表名称重复或为空')
      varint()
      const entries = []
      for (let n = count(4096); n > 0; n--) {
        const ns = str() || 'minecraft'
        for (let s = count(); s > 0; s--) {
          varint()
          const size = count()
          totalEntries += size
          if (totalEntries > 100_000) throw new Error('注册表累计条目超限')
          for (let c = size; c > 0; c--) {
            const entry = str()
            if (!entry) throw new Error('注册表条目为空')
            entries.push(`${ns}:${entry}`)
          }
        }
      }
      registries[name] = entries
    }
  }
  if (i !== buf.length) throw new Error('注册表含多余数据')
  return registries
}

function patchComponents(version, components, codecs = new Map()) {
  const types = mcData(version).protocol.types
  const mappings = types.SlotComponentType[1].mappings
  const fields = types.SlotComponent[1][1].type[1].fields
  const vanillaCount = Object.keys(mappings).length
  let known = 0, unknown = 0
  components.forEach((full, id) => {
    if (id < vanillaCount) {
      if (`minecraft:${mappings[id]}` !== full) console.log(`[fabric] 组件 ${id} 不一致: ${mappings[id]} vs ${full}`)
      return
    }
    const codec = codecs.get(full)
    // 编码未知，或这个版本的协议里没有这个类型：保持未映射，解析时报错而不是读歪
    if (!codec || !types[codec]) { unknown++; return }
    mappings[id] = full
    fields[full] = codec
    known++
  })
  if (known || unknown) console.log(`[fabric] 模组物品组件：认识 ${known} 个，不认识 ${unknown} 个（带不认识组件的物品读不出来，可在扩展里补 components）`)
}

// brand 负载是一个带 VarInt 长度前缀的字符串；只取可打印部分、限长，防止日志被塞怪字符
function readBrand(buf) {
  try {
    const b = Buffer.from(buf)
    let len = 0, shift = 0, i = 0
    for (; i < 5 && i < b.length; i++) { len |= (b[i] & 0x7f) << shift; shift += 7; if (!(b[i] & 0x80)) { i++; break } }
    return b.subarray(i, i + Math.min(len, 64)).toString('utf8').replace(/[^\x20-\x7e]/g, '?') || '未知'
  } catch { return '未知' }
}

// 注册表里出现过的非原版命名空间，用来决定启用哪些模组扩展
function namespacesOf(registries) {
  const out = new Set()
  for (const entries of Object.values(registries)) for (const full of entries) {
    const ns = full.slice(0, full.indexOf(':'))
    if (ns && ns !== 'minecraft') out.add(ns)
  }
  return out
}

function patchRegistry(bot, registries) {
  const reg = bot.registry
  // 物品：补上模组物品的名字，堆叠数按 64 估计
  ;(registries.item || []).forEach((full, id) => {
    if (reg.items[id]) return
    const name = full.replace(/^minecraft:/, '')
    const entry = { id, name, displayName: name, stackSize: 64 }
    reg.items[id] = entry
    reg.itemsByName[name] = entry
    reg.itemsArray.push(entry)
  })

  // 方块：原版之后的状态 ID 都当成实心的模组方块
  const vanillaMax = Math.max(...reg.blocksArray.map((b) => b.maxStateId))
  const modded = {
    id: MODDED_BLOCK_ID, name: 'modded_block', displayName: '模组方块',
    hardness: 3, resistance: 3, diggable: false, transparent: false, boundingBox: 'block',
    material: 'default', shapes: [[0, 0, 0, 1, 1, 1]], drops: [],
    minStateId: vanillaMax + 1, maxStateId: Number.MAX_SAFE_INTEGER, defaultState: vanillaMax + 1, states: [],
  }
  // prismarine-block 会按名字从碰撞形状表里重设 shapes，所以也要登记，借用石头的整块形状
  const collision = reg.blockCollisionShapes
  if (collision) collision.blocks.modded_block = collision.blocks.stone
  reg.blocks[MODDED_BLOCK_ID] = modded
  reg.blocksByName.modded_block = modded
  const byState = reg.blocksByStateId
  reg.blocksByStateId = new Proxy(byState, {
    get: (target, key) => target[key] ?? (typeof key === 'string' && Number(key) > vanillaMax ? modded : undefined),
  })
  // 模组方块的名字（状态数未知，世界里仍统一当 modded_block；但手里的物品能知道它是不是方块）
  reg.moddedBlockNames = new Set((registries.block || []).filter((n) => !n.startsWith('minecraft:')))
  const moddedBlocks = reg.moddedBlockNames.size
  const moddedItems = (registries.item || []).filter((n) => !n.startsWith('minecraft:')).length
  console.log(`[fabric] 模组物品 ${moddedItems} 个，模组方块 ${moddedBlocks} 种（统一视为 modded_block）`)
}

// onRegistries(namespaces) 返回要用的组件编码 Map（模组扩展在这时决定启用哪些）。
// version 不传就用连接实际协商出的版本（MC_VERSION 留空时自动检测）。
function setupFabric(bot, { version, onRegistries = () => new Map() } = {}) {
  let registries = null
  let vanillaOnly = false // NeoForge/Forge：以原版客户端身份进，不声明任何模组频道
  let brandLogged = false
  bot._client.on('packet', (data, meta) => {
    if (meta.name === 'custom_payload' && !brandLogged && /^(minecraft:brand|MC\|Brand)$/.test(data.channel || '')) {
      brandLogged = true
      console.log(`[loader] 服务器类型 ${readBrand(data.data)}`)
    }
    if (meta.state !== 'configuration') return
    const c = bot._client
    // mineflayer 自己会答 ping（所有阶段）；再答一次，NeoForge 会把第二个 pong 当成下一步的确认，然后报 synchronize_registries 没完成踢人。
    // 只有裸 minecraft-protocol 客户端（注册表探测脚本）没人答，才由这里答
    if (meta.name === 'ping') return c.listenerCount('ping') ? undefined : c.write('pong', { id: data.id })
    if (meta.name !== 'custom_payload') return
    const ch = data.channel
    if (ch === 'minecraft:register') {
      // NeoForge 的频道表里有 neoforge:*：只要回了频道表，它就当我们是模组客户端、等一个永远不会来的注册表同步，然后踢人。
      // 什么都不回、只答 ping，它就按原版客户端放行（服务器没有必须装在客户端的模组时）。
      const listed = Buffer.from(data.data).toString('utf8').split('\0')
      const other = OTHER_LOADERS.find(([re]) => listed.some((x) => re.test(x)))
      if (other) {
        if (!vanillaOnly) console.log(`[loader] 服务器是 ${other[1]}，以原版客户端身份进入（服务器装了必须客户端也装的模组时会被拒）`)
        vanillaOnly = true
        return
      }
      c.write('custom_payload', { channel: 'minecraft:register', data: Buffer.from(CHANNELS.join('\0')) })
    } else if (vanillaOnly) {
      // 不回应任何加载器私有频道
    } else if (ch === 'c:version' || ch === 'c:register') {
      c.write('custom_payload', { channel: ch, data: Buffer.from(data.data) })
    } else if (ch.startsWith('fabric:registry/sync')) {
      // 必须在进入 play 阶段之前改好协议，play 的解析器是那时才编译的
      try {
        const parsed = parseRegistrySync(Buffer.from(data.data))
        const codecs = onRegistries(namespacesOf(parsed))
        patchComponents(version || c.version, parsed.data_component_type || [], codecs instanceof Map ? codecs : new Map())
        registries = parsed
      } catch (err) {
        registries = null
        console.log('[fabric] 注册表解析失败:', err.message)
        c.end('Invalid Fabric registry sync')
        return
      }
      c.write('custom_payload', { channel: 'fabric:registry/sync/complete', data: Buffer.alloc(0) })
    }
  })
  bot.once('login', () => { if (registries) patchRegistry(bot, registries) })
}

module.exports = { setupFabric, MODDED_BLOCK_ID, parseRegistrySync, patchComponents, namespacesOf, readBrand }
