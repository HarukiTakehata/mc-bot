// 跑酷：自带 A* 路线（走、上台阶、下落、跳 1~3 格沟、跳上/跳下、爬梯子）。
// 思路参考 Azalea 的 parkour move 表和 Baritone MovementParkour；"起跳前先物理模拟" 参考 mineflayer-pathfinder 的 physics.js。
// 共享血量：摔一下全队掉血。默认只走摔不死的路线（沟下 3 格内有地或有水），岩浆/虚空上方一律不跳；
// 每一跳都用 prismarine-physics 模拟，模拟落不到目标就不跳，换路线。
const { PlayerState } = require('prismarine-physics')
const { Vec3 } = require('vec3')

const CARDINAL = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const DIAGONAL = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
const MAX_SAFE_FALL = 3
const MAX_NODES = 30_000
const ROUTE_BUDGET_MS = 2000
const MIN_HP = 10
const DANGER = /^(lava|fire|soul_fire|magma_block|cactus|sweet_berry_bush|wither_rose|powder_snow|pointed_dripstone|campfire|soul_campfire|cobweb)$/
const CLIMB = /^(ladder|vine|twisting_vines|twisting_vines_plant|weeping_vines|weeping_vines_plant|cave_vines|cave_vines_plant)$/
const OPENABLE = /(_door|_fence_gate|_trapdoor)$/

// 空中控制：按当前速度估算不再按键会落在哪，决定前推/松手/后拉（闭环，抗一两刻的抖动；思路同 Azalea 的滞空调整）。
// along 是沿起跳方向已走的距离，v 是沿该方向的速度，span 是要落到的距离，height 是离落点平面的高度。
function airControl(along, v, span, height, vy) {
  let y = height, vel = vy, n = 0
  while (n < 40 && (y > 0 || vel > 0)) { vel = (vel - 0.08) * 0.98; y += vel; n++ }
  const carry = v * (1 - 0.91 ** n) / 0.09 // 空气阻力 0.91/刻 下还能滑多远
  const landing = along + carry
  if (landing < span - 0.1) return 'forward'
  if (landing > span + 0.1) return 'back'
  return 'none'
}

// 把 mineflayer 方块归成规划器要的几个属性（方块缺失按"未知"处理：不可走、不可落，宁可不跳）
function classify(block) {
  if (!block) return { known: false, passable: false, solid: false, danger: false, water: false, climb: false, top: 0 }
  const name = block.name
  const water = name === 'water' || name === 'bubble_column' || block.getProperties?.()?.waterlogged === true
  const danger = DANGER.test(name)
  const climb = CLIMB.test(name)
  const empty = block.boundingBox === 'empty'
  const top = empty ? 0 : Math.max(0, ...(block.shapes || []).map((s) => s[4]))
  // 门、栅栏门、活板门的碰撞随开关变，规划时都当墙（门由寻路负责，不跳门）
  const solid = !empty && !OPENABLE.test(name) && name !== 'modded_block' ? true : (name === 'modded_block' || (!empty && OPENABLE.test(name)))
  return { known: true, name, passable: empty && !danger && name !== 'lava', solid, standable: solid && top > 0 && top <= 1 && !danger, danger, water, climb, top }
}

