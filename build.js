// 建筑引擎：把蓝图（blueprint.js）一块块放到世界里，每块放完读回校验。
// 共享世界的边界：绝不覆盖已有的非天然方块；不放破坏性方块；放之前先核对材料；能续建（已放对的跳过）；可 undo。
// 借鉴：mineflayer-builder 的朝向/属性放置表，mineflayer-schem 的失败重试和进度，Baritone builder 的"支撑优先"顺序。
const fs = require('node:fs')
const path = require('node:path')
const { Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { readJSON, writeJSON } = require('./storage')
const BP = require('./blueprint')

const DATA_DIR = path.join(__dirname, 'data')
const BLUEPRINT_DIR = path.join(DATA_DIR, 'blueprints')
const SCHEM_DIR = path.join(DATA_DIR, 'schematics')
const UNDO_FILE = path.join(DATA_DIR, 'lastbuild.json')
const REACH = 4.2
const DIRS = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] }
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' }
const YAW = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 }
const SIX = Object.values(DIRS)
// 右键会触发交互（不会放方块）的方块不能当"贴着放"的参照
const INTERACTIVE = /(chest|barrel|furnace|smoker|crafting_table|smithing_table|grindstone|stonecutter|loom|cartography_table|fletching_table|anvil|enchanting_table|brewing_stand|beacon|hopper|dropper|dispenser|shulker_box|lever|_button|_door|_trapdoor|_fence_gate|_bed|repeater|comparator|note_block|jukebox|daylight_detector|lectern|cake|campfire|composter|bell|^modded_block$|_sign$)/
// 可以直接放上去盖掉的（草、花、雪片之类）
const REPLACEABLE = /^(air|cave_air|void_air|short_grass|tall_grass|short_dry_grass|tall_dry_grass|fern|large_fern|dead_bush|bush|firefly_bush|leaf_litter|wildflowers|pink_petals|snow|seagrass|tall_seagrass|water|vine|glow_lichen|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|.*_sapling)$/
// 上面这些里游戏不允许直接盖掉的：先掰掉再放
const BREAK_FIRST = /^(dead_bush|bush|firefly_bush|leaf_litter|wildflowers|pink_petals|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|.*_sapling)$/
// clear=1 时才允许挖掉的天然地形（别人的建筑不在其中）
const NATURAL = /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mud|stone|andesite|diorite|granite|deepslate|tuff|sand|red_sand|gravel|clay|sandstone|netherrack|snow_block|.*_leaves|mangrove_roots)$/
// 校验时要对上的属性（其余如 powered/lit/shape/east... 由游戏计算）
const CRITICAL = ['facing', 'half', 'type', 'face', 'axis', 'delay', 'mode', 'inverted', 'part', 'attachment', 'rotation']
const COSMETIC_MISMATCH_OK = new Set(['axis', 'rotation'])
const NEEDS_FLOOR = /(torch$|redstone_wire|_pressure_plate$|rail$|^repeater$|^comparator$|^flower_pot$|_door$|_bed$|_sapling$)/
const SCAFFOLD_ITEMS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack']

const SEARCH_LIMIT = 256

// 站到"手够得着目标"的地方就行（GoalNear 的 3 格是三维距离，站地上明明够得着也要爬上去）
class GoalReach extends goals.Goal {
  constructor(p, avoid) {
    super()
    this.p = p
    this.avoid = avoid
  }

  heuristic(node) {
    const dx = node.x - this.p.x, dy = node.y - this.p.y, dz = node.z - this.p.z
    return Math.hypot(dx, dz) + Math.abs(dy)
  }

  isEnd(node) {
    const d = Math.hypot(node.x - this.p.x, node.y + 1.12 - this.p.y, node.z - this.p.z) // 眼睛到方块中心
    if (d > 4) return false
    if (node.x === this.p.x && node.z === this.p.z && (node.y === this.p.y || node.y + 1 === this.p.y)) return false
    return !this.avoid(node)
  }
}

