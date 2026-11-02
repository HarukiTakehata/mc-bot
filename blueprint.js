// 蓝图：纯数据和计算，不碰游戏（方便测试）。
// 模板坐标约定：y 向上，玩家朝北（-z）看，+x 在右手边；旋转时方块朝向属性一起转。
// 属性解析和"按朝向放方块"的思路参考 mineflayer-builder（MIT）与 mineflayer-schem（MIT）；.schem 格式按 Sponge Schematic 规范实现。
const nbt = require('prismarine-nbt')

const HORIZONTAL = ['north', 'east', 'south', 'west']
const MAX_BLOCKS = 4096

// 绝不放：破坏性方块（共享世界，炸坏/烧掉别人的东西无法撤回）和管理方块
const FORBIDDEN = /^(tnt|lava|fire|soul_fire|command_block|chain_command_block|repeating_command_block|structure_block|structure_void|jigsaw|barrier|bedrock|end_portal|nether_portal|end_gateway|spawner|respawn_anchor|end_crystal)$/
// AI 不许自己花掉的稀有材料（玩家亲自下指令可以）
const RARE = /(diamond|emerald|netherite|gold_block|iron_block|beacon|ancient_debris|enchanting_table|anvil|lapis_block|shulker_box|dragon)/

// 方块 → 放它要用的物品
function itemFor(name) {
  if (name === 'redstone_wire') return 'redstone'
  if (name === 'wall_torch') return 'torch'
  if (name === 'redstone_wall_torch') return 'redstone_torch'
  if (name === 'soul_wall_torch') return 'soul_torch'
  if (name.endsWith('_wall_sign')) return name.replace('_wall_sign', '_sign')
  if (name.endsWith('_wall_hanging_sign')) return name.replace('_wall_hanging_sign', '_hanging_sign')
  if (name.endsWith('_wall_banner')) return name.replace('_wall_banner', '_banner')
  if (name.endsWith('_wall_head')) return name.replace('_wall_head', '_head')
  if (name === 'water') return 'water_bucket'
  return name
}

function parseSpec(spec) {
  const m = /^(?:minecraft:)?([a-z0-9_]+)(?:\[(.*)\])?$/.exec(spec)
  if (!m) throw new Error(`方块写法不对: ${spec}`)
  const props = {}
  if (m[2]) {
    for (const part of m[2].split(',')) {
      const [k, v] = part.split('=')
      if (!k || v === undefined) throw new Error(`方块属性不对: ${spec}`)
      props[k] = v
    }
  }
  return { name: m[1], props }
}

const turn = (dir, n) => (HORIZONTAL.includes(dir) ? HORIZONTAL[(HORIZONTAL.indexOf(dir) + n) % 4] : dir)
function rotateProps(props, n) {
  const out = { ...props }
  if (out.facing) out.facing = turn(out.facing, n)
  if (out.axis && n % 2 && out.axis !== 'y') out.axis = out.axis === 'x' ? 'z' : 'x'
  if (out.rotation !== undefined) out.rotation = String((Number(out.rotation) + n * 4) % 16)
  for (const dir of HORIZONTAL) delete out[dir] // 围栏、红石线的连接由服务器算
  return out
}
// 把模板摆到世界里：origin 是世界坐标，facing 是模板"前方"（模板里的北）对应的世界方向
function place(blocks, origin, facing = 'north') {
  const n = HORIZONTAL.indexOf(facing)
  if (n < 0) throw new Error(`朝向只能是 ${HORIZONTAL.join('/')}`)
  return blocks.map((b) => {
    let { x, z } = b
    for (let i = 0; i < n; i++) [x, z] = [-z, x]
    return { ...b, x: origin.x + x, y: origin.y + b.y, z: origin.z + z, props: rotateProps(b.props, n), seq: b.seq ?? 0 }
  })
}

// 必须最后放的（要靠别的方块支撑或会马上工作）
const ATTACHED = /(torch|_button|^lever$|^ladder$|redstone_wire|^repeater$|^comparator$|_pressure_plate|_door$|_carpet$|^carpet$|rail$|_sign$|_banner$|_bed$|^tripwire|^vine$|^flower_pot$|_trapdoor$|^snow$|^lantern$|^soul_lantern$)/
// 放置阶段：0 普通方块，1 依附类；模板可用 seq 再强制后移（如红石电路最后接电源）
const phase = (b) => (b.seq || 0) * 10 + (ATTACHED.test(b.name) ? 1 : 0)

