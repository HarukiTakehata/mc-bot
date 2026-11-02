// 建筑 / 红石 / 跑酷的实机场景，判定全部走服务器侧。用法：node scripts/lab/new-capabilities.js [场景名片段...]
const { createLab, rcon, assert, sleep, NAME } = require('./harness')
const BP = require('../../blueprint')

const CRITICAL = ['facing', 'half', 'type', 'face', 'part', 'delay', 'mode', 'inverted']
const specOf = (b) => {
  const props = CRITICAL.filter((k) => b.props[k] !== undefined).map((k) => `${k}=${b.props[k]}`)
  return `minecraft:${b.name}${props.length ? `[${props.join(',')}]` : ''}`
}
// 蓝图逐块问服务器（门上半等由游戏生成的跳过）
function verify(lab, blocks) {
  const wrong = []
  for (const b of blocks) {
    if (BP.isSecondaryPart(b)) continue
    if (!lab.block(b.x, b.y, b.z, specOf(b))) wrong.push(`${specOf(b)}@${b.x},${b.y},${b.z}`)
  }
  return wrong
}
const giveFor = (lab, blocks, extra = 4) => {
  for (const [item, n] of Object.entries(BP.materials(blocks))) lab.give(`minecraft:${item}`, n + extra)
}
const DONE = /盖好了/
const FAILED = /没开工|没盖完|盖不了|贴不了|失败|我挂了/

function buildCase(template, opts, x, facing) {
  return async (lab) => {
    const a = await lab.arena(x, 0, 20)
    const origin = { x: a.cx, y: 100, z: a.cz - 4 }
    const blocks = BP.place(BP.TEMPLATES[template].build(opts), origin, facing)
    giveFor(lab, blocks)
    lab.give('minecraft:iron_pickaxe', 1); lab.give('minecraft:dirt', 32)
    await sleep(1000)
    const args = Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(' ')
    const r = await lab.cmd(`bot build ${template} at=${origin.x},${origin.y},${origin.z} f=${facing} ${args}`.trim(), DONE, FAILED, 600_000)
    assert(r.ok, `机器人没盖完: ${r.text}`)
    const wrong = verify(lab, blocks)
    assert(!wrong.length, `服务器核对错 ${wrong.length}/${blocks.length}: ${wrong.slice(0, 4).join(' ')}`)
    return { blocks: blocks.length, ms: r.ms }
  }
}
function circuitCase(name, x, facing, extra = (async () => ({}))) {
  return async (lab) => {
    const a = await lab.arena(x, 0, 16)
    const origin = { x: a.cx, y: 100, z: a.cz - 4 }
    const blocks = BP.place(BP.CIRCUITS[name].blocks(), origin, facing)
    giveFor(lab, blocks)
    await sleep(1000)
    const r = await lab.cmd(`bot circuit ${name} at=${origin.x},${origin.y},${origin.z} f=${facing}`, /搭好并自检通过|这种没有自检/, /自检失败|没开工|没盖完|搭不了/, 180_000)
    assert(r.ok, `电路: ${r.text}`)
    const wrong = verify(lab, blocks.filter((b) => !/piston$/.test(b.name) && b.name !== 'observer' && b.name !== 'repeater'))
    assert(!wrong.length, `服务器核对错: ${wrong.slice(0, 4).join(' ')}`)
    const more = await extra(lab, origin, facing, a)
    return { said: r.text, ...more }
  }
}
// 整个场地宽度的护城河：跳不过就掉水，绝没有绕路走过去的可能（踩过：窄沟被走路绕过，假通过）
function moat(x1, x2, a, r = 40) {
  rcon(`fill ${x1} 90 ${a.cz - r} ${x2} 99 ${a.cz + r} minecraft:air`)
  rcon(`fill ${x1} 90 ${a.cz - r} ${x2} 96 ${a.cz + r} minecraft:water`)
}
const world = (origin, facing, rel) => {
  const n = BP.HORIZONTAL.indexOf(facing)
  let [x, y, z] = rel
  for (let i = 0; i < n; i++) [x, z] = [-z, x]
  return { x: origin.x + x, y: origin.y + y, z: origin.z + z }
}

