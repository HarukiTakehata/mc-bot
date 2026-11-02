// 万能获取规划（参考 AltoClef 的 @get 和 Odyssey 的组合技能）：把"要 N 个某物品"拆成挖/烧/合成步骤。
// 纯逻辑，不碰游戏：用虚拟背包推演，世界信息（附近有没有某种方块）由 env 提供，方便测试和 bot plan 预览。
//
// 对每个物品依次尝试：背包里够 → 能烧（原料递归获取）→ 附近有天然方块能挖（缺镐先做镐）→ 按配方合成（逐个配方回溯）。
// 只挖天然方块：木板、羊毛这类方块可能是别人的建筑，绝不当成原料来源。

const NATURAL = /(_log|_stem|_ore)$|^(stone|deepslate|dirt|sand|red_sand|gravel|clay|netherrack|blackstone|basalt|tuff|andesite|diorite|granite|calcite|soul_sand|soul_soil|mud|snow_block|ice|packed_ice|cobweb|pumpkin|melon|sugar_cane|bamboo|cactus|kelp|glowstone|obsidian|ancient_debris|amethyst_cluster|moss_block|dripstone_block|pointed_dripstone)$/

// 产物 → 原料（熔炉）。'log' 表示任意原木
const SMELT = {
  iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper', glass: 'sand', stone: 'cobblestone',
  smooth_stone: 'stone', deepslate: 'cobbled_deepslate', charcoal: 'log', brick: 'clay_ball', terracotta: 'clay',
  cooked_beef: 'beef', cooked_porkchop: 'porkchop', cooked_chicken: 'chicken', cooked_mutton: 'mutton',
  cooked_rabbit: 'rabbit', cooked_cod: 'cod', cooked_salmon: 'salmon', baked_potato: 'potato', dried_kelp: 'kelp',
}
const FUEL_PER = { coal: 8, charcoal: 8, coal_block: 80 }
const TOOL_RANK = ['wooden', 'stone', 'iron', 'diamond', 'netherite'] // 金镐太脆，不选
const MAX_DEPTH = 8
const MAX_STEPS = 40

class PlanError extends Error {
  constructor(message, weak = false) { super(message); this.weak = weak } // weak：绕回自己之类，不如别的原因有用
}

// 从 minecraft-data 构造与世界无关的部分：配方、掉落、采集工具
function registryInfo(registry) {
  const nameOf = (id) => registry.items[id]?.name
  const ingredientId = (x) => (Array.isArray(x) ? ingredientId(x[0]) : typeof x === 'object' && x ? x.id : x)
  const recipes = (name) => {
    const item = registry.itemsByName[name]
    if (!item) return []
    return (registry.recipes?.[item.id] || []).map((r) => {
      const cells = r.inShape ? r.inShape.flat() : (r.ingredients || [])
      const counts = {}
      for (const c of cells) {
        const id = ingredientId(c)
        if (id == null || id < 0) continue
        const n = nameOf(id)
        if (!n) return null
        counts[n] = (counts[n] || 0) + 1
      }
      const table = r.inShape ? (r.inShape.length > 2 || r.inShape.some((row) => row.length > 2)) : cells.length > 4
      return { ingredients: counts, count: r.result?.count || 1, table }
    }).filter((r) => r && Object.keys(r.ingredients).length && !Object.hasOwn(r.ingredients, name))
  }
  const dropping = {}
  for (const b of registry.blocksArray) {
    if (!NATURAL.test(b.name)) continue
    for (const d of b.drops || []) {
      const id = typeof d === 'object' ? (d.drop?.id ?? d.id) : d
      const n = nameOf(id)
      if (n) (dropping[n] ||= []).push(b.name)
    }
  }
  const harvestTools = (blockName) => {
    const tools = registry.blocksByName[blockName]?.harvestTools
    return tools ? Object.keys(tools).map(nameOf).filter(Boolean) : null
  }
  return { recipes, dropping: (n) => dropping[n] || [], harvestTools }
}

