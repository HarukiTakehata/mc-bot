// 本机Mineflayer 4.39的26.1动作能力标记/鞘翅动作名与实际协议表不一致。
// 只在明确核对的26.1协议上适配本bot，不修改node_modules或全局注册表。
const minecraftData = require('minecraft-data')
const INSTALLED = Symbol('mc26ActionCompatibility')
// 贴墙卡住、附魔读法是物理库/物品库的问题，与版本无关，所有版本都装；鞘翅动作名映射只在核对过的 26.1 上改
function installProtocolCompat(bot) {
  if (bot[INSTALLED]) return false
  bot[INSTALLED] = true
  installEnchantFix(bot)
  installWallEdgeFix(bot)
  if (!['26.1', '26.1.2'].includes(bot.version)) return false
  const fields = minecraftData(bot.version).protocol.play.toServer.types.packet_entity_action[1]
  const mappings = fields.find((field) => field.name === 'actionId')?.type?.[1]?.mappings
  if (mappings?.[6] !== 'start_fall_flying' || mappings?.[1] !== 'start_sprinting' || mappings?.[2] !== 'stop_sprinting') throw new Error('26.1玩家动作协议与已验证映射不一致')
  const originalFeature = bot.supportFeature.bind(bot)
  bot.supportFeature = (name) => name === 'entityActionUsesStringMapper' || originalFeature(name)
  const originalWrite = bot._client.write
  bot._client.write = function (name, params, ...rest) {
    if (name === 'entity_action' && params?.actionId === 'start_elytra_flying') params = { ...params, actionId: 'start_fall_flying' }
    return originalWrite.call(this, name, params, ...rest)
  }
  return true
}
// minecraft-data 26.1 把需要特定等级工具的方块（黑曜石、各种矿石…）的 material 写成了 incorrect_for_wooden_tool 这类标签，
// 查不到挖掘加速：钻石镐挖黑曜石算成 75 秒（实际 9.4 秒），寻路代价也跟着错。按能采集它的工具种类改回 mineable/*。
function fixToolMaterials(registry) {
  let fixed = 0
  for (const block of registry.blocksArray || []) {
    if (!/^incorrect_for_/.test(block.material || '') || !block.harvestTools) continue
    const tool = registry.items[Object.keys(block.harvestTools)[0]]?.name
    const kind = /_(pickaxe|shovel|axe|hoe)$/.exec(tool || '')?.[1]
    if (kind && registry.materials[`mineable/${kind}`]) { block.material = `mineable/${kind}`; fixed++ }
  }
  return fixed
}

// 26.1 的 item.enchants 直接返回协议原始数据 { enchantments: [{ id, level }] }，不是库内部约定的 [{ name, lvl }]。
// 手里有附魔工具时 bot.dig 算挖掘时间直接抛 "enchantments.concat is not a function"，一块都挖不了（线上：砍树全失败）。
function normalizeEnchants(data, registry) {
  const list = Array.isArray(data) ? data : data?.enchantments
  if (!Array.isArray(list)) return []
  return list.map((e) => e && e.name ? e : { name: registry.enchantments?.[e?.id]?.name ?? null, lvl: e?.level ?? 0 }).filter((e) => e.name)
}
const PATCHED_ITEMS = new WeakSet()
function fixItemEnchants(item, registry) {
  const proto = item && Object.getPrototypeOf(item)
  if (!proto || proto === Object.prototype || PATCHED_ITEMS.has(proto)) return
  const original = Object.getOwnPropertyDescriptor(proto, 'enchants')
  if (!original?.get) return
  PATCHED_ITEMS.add(proto)
  Object.defineProperty(proto, 'enchants', { ...original, get () {
    if (this.componentMap?.has?.('enchantments')) return normalizeEnchants(this.componentMap.get('enchantments')?.data, registry)
    return original.get.call(this)
  } })
}
// mineflayer 每个插件各有一个 Item 类，改不到全局；挖之前把用到的那两件（手上、头上）的类修好
function installEnchantFix(bot) {
  const fix = () => {
    fixItemEnchants(bot.heldItem, bot.registry)
    fixItemEnchants(bot.inventory?.slots?.[bot.getEquipmentDestSlot?.('head')], bot.registry)
  }
  for (const name of ['dig', 'digTime']) {
    const original = bot[name]
    if (typeof original === 'function') bot[name] = function (...args) { fix(); return original.apply(this, args) }
  }
}

// 贴墙站时坐标是 x.3 / x.7，物理库不留容差：0.3 - 2.3 = -1.9999999999999998，算出来已经嵌进墙一点点，这堵墙就不再挡路。
// 机器人一动就穿进方块，服务器立刻拉回同一坐标，来回循环（实测：贴着树叶原地不动，直到报"连续3次脱困"）。往外让 0.01 毫米
function moveOffWallEdge(position) {
  for (const axis of ['x', 'z']) {
    const offset = position[axis] - Math.floor(position[axis])
    if (Math.abs(offset - 0.3) < 1e-6) position[axis] += 1e-5
    else if (Math.abs(offset - 0.7) < 1e-6) position[axis] -= 1e-5
  }
}
function installWallEdgeFix(bot) {
  const fix = () => { if (bot.entity?.position) moveOffWallEdge(bot.entity.position) }
  bot._client?.on('position', fix) // 排在 mineflayer 自己的处理之后
  bot.on('physicsTick', fix)
}

module.exports = { fixToolMaterials, installProtocolCompat, installEnchantFix, normalizeEnchants, fixItemEnchants, moveOffWallEdge }