const scenarios = {
  // ---- 建筑 ----
  '建筑_瞭望塔_朝南_梯子护栏': buildCase('tower', { h: 5 }, 5200, 'south'),
  '建筑_楼梯_朝西': buildCase('stairs', { n: 6 }, 5300, 'west'),
  async '建筑_占位不覆盖_chest在场'(lab) {
    const a = await lab.arena(5400, 0, 16)
    const origin = { x: a.cx, y: 100, z: a.cz - 4 }
    const blocks = BP.place(BP.TEMPLATES.wall.build({ w: 10, h: 3, m: 'cobblestone' }), origin, 'north')
    giveFor(lab, blocks)
    const c = blocks[0]
    lab.setblock(c.x, c.y, c.z, 'minecraft:chest')
    await sleep(1000)
    const r = await lab.cmd(`bot build wall w=10 h=3 m=cobblestone at=${origin.x},100,${origin.z} f=north`, /没开工.*chest/, DONE, 20_000)
    assert(r.ok, `应拒绝: ${r.text}`)
    assert(lab.block(c.x, c.y, c.z, 'minecraft:chest'), '箱子被动了')
    assert(lab.count('minecraft:cobblestone') === BP.materials(blocks).cobblestone + 4, '材料被消耗了')
    return {}
  },
  async '建筑_材料不足拒绝_且不开工'(lab) {
    const a = await lab.arena(5500, 0, 16)
    lab.give('minecraft:cobblestone', 3)
    await sleep(800)
    const r = await lab.cmd(`bot build wall w=10 h=3 m=cobblestone at=${a.cx},100,${a.cz - 4} f=north`, /没开工.*材料不够/, DONE, 15_000)
    assert(r.ok, `应拒绝: ${r.text}`)
    assert(lab.count('minecraft:cobblestone') === 3, '材料被用了')
    return { said: r.text }
  },
  async '建筑_禁用方块_tnt和岩浆'(lab) {
    const a = await lab.arena(5600, 0, 16)
    lab.give('minecraft:tnt', 8)
    await sleep(800)
    const r = await lab.cmd(`bot fill ${a.cx + 3} 100 ${a.cz} ${a.cx + 4} 100 ${a.cz} tnt`, /不放 tnt/, DONE, 10_000)
    assert(r.ok, `应拒绝 tnt: ${r.text}`)
    assert(lab.block(a.cx + 3, 100, a.cz, 'minecraft:air'), 'TNT 被放了')
    const b = await lab.cmd(`bot build wall m=tnt at=${a.cx},100,${a.cz - 3} f=north`, /不放 tnt/, DONE, 10_000)
    assert(b.ok, `模板材料也要拒绝 tnt: ${b.text}`)
    return {}
  },
  async '建筑_中途stop后续建到完成'(lab) {
    const a = await lab.arena(5700, 0, 16)
    const origin = { x: a.cx, y: 100, z: a.cz - 4 }
    const blocks = BP.place(BP.TEMPLATES.wall.build({ w: 12, h: 3 }), origin, 'north')
    giveFor(lab, blocks)
    await sleep(1000)
    const cmd = `bot build wall w=12 h=3 at=${origin.x},100,${origin.z} f=north`
    lab.say(cmd)
    await sleep(3500)
    lab.say('bot stop')
    assert(await lab.waitChat(/停下了/, 8000), 'stop 没回复')
    await sleep(2500)
    const placedAtStop = blocks.length - verify(lab, blocks).length
    assert(placedAtStop > 0 && placedAtStop < blocks.length, `stop 时应只盖了一部分，实际 ${placedAtStop}/${blocks.length}`)
    await sleep(2000)
    assert(blocks.length - verify(lab, blocks).length === placedAtStop, 'stop 后还在盖')
    const r = await lab.cmd(cmd, DONE, FAILED, 180_000)
    assert(r.ok, `续建: ${r.text}`)
    assert(!verify(lab, blocks).length, '续建后不完整')
    return { placedAtStop, total: blocks.length }
  },
  async '建筑_undo只拆自己放的'(lab) {
    const a = await lab.arena(5800, 0, 16)
    const origin = { x: a.cx, y: 100, z: a.cz - 4 }
    const blocks = BP.place(BP.TEMPLATES.wall.build({ w: 6, h: 2 }), origin, 'north')
    giveFor(lab, blocks)
    lab.give('minecraft:iron_pickaxe', 1)
    await sleep(1000)
    const r = await lab.cmd(`bot build wall w=6 h=2 at=${origin.x},100,${origin.z} f=north`, DONE, FAILED, 120_000)
    assert(r.ok, r.text)
    // 玩家后来换了一块：不能被 undo 拆
    const kept = blocks[0]
    lab.setblock(kept.x, kept.y, kept.z, 'minecraft:gold_block')
    const u = await lab.cmd('bot undo', /撤销/, /撤销不了/, 90_000)
    assert(u.ok, u.text)
    assert(lab.block(kept.x, kept.y, kept.z, 'minecraft:gold_block'), '玩家换的方块被拆了')
    const left = blocks.slice(1).filter((b) => !lab.block(b.x, b.y, b.z, 'minecraft:air'))
    assert(!left.length, `还剩 ${left.length} 块没拆`)
    return { said: u.text }
  },
  async '建筑_复制粘贴并旋转'(lab) {
    const a = await lab.arena(5900, 0, 24)
    const o = { x: a.cx - 8, y: 100, z: a.cz - 8 }
    lab.setblock(o.x, 100, o.z, 'minecraft:oak_planks')
    lab.setblock(o.x + 1, 100, o.z, 'minecraft:oak_stairs[facing=east]')
    lab.setblock(o.x, 101, o.z, 'minecraft:cobblestone')
    lab.setblock(o.x, 100, o.z + 1, 'minecraft:chest[facing=south]')
    await sleep(1500)
    rcon(`tp ${NAME} ${o.x + 3.5} 100 ${o.z + 3.5}`)
    await sleep(1000)
    const c = await lab.cmd(`bot copy ${o.x} 100 ${o.z} ${o.x + 1} 101 ${o.z + 1} 样板`, /存了蓝图 样板：4 块/, /复制不了/, 8000)
    assert(c.ok, c.text)
    for (const i of ['oak_planks', 'oak_stairs', 'cobblestone', 'chest']) lab.give(`minecraft:${i}`, 1)
    await sleep(800)
    const at = { x: a.cx + 8, y: 100, z: a.cz + 8 }
    const p = await lab.cmd(`bot paste 样板 at=${at.x},100,${at.z} f=east`, DONE, FAILED, 90_000)
    assert(p.ok, p.text)
    // 原件 z = -2/-1，x = 0/1；朝东旋转 (x,z)->(-z,x)
    assert(lab.block(at.x + 2, 100, at.z, 'minecraft:oak_planks'), '木板位置不对')
    assert(lab.block(at.x + 2, 100, at.z + 1, 'minecraft:oak_stairs[facing=south]'), '楼梯旋转后朝向不对')
    assert(lab.block(at.x + 1, 100, at.z, 'minecraft:chest[facing=west]'), '箱子旋转后朝向不对')
    return {}
  },
  async '建筑_铺路过虚空沟且不掉'(lab) {
    const a = await lab.arena(6000, 0, 20)
    rcon(`fill ${a.cx + 3} 90 ${a.cz - 3} ${a.cx + 12} 99 ${a.cz + 3} minecraft:air`)
    rcon(`tp ${NAME} ${a.cx + 2.5} 100 ${a.cz + 0.5}`)
    lab.give('minecraft:cobblestone', 16)
    await sleep(1500)
    const r = await lab.cmd('bot bridge 12 east', /铺了 \d+ 块、走了 \d+ 格/, /铺不了/, 60_000)
    assert(r.ok, r.text)
    const p = lab.pos()
    assert(p.x >= a.cx + 13, `没过沟 x=${p.x}（${r.text}）`)
    assert(p.y >= 99.9, `掉下去了 y=${p.y}`)
    assert(/铺了 1[0-9] 块/.test(r.text), `铺块数不对: ${r.text}`)
    return { said: r.text }
  },
  async '建筑_铺路遇岩浆停'(lab) {
    const a = await lab.arena(6100, 0, 16)
    rcon(`fill ${a.cx + 4} 99 ${a.cz - 2} ${a.cx + 7} 99 ${a.cz + 2} minecraft:lava`)
    lab.give('minecraft:cobblestone', 16)
    await sleep(1200)
    const r = await lab.cmd('bot bridge 10 east', /铺了 \d+ 块、走了 \d+ 格/, /铺不了/, 30_000)
    assert(r.ok && /岩浆/.test(r.text), `应在岩浆前停: ${r.text}`)
    assert(lab.pos().x < a.cx + 4.5, '走到岩浆上了')
    assert(lab.health() >= 19, `掉血了 ${lab.health()}`)
    return { said: r.text }
  },
  async '建筑_垫高不掉血'(lab) {
    await lab.arena(6200, 0, 16)
    lab.give('minecraft:cobblestone', 16)
    await sleep(800)
    const y0 = lab.pos().y
    const r = await lab.cmd('bot pillar 6', /垫高了 \d+ 格/, /垫不了/, 45_000)
    assert(r.ok, r.text)
    const dy = lab.pos().y - y0
    assert(dy >= 5.5, `只升高 ${dy}（${r.text}）`)
    assert(lab.health() >= 19, `掉血 ${lab.health()}`)
    return { said: r.text }
  },
  // ---- 红石 ----
  '红石_灯_朝北': circuitCase('lamp', 6300, 'north', async (lab, o, f) => {
    // 独立于自检：让机器人按拉杆后问服务器
    const lever = world(o, f, [0, 0, 0]), lamp = world(o, f, [0, 0, -3])
    const r = await lab.cmd(`bot use ${lever.x} ${lever.y} ${lever.z}`, /lever.*现在开/, /按不了|失败/, 10_000)
    assert(r.ok, r.text)
    await sleep(400)
    assert(lab.block(lamp.x, lamp.y, lamp.z, 'minecraft:redstone_lamp[lit=true]'), '服务器看灯没亮')
    return {}
  }),
  '红石_灯_朝东': circuitCase('lamp', 6400, 'east'),
  '红石_非门_朝南': circuitCase('not', 6500, 'south'),
  '红石_或门_朝西': circuitCase('or', 6600, 'west'),
  '红石_与门_朝北': circuitCase('and', 6700, 'north'),
  '红石_记忆单元_朝东': circuitCase('memory', 6800, 'east'),
  '红石_活塞门_朝南': circuitCase('gate', 6900, 'south'),
  '红石_自动铁门_朝北': circuitCase('autodoor', 7000, 'north'),
  '红石_时钟_朝西': circuitCase('clock', 7100, 'west', async (lab, o, f) => {
    const lamp = world(o, f, [5, 0, -1])
    const seen = new Set()
    for (let i = 0; i < 40; i++) { seen.add(lab.block(lamp.x, lamp.y, lamp.z, 'minecraft:redstone_lamp[lit=true]')); if (seen.size === 2) break; await sleep(40) }
    assert(seen.size === 2, '服务器看灯没闪')
    return {}
  }),
  '红石_观察者高速时钟_朝东': circuitCase('fastclock', 7150, 'east'),
  '红石_光感灯': circuitCase('nightlight', 7200, 'north', async (lab, o, f) => {
    const lamp = world(o, f, [0, 0, -2])
    rcon('time set 1000'); await sleep(1500)
    assert(lab.block(lamp.x, lamp.y, lamp.z, 'minecraft:redstone_lamp[lit=false]'), '白天灯不该亮')
    rcon('time set 18000'); await sleep(1500)
    const lit = lab.block(lamp.x, lamp.y, lamp.z, 'minecraft:redstone_lamp[lit=true]')
    rcon('time set 1000')
    assert(lit, '夜里灯没亮')
    return {}
  }),
  '红石_收集箱': circuitCase('dropbox', 7300, 'north', async (lab, o, f) => {
    const hop = world(o, f, [0, 1, -1])
    rcon(`summon minecraft:item ${hop.x + 0.5} ${hop.y + 1.2} ${hop.z + 0.5} {Item:{id:"minecraft:diamond",count:3}}`)
    await sleep(2500)
    const chest = world(o, f, [0, 0, -1])
    const text = rcon(`data get block ${chest.x} ${chest.y} ${chest.z} Items`)
    assert(/diamond/.test(text), `箱子里没有: ${text.slice(0, 120)}`)
    return {}
  }),
  async '红石_长线30格加中继器_信号到头'(lab) {
    const a = await lab.arena(7400, 0, 24)
    const y = 100, x0 = a.cx - 15, x1 = a.cx + 15, z = a.cz + 3
    lab.give('minecraft:redstone', 40); lab.give('minecraft:repeater', 4)
    await sleep(1000)
    const r = await lab.cmd(`bot wire ${x0} ${y} ${z} ${x1} ${y} ${z}`, DONE, FAILED, 180_000)
    assert(r.ok, r.text)
    lab.setblock(x1 + 1, y, z, 'minecraft:redstone_lamp')
    lab.setblock(x0 - 1, y, z, 'minecraft:lever[face=floor,facing=east,powered=false]')
    await sleep(300)
    lab.setblock(x0 - 1, y, z, 'minecraft:lever[face=floor,facing=east,powered=true]')
    await sleep(1500)
    assert(lab.block(x1 + 1, y, z, 'minecraft:redstone_lamp[lit=true]'), '31 格外的灯没亮')
    const t = await lab.cmd(`bot rstrace ${x0} ${y} ${z}`, /走线 \d+ 格.*redstone_lamp/, /$^/, 6000)
    assert(t.ok, `追踪: ${t.text}`)
    return { said: t.text }
  },
  async '红石_排错和状态读取'(lab) {
    const a = await lab.arena(7500, 0, 16)
    const z = a.cz + 3
    lab.setblock(a.cx + 4, 100, z, 'minecraft:redstone_lamp')
    lab.setblock(a.cx + 3, 100, z, 'minecraft:redstone_wire')
    await sleep(1000)
    const d = await lab.cmd(`bot rsdiag ${a.cx + 4} 100 ${z}`, /没有信号送到/, /$^/, 6000)
    assert(d.ok, `排错: ${d.text}`)
    const s = await lab.cmd('bot rs', /红石线1格/, /没有红石元件/, 6000)
    assert(s.ok, `状态: ${s.text}`)
    return { diag: d.text, scan: s.text }
  },
  async '红石_门开关和中继器调档'(lab) {
    const a = await lab.arena(7600, 0, 16)
    lab.setblock(a.cx + 3, 100, a.cz, 'minecraft:oak_door[facing=west,half=lower]')
    lab.setblock(a.cx + 3, 101, a.cz, 'minecraft:oak_door[facing=west,half=upper]')
    lab.setblock(a.cx, 100, a.cz + 3, 'minecraft:repeater[facing=north,delay=1]')
    await sleep(1000)
    const o = await lab.cmd('bot door open', /门开了/, /开不了|没动|没有/, 10_000)
    assert(o.ok, o.text)
    assert(lab.block(a.cx + 3, 100, a.cz, 'minecraft:oak_door[open=true]'), '服务器看门没开')
    const again = await lab.cmd('bot door open', /本来就开着/, /开不了/, 8000)
    assert(again.ok, '开着时不该再按（否则会关上）')
    const c = await lab.cmd('bot door close', /门关了/, /开不了|没动/, 10_000)
    assert(c.ok, c.text)
    const rep = await lab.cmd(`bot repeater ${a.cx} 100 ${a.cz + 3} 3`, /调到延迟 3/, /调不了|没调/, 10_000)
    assert(rep.ok && lab.block(a.cx, 100, a.cz + 3, 'minecraft:repeater[delay=3]'), `中继器: ${rep.text}`)
    return {}
  },
  async '寻路_穿过木门'(lab) {
    const a = await lab.arena(7700, 0, 16)
    rcon(`fill ${a.cx + 4} 100 ${a.cz - 16} ${a.cx + 4} 103 ${a.cz + 16} minecraft:obsidian`)
    lab.setblock(a.cx + 4, 100, a.cz, 'minecraft:oak_door[facing=east,half=lower]')
    lab.setblock(a.cx + 4, 101, a.cz, 'minecraft:oak_door[facing=east,half=upper]')
    await sleep(1200)
    const r = await lab.cmd(`bot goto ${a.cx + 9} 100 ${a.cz}`, /^到了/, /失败/, 40_000)
    assert(r.ok, r.text)
    assert(lab.block(a.cx + 4, 102, a.cz, 'minecraft:obsidian'), '墙被挖了')
    assert(lab.block(a.cx + 4, 100, a.cz, 'minecraft:oak_door') && lab.block(a.cx + 4, 101, a.cz, 'minecraft:oak_door'), '门被砸了')
    return { ms: r.ms }
  },
  // ---- 跑酷 ----
  async '跑酷_连跳赛道_沟1沟2沟3上跳下跳'(lab) {
    const a = await lab.arena(7800, 0, 30, { tester: true })
    const c = a.cx
    moat(c + 2, c + 30, a)
    const plat = (x, y = 99, z = a.cz) => lab.setblock(c + x, y, z, 'minecraft:stone')
    plat(3) // 1 格沟
    plat(6) // 2 格沟
    for (const x of [10, 11, 12]) plat(x) // 3 格沟之前留助跑
    plat(16); plat(17) // 3 格沟；多一格给上跳助跑（单格起跳够不到，物理模拟会拒绝）
    plat(19, 100) // 1 格沟上跳
    plat(22) // 2 格沟下跳
    plat(24, 99, a.cz + 2)
    rcon(`tp ${NAME} ${c + 0.5} 100 ${a.cz + 0.5}`)
    await sleep(2000)
    const goal = { x: c + 24, y: 100, z: a.cz + 2 }
    // 逐段预检：哪一跳算不过一目了然
    const legs = {}
    for (const [name, t] of Object.entries({ 沟1: [3, 100, 0], 沟2: [6, 100, 0], 沟3: [16, 100, 0], 上跳: [19, 101, 0], 下跳: [22, 100, 0], 斜跳: [24, 100, 2] })) {
      const q = await lab.cmd(`bot parkour check ${c + t[0]} ${t[1]} ${a.cz + t[2]}`, /能到/, /没有安全路线/, 15_000)
      legs[name] = q.text
      await sleep(1300)
    }
    const check = { ok: /能到/.test(legs.斜跳), text: JSON.stringify(legs) }
    assert(check.ok, `应能规划: ${check.text}`)
    const r = await lab.cmd(`bot parkour ${goal.x} ${goal.y} ${goal.z}`, /跑酷到了/, /跑酷失败/, 120_000)
    const p = lab.pos()
    assert(r.ok, `失败: ${r.text}，停在 ${JSON.stringify(p)}`)
    assert(Math.floor(p.x) === goal.x && Math.floor(p.z) === goal.z, `服务器坐标没到: ${JSON.stringify(p)}`)
    assert(lab.health() >= 19, `掉血 ${lab.health()}`)
    return { check: check.text, said: r.text, ms: r.ms }
  },
  async '跑酷_跳5次2格沟_成功率'(lab) {
    const a = await lab.arena(7900, 0, 24)
    const c = a.cx
    moat(c + 2, c + 22, a)
    const xs = [1, 4, 7, 10, 13, 16]
    for (const x of xs) lab.setblock(c + x, 99, a.cz, 'minecraft:stone')
    await sleep(1200)
    const results = []
    for (let i = 0; i < 2; i++) {
      rcon(`tp ${NAME} ${c + 1.5} 100 ${a.cz + 0.5}`)
      await sleep(1500)
      const r = await lab.cmd(`bot parkour ${c + 16} 100 ${a.cz}`, /跑酷到了/, /跑酷失败/, 60_000)
      results.push(r.ok)
      await sleep(800)
    }
    assert(results.every(Boolean), `结果: ${results}`)
    return { results }
  },
  async '跑酷_岩浆虚空和4格沟_拒绝'(lab) {
    const a = await lab.arena(8000, 0, 20)
    const c = a.cx
    rcon(`fill ${c + 3} 90 ${a.cz - 20} ${c + 4} 98 ${a.cz + 20} minecraft:lava`)
    rcon(`fill ${c + 3} 99 ${a.cz - 20} ${c + 4} 99 ${a.cz + 20} minecraft:air`)
    rcon(`tp ${NAME} ${c + 1.5} 100 ${a.cz + 0.5}`)
    await sleep(1500)
    const lava = await lab.cmd(`bot parkour check ${c + 6} 100 ${a.cz}`, /没有安全路线/, /能到/, 10_000)
    assert(lava.ok, `岩浆沟应拒绝: ${lava.text}`)
    const risk = await lab.cmd(`bot parkour ${c + 6} 100 ${a.cz} risk`, /跑酷失败/, /跑酷到了/, 15_000)
    assert(risk.ok, `risk 也不跳岩浆: ${risk.text}`)
    assert(lab.pos().x < c + 3, '跳了')
    rcon(`fill ${c + 3} 80 ${a.cz - 20} ${c + 6} 99 ${a.cz + 20} minecraft:air`)
    await sleep(1000)
    const wide = await lab.cmd(`bot parkour check ${c + 7} 100 ${a.cz}`, /没有安全路线/, /能到/, 10_000)
    assert(wide.ok, `4 格沟应拒绝: ${wide.text}`)
    return { lava: lava.text, wide: wide.text }
  },
  async '寻路_goto不从岩浆上跳'(lab) {
    const a = await lab.arena(8400, 0, 20)
    const c = a.cx
    rcon(`fill ${c + 3} 95 ${a.cz - 20} ${c + 4} 98 ${a.cz + 20} minecraft:lava`)
    rcon(`fill ${c + 3} 99 ${a.cz - 20} ${c + 4} 99 ${a.cz + 20} minecraft:air`)
    rcon(`tp ${NAME} ${c + 1.5} 100 ${a.cz + 0.5}`)
    await sleep(1500)
    const hp = lab.health()
    // 沟两头通向平台外的自然地形：绕过去或认输都行，只要不穿过岩浆沟、不掉血
    let crossed = null
    const watch = setInterval(() => { try { const p = lab.pos(); if (p.x > c + 2.7 && p.x < c + 5.3 && Math.abs(p.z - a.cz) <= 20) crossed = p } catch {} }, 250)
    const r = await lab.cmd(`bot goto ${c + 8} 100 ${a.cz}`, /^到了/, /失败/, 60_000)
    clearInterval(watch)
    assert(lab.health() >= hp, `掉血 ${hp}→${lab.health()}`)
    assert(!lab.chatSince(lab.mark).some((t) => /我挂了/.test(t)), '死了')
    assert(!crossed, `从岩浆沟上过去了: ${JSON.stringify(crossed)}`)
    return { said: r.text }
  },
  async '跑酷_低血量拒绝'(lab) {
    const a = await lab.arena(8100, 0, 16)
    rcon(`damage ${NAME} 12 minecraft:generic`)
    await sleep(600)
    const r = await lab.cmd(`bot parkour ${a.cx + 4} 100 ${a.cz}`, /跑酷失败.*血/, /跑酷到了/, 8000)
    assert(r.ok, r.text)
    return { said: r.text }
  },
  async '跑酷_goto走不通时自动跳过去'(lab) {
    // 孤岛上只有斜跳能离开：寻路库没有斜跳，走不通，必须靠 parkour 兜底
    const a = await lab.arena(8200, 0, 16)
    const c = a.cx
    moat(c - 16, c + 16, a, 16)
    lab.setblock(c, 99, a.cz, 'minecraft:stone')
    lab.setblock(c + 2, 99, a.cz + 2, 'minecraft:stone')
    rcon(`tp ${NAME} ${c + 0.5} 100 ${a.cz + 0.5}`)
    await sleep(2000)
    const r = await lab.cmd(`bot goto ${c + 2} 100 ${a.cz + 2}`, /^到了/, /失败/, 60_000)
    assert(r.ok, r.text)
    const p = lab.pos()
    assert(Math.abs(p.x - (c + 2.5)) < 1 && Math.abs(p.z - (a.cz + 2.5)) < 1, `没到: ${JSON.stringify(p)}`)
    assert(lab.chatSince(lab.mark).some((t) => /试试跳过去/.test(t)), '应走跑酷兜底')
    return { said: lab.chatSince(lab.mark).slice(-4), ms: r.ms }
  },
  async '跑酷_stop在途立刻停'(lab) {
    const a = await lab.arena(8300, 0, 30)
    const c = a.cx
    moat(c + 3, c + 26, a)
    for (const x of [5, 8, 11, 14, 17, 20, 23]) lab.setblock(c + x, 99, a.cz, 'minecraft:stone')
    await sleep(1200)
    lab.say(`bot parkour ${c + 23} 100 ${a.cz}`)
    await lab.waitChat(/路线/, 8000)
    await sleep(1500)
    lab.say('bot stop')
    assert(await lab.waitChat(/停下了/, 6000), 'stop 没回复')
    await sleep(1800)
    const p0 = lab.pos()
    await sleep(2500)
    const p1 = lab.pos()
    assert(Math.hypot(p1.x - p0.x, p1.z - p0.z) < 0.3, '停了还在动')
    return { at: p1 }
  },
}

async function main() {
  const lab = createLab({})
  rcon('gamerule spawn_mobs false')
  rcon('kill @e[type=!player]')
  await lab.startBot()
  await lab.startTester()
  await lab.run('new', scenarios, process.argv.slice(2))
  await lab.stop()
  process.exit(0)
}
main().catch((err) => { console.error(err); process.exit(1) })