// 只有门下半、床脚需要真的放；上半和床头由游戏自动生成
function isSecondaryPart(b) {
  return (b.name.endsWith('_door') && b.props.half === 'upper') || (b.name.endsWith('_bed') && b.props.part === 'head') ||
    b.name === 'piston_head' || b.name === 'moving_piston' || ((b.name === 'tall_grass' || b.name === 'large_fern' || b.name === 'sunflower' || b.name === 'lilac' || b.name === 'rose_bush' || b.name === 'peony' || b.name === 'tall_seagrass') && b.props.half === 'upper')
}

function materials(blocks) {
  const need = {}
  for (const b of blocks) {
    if (isSecondaryPart(b)) continue
    const item = itemFor(b.name)
    need[item] = (need[item] || 0) + (b.name.endsWith('_slab') && b.props.type === 'double' ? 2 : 1)
  }
  return need
}

function validate(blocks, { ai = false, maxBlocks = MAX_BLOCKS } = {}) {
  if (!blocks.length) throw new Error('蓝图是空的')
  if (blocks.length > maxBlocks) throw new Error(`蓝图有 ${blocks.length} 块，超过上限 ${maxBlocks}`)
  const seen = new Set()
  for (const b of blocks) {
    if (FORBIDDEN.test(b.name)) throw new Error(`不放 ${b.name}（破坏性或管理方块）`)
    if (ai && RARE.test(b.name)) throw new Error(`${b.name} 是稀有材料，AI 不能自己决定用，请玩家直接下指令`)
    const key = `${b.x},${b.y},${b.z}`
    if (seen.has(key)) throw new Error(`蓝图有重复位置 ${key}`)
    seen.add(key)
    if (![b.x, b.y, b.z].every(Number.isInteger)) throw new Error('蓝图坐标不是整数')
  }
  return blocks
}

// ---- 模板 ----
const block = (x, y, z, spec, seq) => ({ x, y, z, ...parseSpec(spec), ...(seq ? { seq } : {}) })
const clampInt = (v, d, lo, hi) => {
  const n = v === undefined ? d : Number(v)
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`尺寸要是 ${lo} 到 ${hi} 的整数`)
  return n
}

const TEMPLATES = {
  wall: { desc: '一堵墙 w=长 h=高', build({ m = 'cobblestone', w, h }) {
    const out = []; w = clampInt(w, 8, 1, 64); h = clampInt(h, 3, 1, 16)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push(block(x - (w >> 1), y, -1, m))
    return out
  } },
  floor: { desc: '一片地板 w=宽 l=长', build({ m = 'cobblestone', w, l }) {
    const out = []; w = clampInt(w, 5, 1, 32); l = clampInt(l, 5, 1, 32)
    for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) out.push(block(x - (w >> 1), 0, -z - 1, m))
    return out
  } },
  stairs: { desc: '向前升高的楼梯 n=级数', build({ m = 'cobblestone_stairs', base = 'cobblestone', n }) {
    const out = []; n = clampInt(n, 5, 1, 32)
    // 两级楼梯只有棱相接没有共用的面，每级下面要垫一块才放得上去
    for (let i = 0; i < n; i++) {
      out.push(block(0, i, -i - 1, `${m}[facing=north,half=bottom]`))
      if (i) out.push(block(0, i - 1, -i - 1, base))
    }
    return out
  } },
  tower: { desc: '瞭望塔（梯子、顶部平台和护栏）h=塔高', build({ m = 'cobblestone', top = 'oak_planks', fence = 'oak_fence', h }) {
    const out = []; h = clampInt(h, 6, 3, 24)
    for (let y = 0; y < h; y++) {
      for (let x = -1; x <= 1; x++) {
        for (let z = -2; z <= 0; z++) {
          if (x === 0 && z === -1) continue
          if (x === 0 && z === 0 && y < 2) continue
          out.push(block(x, y, z, m))
        }
      }
      out.push(block(0, y, -1, 'ladder[facing=south]'))
    }
    out.push(block(0, 0, 0, 'oak_door[facing=north,half=lower]'))
    for (let x = -2; x <= 2; x++) {
      for (let z = -3; z <= 1; z++) {
        if (x === 0 && z === -1) { out.push(block(0, h, -1, 'ladder[facing=south]')); continue }
        out.push(block(x, h, z, top))
        if (Math.abs(x) === 2 || z === -3 || z === 1) out.push(block(x, h + 1, z, fence))
      }
    }
    return out
  } },
  pyramid: { desc: '实心金字塔 n=底边半宽', build({ m = 'sandstone', n }) {
    const out = []; n = clampInt(n, 3, 1, 10)
    for (let level = 0; level <= n; level++) {
      const r = n - level
      for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) out.push(block(x, level, z - n - 1, m))
    }
    return out
  } },
}

