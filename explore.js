// 模组物品主动探索：不认识的物品先 inspect 看本地信息，再 try 亲手试一下（放下右键看界面 / 对空气使用），
// 试出来的结果记进 data/itemnotes.json，之后 AI 每次看到这个物品都会带上这条笔记。
// 世界里的模组方块分不清是哪种（只知道是 modded_block），所以探索只针对背包里的物品。
const path = require('path')
const { goals } = require('mineflayer-pathfinder')
const { readJSON, writeJSON } = require('./storage')
const { relevantTips, modTipFor } = require('./knowledge')

const NOTES_FILE = path.join(__dirname, 'data', 'itemnotes.json')
const MAX_NOTES = 100

function createExplorer(bot, ctx) {
  const { say, runTask, sleepMs, fmt } = ctx
  const loaded = readJSON(ctx.notesFile || NOTES_FILE, {})
  const notes = Object.create(null)
  if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
    for (const [k, v] of Object.entries(loaded).slice(0, MAX_NOTES)) if (/^[a-z0-9_:./-]{1,96}$/.test(k) && typeof v === 'string') notes[k] = v.slice(0, 200)
  }
  function remember(name, text) {
    const next = { ...notes, [name]: text.slice(0, 200) }
    const keys = Object.keys(next)
    if (keys.length > MAX_NOTES) delete next[keys[0]]
    try { writeJSON(ctx.notesFile || NOTES_FILE, next) } catch (err) { ctx.log('[explore] 笔记保存失败', err.message) }
    for (const k of Object.keys(notes)) if (!Object.hasOwn(next, k)) delete notes[k]
    notes[name] = next[name]
  }

  const findItem = (name) => bot.inventory.items().find((i) => i.name === name)
  const fullName = (name) => (name.includes(':') ? name : `minecraft:${name}`)
  const isBlockItem = (name) => !!bot.registry.blocksByName[name] || !!bot.registry.moddedBlockNames?.has(fullName(name))

  function describe(name) {
    const item = findItem(name)
    const info = bot.registry.itemsByName[name]
    if (!info && !item) return `不认识 ${name}`
    const parts = [`${name}${name.includes(':') ? `（模组 ${name.split(':')[0]}）` : ''}`]
    parts.push(isBlockItem(name) ? '可以放置的方块' : '不是方块（可能是工具/材料/消耗品）')
    if (info?.stackSize) parts.push(`堆叠 ${info.stackSize}`)
    const recipes = info && bot.registry.recipes?.[info.id]?.length
    parts.push(recipes ? `已知 ${recipes} 个合成配方` : name.includes(':') ? '模组配方本地看不到（可让玩家查 JEI）' : '没有合成配方（只能采集/掉落/交易）')
    if (item) {
      parts.push(`背包里有 ${bot.inventory.count(item.type)} 个`)
      const comps = item.components?.map((c) => c.type).filter(Boolean)
      if (comps?.length) parts.push(`组件: ${[...new Set(comps)].slice(0, 6).join(',')}`)
    } else parts.push('背包里没有')
    const tip = name.includes(':') ? modTipFor(name) : relevantTips(name, 1)[0]
    if (tip) parts.push(`知识: ${tip}`)
    if (notes[name]) parts.push(`试用笔记: ${notes[name]}`)
    return parts.join('；')
  }

  // 等一个窗口打开（右键机器后），超时返回 null
  const nextWindow = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => { bot.removeListener('windowOpen', on); resolve(null) }, ms)
    const on = (w) => { clearTimeout(t); resolve(w) }
    bot.once('windowOpen', on)
  })

  async function tryItem(name) {
    if (!name.includes(':')) return say(`${name} 是原版物品，用法直接问我（bot ${name}怎么用），不用消耗物品试用`)
    const item = findItem(name)
    if (!item) return say(`背包里没有 ${name}，没法试`)
    const before = {}
    for (const it of bot.inventory.items()) before[it.name] = (before[it.name] || 0) + it.count
    const heard = []
    const onMsg = (m) => { if (!m.startsWith('<') && heard.length < 3) heard.push(m.slice(0, 80)) }
    bot.on('messagestr', onMsg)
    const result = []
    try {
      if (isBlockItem(name)) {
        const placed = await ctx.placeNearby((n) => n === name)
        if (!placed) { result.push('附近没地方放'); return }
        const pos = placed.position
        result.push('能放置')
        const win = nextWindow(2500)
        await bot.activateBlock(bot.blockAt(pos)).catch(() => {})
        const w = await win
        if (w) {
          const title = typeof w.title === 'string' ? w.title : JSON.stringify(w.title)
          result.push(`右键打开界面「${String(title).replace(/[{}"]/g, '').slice(0, 40)}」共 ${w.slots.length} 格（是机器/容器）`)
          bot.closeWindow(w)
        } else result.push('右键没打开容器界面（可能是装饰方块、需要先激活/通电，或是机器人看不到的模组自定义界面）')
        // 试完收回来：模组方块平时禁止挖（怕挖坏别人的机器），这块是自己刚放的，可以挖
        const block = bot.blockAt(pos)
        if (block && block.name !== 'air') {
          block.diggable = true
          try {
            await bot.dig(block, true)
            await sleepMs(300)
            await ctx.travel(new goals.GoalNear(pos.x, pos.y, pos.z, 0.5)).catch(() => {})
            result.push('已收回')
          } catch (err) {
            result.push(`收不回来，留在 ${fmt(pos)}`)
          }
        }
      } else {
        await bot.equip(item, 'hand')
        const win = nextWindow(1500)
        bot.activateItem()
        await sleepMs(1200)
        bot.deactivateItem()
        const w = await win
        if (w) { result.push(`使用后打开界面「${String(w.title).replace(/[{}"]/g, '').slice(0, 40)}」`); bot.closeWindow(w) }
        else result.push('对空气右键没打开容器界面（模组自定义界面看不到）')
      }
    } finally {
      bot.removeListener('messagestr', onMsg)
      await ctx.inventorySettled?.()
      const after = {}
      for (const it of bot.inventory.items()) after[it.name] = (after[it.name] || 0) + it.count
      const delta = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .map((n) => [n, (after[n] || 0) - (before[n] || 0)]).filter(([n, d]) => d && !(n === name && d === 0))
        .map(([n, d]) => `${d > 0 ? '+' : ''}${d}${n}`).slice(0, 4)
      if (delta.length && !result.includes('已收回')) result.push(`背包变化 ${delta.join(' ')}`)
      if (heard.length) result.push(`服务器提示: ${heard.join(' / ')}`)
      if (result.length) {
        const text = result.join('，')
        remember(name, text)
        say(`试了 ${name}：${text}`)
      }
    }
  }

  return {
    commands: {
      inspect: (_u, [name]) => name ? say(describe(name)) : say('用法: bot inspect <物品>'),
      try: (_u, [name]) => name ? runTask(`试${name}`, () => tryItem(name)) : say('用法: bot try <物品>'),
      tip: (_u, args) => {
        const tips = relevantTips(args.join(' ') || '夜晚 饥饿 挖矿', 3)
        say(tips.length ? tips.join(' | ') : '这个话题我还没整理，直接问我：bot 怎么xxx')
      },
    },
    notesFor: (names) => names.filter((n) => notes[n]).slice(0, 6).map((n) => `${n}: ${notes[n]}`),
  }
}

module.exports = { createExplorer }