// 纯逻辑规划：at(x,y,z) 返回 classify 的结果；canJump(from,to,meta) 由物理模拟决定（测试时可替换）
function planRoute(at, start, goal, { risk = false, canJump = () => true, maxNodes = MAX_NODES, range = 0, budgetMs = Infinity } = {}) {
  const key = (x, y, z) => `${x},${y},${z}`
  const free = (x, y, z) => at(x, y, z).passable
  const body = (x, y, z) => free(x, y, z) && free(x, y + 1, z)
  const stand = (x, y, z) => body(x, y, z) && at(x, y - 1, z).standable && !at(x, y, z).water
  const climbing = (x, y, z) => at(x, y, z).climb

  // 从 (x,y,z) 往下看：掉下去会落到哪、会不会受伤
  function fallInfo(x, y, z) {
    for (let d = 1; d <= 48; d++) {
      const b = at(x, y - d, z)
      if (!b.known) return { kind: 'unknown', depth: d }
      if (b.danger || b.name === 'lava') return { kind: 'danger', depth: d }
      if (b.water) return { kind: 'water', depth: d }
      if (b.solid) return { kind: 'floor', depth: d - 1 }
    }
    return { kind: 'void', depth: 49 }
  }
  const gapSafe = (x, y, z) => {
    const f = fallInfo(x, y, z)
    if (f.kind === 'water') return true
    if (f.kind === 'floor') return risk || f.depth <= MAX_SAFE_FALL
    return false // 岩浆、虚空、未加载：跌落后无法恢复，risk 也不跳
  }

  function neighbors(n) {
    const out = []
    const { x, y, z } = n
    if (climbing(x, y, z) || climbing(x, y + 1, z)) {
      if (body(x, y + 1, z) || climbing(x, y + 1, z)) out.push({ x, y: y + 1, z, cost: 1.5, kind: 'climb' })
      if (at(x, y - 1, z).passable && (climbing(x, y - 1, z) || stand(x, y - 1, z))) out.push({ x, y: y - 1, z, cost: 1.5, kind: 'climb' })
    }
    for (const [dx, dz] of CARDINAL) {
      const nx = x + dx, nz = z + dz
      if (stand(nx, y, nz)) out.push({ x: nx, y, z: nz, cost: 1, kind: 'walk' })
      else if (climbing(nx, y, nz) && free(nx, y + 1, nz)) out.push({ x: nx, y, z: nz, cost: 1.2, kind: 'walk' })
      if (free(x, y + 2, z) && stand(nx, y + 1, nz) && at(nx, y + 2, nz).passable) out.push({ x: nx, y: y + 1, z: nz, cost: 2, kind: 'step' })
      if (body(nx, y, nz) && !at(nx, y - 1, nz).solid) { // 前面是坑：直接走下去
        const f = fallInfo(nx, y, nz)
        if (f.kind === 'floor' && f.depth >= 1 && f.depth <= MAX_SAFE_FALL && stand(nx, y - f.depth, nz)) {
          out.push({ x: nx, y: y - f.depth, z: nz, cost: 1.5 + f.depth, kind: 'drop' })
        }
      }
      // 跳沟：g 是沟宽，落点在 g+1 格外；dy 是落点高度差。起跳点必须有地、头顶能起跳
      if (!at(x, y - 1, z).standable || !free(x, y + 2, z)) continue
      for (let g = 1; g <= 3; g++) {
        let clear = true
        for (let i = 1; i <= g && clear; i++) {
          const cx = x + dx * i, cz = z + dz * i
          clear = body(cx, y, cz) && free(cx, y + 2, cz) && !at(cx, y - 1, cz).standable && gapSafe(cx, y, cz)
        }
        if (!clear) break // 沟中间被挡，或沟下危险：更宽的也不用看了
        const tx = x + dx * (g + 1), tz = z + dz * (g + 1)
        for (const dy of (g === 3 ? [0, -1] : [1, 0, -1, -2])) {
          if (!stand(tx, y + dy, tz) || !free(tx, y + dy + 2, tz)) continue
          if (dy > 0 && !free(x + dx * g, y + 3, z + dz * g)) continue
          const meta = { gap: g, dy, dir: [dx, dz] }
          if (!canJump({ x, y, z }, { x: tx, y: y + dy, z: tz }, meta)) continue
          out.push({ x: tx, y: y + dy, z: tz, cost: 3 + g * 2 + (g === 3 ? 4 : 0) + (dy > 0 ? 1 : 0), kind: 'jump', ...meta })
        }
      }
    }
    for (const [dx, dz] of DIAGONAL) {
      const nx = x + dx, nz = z + dz
      if (stand(nx, y, nz) && body(x + dx, y, z) && body(x, y, z + dz)) out.push({ x: nx, y, z: nz, cost: 1.5, kind: 'walk' })
      // 斜跳 1 格（踩角跳）：两侧要全空，起跳落地都不蹭墙
      if (at(x, y - 1, z).standable && free(x, y + 2, z) && !at(nx, y - 1, nz).standable && body(nx, y, nz) && free(nx, y + 2, nz) && gapSafe(nx, y, nz)) {
        const tx = x + dx * 2, tz = z + dz * 2
        const sides = [[x + dx, z], [x, z + dz], [tx - dx, tz], [tx, tz - dz]]
        if (stand(tx, y, tz) && free(tx, y + 2, tz) && sides.every(([a, b]) => body(a, y, b) && free(a, y + 2, b))) {
          const meta = { gap: 1, dy: 0, dir: [dx, dz], diagonal: true }
          if (canJump({ x, y, z }, { x: tx, y, z: tz }, meta)) out.push({ x: tx, y, z: tz, cost: 6, kind: 'jump', ...meta })
        }
      }
    }
    return out
  }

  const h = (n) => Math.hypot(n.x - goal.x, n.z - goal.z) + Math.abs(n.y - goal.y)
  const done = (n) => (range ? Math.abs(n.x - goal.x) <= range && Math.abs(n.z - goal.z) <= range && Math.abs(n.y - goal.y) <= 1 : n.x === goal.x && n.y === goal.y && n.z === goal.z)
  const open = [{ ...start, g: 0, f: h(start), parent: null, move: null }]
  const best = new Map([[key(start.x, start.y, start.z), 0]])
  let visited = 0
  let closest = open[0]
  const stopAt = Date.now() + budgetMs
  while (open.length && visited < maxNodes && Date.now() < stopAt) {
    let bi = 0
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i
    const n = open[bi]
    open[bi] = open[open.length - 1]
    open.pop()
    visited++
    if (h(n) < h(closest)) closest = n
    if (done(n)) {
      const moves = []
      for (let c = n; c.parent; c = c.parent) moves.push(c.move)
      return { ok: true, moves: moves.reverse(), visited }
    }
    for (const m of neighbors(n)) {
      const g = n.g + m.cost
      const k = key(m.x, m.y, m.z)
      if (best.get(k) <= g) continue
      best.set(k, g)
      open.push({ x: m.x, y: m.y, z: m.z, g, f: g + h(m), parent: n, move: m })
    }
  }
  return { ok: false, visited, closest: { x: closest.x, y: closest.y, z: closest.z }, exhausted: visited >= maxNodes || Date.now() >= stopAt }
}