// ---- 红石电路模板 ----
// test：搭完后的功能自检。press 右键（相对坐标，随模板旋转），walk 走到某格，
// expect 读方块属性；probe 表示要在一段时间内看到某属性的两种取值（时钟用）。
const CIRCUITS = {
  lamp: { desc: '拉杆→红石线→灯', blocks: () => [
    block(0, 0, -3, 'redstone_lamp'), block(0, 0, -2, 'redstone_wire'), block(0, 0, -1, 'redstone_wire'),
    block(0, 0, 0, 'lever[face=floor,facing=north]', 1),
  ], test: [
    { expect: [[0, 0, -3, 'lit', 'false']] }, { press: [0, 0, 0], expect: [[0, 0, -3, 'lit', 'true']] }, { press: [0, 0, 0], expect: [[0, 0, -3, 'lit', 'false']] },
  ] },
  not: { desc: '非门：拉杆开时灯灭（红石火把反相）', blocks: () => [
    block(0, 0, -2, 'stone'), block(0, 0, -4, 'redstone_lamp'), block(0, 0, -1, 'redstone_wire'), block(0, 0, -3, 'redstone_wall_torch[facing=north]'),
    block(0, 0, 0, 'lever[face=floor,facing=north]', 1),
  ], test: [
    { expect: [[0, 0, -4, 'lit', 'true']] }, { press: [0, 0, 0], expect: [[0, 0, -4, 'lit', 'false']] }, { press: [0, 0, 0], expect: [[0, 0, -4, 'lit', 'true']] },
  ] },
  or: { desc: '或门：两根拉杆任一开，灯亮', blocks: () => [
    block(0, 0, -3, 'redstone_lamp'), block(0, 0, -2, 'redstone_wire'), block(0, 0, -1, 'redstone_wire'), block(-1, 0, -1, 'redstone_wire'), block(1, 0, -1, 'redstone_wire'),
    block(-1, 0, 0, 'lever[face=floor,facing=north]', 1), block(1, 0, 0, 'lever[face=floor,facing=north]', 1),
  ], test: [
    { expect: [[0, 0, -3, 'lit', 'false']] }, { press: [-1, 0, 0], expect: [[0, 0, -3, 'lit', 'true']] }, { press: [1, 0, 0], expect: [[0, 0, -3, 'lit', 'true']] },
    { press: [-1, 0, 0], expect: [[0, 0, -3, 'lit', 'true']] }, { press: [1, 0, 0], expect: [[0, 0, -3, 'lit', 'false']] },
  ] },
  and: { desc: '与门：两根拉杆都开，灯才亮', blocks: () => [
    block(-1, 0, -1, 'stone'), block(1, 0, -1, 'stone'), block(0, 0, -1, 'stone'), block(0, 0, -2, 'stone'), block(0, 0, -3, 'stone'), block(0, 1, -3, 'stone'),
    block(0, 0, -4, 'stone'), block(0, 0, -5, 'stone'), block(0, 1, -5, 'redstone_lamp'),
    block(-1, 1, -1, 'redstone_torch'), block(1, 1, -1, 'redstone_torch'), block(0, 1, -1, 'redstone_wire'), block(0, 1, -2, 'redstone_wire'), block(0, 1, -4, 'redstone_wall_torch[facing=north]'),
    block(-1, 0, 0, 'lever[face=wall,facing=south]', 1), block(1, 0, 0, 'lever[face=wall,facing=south]', 1),
  ], test: [
    { expect: [[0, 1, -5, 'lit', 'false']] }, { press: [-1, 0, 0], expect: [[0, 1, -5, 'lit', 'false']] }, { press: [1, 0, 0], expect: [[0, 1, -5, 'lit', 'true']] }, { press: [-1, 0, 0], expect: [[0, 1, -5, 'lit', 'false']] },
  ] },
  memory: { desc: '记忆单元：中继器锁存。开"写保护"后灯状态不再变', blocks: () => [
    block(0, 0, -2, 'redstone_lamp'), block(0, 0, -1, 'repeater[facing=south,delay=1]'), block(1, 0, -1, 'repeater[facing=east,delay=1]'),
    block(0, 0, 0, 'lever[face=floor,facing=north]', 1), block(2, 0, -1, 'lever[face=floor,facing=north]', 1),
  ], test: [
    { press: [0, 0, 0], expect: [[0, 0, -2, 'lit', 'true']] }, { press: [2, 0, -1], expect: [[0, 0, -1, 'locked', 'true']] },
    { press: [0, 0, 0], expect: [[0, 0, -2, 'lit', 'true']] }, { press: [2, 0, -1], expect: [[0, 0, -2, 'lit', 'false']] },
  ] },
  gate: { desc: '活塞门：两格高，拉杆开=关门、拉杆关=开门', blocks: () => [
    block(-2, 0, -1, 'stone'), block(-2, 1, -1, 'stone'),
    block(-1, 0, -1, 'sticky_piston[facing=east]'), block(-1, 1, -1, 'sticky_piston[facing=east]'),
    block(0, 0, -1, 'stone'), block(0, 1, -1, 'stone'),
    block(-2, 1, 0, 'lever[face=wall,facing=south]', 1),
  ], test: [
    { expect: [[1, 0, -1, '@name', 'air'], [1, 1, -1, '@name', 'air']] },
    { press: [-2, 1, 0], settle: 700, expect: [[1, 0, -1, '@name', 'stone'], [1, 1, -1, '@name', 'stone']] },
    { press: [-2, 1, 0], settle: 700, expect: [[1, 0, -1, '@name', 'air'], [1, 1, -1, '@name', 'air'], [0, 0, -1, '@name', 'stone']] },
  ] },
  autodoor: { desc: '自动门：铁门加前后压力板', blocks: () => [
    block(0, 0, -1, 'iron_door[facing=north,half=lower]'), block(0, 0, 0, 'stone_pressure_plate', 1), block(0, 0, -2, 'stone_pressure_plate', 1),
  ], test: [
    { expect: [[0, 0, -1, 'open', 'false']] }, { walk: [0, 0, 0], settle: 500, expect: [[0, 0, -1, 'open', 'true']] },
  ] },
  clock: { desc: '中继器时钟：按一下按钮后灯约每 1.6 秒闪一次（要拆才停，bot undo）', blocks: () => [
    block(-1, 0, -1, 'stone'), block(0, 0, -1, 'redstone_wire'), block(1, 0, -1, 'repeater[facing=west,delay=4]'), block(2, 0, -1, 'repeater[facing=west,delay=4]'),
    block(3, 0, -1, 'redstone_wire'), block(4, 0, -1, 'redstone_wire'), block(5, 0, -1, 'redstone_lamp'),
    block(3, 0, -2, 'redstone_wire'), block(2, 0, -2, 'repeater[facing=east,delay=4]'), block(1, 0, -2, 'repeater[facing=east,delay=4]'), block(0, 0, -2, 'redstone_wire'),
    block(-2, 0, -1, 'stone_button[face=wall,facing=west]', 1),
  ], test: [{ press: [-2, 0, -1], settle: 200, probe: [5, 0, -1, 'lit'], ms: 5000 }] },
  fastclock: { desc: '观察者高速时钟：每 0.2 秒一个脉冲，红石线闪，灯看着常亮（要拆才停）', blocks: () => [
    block(-2, 0, -1, 'redstone_lamp'), block(-1, 0, -1, 'redstone_wire'),
    block(0, 0, -1, 'observer[facing=east]'), block(1, 0, -1, 'observer[facing=west]', 1),
  ], test: [{ probe: [-1, 0, -1, 'power'], ms: 2000 }] },
  nightlight: { desc: '光感灯：天黑自动亮（反相阳光传感器）', blocks: () => [
    block(0, 0, -2, 'redstone_lamp'), block(0, 0, -1, 'daylight_detector[inverted=true]'),
  ], test: [] },
  dropbox: { desc: '收集箱：扔到漏斗上的东西进箱子', blocks: () => [
    block(0, 0, -1, 'chest[facing=south]'), block(0, 1, -1, 'hopper[facing=down]'),
  ], test: [] },
}

