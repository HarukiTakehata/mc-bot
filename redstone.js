// 红石：操作（拉杆/按钮/门）、读电路（状态、走线追踪、排错）、搭电路并做功能自检。
// 同类 mineflayer 项目基本没有红石能力，这里按原版机制自己实现：
// 读状态都走方块属性（powered/lit/power/extended/locked…），操作后读回确认，不假设成功。
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const BP = require('./blueprint')

const SIDES = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' }
// 机器人可以按的。不含 TNT、发射器（可能装着东西）等
const USABLE = /(^lever$|_button$|_door$|_trapdoor$|_fence_gate$|^repeater$|^comparator$|^daylight_detector$|^note_block$)/
const IRON_OPENABLE = /^iron_(door|trapdoor)$/
const OPENABLE = /(_door|_trapdoor|_fence_gate)$/
const REPORT = /(^lever$|_button$|_pressure_plate$|^redstone_wire$|^repeater$|^comparator$|^redstone_torch$|^redstone_wall_torch$|^redstone_lamp$|piston$|^observer$|^dropper$|^dispenser$|^hopper$|^daylight_detector$|^target$|^redstone_block$|_door$|_trapdoor$|^note_block$|^tnt$)/
const POWER_SOURCE = /(^lever$|_button$|_pressure_plate$|^redstone_torch$|^redstone_wall_torch$|^redstone_block$|^daylight_detector$|^observer$|^target$|^tripwire_hook$|^trapped_chest$|^lectern$|^sculk_sensor$)/
const CONSUMER = /(^redstone_lamp$|piston$|_door$|_trapdoor$|_fence_gate$|^dropper$|^dispenser$|^hopper$|^note_block$|^tnt$|^powered_rail$|^activator_rail$|^bell$)/

// 纯逻辑：沿红石线走，返回能到的负载和断点。at(x,y,z) 返回 { name, props, solid, transparent }。
// 模型只含：同层相连、上下台阶（被实心方块盖住的台阶断开）、线末端指向的负载、中继器/比较器向前传。
function traceWire(at, start, { limit = 512 } = {}) {
  const key = (p) => `${p.x},${p.y},${p.z}`
  const seen = new Set([key(start)])
  const queue = [{ ...start, hops: 0 }]
  const loads = [], sources = [], ends = []
  const cells = []
  while (queue.length && seen.size < limit) {
    const p = queue.shift()
    const here = at(p.x, p.y, p.z)
    cells.push({ x: p.x, y: p.y, z: p.z, name: here.name, power: here.props?.power })
    let links = 0
    if (here.name === 'repeater' || here.name === 'comparator') {
      // 这两种只往 facing 反方向（输出端）传
      const out = SIDES[OPPOSITE[here.props.facing]]
      if (out) links += follow(p.x + out[0], p.y, p.z + out[1], p, queue)
      continue
    }
    for (const dir of Object.values(SIDES)) {
      const nx = p.x + dir[0], nz = p.z + dir[1]
      links += follow(nx, p.y, nz, p, queue)
      // 上台阶：头顶不能有实心方块
      if (!at(p.x, p.y + 1, p.z).solid && at(nx, p.y + 1, nz).name === 'redstone_wire') links += follow(nx, p.y + 1, nz, p, queue)
      // 下台阶：旁边那格不能是实心方块
      if (!at(nx, p.y, nz).solid && at(nx, p.y - 1, nz).name === 'redstone_wire') links += follow(nx, p.y - 1, nz, p, queue)
    }
    if (!links) ends.push({ x: p.x, y: p.y, z: p.z })
  }
  function follow(x, y, z, from, q) {
    const b = at(x, y, z)
    if (b.name === 'redstone_wire' || b.name === 'repeater' || b.name === 'comparator') {
      if (b.name !== 'redstone_wire') {
        // 中继器只从背后（facing 那一侧）进线
        const back = SIDES[b.props.facing]
        if (!back || x + back[0] !== from.x || z + back[1] !== from.z) return 0
      }
      const k = key({ x, y, z })
      if (!seen.has(k)) { seen.add(k); q.push({ x, y, z, hops: from.hops + 1 }) }
      return 1
    }
    if (CONSUMER.test(b.name)) { if (!loads.some((l) => key(l) === key({ x, y, z }))) loads.push({ x, y, z, name: b.name, ...flag(b) }); return 1 }
    if (POWER_SOURCE.test(b.name)) { if (!sources.some((l) => key(l) === key({ x, y, z }))) sources.push({ x, y, z, name: b.name, ...flag(b) }); return 1 }
    return 0
  }
  return { cells, loads, sources, ends }
}
const flag = (b) => {
  const out = {}
  for (const k of ['lit', 'powered', 'open', 'extended', 'power']) if (b.props?.[k] !== undefined) out[k] = b.props[k]
  return out
}