function describeRoute(moves) {
  const jumps = moves.filter((m) => m.kind === 'jump')
  const hardest = jumps.reduce((a, m) => Math.max(a, m.gap), 0)
  return `${moves.length} 步，其中跳跃 ${jumps.length} 次${hardest ? `（最宽 ${hardest} 格沟）` : ''}`
}

function createParkour(bot, ctx) {
  const { say, runTask, fmt } = ctx
  let airborne = false // 起跳到落地这段：别被吃东西、战斗抢控制
  const worldView = { getBlock: (pos) => bot.blockAt(pos, false) }
  const cache = new Map()
  const at = (x, y, z) => {
    const k = `${x},${y},${z}`
    let v = cache.get(k)
    if (!v) { v = classify(bot.blockAt(new Vec3(x, y, z), false)); cache.set(k, v) }
    return v
  }
  const center = (p) => new Vec3(p.x + 0.5, p.y, p.z + 0.5)

  // ---- 物理模拟：从 from 中心往 to 跑跳，能不能落在 to 那一列的方块上 ----
  // 策略：runup（先往后退多少格助跑）、takeoff（越过起跳块中心多远时按跳）。把模拟通过的策略交给执行器原样复现。
  function simulateJump(from, to, { runup, takeoff, sprint }) {
    const dir = new Vec3(to.x - from.x, 0, to.z - from.z).normalize()
    const yaw = Math.atan2(-dir.x, -dir.z)
    const start = center(from).offset(-dir.x * runup, 0, -dir.z * runup)
    const state = new PlayerState(bot, { forward: true, back: false, left: false, right: false, jump: false, sprint, sneak: false })
    state.pos = start.clone()
    state.vel = new Vec3(0, 0, 0)
    state.onGround = true
    state.isInWater = false
    state.isInLava = false
    state.isInWeb = false
    state.isCollidedHorizontally = false
    state.isCollidedVertically = false
    state.jumpTicks = 0
    state.jumpQueued = false
    state.yaw = yaw
    state.pitch = 0
    const origin = center(from)
    const span = Math.hypot(to.x - from.x, to.z - from.z)
    const landY = to.y - 1 + at(to.x, to.y - 1, to.z).top
    const along = () => (state.pos.x - origin.x) * dir.x + (state.pos.z - origin.z) * dir.z
    let jumped = false
    for (let t = 0; t < 60; t++) {
      const a = along()
      state.control.jump = !jumped && state.onGround && a >= takeoff
      const launching = state.control.jump
      if (launching) jumped = true
      const air = jumped && !launching && !state.onGround
      const choice = air ? airControl(a, state.vel.x * dir.x + state.vel.z * dir.z, span, state.pos.y - landY, state.vel.y) : 'forward'
      state.control.forward = choice === 'forward'
      state.control.back = choice === 'back'
      state.control.sprint = sprint && choice === 'forward'
      bot.physics.simulatePlayer(state, worldView)
      if (state.isInLava || state.isInWater) return null
      if (jumped && state.onGround && t > 2) {
        // 玩家碰撞箱宽 0.6：中心悬在方块外 0.3 以内也站得住，所以不能只看中心落在哪一列
        const top = to.y - 1 + at(to.x, to.y - 1, to.z).top
        if (Math.abs(state.pos.y - top) > 0.1) return null
        const offX = Math.abs(state.pos.x - to.x - 0.5), offZ = Math.abs(state.pos.z - to.z - 0.5)
        const overlap = Math.min(0.8 - offX, 0.8 - offZ) // 碰撞箱和落点方块的重叠宽度
        if (overlap <= 0) return null
        return { margin: overlap, ticks: t, land: state.pos.clone() }
      }
      if (state.pos.y < from.y - 6) return null
    }
    return null
  }

  function jumpStrategy(from, to, meta) {
    const span = Math.hypot(to.x - from.x, to.z - from.z)
    const needSprint = span > 2 || meta.dy > 0
    // 能退多远：身后同高度的方块要能站。退满 1 格 / 半格 / 不退
    const [dx, dz] = meta.dir
    const backClear = (n) => {
      for (let i = 1; i <= n; i++) {
        const bx = from.x - dx * i, bz = from.z - dz * i
        if (!at(bx, from.y - 1, bz).standable || !at(bx, from.y, bz).passable || !at(bx, from.y + 1, bz).passable) return false
      }
      return true
    }
    const runups = [0.25]
    if (needSprint) { if (backClear(1)) runups.push(1); if (backClear(2)) runups.push(2) } else runups.unshift(0)
    const takeoffs = [0.15, 0.3, 0.42]
    let best = null
    for (const sprint of needSprint ? [true] : [false, true]) {
      for (const runup of runups) {
        for (const takeoff of takeoffs) {
          const r = simulateJump(from, to, { runup, takeoff, sprint })
          // 落脚重叠不足 0.2 格就算不稳：实际执行比模拟有几 tick 的抖动
          if (r && r.margin >= 0.2 && (!best || r.margin > best.margin)) best = { ...r, runup, takeoff, sprint }
        }
      }
      if (best) return best
    }
    return best
  }

  // ---- 执行 ----
  const tick = () => new Promise((resolve) => bot.once('physicsTick', resolve))
  const clear = () => bot.clearControlStates()
  async function aim(target) {
    await bot.look(Math.atan2(-(target.x - bot.entity.position.x), -(target.z - bot.entity.position.z)), 0, true)
  }
  // 走到某格中心：贴边不冲刺，靠近就松手让摩擦停下
  async function walkTo(p, { timeout = 3000, tolerance = 0.25 } = {}) {
    const target = center(p)
    const deadline = Date.now() + timeout
    try {
      while (Date.now() < deadline) {
        ctx.assertActive()
        const pos = bot.entity.position
        const d = Math.hypot(target.x - pos.x, target.z - pos.z)
        if (d < tolerance && bot.entity.onGround && Math.abs(pos.y - p.y) < 1.1) return true
        await aim(target)
        bot.setControlState('forward', d >= tolerance)
        bot.setControlState('sneak', d < 0.6) // 慢下来，别滑过头
        await tick()
      }
      return false
    } finally { clear() }
  }
  async function step(move) {
    const target = center(move)
    const deadline = Date.now() + 3000
    try {
      while (Date.now() < deadline) {
        ctx.assertActive()
        const pos = bot.entity.position
        const d = Math.hypot(target.x - pos.x, target.z - pos.z)
        if (d < 0.3 && pos.y >= move.y - 0.1 && bot.entity.onGround) return true
        await aim(target)
        bot.setControlState('forward', d >= 0.15)
        bot.setControlState('jump', pos.y < move.y - 0.1 && d < 1.3)
        await tick()
      }
      return false
    } finally { clear() }
  }
  async function climb(move) {
    const target = center(move)
    const going = move.y > bot.entity.position.y
    const deadline = Date.now() + 4000
    try {
      while (Date.now() < deadline) {
        ctx.assertActive()
        const pos = bot.entity.position
        if (going ? pos.y >= move.y - 0.05 : pos.y <= move.y + 0.05) return true
        await aim(target)
        if (going) { bot.setControlState('forward', true); bot.setControlState('jump', true) } else bot.setControlState('sneak', false)
        await tick()
      }
      return false
    } finally { clear() }
  }
  async function jump(move, from) {
    const live = jumpStrategy(from, move, move) // 方块可能刚变过，起跳前再算一次
    if (!live) return { ok: false, why: '起跳前模拟落不到目标' }
    const dir = new Vec3(move.x - from.x, 0, move.z - from.z).normalize()
    const origin = center(from)
    const back = origin.offset(-dir.x * live.runup, 0, -dir.z * live.runup)
    if (!await walkTo({ x: back.x - 0.5, y: from.y, z: back.z - 0.5 }, { tolerance: 0.12 })) return { ok: false, why: '站不到起跳点' }
    await new Promise((r) => setTimeout(r, 250)) // 等速度归零，贴近模拟的初始状态
    const span = Math.hypot(move.x - from.x, move.z - from.z)
    const landY = move.y - 1 + at(move.x, move.y - 1, move.z).top
    const yaw = Math.atan2(-dir.x, -dir.z)
    await bot.look(yaw, 0, true)
    const along = () => (bot.entity.position.x - origin.x) * dir.x + (bot.entity.position.z - origin.z) * dir.z
    let jumped = false
    airborne = true
    try {
      for (let t = 0; t < 120; t++) {
        ctx.assertActive()
        const a = along()
        const launch = !jumped && bot.entity.onGround && a >= live.takeoff
        if (launch) jumped = true
        bot.setControlState('jump', launch)
        const vel = bot.entity.velocity
        const inAir = jumped && !launch && !bot.entity.onGround
        const choice = inAir ? airControl(a, vel.x * dir.x + vel.z * dir.z, span, bot.entity.position.y - landY, vel.y) : 'forward'
        bot.setControlState('forward', choice === 'forward')
        bot.setControlState('back', choice === 'back')
        bot.setControlState('sprint', live.sprint && choice === 'forward')
        await tick()
        if (jumped && bot.entity.onGround && t > 2) break
        if (bot.entity.isInWater || bot.entity.isInLava) break
      }
    } finally { clear(); airborne = false }
    await tick()
    const pos = bot.entity.position
    const reached = bot.entity.onGround && Math.abs(pos.x - move.x - 0.5) < 0.81 && Math.abs(pos.z - move.z - 0.5) < 0.81 && Math.abs(pos.y - move.y) < 1.1
    return { ok: reached, why: reached ? null : `落在 ${fmt(pos)}，不是目标` }
  }

  function currentNode() {
    const p = bot.entity.position
    const f = p.floored()
    // 站在台阶/半砖上：floor 就是脚下方块那一层
    if (at(f.x, f.y, f.z).standable && !at(f.x, f.y + 1, f.z).standable) return { x: f.x, y: f.y + 1, z: f.z }
    if (at(f.x, f.y - 1, f.z).standable || !bot.entity.onGround) return { x: f.x, y: f.y, z: f.z }
    // 踩在方块边缘：中心已悬空，脚下的方块在旁边一列
    let best = null
    for (const dx of [-1, 0, 1]) {
      for (const dz of [-1, 0, 1]) {
        const x = f.x + dx, z = f.z + dz
        const off = Math.max(Math.abs(p.x - x - 0.5), Math.abs(p.z - z - 0.5))
        if (off < 0.81 && at(x, f.y - 1, z).standable && (!best || off < best.off)) best = { x, z, off }
      }
    }
    return best ? { x: best.x, y: f.y, z: best.z } : { x: f.x, y: f.y, z: f.z }
  }
  function route(goal, risk) {
    cache.clear()
    const memo = new Map()
    const canJump = (from, to, meta) => {
      const k = `${from.x},${from.y},${from.z}>${to.x},${to.y},${to.z}`
      if (!memo.has(k)) memo.set(k, !!jumpStrategy(from, to, meta))
      return memo.get(k)
    }
    // 同步搜索，每一跳都要跑物理模拟：不限时会把主线程卡住几十秒，服务器按超时踢人（实测）
    return planRoute(at, currentNode(), goal, { risk, canJump, budgetMs: ROUTE_BUDGET_MS })
  }

  async function run(goal, risk) {
    if (bot.health <= MIN_HP) return { ok: false, error: `血量 ${bot.health.toFixed(0)}，共享血量不够摔，先回血再跳` }
    let plan = route(goal, risk)
    if (!plan.ok) return { ok: false, error: plan.exhausted ? '路线太复杂，搜索放弃了' : `没有安全的跑酷路线（最近能到 ${plan.closest.x} ${plan.closest.y} ${plan.closest.z}）` }
    say(`路线 ${describeRoute(plan.moves)}，出发`)
    let misses = 0
    let jumps = 0
    while (plan.moves.length) {
      const move = plan.moves.shift()
      const from = currentNode()
      ctx.assertActive()
      if (ctx.combatActive?.()) { await ctx.waitCombat?.(); plan = route(goal, risk); if (!plan.ok) return { ok: false, error: '打完架后找不到路线了' }; continue }
      let res
      if (move.kind === 'jump') { res = await jump(move, from); if (res.ok) jumps++ } else if (move.kind === 'climb') res = { ok: await climb(move) }
      else if (move.kind === 'step') res = { ok: await step(move) }
      else res = { ok: await walkTo(move, { tolerance: 0.35 }) }
      if (res.ok) continue
      misses++
      ctx.log(`[parkour] ${move.kind} ${move.x},${move.y},${move.z} 失败: ${res.why || '超时'}`)
      if (misses >= 4) return { ok: false, error: `连续失败：${res.why || '走不过去'}`, jumps }
      if (bot.health <= MIN_HP) return { ok: false, error: '摔得血不够了，先停下', jumps }
      await new Promise((r) => setTimeout(r, 400))
      // 掉水里了：先游回能站的地方再重新规划
      if (bot.entity.isInWater) await ctx.travel(new (require('mineflayer-pathfinder').goals.GoalNear)(from.x, from.y, from.z, 2)).catch(() => {})
      plan = route(goal, risk)
      if (!plan.ok) return { ok: false, error: '失误后找不到路线了', jumps }
    }
    const end = currentNode()
    return { ok: end.x === goal.x && end.z === goal.z && Math.abs(end.y - goal.y) <= 1, jumps, end }
  }

  // ---- 指令 ----
  const parseGoal = (args) => {
    const numbers = args.slice(0, 3).map(Number)
    return numbers.length === 3 && numbers.every(Number.isFinite) ? { x: Math.floor(numbers[0]), y: Math.floor(numbers[1]), z: Math.floor(numbers[2]) } : null
  }
  const commands = {
    parkour: (_u, args) => {
      const check = args[0] === 'check'
      const rest = check ? args.slice(1) : args
      const goal = parseGoal(rest)
      if (!goal) return say('用法: bot parkour x y z [risk] / bot parkour check x y z')
      const risk = rest[3] === 'risk'
      if (check) {
        const plan = route(goal, risk)
        return say(plan.ok ? `能到 ${goal.x} ${goal.y} ${goal.z}：${describeRoute(plan.moves)}` : `没有安全路线（最近能到 ${plan.closest?.x} ${plan.closest?.y} ${plan.closest?.z}）`)
      }
      return runTask('跑酷', async () => {
        const r = await run(goal, risk)
        if (r.ok) say(`跑酷到了 ${fmt(bot.entity.position)}，跳了 ${r.jumps} 次`)
        else say(`跑酷失败: ${r.error || '没到终点'}`)
        return { ok: !!r.ok, error: r.error }
      }, { timeoutMs: 5 * 60_000 })
    },
  }
  return { commands, inJump: () => airborne, tryRoute: async (goal) => run(goal, false), checkRoute: (goal) => route(goal, false) }
}

module.exports = { createParkour, planRoute, classify, describeRoute, airControl }