// env: { info, have(name), nearby(blockNames) → bool, tableNearby, furnaceNearby, logName() → 附近或背包里的原木名 }
function makePlan(target, count, env) {
  const inv = new Map()
  const have = (n) => inv.has(n) ? inv.get(n) : env.have(n)
  const add = (n, c) => inv.set(n, have(n) + c)
  const state = { table: !!env.tableNearby, furnace: !!env.furnaceNearby }
  const steps = []
  const push = (step) => { if (steps.length >= MAX_STEPS) throw new PlanError('步骤太多，换个小一点的目标'); steps.push(step) }
  const resolve = (n) => n === 'log' ? env.logName() : n === 'planks' ? env.logName()?.replace(/_(log|stem)$/, '_planks') : n

  function snapshot() { return { inv: new Map(inv), state: { ...state }, len: steps.length } }
  function restore(s) { inv.clear(); for (const [k, v] of s.inv) inv.set(k, v); Object.assign(state, s.state); steps.length = s.len }

  function obtain(name, need, depth, visiting) {
    name = resolve(name)
    if (!name) throw new PlanError('附近找不到原木')
    const missing = need - have(name)
    if (missing <= 0) return
    if (depth > MAX_DEPTH) throw new PlanError(`${name} 的制作链太长`)
    if (visiting.has(name)) throw new PlanError(`${name} 的配方绕回自己`, true)
    const path = new Set(visiting).add(name)
    const errors = []

    // 1. 熔炉
    if (SMELT[name]) {
      const s = snapshot()
      try {
        const input = resolve(SMELT[name])
        if (!input) throw new PlanError('附近找不到原木')
        // 熔炉先备好（做熔炉会吃掉圆石），再补原料和燃料，最后核对
        if (!state.furnace) { obtain('furnace', 1, depth + 1, path); state.furnace = true; add('furnace', -1) }
        obtain(input, missing, depth + 1, path)
        fuel(missing, depth, path, input)
        if (have(input) < missing) throw new PlanError(`${input} 不够`)
        add(input, -missing)
        add(name, missing)
        push({ op: 'smelt', item: name, input, count: missing })
        return
      } catch (err) { restore(s); errors.push(err) }
    }

    // 2. 挖天然方块
    const blocks = env.info.dropping(name)
    if (blocks.length) {
      const s = snapshot()
      try {
        if (!env.nearby(blocks)) throw new PlanError(`64 格内找不到 ${blocks.slice(0, 3).join('/')}`)
        const tools = env.info.harvestTools(blocks[0])
        if (tools && !tools.some((t) => have(t) > 0)) {
          const tool = tools.filter((t) => TOOL_RANK.includes(t.split('_')[0]))
            .sort((a, b) => TOOL_RANK.indexOf(a.split('_')[0]) - TOOL_RANK.indexOf(b.split('_')[0]))[0]
          if (!tool) throw new PlanError(`挖 ${blocks[0]} 需要特殊工具`)
          obtain(tool, 1, depth + 1, path)
        }
        add(name, missing)
        push({ op: 'mine', item: name, blocks, count: missing })
        return
      } catch (err) { restore(s); errors.push(err) }
    }

    // 3. 合成：缺得少的配方先试，失败就回溯换下一个
    const recipes = env.info.recipes(name)
      .map((r) => {
        const lacking = Object.entries(r.ingredients).filter(([k, c]) => c * Math.ceil(missing / r.count) > have(k))
        const short = lacking.reduce((n, [k, c]) => n + c * Math.ceil(missing / r.count) - have(k), 0)
        // 缺得一样多时，选原料离得近的（地表圆石优于深层深板岩）
        // 不能直接挖的（木板）看原料：手头一步能做的最优（实测：背包有橡木，却跑去砍旁边的金合欢）
        const reach = (k) => { const b = env.info.dropping(k); return b.length && env.distance ? Math.min(env.distance(b), 500) : 0 }
        const far = lacking.reduce((n, [k]) => {
          if (env.info.dropping(k).length) return n + reach(k)
          const made = env.info.recipes(k).map((x) => Object.keys(x.ingredients))
          if (made.some((ing) => ing.every((i) => have(i) > 0))) return n
          return n + 1 + (made.length ? Math.min(...made.map((ing) => ing.reduce((m, i) => m + reach(i), 0))) : 0)
        }, 0)
        return { r, short, far }
      })
      .sort((a, b) => a.short - b.short || a.far - b.far)
    for (const { r } of recipes) {
      const s = snapshot()
      try {
        const times = Math.ceil(missing / r.count)
        if (r.table && !state.table) { // 工作台先做（会吃掉木板）
          obtain('crafting_table', 1, depth + 1, path)
          state.table = true
          add('crafting_table', -1)
        }
        // 备一种材料时可能用掉另一种（木板做了木棍），多轮补齐
        const enough = () => Object.entries(r.ingredients).every(([ing, c]) => have(ing) >= c * times)
        for (let pass = 0; pass < 3 && !enough(); pass++) {
          for (const [ing, c] of Object.entries(r.ingredients)) obtain(ing, c * times, depth + 1, path)
        }
        if (!enough()) throw new PlanError(`${name} 的材料凑不齐`)
        for (const [ing, c] of Object.entries(r.ingredients)) add(ing, -c * times)
        add(name, r.count * times)
        push({ op: 'craft', item: name, count: missing })
        return
      } catch (err) { restore(s); errors.push(err) }
    }
    const strong = errors.find((e) => !e.weak)
    if (strong) throw strong
    const crop = /^(wheat|carrot|potato|beetroot)/.test(name)
    throw new PlanError(crop ? `缺 ${name}，作物请先用 bot farm 收` : `不知道怎么获得 ${name}`, !crop)
  }

  // 烧东西的燃料：已有煤/木炭/木板/原木就用，否则去砍原木
  // reserve：正在烧的原料（烧木炭时原木不能同时当燃料）
  function fuel(n, depth, path, reserve) {
    for (const [f, per] of Object.entries(FUEL_PER)) {
      const need = Math.ceil(n / per)
      if (have(f) >= need) { add(f, -need); return }
    }
    const need = Math.ceil(n / 1.5)
    const spare = (k) => have(k) - (k === reserve ? n : 0)
    const wood = [...(env.woodItems?.() || []), ...inv.keys()].find((k) => /_(planks|log|stem)$/.test(k) && spare(k) >= need)
    if (wood) { add(wood, -need); return }
    const log = env.logName()
    if (!log) throw new PlanError('没有燃料，附近也没有原木')
    obtain(log, have(log) + need, depth + 1, path) // 原料已在 have 里，再多挖燃料那份
    add(log, -need)
  }

  obtain(target, count, 0, new Set())
  // 同一种原料分几趟挖不如一次挖够：后面的挖掘量并到第一次（提前多挖不会让后续步骤失败）
  const merged = []
  for (const step of steps) {
    const first = step.op === 'mine' && merged.find((m) => m.op === 'mine' && m.item === step.item)
    if (first) first.count += step.count
    else merged.push({ ...step })
  }
  return merged
}

const STEP_TEXT = { mine: (s) => `挖${s.item}x${s.count}`, smelt: (s) => `烧${s.input}→${s.item}x${s.count}`, craft: (s) => `做${s.item}x${s.count}` }
const describeSteps = (steps) => steps.map((s) => STEP_TEXT[s.op](s)).join(' → ')

module.exports = { makePlan, registryInfo, describeSteps, PlanError, SMELT, NATURAL }