// 这个负载为什么没通电：查六面邻居，给出人话
function diagnose(at, p) {
  const b = at(p.x, p.y, p.z)
  if (!CONSUMER.test(b.name) && !/^redstone_wire$|^repeater$|^comparator$/.test(b.name)) return `${b.name} 不是红石负载`
  const notes = []
  let powered = false
  const six = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  for (const [dx, dy, dz] of six) {
    const n = at(p.x + dx, p.y + dy, p.z + dz)
    const where = `(${p.x + dx} ${p.y + dy} ${p.z + dz})`
    if (n.name === 'redstone_wire') {
      const power = Number(n.props?.power ?? 0)
      if (power === 0) notes.push(`${where} 红石线没信号`)
      else { powered = true; notes.push(`${where} 红石线强度 ${power}`) }
    } else if (POWER_SOURCE.test(n.name)) {
      const on = n.props?.powered === 'true' || n.props?.powered === true || n.props?.lit === 'true' || n.props?.lit === true || Number(n.props?.power) > 0 || n.name === 'redstone_block'
      if (on) powered = true
      notes.push(`${where} ${n.name} ${on ? '有电' : '没开'}`)
    } else if (n.name === 'repeater' || n.name === 'comparator') {
      const out = SIDES[OPPOSITE[n.props?.facing]]
      const pointsHere = out && p.x + dx + out[0] === p.x && p.z + dz + out[1] === p.z && dy === 0
      if (pointsHere) {
        const on = n.props?.powered === 'true' || n.props?.powered === true
        if (on) powered = true
        notes.push(`${where} ${n.name} 指向这里，${on ? '有输出' : '没输出'}`)
      } else notes.push(`${where} ${n.name} 没指向这里`)
    }
  }
  if (!notes.length) return `${b.name} 周围六面没有任何红石元件，缺信号来源`
  return `${powered ? '有信号送到' : '没有信号送到'}：${notes.slice(0, 5).join('；')}`
}