// 一条红石线：沿 x/z 走折线，每 14 格插一个中继器防信号衰减（同高度，需要地面支撑）
function wirePath(from, to, { repeaterEvery = 14 } = {}) {
  if (from.y !== to.y) throw new Error('红石线目前只支持同一高度')
  const cells = []
  const stepToward = (a, b) => (a < b ? 1 : a > b ? -1 : 0)
  let { x, z } = from
  cells.push({ x, z })
  while (x !== to.x) { x += stepToward(x, to.x); cells.push({ x, z }) }
  while (z !== to.z) { z += stepToward(z, to.z); cells.push({ x, z }) }
  if (cells.length > 256) throw new Error('红石线太长（上限 256 格）')
  const out = []
  cells.forEach((c, i) => {
    const prev = cells[i - 1]
    const next = cells[i + 1]
    const straight = prev && next && (prev.x === c.x) === (next.x === c.x)
    if (i && i % repeaterEvery === 0 && straight) {
      const facing = prev.x < c.x ? 'west' : prev.x > c.x ? 'east' : prev.z < c.z ? 'north' : 'south'
      out.push({ x: c.x, y: from.y, z: c.z, name: 'repeater', props: { facing, delay: '1' } })
    } else out.push({ x: c.x, y: from.y, z: c.z, name: 'redstone_wire', props: {} })
  })
  return out
}