function createBuilder(bot, ctx) {
  const { say, runTask, sleepMs, fmt } = ctx
  let moves = null
  let progress = null

  const itemCount = (name) => bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
  const vec = (b) => new Vec3(b.x, b.y, b.z)
  const eyes = () => bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  const key = (b) => `${b.x},${b.y},${b.z}`
  const propsOf = (block) => block?.getProperties?.() || {}

  function builderMoves() {
    if (moves) return moves
    moves = new Movements(bot)
    moves.canDig = false
    moves.allowParkour = false
    moves.allow1by1towers = false
    moves.scafoldingBlocks = []
    moves.infiniteLiquidDropdownDistance = false
    moves.canOpenDoors = true
    moves.maxDropDown = 3
    moves.blocksCantBreak.add(bot.registry.blocksByName.modded_block?.id ?? -1)
    return moves
  }
  function setScaffold() {
    bot.pathfinder.setMovements(builderMoves())
  }
  // 能拿来垫脚的方块：只算蓝图还用不完的部分，绝不把建筑材料垫掉（实测：垫完屋顶就缺料了）
  function scaffoldItem(job) {
    const left = {}
    for (const t of job.targets) {
      if (!job.pending.has(key(t))) continue
      const it = BP.itemFor(t.name)
      left[it] = (left[it] || 0) + 1
    }
    return SCAFFOLD_ITEMS.find((n) => itemCount(n) - (left[n] || 0) > 0)
  }

  // 方块是不是已经是蓝图要的样子
  function matches(block, want) {
    if (!block || block.name !== want.name) return false
    const have = propsOf(block)
    for (const k of CRITICAL) {
      if (want.props[k] === undefined || have[k] === undefined) continue
      if (String(have[k]) !== String(want.props[k]) && !COSMETIC_MISMATCH_OK.has(k)) return false
    }
    return true
  }
  const nameMatches = (block, want) => block?.name === want.name
  const replaceable = (block) => !!block && REPLACEABLE.test(block.name)

  // 选一个能贴着放的邻居，返回 { ref, face }
  function reference(target, prefer = []) {
    const p = vec(target)
    const order = [...prefer, ...SIX.filter((d) => !prefer.includes(d))]
    for (const d of order) {
      const refPos = p.offset(d[0], d[1], d[2])
      const ref = bot.blockAt(refPos)
      if (!ref || ref.boundingBox !== 'block' || INTERACTIVE.test(ref.name)) continue
      return { ref, face: new Vec3(-d[0], -d[1], -d[2]) }
    }
    return null
  }

  // 放这种方块时要怎么看、点哪个面（游戏是按玩家朝向和点击面决定方块朝向的）
  function placement(target) {
    const { name, props } = target
    const facing = props.facing
    const plain = () => ({ ...reference(target, [DIRS.down]) })
    const attach = (dir) => { // 只能贴在 dir 方向那个方块上
      const ref = bot.blockAt(vec(target).offset(...dir))
      if (!ref || ref.boundingBox !== 'block') return null
      return { ref, face: new Vec3(-dir[0], -dir[1], -dir[2]) }
    }
    const flip = (dir) => (target.flip ? OPPOSITE[dir] : dir)
    if (/(wall_torch|^ladder$|_wall_sign$|^tripwire_hook$|_wall_banner$)/.test(name) && facing) return attach(DIRS[OPPOSITE[facing]])
    if (/(^lever$|_button$)/.test(name)) {
      if (props.face === 'floor') { const a = attach(DIRS.down); return a && { ...a, yaw: YAW[flip(facing || 'north')] } }
      if (props.face === 'ceiling') { const a = attach(DIRS.up); return a && { ...a, yaw: YAW[flip(facing || 'north')] } }
      return attach(DIRS[OPPOSITE[facing]])
    }
    if (/(torch$|redstone_wire|_pressure_plate$|_carpet$|^carpet$|rail$|^repeater$|^comparator$|^flower_pot$|_door$|_bed$|^snow$|_sapling$)/.test(name)) {
      const a = attach(DIRS.down)
      if (!a) return null
      if (/(^repeater$|^comparator$)/.test(name)) return { ...a, yaw: YAW[flip(OPPOSITE[facing])] }
      if (/(_door$|_bed$)/.test(name)) return { ...a, yaw: YAW[flip(facing)] }
      return a
    }
    if (/_stairs$/.test(name)) {
      const half = props.half === 'top' ? 'top' : 'bottom'
      const pick = reference(target, half === 'top' ? [DIRS.up] : [DIRS.down])
      if (!pick) return null
      const side = pick.face.y === 0
      if (half === 'top' && pick.face.y > 0) return null // 只能点到地面：做不出倒楼梯，等上面有支撑
      if (half === 'bottom' && pick.face.y < 0) return null
      return { ...pick, yaw: YAW[flip(facing)], half: side ? half : undefined }
    }
    if (/_slab$/.test(name)) {
      const top = props.type === 'top'
      const pick = reference(target, top ? [DIRS.up] : [DIRS.down])
      if (!pick) return null
      if (props.type !== 'double' && pick.face.y !== 0 && (pick.face.y > 0) === top) return null
      return { ...pick, half: pick.face.y === 0 ? (top ? 'top' : 'bottom') : undefined }
    }
    if (/_trapdoor$/.test(name)) {
      const a = attach(DIRS.down) || reference(target)
      return a && { ...a, yaw: YAW[flip(OPPOSITE[facing])], half: a.face.y === 0 ? props.half : undefined }
    }
    if (/(^piston$|^sticky_piston$|^dispenser$|^dropper$|^barrel$)/.test(name) && facing) {
      const look = flip(OPPOSITE[facing]) // 这几种方块的 facing 指向玩家，所以看向反方向
      const pick = reference(target, [DIRS.down])
      if (!pick) return null
      if (look === 'up') return { ...pick, yaw: 0, pitch: Math.PI / 2 }
      if (look === 'down') return { ...pick, yaw: 0, pitch: -Math.PI / 2 }
      return { ...pick, yaw: YAW[look], pitch: 0 }
    }
    if (name === 'observer') { // 观察者和活塞相反：facing 就是玩家看的方向（实测）
      const pick = reference(target, [DIRS.down])
      if (!pick) return null
      const look = flip(facing)
      if (look === 'up') return { ...pick, yaw: 0, pitch: Math.PI / 2 }
      if (look === 'down') return { ...pick, yaw: 0, pitch: -Math.PI / 2 }
      return { ...pick, yaw: YAW[look], pitch: 0 }
    }
    if (name === 'hopper') {
      if (facing && facing !== 'down') return attach(DIRS[facing])
      return attach(DIRS.down) || reference(target, [DIRS.up])
    }
    if (facing && DIRS[facing] && YAW[facing] !== undefined) { // 箱子、熔炉、南瓜灯这类：正面朝向玩家
      const pick = plain()
      return pick.ref ? { ...pick, yaw: YAW[flip(OPPOSITE[facing])] } : null
    }
    if (props.axis) {
      const dir = { x: DIRS.west, y: DIRS.down, z: DIRS.north }[props.axis]
      return attach(dir) || attach(dir.map((v) => -v)) || (plain().ref ? plain() : null)
    }
    return plain().ref ? plain() : null
  }

  async function equipFor(name) {
    const wanted = BP.itemFor(name)
    for (let tries = 0; tries < 3; tries++) {
      const item = bot.inventory.items().find((i) => i.name === wanted)
      if (!item) return false
      if (bot.heldItem?.name === wanted) return true
      try { await bot.equip(item, 'hand'); return true } catch (err) {
        ctx.log(`[build] 换手失败 ${wanted}: ${err.message}`)
        await ctx.inventorySettled?.()
      }
    }
    return false
  }

  function inBody(p) {
    const me = bot.entity.position
    return p.x === Math.floor(me.x) && p.z === Math.floor(me.z) && (p.y === Math.floor(me.y) || p.y === Math.floor(me.y + 1))
  }
  async function stepOut(job, p) {
    const dirs = [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2], [3, 0], [-3, 0], [0, 3], [0, -3]]
    for (const [dx, dz] of dirs) {
      const q = bot.entity.position.floored().offset(dx, 0, dz)
      if (job.pending.has(key(q)) || job.pending.has(key(q.offset(0, 1, 0)))) continue
      try {
        await ctx.travel(new goals.GoalBlock(q.x, q.y, q.z))
        if (!inBody(p)) return true
      } catch { ctx.assertActive() }
    }
    return false
  }

  const inReach = (p) => eyes().distanceTo(p.offset(0.5, 0.5, 0.5)) <= REACH
  async function approach(job, p) {
    if (inReach(p) && !inBody(p)) return true
    if (job.pillar) await descend(job)
    const avoid = (n) => job.pending.has(`${n.x},${n.y},${n.z}`) || job.pending.has(`${n.x},${n.y + 1},${n.z}`)
    try {
      await ctx.travel(new GoalReach(p, avoid))
      if (inReach(p) && !inBody(p)) return true
    } catch (err) {
      ctx.assertActive()
      ctx.log(`[build] 走不到 ${p}: ${err.name}`)
    }
    if (inBody(p) && await stepOut(job, p) && inReach(p)) return true
    job.noScaffold = false
    return climbTo(job, p)
  }

  // 高处够不着：在旁边找一根立柱的位置，垫高到够得着（完工后自动拆）。
  async function climbTo(job, p) {
    const item = scaffoldItem(job)
    if (!item) { job.noScaffold = true; return false }
    const here = bot.entity.position
    const spots = []
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        if (Math.hypot(dx, dz) > 3.2 || (dx === 0 && dz === 0)) continue
        const x = p.x + dx, z = p.z + dz
        const stand = p.y - 2 // 眼睛和目标差不多高
        let ground = null
        for (let y = stand - 1; y >= p.y - 14; y--) {
          const b = bot.blockAt(new Vec3(x, y, z))
          if (!b) break
          if (b.boundingBox === 'block' && !INTERACTIVE.test(b.name)) { ground = y; break }
          if (b.boundingBox !== 'empty' || /^(water|lava)$/.test(b.name)) break
        }
        if (ground === null || ground >= stand) continue
        let free = true
        for (let y = ground + 1; y <= stand + 1 && free; y++) {
          const b = bot.blockAt(new Vec3(x, y, z))
          free = !!b && b.boundingBox === 'empty' && !/^(water|lava)$/.test(b.name) && !job.pending.has(`${x},${y},${z}`)
        }
        if (free) spots.push({ x, z, ground, stand })
      }
    }
    spots.sort((a, b) => Math.hypot(a.x + 0.5 - here.x, a.z + 0.5 - here.z) - Math.hypot(b.x + 0.5 - here.x, b.z + 0.5 - here.z))
    for (const s of spots.slice(0, 6)) {
      try {
        await ctx.travel(new goals.GoalBlock(s.x, s.ground + 1, s.z))
      } catch (err) {
        ctx.assertActive()
        continue
      }
      const need = s.stand - (s.ground + 1)
      job.pillar = { x: s.x, z: s.z, base: s.ground + 1 }
      job.scaffoldsUsed = true
      const r = await climb(need, item, (pos) => job.scaffolds.push(key(pos)))
      if (r.up === need && inReach(p)) return true
      ctx.log(`[build] 立柱到 ${s.x},${s.z} 没够到: ${r.reason || ''}`)
      await descend(job)
    }
    return false
  }

  // 从立柱上下来：挖脚下，一格一格落回去
  async function descend(job) {
    const pillar = job.pillar
    if (!pillar) return
    job.pillar = null
    for (let i = 0; i < 40; i++) {
      ctx.assertActive()
      const floor = bot.entity.position.floored().offset(0, -1, 0)
      if (floor.y < pillar.base) break
      if (floor.x !== pillar.x || floor.z !== pillar.z) break
      const b = bot.blockAt(floor)
      if (!b || !SCAFFOLD_ITEMS.includes(b.name) || !job.scaffolds.includes(key(floor))) break
      await bot.tool.equipForBlock(b, {}).catch(() => {})
      await bot.dig(b, true)
      job.scaffolds = job.scaffolds.filter((k) => k !== key(floor))
      const until = Date.now() + 1200
      while (bot.entity.position.y > floor.y + 0.1 && Date.now() < until) await bot.waitForTicks(1)
    }
    await sleepMs(700) // 掉落物 10 刻后才能捡：走太快会把垫脚方块留在地上（实测：32 个泥土很快垫光）
  }

  // 门、火把这类要站在实心顶面上，树叶不算（实测：地基落在树冠上，门被服务器一直拒绝）。clear 时把那格树叶换成垫脚方块
  async function replaceLeafFloor(job, target) {
    if (!NEEDS_FLOOR.test(target.name) || target.props.face === 'wall') return null
    const floor = bot.blockAt(vec(target).offset(0, -1, 0))
    if (!floor || !/_leaves$/.test(floor.name)) return null
    if (!job.clear) return `fail:${target.name} 脚下是树叶放不住（加 clear=1 或换地方）`
    const item = scaffoldItem(job)
    if (!item) return `fail:${target.name} 脚下是树叶，缺垫脚方块（泥土、圆石）`
    if (!await approach(job, floor.position)) return 'fail:走不到'
    await bot.tool.equipForBlock(floor, {}).catch(() => {})
    await bot.dig(floor, true)
    await sleepMs(100)
    const r = await placeOne(job, { x: target.x, y: target.y - 1, z: target.z, name: item, props: {} })
    return r === 'ok' ? null : r
  }

  // 放一块；返回 'ok' | 'wait'（支撑还没好）| 'fail:原因'
  async function placeOne(job, target) {
    const p = vec(target)
    const current = bot.blockAt(p)
    if (!current) return 'fail:区块未加载'
    if (matches(current, target)) return 'ok'
    if (BP.isSecondaryPart(target)) return nameMatches(current, target) ? 'ok' : 'wait'
    if (!replaceable(current)) {
      if (nameMatches(current, target) && !job.fixWrong) return 'ok'
      if (!(nameMatches(current, target) || (job.clear && NATURAL.test(current.name)))) return `fail:${current.name} 挡路`
      if (!await approach(job, p)) return 'fail:走不到'
      await bot.tool.equipForBlock(current, {}).catch(() => {})
      await bot.dig(current, true)
      await sleepMs(100)
    }
    const under = await replaceLeafFloor(job, target)
    if (under) return under
    const plan = placement(target)
    if (!plan?.ref) return 'wait'
    if (!await approach(job, p)) return job.noScaffold ? 'fail:够不着，缺垫脚方块（泥土、圆石）' : 'fail:走不到'
    const again = placement(target) // 走路途中世界可能变了
    if (!again?.ref) return 'wait'
    const fresh = bot.blockAt(p)
    if (fresh && BREAK_FIRST.test(fresh.name)) { await bot.dig(fresh, true); await sleepMs(80) }
    if (!await equipFor(target.name)) return `fail:缺 ${BP.itemFor(target.name)}`
    // 朝向由服务器按玩家当前视角算，视角包要先到：多等几刻（实测只等 1 刻时，偶尔放成上一次的朝向）
    if (again.yaw !== undefined) {
      await bot.look(again.yaw, again.pitch ?? 0, true)
      await bot.waitForTicks(3)
    }
    const sneak = INTERACTIVE.test(again.ref.name) // 点箱子这类会打开界面，蹲下才是放方块
    if (sneak) { bot.setControlState('sneak', true); await bot.waitForTicks(2) }
    try {
      await bot._placeBlockWithOptions(again.ref, again.face, { half: again.half, forceLook: again.yaw !== undefined ? 'ignore' : true, swingArm: 'right' })
    } catch (err) {
      ctx.log(`[build] ${target.name}@${key(target)} ${err.message}`)
      await sleepMs(250)
      return 'fail:服务器拒绝'
    } finally {
      if (sneak) { bot.setControlState('sneak', false); await bot.waitForTicks(1) }
    }
    await sleepMs(60)
    if (target.name.endsWith('_slab') && target.props.type === 'double') {
      await bot._placeBlockWithOptions(bot.blockAt(p), new Vec3(0, 1, 0), { forceLook: true }).catch(() => {})
      await sleepMs(60)
    }
    const placed = bot.blockAt(p)
    if (!placed || placed.name !== target.name) return `fail:放完是 ${placed?.name}`
    job.placed.push({ x: p.x, y: p.y, z: p.z, name: target.name })
    if (!matches(placed, target)) {
      // 朝向不对：挖掉重放一次，再不对就按反向放一次（模组或版本差异），还不对才算失败
      const have = propsOf(placed), bad = CRITICAL.find((k) => target.props[k] !== undefined && have[k] !== undefined && String(have[k]) !== String(target.props[k]))
      if (bad === 'facing' && (target.tries || 0) < 2) {
        target.tries = (target.tries || 0) + 1
        target.flip = target.tries === 2
        ctx.log(`[build] ${target.name} 朝向放成 ${have.facing}（要 ${target.props.facing}），第 ${target.tries} 次重放`)
        await bot.tool.equipForBlock(placed, {}).catch(() => {})
        await bot.dig(placed, true)
        await sleepMs(150)
        job.placed.pop()
        return placeOne(job, target)
      }
      if (['delay', 'mode', 'inverted'].includes(bad)) return await tune(target) ? 'ok' : `fail:${target.name} 调不到 ${bad}=${target.props[bad]}`
      return `fail:${target.name} 属性 ${bad}=${have[bad]}，要 ${target.props[bad]}`
    }
    return await tune(target) ? 'ok' : `fail:${target.name} 属性调不到`
  }

  // 放完要右键调整的：中继器延迟、比较器模式、阳光传感器反相
  async function tune(target) {
    const p = vec(target)
    const prop = target.name === 'repeater' ? 'delay' : target.name === 'comparator' ? 'mode' : target.name === 'daylight_detector' ? 'inverted' : null
    if (!prop || target.props[prop] === undefined) return true
    for (let i = 0; i < 4; i++) {
      const block = bot.blockAt(p)
      if (String(propsOf(block)[prop]) === String(target.props[prop])) return true
      await bot.activateBlock(block)
      await sleepMs(150)
    }
    return String(propsOf(bot.blockAt(p))[prop]) === String(target.props[prop])
  }

  // ---- 总流程 ----
  function preflight(blocks) {
    const conflicts = []
    let done = 0
    for (const b of blocks) {
      const cur = bot.blockAt(vec(b))
      if (!cur) { conflicts.push(`${key(b)} 未加载`); continue }
      if (matches(cur, b)) { done++; continue }
      if (replaceable(cur) || nameMatches(cur, b)) continue
      conflicts.push(`${cur.name}@${key(b)}`)
    }
    return { conflicts, done }
  }
  function missing(blocks) {
    const need = {}
    for (const b of blocks) {
      if (matches(bot.blockAt(vec(b)), b) || BP.isSecondaryPart(b)) continue
      const item = BP.itemFor(b.name)
      need[item] = (need[item] || 0) + 1
    }
    return Object.entries(need).filter(([n, c]) => itemCount(n) < c).map(([n, c]) => `${n} 差 ${c - itemCount(n)}`)
  }

  async function execute(label, blocks, { clear = false, quiet = false } = {}) {
    const fail = (error) => { say(`${label}没开工：${error}`); return { ok: false, error } }
    if (bot.game?.gameMode === 'spectator') return fail('旁观模式放不了方块')
    const { conflicts, done } = preflight(blocks)
    const hard = conflicts.filter((c) => !(clear && NATURAL.test(c.split('@')[0])))
    if (hard.length) return fail(`${hard.length} 处被占：${hard.slice(0, 3).join('、')}${clear ? '' : '（天然地形可加 clear=1）'}`)
    // 地基悬在水上时，机器人要一直在水里垫脚手架，很容易淹死（实测：沼泽里盖屋，淹死在半路）
    const lowest = Math.min(...blocks.map((b) => b.y))
    const floor = blocks.filter((b) => b.y === lowest)
    const overWater = floor.filter((b) => {
      for (let d = 0; d <= 8; d++) {
        const below = bot.blockAt(vec(b).offset(0, -d, 0))
        if (below?.name === 'water') return true
        if (below && below.boundingBox === 'block') return false
      }
      return false
    }).length
    if (overWater * 5 >= floor.length) return fail(`地基有 ${overWater}/${floor.length} 格悬在水面上，先填平或换个地方`)
    const lack = missing(blocks)
    if (lack.length) return fail(`材料不够：${lack.slice(0, 5).join('，')}`)

    const job = { cells: new Set(blocks.map(key)), pending: new Set(blocks.map(key)), targets: blocks, placed: [], clear, scaffolds: [] }
    // 比站地上能够到的高 2 格以上，就要垫脚：先核对，别盖到一半才发现
    const top = Math.max(...blocks.map((b) => b.y)), ground = Math.min(...blocks.map((b) => b.y))
    const climbNeed = Math.max(0, top - ground - 5)
    if (climbNeed && !quiet) {
      const need = {}
      for (const b of blocks) { const it = BP.itemFor(b.name); need[it] = (need[it] || 0) + 1 }
      const spare = SCAFFOLD_ITEMS.reduce((n, it) => n + Math.max(0, itemCount(it) - (need[it] || 0)), 0)
      if (spare < climbNeed) return fail(`要垫高 ${climbNeed} 格，还差 ${climbNeed - spare} 个垫脚方块（泥土或多余的圆石，拆下来会还）`)
    }
    setScaffold()
    // 先放地基和普通方块，依附类最后；同层就近
    const queue = blocks.slice().sort((a, b) => BP.phase(a) - BP.phase(b) || a.y - b.y)
    const failures = new Map()
    let round = 0, finished = 0, lastReport = Date.now(), stalled = 0
    progress = { label, total: blocks.length, done }
    if (!quiet) say(`开始 ${label}：共 ${blocks.length} 块${done ? `，已有 ${done} 块` : ''}`)
    try {
      // 屋脊这种要一块接一块才放得上：只要这一轮有进展就继续；连续没进展才算卡住
      while (queue.length && round < 24 && stalled < 3) {
        round++
        const before = finished
        const next = []
        while (queue.length) {
          ctx.assertActive()
          // 自卫优先：盖房会换手、抢寻路目标，边盖边打等于拿着方块挨打（实测：盖完房人也被打死了）
          if (ctx.combatActive?.()) await ctx.waitCombat()
          ctx.assertActive()
          // 同一阶段+同一层里挑最近的，减少跑动
          const head = queue[0], bucket = (b) => BP.phase(b) === BP.phase(head) && b.y === head.y
          let bi = 0, bd = Infinity
          const me = bot.entity.position
          for (let i = 0; i < queue.length && bucket(queue[i]); i++) {
            const d = vec(queue[i]).distanceSquared(me)
            if (d < bd) { bd = d; bi = i }
          }
          const target = queue.splice(bi, 1)[0]
          const r = await placeOne(job, target)
          if (r === 'ok') {
            job.pending.delete(key(target)); failures.delete(key(target)); finished++
            progress.done = finished
          } else {
            failures.set(key(target), { target, why: r })
            if (r.startsWith('fail:缺') || r === 'fail:背包') { queue.length = 0; next.length = 0; break }
            next.push(target)
          }
          if (Date.now() - lastReport > 30_000) { say(`${label} 进度 ${finished}/${blocks.length}`); lastReport = Date.now() }
        }
        queue.push(...next.sort((a, b) => BP.phase(a) - BP.phase(b) || a.y - b.y))
        // 整轮一块都没放上（真的四周悬空）才垫脚手架，否则白白把垫脚方块用光（实测）
        stalled = finished === before ? stalled + 1 : 0
        if (queue.length && stalled) await supportFloating(job, queue)
      }
      await descend(job)
    } finally {
      progress = null
    }
    await cleanScaffolds(job)
    // 拆脚手架掉的东西捡回来（共享背包）
    if (job.scaffoldsUsed) {
      for (const it of Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 12).slice(0, 16)) {
        if (!ctx.stillRunning() || !bot.entities[it.id]) break
        await ctx.travel(new goals.GoalNear(it.position.x, it.position.y, it.position.z, 1)).catch(() => {})
      }
    }
    const undoList = job.placed.filter((b) => job.cells.has(key(b)))
    try { writeJSON(ctx.undoFile || UNDO_FILE, { label, blocks: undoList.slice(-BP.MAX_BLOCKS) }) } catch (err) { ctx.log(`[build] undo 记录失败: ${err.message}`) }
    // 最终核对读真实世界，不信过程记录
    const wrong = blocks.filter((b) => !BP.isSecondaryPart(b) && !matches(bot.blockAt(vec(b)), b))
    if (wrong.length) {
      const f = failures.get(key(wrong[0]))
      const why = (f?.why || '').replace('fail:', '')
      say(`${label}没盖完：${blocks.length - wrong.length}/${blocks.length} 块，例如 ${wrong[0].name}@${key(wrong[0])}${why ? `（${why}）` : ''}`)
      return { ok: false, error: why || '有方块没放上', placed: blocks.length - wrong.length }
    }
    if (!quiet) say(`${label}盖好了：${blocks.length} 块全部核对通过${job.scaffolds.length ? `，拆了 ${job.scaffolds.length} 块脚手架` : ''}`)
    return { ok: true, placed: blocks.length }
  }

  // 悬空块：往下垫一根脚手架柱到它旁边
  async function supportFloating(job, queue) {
    for (const t of queue.slice(0, 8)) {
      const scaffold = scaffoldItem(job)
      if (!scaffold) return
      ctx.assertActive()
      const p = vec(t)
      if (placement(t)?.ref) continue
      if (BP.ATTACHED.test(t.name)) { // 门、压力板脚下是坑：垫实（留着不拆，拆了门就掉了）
        const under = p.offset(0, -1, 0)
        const b = bot.blockAt(under)
        if (b?.boundingBox === 'block' || job.cells.has(key(under))) continue
        const ref = reference({ x: under.x, y: under.y, z: under.z })
        if (!ref?.ref || !await approach(job, under) || !await equipFor(scaffold)) continue
        await bot._placeBlockWithOptions(ref.ref, ref.face, { forceLook: true, swingArm: 'right' }).catch((err) => ctx.log(`[build] 垫门下: ${err.message}`))
        continue
      }
      const below = []
      for (let d = 1; d <= 6; d++) {
        const q = p.offset(0, -d, 0)
        const b = bot.blockAt(q)
        if (b?.boundingBox === 'block') break
        if (job.cells.has(key(q))) { below.length = 0; break }
        below.push(q)
      }
      for (const q of below.reverse()) {
        if (!await approach(job, q)) break
        const ref = bot.blockAt(q.offset(0, -1, 0))
        if (ref?.boundingBox !== 'block' || INTERACTIVE.test(ref.name)) break
        if (!await equipFor(scaffold)) return
        try {
          await bot._placeBlockWithOptions(ref, new Vec3(0, 1, 0), { forceLook: true, swingArm: 'right' })
          job.scaffolds.push(key(q))
        } catch (err) { ctx.log(`[build] 脚手架: ${err.message}`); break }
      }
    }
  }

  async function cleanScaffolds(job) {
    if (!job.scaffolds.length) return
    const moved = [...new Set(job.scaffolds)].map((s) => s.split(',').map(Number)).sort((a, b) => b[1] - a[1])
    const left = []
    for (const [x, y, z] of moved) {
      if (!ctx.stillRunning()) break
      const p = new Vec3(x, y, z)
      const b = bot.blockAt(p)
      if (!b || !SCAFFOLD_ITEMS.includes(b.name)) continue
      try {
        if (!await approach(job, p)) { left.push(key({ x, y, z })); continue }
        await bot.tool.equipForBlock(b, {}).catch(() => {})
        await bot.dig(b, true)
      } catch (err) { left.push(key({ x, y, z })); ctx.log(`[build] 拆脚手架: ${err.message}`) }
    }
    job.scaffolds = job.scaffolds.filter((s) => !left.includes(s))
    if (left.length) say(`有 ${left.length} 块脚手架没拆掉，例如 ${left[0]}`)
  }

  // 只撤销"上次蓝图放的、现在还是那个方块"的；别人后来动过的不碰
  async function undo() {
    const data = readJSON(ctx.undoFile || UNDO_FILE, {})
    const list = Array.isArray(data?.blocks) ? data.blocks.filter((b) => [b.x, b.y, b.z].every(Number.isInteger) && typeof b.name === 'string') : []
    if (!list.length) { say('没有可以撤销的建筑'); return { ok: false } }
    const job = { cells: new Set(), pending: new Set(), targets: [], placed: [], scaffolds: [] }
    setScaffold()
    let removed = 0, skipped = 0
    for (const b of list.sort((a, c) => c.y - a.y)) {
      ctx.assertActive()
      const p = vec(b)
      const cur = bot.blockAt(p)
      if (cur?.name !== b.name) { skipped++; continue }
      if (!await approach(job, p)) { skipped++; continue }
      await bot.tool.equipForBlock(cur, {}).catch(() => {})
      try { await bot.dig(cur, true); removed++ } catch (err) { skipped++; ctx.log(`[build] undo: ${err.message}`) }
    }
    writeJSON(ctx.undoFile || UNDO_FILE, {})
    say(`撤销「${data.label}」：拆了 ${removed} 块${skipped ? `，跳过 ${skipped} 块（已被改动或够不着）` : ''}`)
    return { ok: true, removed }
  }

  // ---- 复制粘贴 ----
  const safeBlueprintName = (n) => /^[\p{L}\p{N}_-]{1,32}$/u.test(n)
  function copyRegion(a, b, name) {
    const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) }
    const hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) }
    const volume = (hi.x - lo.x + 1) * (hi.y - lo.y + 1) * (hi.z - lo.z + 1)
    if (volume > 32_768) return { error: `范围 ${volume} 格，上限 32768` }
    const blocks = []
    const skipped = {}
    for (let y = lo.y; y <= hi.y; y++) {
      for (let x = lo.x; x <= hi.x; x++) {
        for (let z = lo.z; z <= hi.z; z++) {
          const cur = bot.blockAt(new Vec3(x, y, z))
          if (!cur) return { error: `(${x} ${y} ${z}) 没加载，靠近一点再复制` }
          if (REPLACEABLE.test(cur.name) && cur.name !== 'water') continue
          if (cur.name === 'modded_block' || BP.FORBIDDEN.test(cur.name) || cur.name === 'water') { skipped[cur.name] = (skipped[cur.name] || 0) + 1; continue }
          blocks.push({ x: x - lo.x, y: y - lo.y, z: z - hi.z - 1, name: cur.name, props: cur.getProperties?.() || {} })
        }
      }
    }
    if (blocks.length > BP.MAX_BLOCKS) return { error: `有 ${blocks.length} 块，超过上限 ${BP.MAX_BLOCKS}` }
    fs.mkdirSync(BLUEPRINT_DIR, { recursive: true })
    writeJSON(path.join(ctx.blueprintDir || BLUEPRINT_DIR, `${name}.json`), { blocks, copiedFrom: lo })
    return { blocks, skipped }
  }
  function loadBlueprint(name) {
    const data = readJSON(path.join(ctx.blueprintDir || BLUEPRINT_DIR, `${name}.json`), null)
    if (!Array.isArray(data?.blocks)) return null
    return data.blocks.filter((b) => b && typeof b.name === 'string' && [b.x, b.y, b.z].every(Number.isInteger)).map((b) => ({ x: b.x, y: b.y, z: b.z, name: b.name, props: b.props && typeof b.props === 'object' ? b.props : {} }))
  }
  async function loadSchem(name) {
    const file = path.join(ctx.schemDir || SCHEM_DIR, `${name}.schem`)
    if (!fs.existsSync(file)) return null
    return BP.parseSchem(fs.readFileSync(file))
  }

  // ---- 走位工具 ----
  const horizontalFacing = () => {
    const x = -Math.sin(bot.entity.yaw), z = -Math.cos(bot.entity.yaw)
    return Math.abs(x) > Math.abs(z) ? (x > 0 ? 'east' : 'west') : (z > 0 ? 'south' : 'north')
  }
  // 默认建在机器人面前 3 格的地面上
  function defaultOrigin(facing) {
    const d = DIRS[facing]
    const p = bot.entity.position.floored()
    return { x: p.x + d[0] * 3, y: p.y, z: p.z + d[2] * 3 }
  }

  // 边走边往前铺路（Baritone 的 scaffold 思路）：脚下一格一格接出去，蹲着走不会掉
  async function bridge(length, dirName, material) {
    const dir = DIRS[dirName || horizontalFacing()]
    const item = material || SCAFFOLD_ITEMS.find((n) => itemCount(n) > 0)
    if (!item || !itemCount(item)) { say('没有铺路的方块（圆石、泥土等）'); return { ok: false } }
    if (BP.FORBIDDEN.test(item)) { say(`不能用 ${item} 铺路`); return { ok: false } }
    let laid = 0
    let walked = 0
    let reason = null
    bot.pathfinder.setGoal(null)
    try {
      for (let i = 0; i < length; i++) {
        ctx.assertActive()
        const feet = bot.entity.position.floored()
        const floor = feet.offset(0, -1, 0)
        const nextFloor = floor.offset(dir[0], 0, dir[2])
        const nextFeet = feet.offset(dir[0], 0, dir[2])
        const nb = bot.blockAt(nextFeet), nh = bot.blockAt(nextFeet.offset(0, 1, 0))
        if (nb?.boundingBox !== 'empty' || nh?.boundingBox !== 'empty' || nb?.name === 'lava' || nh?.name === 'lava') { reason = '前面被挡住了'; break }
        const nf = bot.blockAt(nextFloor)
        if (!nf) { reason = '前面区块没加载'; break }
        if (nf.name === 'lava') { reason = '前面是岩浆，不接'; break }
        if (nf.boundingBox !== 'block') {
          if (!itemCount(item)) { reason = `${item} 用完了`; break }
          if (!await equipFor(item)) { reason = `拿不出 ${item}`; break }
          const ref = bot.blockAt(floor)
          if (ref?.boundingBox !== 'block') { reason = '脚下不是实心方块'; break }
          await bot.lookAt(nextFloor.offset(0.5, 0.5, 0.5), true)
          await bot._placeBlockWithOptions(ref, new Vec3(dir[0], 0, dir[2]), { forceLook: 'ignore', swingArm: 'right' })
          await sleepMs(60)
          if (bot.blockAt(nextFloor)?.boundingBox !== 'block') { reason = '放不上方块'; break }
          laid++
        }
        const target = nextFeet.offset(0.5, 0, 0.5)
        const deadline = Date.now() + 2500
        await bot.look(Math.atan2(-dir[0], -dir[2]), 0.4, true)
        bot.setControlState('sneak', true)
        bot.setControlState('forward', true)
        while (Date.now() < deadline) {
          ctx.assertActive()
          const pos = bot.entity.position
          if (Math.hypot(target.x - pos.x, target.z - pos.z) < 0.3) break
          await bot.waitForTicks(1)
        }
        bot.setControlState('forward', false)
        await bot.waitForTicks(3)
        if (bot.entity.position.y < feet.y - 0.5) { reason = '脚滑掉下去了'; break }
        walked++
      }
    } finally {
      bot.setControlState('forward', false)
      bot.setControlState('sneak', false)
    }
    say(`铺了 ${laid} 块、走了 ${walked} 格，到 ${fmt(bot.entity.position)}${reason ? `，停下原因：${reason}` : ''}`)
    return { ok: walked > 0 && !/掉下去/.test(reason || ''), laid, walked }
  }

  // 耕地、土径、灵魂沙不满一格：站在上面时脚的坐标取整后就是这块本身，不是下面那块。
  // 线上：站在耕地上垫高，往"耕地下方块"的顶面放，服务器拒绝（"the block is still farmland"）。
  function standingOn() {
    const feet = bot.entity.position.floored()
    const here = bot.blockAt(feet)
    return here?.boundingBox === 'block' ? here : bot.blockAt(feet.offset(0, -1, 0))
  }

  // 原地垫高（1x1 塔）：跳起来往脚下塞方块
  async function climb(height, item, onPlaced = () => {}) {
    let up = 0
    let reason = null
    await bot.look(bot.entity.yaw, -Math.PI / 2, true)
    for (let i = 0; i < height; i++) {
      ctx.assertActive()
      const ref = standingOn()
      if (bot.blockAt(ref?.position.offset(0, 3, 0) ?? bot.entity.position.floored().offset(0, 2, 0))?.boundingBox !== 'empty') { reason = '头顶被挡住了'; break }
      if (!await equipFor(item)) { reason = `${item} 用完了`; break }
      if (ref?.boundingBox !== 'block') { reason = '脚下不是实心方块'; break }
      const floor = ref.position
      const targetY = floor.y + 1
      bot.setControlState('jump', true)
      const deadline = Date.now() + 1500
      while (bot.entity.position.y < targetY + 0.95 && Date.now() < deadline) await bot.waitForTicks(1)
      bot.setControlState('jump', false)
      if (bot.entity.position.y < targetY + 0.95) { reason = '跳不够高'; break }
      try {
        await bot._placeBlockWithOptions(ref, new Vec3(0, 1, 0), { forceLook: true, swingArm: 'right' })
      } catch (err) { reason = '放不上方块'; ctx.log(`[build] 垫高: ${err.message}`); break }
      onPlaced(ref.position.offset(0, 1, 0))
      await bot.waitForTicks(6)
      up++
    }
    return { up, reason }
  }
  async function pillar(height, material) {
    const item = material || SCAFFOLD_ITEMS.find((n) => itemCount(n) > 0)
    if (!item || itemCount(item) < 1) { say('没有垫脚的方块'); return { ok: false } }
    if (BP.FORBIDDEN.test(item)) { say(`不能用 ${item} 垫高`); return { ok: false } }
    const { up, reason } = await climb(height, item)
    say(`垫高了 ${up} 格，现在 y=${Math.floor(bot.entity.position.y)}${reason ? `，停下原因：${reason}` : ''}。下去用 bot come（会挖下去）`)
    return { ok: up > 0 }
  }

  // ---- 指令解析 ----
  // key=value 形式的可选参数；位置参数按模板顺序
  function parseOptions(args) {
    const opts = {}
    for (const a of args) {
      const m = /^([a-z]+)=([^=]+)$/.exec(a)
      if (m) opts[m[1]] = m[2]
    }
    return opts
  }
  const parseAt = (s) => {
    const parts = String(s).split(',').map(Number)
    if (parts.length !== 3 || !parts.every(Number.isInteger)) throw new Error('at= 要写成 x,y,z')
    return { x: parts[0], y: parts[1], z: parts[2] }
  }
  function layout(opts) {
    const facing = opts.f || horizontalFacing()
    if (!BP.HORIZONTAL.includes(facing)) throw new Error('f= 只能是 north/south/east/west')
    return { facing, origin: opts.at ? parseAt(opts.at) : defaultOrigin(facing) }
  }
  const validated = (blocks, opts) => BP.validate(blocks, { ai: !!opts.ai })
  const friendly = async (label, fn) => {
    try { return await fn() } catch (err) {
      if (err?.name === 'CancelledError') throw err
      say(`${label}: ${err.message}`)
      return { ok: false, error: err.message }
    }
  }

  const LONG = { timeoutMs: 30 * 60_000 }
  const commands = {
    build: (_u, [name, ...rest]) => {
      if (!name) return say(`用法: bot build <模板> [m=材料] [at=x,y,z] [f=朝向] [clear=1]；模板: ${Object.keys(BP.TEMPLATES).join(' ')}；或 bot paste <蓝图名>`)
      const tpl = Object.hasOwn(BP.TEMPLATES, name) && BP.TEMPLATES[name]
      if (!tpl) return say(`没有模板 ${name}，可选: ${Object.keys(BP.TEMPLATES).join(' ')}`)
      return runTask(`盖${name}`, () => friendly('盖不了', async () => {
        const opts = parseOptions(rest)
        const { facing, origin } = layout(opts)
        const blocks = validated(BP.place(tpl.build(opts), origin, facing), opts)
        return execute(`${name}@${origin.x} ${origin.y} ${origin.z}`, blocks, { clear: opts.clear === '1' })
      }), LONG)
    },
    fill: (_u, args) => {
      const [x1, y1, z1, x2, y2, z2, material, mode] = args
      const nums = [x1, y1, z1, x2, y2, z2].map(Number)
      if (!nums.every(Number.isInteger) || !material) return say('用法: bot fill x1 y1 z1 x2 y2 z2 <方块> [hollow]')
      return runTask('填方块', () => friendly('填不了', async () => {
        const blocks = validated(BP.fillBox({ x: nums[0], y: nums[1], z: nums[2] }, { x: nums[3], y: nums[4], z: nums[5] }, material, { hollow: mode === 'hollow' }), {})
        return execute('填方块', blocks)
      }), LONG)
    },
    copy: (_u, args) => {
      const nums = args.slice(0, 6).map(Number)
      const name = args[6]
      if (!nums.every(Number.isInteger) || nums.length !== 6 || !name || !safeBlueprintName(name)) return say('用法: bot copy x1 y1 z1 x2 y2 z2 <蓝图名>（容器内物品不复制）')
      const r = copyRegion({ x: nums[0], y: nums[1], z: nums[2] }, { x: nums[3], y: nums[4], z: nums[5] }, name)
      if (r.error) return say(`复制不了: ${r.error}`)
      const skipped = Object.entries(r.skipped).map(([k, v]) => `${k}x${v}`).join(' ')
      say(`存了蓝图 ${name}：${r.blocks.length} 块${skipped ? `；没存 ${skipped}` : ''}`)
    },
    paste: (_u, [name, ...rest]) => {
      if (!name || !safeBlueprintName(name)) return say('用法: bot paste <蓝图名> [at=x,y,z] [f=朝向] [clear=1]')
      return runTask(`贴${name}`, () => friendly('贴不了', async () => {
        const opts = parseOptions(rest)
        const raw = loadBlueprint(name) || await loadSchem(name)
        if (!raw) throw new Error(`没有蓝图 ${name}（bot blueprints 看列表；.schem 放 data/schematics/）`)
        const { facing, origin } = layout(opts)
        const blocks = validated(BP.place(raw, origin, facing), opts)
        return execute(`蓝图${name}`, blocks, { clear: opts.clear === '1' })
      }), LONG)
    },
    blueprints: () => {
      const list = (dir, ext) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length)) } catch { return [] } }
      const own = [...list(ctx.blueprintDir || BLUEPRINT_DIR, '.json'), ...list(ctx.schemDir || SCHEM_DIR, '.schem')]
      say(`模板: ${Object.entries(BP.TEMPLATES).map(([n, t]) => `${n}(${t.desc})`).join(' ')}`.slice(0, 380))
      if (own.length) say(`蓝图: ${own.slice(0, 40).join(' ')}`)
    },
    materials: (_u, [name, ...rest]) => {
      if (!name) return say('用法: bot materials <模板或蓝图名> [m=材料]')
      try {
        const opts = parseOptions(rest)
        const tpl = Object.hasOwn(BP.TEMPLATES, name) && BP.TEMPLATES[name]
        const raw = tpl ? tpl.build(opts) : loadBlueprint(name)
        if (!raw) return say(`没有 ${name}`)
        const need = BP.materials(raw)
        say(`${name} 要: ${Object.entries(need).map(([n, c]) => `${n}x${c}（有${itemCount(n)}）`).join('，')}`.slice(0, 380))
      } catch (err) { say(err.message) }
    },
    undo: () => runTask('撤销建筑', () => friendly('撤销不了', undo), LONG),
    bridge: (_u, [len, dir, material]) => runTask('铺路', () => friendly('铺不了', () => bridge(Number(len) || 8, dir, material))),
    pillar: (_u, [h, material]) => runTask('垫高', () => friendly('垫不了', () => pillar(Number(h) || 3, material))),
  }
  return { commands, execute, undo, progress: () => progress, setScaffold, horizontalFacing, defaultOrigin, layout, parseOptions, friendly }
}

module.exports = { createBuilder, INTERACTIVE, REPLACEABLE, NATURAL, SEARCH_LIMIT }