function createRedstone(bot, ctx, builder) {
  const { say, runTask, sleepMs, fmt } = ctx
  const propsOf = (block) => block?.getProperties?.() || {}
  const fromBlock = (block) => {
    if (!block) return { name: 'unknown', props: {}, solid: false }
    return { name: block.name, props: propsOf(block), solid: block.boundingBox === 'block' && !block.transparent }
  }
  const at = (x, y, z) => fromBlock(bot.blockAt(new Vec3(x, y, z)))

  async function walkNear(pos, range = 3) {
    if (bot.entity.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4) return
    await ctx.travel(new goals.GoalNear(pos.x, pos.y, pos.z, range))
  }
  // 右键一个红石元件，返回前后的属性
  async function press(pos) {
    const block = bot.blockAt(pos)
    if (!block) throw new Error('方块没加载')
    if (!USABLE.test(block.name)) throw new Error(`${block.name} 不能按（只能操作拉杆、按钮、门、中继器等）`)
    await walkNear(pos)
    const before = propsOf(bot.blockAt(pos))
    // 手上拿方块时右键可能变成"放方块"（门、拉杆不会，但保险起见不拿方块）
    await bot.activateBlock(bot.blockAt(pos))
    await sleepMs(250)
    return { before, after: propsOf(bot.blockAt(pos)), name: block.name }
  }

  const describeState = (name, p) => {
    if (/^lever$|_button$/.test(name)) return p.powered === 'true' || p.powered === true ? '开' : '关'
    if (OPENABLE.test(name)) return p.open === 'true' || p.open === true ? '开着' : '关着'
    if (name === 'repeater') return `延迟 ${p.delay}`
    if (name === 'comparator') return p.mode === 'subtract' ? '相减模式' : '比较模式'
    if (name === 'daylight_detector') return p.inverted === 'true' || p.inverted === true ? '夜间模式' : '白天模式'
    return ''
  }

  function parseXYZ(args) {
    const nums = args.slice(0, 3).map(Number)
    return nums.length === 3 && nums.every(Number.isFinite) ? new Vec3(Math.floor(nums[0]), Math.floor(nums[1]), Math.floor(nums[2])) : null
  }
  const nearest = (re, dist = 16) => bot.findBlock({ matching: (b) => b && re.test(b.name), maxDistance: dist })

  // ---- 读电路 ----
  function scan(radius) {
    const found = bot.findBlocks({ matching: (b) => b && REPORT.test(b.name), maxDistance: radius, count: 256 })
    const groups = {}
    for (const p of found) {
      const b = bot.blockAt(p)
      if (!b) continue
      const prop = propsOf(b)
      let state = ''
      if (b.name === 'redstone_wire') {
        const power = Number(prop.power)
        const g = groups.redstone_wire ||= { count: 0, lit: 0, max: 0 }
        g.count++
        if (power) g.lit++
        g.max = Math.max(g.max, power)
        continue
      }
      if (prop.lit !== undefined) state = String(prop.lit) === 'true' ? '亮' : '灭'
      else if (prop.extended !== undefined) state = String(prop.extended) === 'true' ? '伸' : '缩'
      else if (prop.powered !== undefined) state = String(prop.powered) === 'true' ? '开' : '关'
      else if (prop.open !== undefined) state = String(prop.open) === 'true' ? '开' : '关'
      ;(groups[b.name] ||= { list: [] }).list.push(`${p.x},${p.y},${p.z}${state ? ':' + state : ''}`)
    }
    const parts = []
    for (const [name, g] of Object.entries(groups)) {
      if (name === 'redstone_wire') parts.push(`红石线${g.count}格(带电${g.lit},最强${g.max})`)
      else parts.push(`${name}×${g.list.length}[${g.list.slice(0, 4).join(' ')}${g.list.length > 4 ? ' …' : ''}]`)
    }
    return parts.join('；')
  }

  // ---- 搭电路并自检 ----
  function localToWorld(rel, origin, facing) {
    const n = BP.HORIZONTAL.indexOf(facing)
    let [x, y, z] = rel
    for (let i = 0; i < n; i++) [x, z] = [-z, x]
    return new Vec3(origin.x + x, origin.y + y, origin.z + z)
  }
  async function selfTest(circuit, origin, facing) {
    for (const [i, step] of (circuit.test || []).entries()) {
      ctx.assertActive()
      if (step.press) await press(localToWorld(step.press, origin, facing))
      if (step.walk) {
        const w = localToWorld(step.walk, origin, facing)
        await ctx.travel(new goals.GoalBlock(w.x, w.y, w.z))
      }
      await sleepMs(step.settle || 400)
      if (step.probe) {
        const [x, y, z, prop] = step.probe
        const pos = localToWorld([x, y, z], origin, facing)
        const seen = new Set()
        const until = Date.now() + (step.ms || 2000)
        while (Date.now() < until) {
          seen.add(String(propsOf(bot.blockAt(pos))[prop]))
          await sleepMs(30)
        }
        if (seen.size < 2) return { ok: false, why: `第 ${i + 1} 步：${prop} 一直是 ${[...seen].join('/')}，没有闪` }
      }
      for (const [x, y, z, prop, want] of step.expect || []) {
        const pos = localToWorld([x, y, z], origin, facing)
        const b = bot.blockAt(pos)
        const have = prop === '@name' ? b?.name : String(propsOf(b)[prop])
        if (have !== want && !(prop === '@name' && want === 'air' && /air$/.test(have || ''))) return { ok: false, why: `第 ${i + 1} 步：(${pos.x} ${pos.y} ${pos.z}) ${prop === '@name' ? '方块' : prop} 是 ${have}，应为 ${want}` }
      }
    }
    return { ok: true, steps: circuit.test?.length || 0 }
  }

  const commands = {
    // 按一下：有坐标按坐标，没坐标按最近的拉杆/按钮
    use: (_u, args) => {
      const pos = parseXYZ(args)
      const target = pos ? bot.blockAt(pos) : nearest(/^lever$|_button$/)
      if (!target) return say(pos ? '那里没加载' : '16 格内没有拉杆或按钮。用法: bot use x y z')
      return runTask('按开关', () => builder.friendly('按不了', async () => {
        if (IRON_OPENABLE.test(target.name)) { say('铁门/铁活板门要靠红石，手按不开'); return { ok: false } }
        const { after, name } = await press(target.position)
        say(`${name} @ ${fmt(target.position)} 现在${describeState(name, after) || '已操作'}`)
        return { ok: true }
      }))
    },
    door: (_u, [mode]) => {
      if (!['open', 'close'].includes(mode)) return say('用法: bot door open|close（最近的门/活板门/栅栏门）')
      const target = bot.findBlock({ matching: (b) => b && OPENABLE.test(b.name) && !IRON_OPENABLE.test(b.name), maxDistance: 16 })
      if (!target) return say('16 格内没有能手开的门')
      return runTask('开关门', () => builder.friendly('开不了', async () => {
        const want = mode === 'open'
        const state = (p) => p.open === 'true' || p.open === true
        if (state(propsOf(target)) === want) { say(`门本来就${want ? '开着' : '关着'}`); return { ok: true } }
        const { after } = await press(target.position)
        const ok = state(after) === want
        say(ok ? `门${want ? '开了' : '关了'}` : '门没动（可能有红石信号顶着）')
        return { ok }
      }))
    },
    repeater: (_u, args) => {
      const pos = parseXYZ(args)
      const delay = Number(args[3])
      if (!pos || ![1, 2, 3, 4].includes(delay)) return say('用法: bot repeater x y z <延迟1-4>')
      return runTask('调中继器', () => builder.friendly('调不了', async () => {
        const b = bot.blockAt(pos)
        if (b?.name !== 'repeater') { say('那里不是中继器'); return { ok: false } }
        await walkNear(pos)
        for (let i = 0; i < 4 && Number(propsOf(bot.blockAt(pos)).delay) !== delay; i++) { await bot.activateBlock(bot.blockAt(pos)); await sleepMs(150) }
        const ok = Number(propsOf(bot.blockAt(pos)).delay) === delay
        say(ok ? `中继器调到延迟 ${delay}` : '没调成功')
        return { ok }
      }))
    },
    rs: (_u, [r]) => {
      const radius = Math.min(Number(r) || 16, 32)
      const text = scan(radius)
      say(text ? `${radius} 格内红石：${text}`.slice(0, 500) : `${radius} 格内没有红石元件`)
    },
    rstrace: (_u, args) => {
      const pos = parseXYZ(args)
      if (!pos) return say('用法: bot rstrace x y z（从这格红石线/中继器开始追踪）')
      const start = bot.blockAt(pos)
      if (!start || !/^(redstone_wire|repeater|comparator)$/.test(start.name)) return say('起点要是红石线、中继器或比较器')
      const t = traceWire(at, { x: pos.x, y: pos.y, z: pos.z })
      const list = (arr) => arr.slice(0, 5).map((l) => `${l.name}(${l.x} ${l.y} ${l.z})${l.lit !== undefined ? (String(l.lit) === 'true' ? '亮' : '灭') : ''}${l.powered !== undefined ? (String(l.powered) === 'true' ? '开' : '关') : ''}`).join(' ') || '无'
      const maxP = Math.max(0, ...t.cells.map((c) => Number(c.power) || 0))
      say(`走线 ${t.cells.length} 格，最强 ${maxP}；电源: ${list(t.sources)}；负载: ${list(t.loads)}；断头: ${t.ends.slice(0, 3).map((e) => `${e.x} ${e.y} ${e.z}`).join('、') || '无'}`.slice(0, 500))
    },
    rsdiag: (_u, args) => {
      const pos = parseXYZ(args)
      if (!pos) return say('用法: bot rsdiag x y z（看这个灯/活塞/门为什么没动）')
      say(diagnose(at, { x: pos.x, y: pos.y, z: pos.z }).slice(0, 500))
    },
    circuit: (_u, [name, ...rest]) => {
      const list = () => Object.entries(BP.CIRCUITS).map(([n, c]) => `${n}(${c.desc})`).join(' ')
      if (!name) return say(`用法: bot circuit <电路> [at=x,y,z] [f=朝向]；可选: ${list()}`.slice(0, 500))
      const c = Object.hasOwn(BP.CIRCUITS, name) && BP.CIRCUITS[name]
      if (!c) return say(`没有电路 ${name}，可选: ${Object.keys(BP.CIRCUITS).join(' ')}`)
      return runTask(`搭${name}`, () => builder.friendly('搭不了', async () => {
        const opts = builder.parseOptions(rest)
        const { facing, origin } = builder.layout(opts)
        const blocks = BP.validate(BP.place(c.blocks(), origin, facing), { ai: !!opts.ai })
        const built = await builder.execute(`电路${name}`, blocks, { quiet: true })
        if (!built.ok) return built
        if (opts.notest === '1' || !c.test?.length) { say(`电路 ${name} 搭好了（${blocks.length} 块）@ ${origin.x} ${origin.y} ${origin.z}，这种没有自检`); return { ok: true } }
        const r = await selfTest(c, origin, facing)
        if (r.ok) say(`电路 ${name} 搭好并自检通过（${r.steps} 步）@ ${origin.x} ${origin.y} ${origin.z}`)
        else say(`电路 ${name} 搭好了但自检失败：${r.why}`)
        return { ok: r.ok, error: r.why }
      }), { timeoutMs: 10 * 60_000 })
    },
    wire: (_u, args) => {
      const nums = args.slice(0, 6).map(Number)
      if (nums.length !== 6 || !nums.every(Number.isInteger)) return say('用法: bot wire x1 y1 z1 x2 y2 z2（同高度，每 14 格自动加中继器）')
      return runTask('拉红石线', () => builder.friendly('拉不了', async () => {
        const blocks = BP.validate(BP.wirePath({ x: nums[0], y: nums[1], z: nums[2] }, { x: nums[3], y: nums[4], z: nums[5] }), {})
        return builder.execute('红石线', blocks)
      }), { timeoutMs: 10 * 60_000 })
    },
  }
  return { commands, press, scan, selfTest }
}

module.exports = { createRedstone, traceWire, diagnose, USABLE }