// fill：实心或空心长方体
function fillBox(a, b, spec, { hollow = false } = {}) {
  const { name, props } = parseSpec(spec)
  const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) }
  const hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) }
  const volume = (hi.x - lo.x + 1) * (hi.y - lo.y + 1) * (hi.z - lo.z + 1)
  if (volume > MAX_BLOCKS) throw new Error(`范围有 ${volume} 格，超过上限 ${MAX_BLOCKS}`)
  const out = []
  for (let y = lo.y; y <= hi.y; y++) {
    for (let x = lo.x; x <= hi.x; x++) {
      for (let z = lo.z; z <= hi.z; z++) {
        if (hollow && x > lo.x && x < hi.x && z > lo.z && z < hi.z && y > lo.y && y < hi.y) continue
        out.push({ x, y, z, name, props })
      }
    }
  }
  return out
}

// ---- .schem（Sponge Schematic v2/v3）读取 ----
function readVarints(buf, expected) {
  const out = []
  let i = 0
  while (i < buf.length && out.length < expected) {
    let v = 0, shift = 0, b
    do {
      if (i >= buf.length || shift > 28) throw new Error('.schem 方块数据损坏')
      b = buf[i++]
      v |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    out.push(v)
  }
  if (out.length !== expected) throw new Error('.schem 方块数据长度不对')
  return out
}
async function parseSchem(buffer) {
  if (buffer.length > 8 * 1024 * 1024) throw new Error('.schem 文件太大（上限 8MB）')
  const root = nbt.simplify((await nbt.parse(buffer)).parsed)
  const data = root.Schematic || root
  const width = data.Width, height = data.Height, length = data.Length
  if (![width, height, length].every((n) => Number.isInteger(n) && n > 0 && n <= 512)) throw new Error('.schem 尺寸不对')
  if (width * height * length > 256 * 256 * 64) throw new Error('.schem 太大')
  const paletteTag = data.Blocks?.Palette || data.Palette
  const raw = data.Blocks?.Data || data.BlockData
  if (!paletteTag || !raw) throw new Error('不是 Sponge .schem 格式')
  const palette = []
  for (const [spec, idx] of Object.entries(paletteTag)) palette[idx] = spec
  const ids = readVarints(Buffer.from(raw).map((b) => b & 0xff), width * height * length)
  const out = []
  ids.forEach((id, i) => {
    const spec = palette[id]
    if (spec === undefined) throw new Error('.schem 调色板不完整')
    const { name, props } = parseSpec(spec)
    if (name === 'air' || name === 'cave_air' || name === 'void_air' || name === 'structure_void') return
    const y = Math.floor(i / (width * length))
    const z = Math.floor((i % (width * length)) / width)
    const x = i % width
    out.push({ x: x - (width >> 1), y, z: z - length, name, props })
  })
  return out
}

module.exports = { TEMPLATES, CIRCUITS, HORIZONTAL, MAX_BLOCKS, FORBIDDEN, RARE, ATTACHED, itemFor, parseSpec, place, rotateProps, phase, isSecondaryPart, materials, validate, wirePath, fillBox, parseSchem, block }
