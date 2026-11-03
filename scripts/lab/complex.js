// 综合测试场景：组合建造、战斗、队友操作与模拟 AI。用法：node scripts/lab/complex.js [场景名片段...]
const { createLab, rcon, assert, sleep, NAME, TESTER } = require('./harness')
const BP = require('../../blueprint')
const CRITICAL = ['facing', 'half', 'type', 'face', 'part', 'delay', 'mode', 'inverted']
const specOf = (b) => {
  const props = CRITICAL.filter((k) => b.props[k] !== undefined).map((k) => `${k}=${b.props[k]}`)
  return `minecraft:${b.name}${props.length ? `[${props.join(',')}]` : ''}`
}
const verify = (lab, blocks) => blocks.filter((b) => !BP.isSecondaryPart(b) && !lab.block(b.x, b.y, b.z, specOf(b))).map((b) => `${specOf(b)}@${b.x},${b.y},${b.z}`)
const giveFor = (lab, blocks, extra = 8) => { for (const [i, n] of Object.entries(BP.materials(blocks))) lab.give(`minecraft:${i}`, n + extra) }
const DONE = /盖好了/, FAILED = /没开工|没盖完|盖不了|失败/

const scenarios = {
  async '综合_建造途中来怪_打完接着盖'(lab) {
    const a = await lab.arena(9000, 0, 24)
    // 测试员不会自卫；共享血量模组可能把它的伤害同步给机器人，因此切换为创造模式。
    rcon(`gamemode creative ${TESTER}`)
    const o = { x: a.cx, y: 100, z: a.cz - 4 }
    const blocks = BP.place(BP.TEMPLATES.wall.build({ w: 10, h: 3, m: 'cobblestone' }), o, 'north')
    giveFor(lab, blocks); lab.give('minecraft:iron_sword', 1); lab.give('minecraft:dirt', 16)
    await sleep(1000)
    const start = Date.now()
    lab.say(`bot build wall w=10 h=3 m=cobblestone at=${o.x},100,${o.z} f=north`)
    await sleep(5000)
    rcon(`summon minecraft:zombie ${a.cx + 8} 100 ${a.cz + 2}`)
    await sleep(6000)
    rcon(`summon minecraft:zombie ${a.cx - 8} 100 ${a.cz - 8}`)
    const text = await lab.waitChat(/盖好了|没盖完|没开工|失败/, 180_000, start)
    assert(text && DONE.test(text), `结果: ${text}`)
    assert(!verify(lab, blocks).length, `错: ${verify(lab, blocks).slice(0, 3)}`)
    // 盖完之后僵尸走到身边也要打掉
    for (let i = 0; i < 12 && lab.near('zombie', a) > 0; i++) await sleep(2000)
    assert(lab.near('zombie', a) === 0, '僵尸还活着')
    return { ms: Date.now() - start, hp: lab.health() }
  },
  async '综合_建造时队友拿走材料_报告而不是卡死'(lab) {
    const a = await lab.arena(9100, 0, 24)
    const o = { x: a.cx, y: 100, z: a.cz - 4 }
    const blocks = BP.place(BP.TEMPLATES.wall.build({ w: 10, h: 3, m: 'cobblestone' }), o, 'north')
    giveFor(lab, blocks, 0)
    await sleep(1000)
    const start = Date.now()
    lab.say(`bot build wall w=10 h=3 m=cobblestone at=${o.x},100,${o.z} f=north`)
    await sleep(4000)
    rcon(`clear ${TESTER} minecraft:cobblestone`)
    const text = await lab.waitChat(/盖好了|没盖完|失败/, 90_000, start)
    assert(text && /没盖完/.test(text), `应报告没盖完: ${text}`)
    assert(await lab.idle(10_000), '之后没空闲')
    // 补料后续建，已经放好的不重放
    giveFor(lab, blocks, 0)
    await sleep(1000)
    const r = await lab.cmd(`bot build wall w=10 h=3 m=cobblestone at=${o.x},100,${o.z} f=north`, DONE, FAILED, 180_000)
    assert(r.ok, `补料续建: ${r.text}`)
    assert(!verify(lab, blocks).length, '续建后不完整')
    return { first: text, ms: r.ms }
  },
  async '综合_玩家站在工地上'(lab) {
    const a = await lab.arena(9200, 0, 24)
    const o = { x: a.cx, y: 100, z: a.cz - 4 }
    const blocks = BP.place(BP.TEMPLATES.wall.build({ w: 6, h: 2 }), o, 'north')
    giveFor(lab, blocks)
    const b = blocks[0]
    rcon(`tp ${TESTER} ${b.x + 0.5} 100 ${b.z + 0.5}`)
    await sleep(1000)
    const start = Date.now()
    lab.say(`bot build wall w=6 h=2 at=${o.x},100,${o.z} f=north`)
    await sleep(9000)
    rcon(`tp ${TESTER} ${a.cx - 20.5} 100 ${a.cz - 20.5}`) // 玩家走开
    const text = await lab.waitChat(/盖好了|没盖完|失败/, 120_000, start)
    assert(text, '没有结论')
    if (!DONE.test(text)) {
      const r = await lab.cmd(`bot build wall w=6 h=2 at=${o.x},100,${o.z} f=north`, DONE, FAILED, 90_000)
      assert(r.ok, `玩家走开后重试: ${r.text}`)
    }
    assert(!verify(lab, blocks).length, '不完整')
    return { first: text }
  },
  async '综合_盖到一半机器人重启_再下指令续建'(lab) {
    const a = await lab.arena(9300, 0, 24)
    const o = { x: a.cx, y: 100, z: a.cz - 4 }
    const blocks = BP.place(BP.TEMPLATES.wall.build({ w: 10, h: 3, m: 'cobblestone' }), o, 'north')
    giveFor(lab, blocks)
    await sleep(1000)
    lab.say(`bot build wall w=10 h=3 m=cobblestone at=${o.x},100,${o.z} f=north`)
    await sleep(6000)
    lab.child.kill('SIGTERM')
    await sleep(4000)
    assert(!lab.child, '没退出')
    await lab.startBot()
    await sleep(2000)
    const r = await lab.cmd(`bot build wall w=10 h=3 m=cobblestone at=${o.x},100,${o.z} f=north`, DONE, FAILED, 180_000)
    assert(r.ok, `续建: ${r.text}`)
    assert(!verify(lab, blocks).length, '不完整')
    return { said: r.text }
  },
  async '综合_红石门控制进屋_自动铁门'(lab) {
    const a = await lab.arena(9500, 0, 24)
    const o = { x: a.cx, y: 100, z: a.cz - 4 }
    const blocks = BP.place(BP.CIRCUITS.autodoor.blocks(), o, 'north')
    giveFor(lab, blocks)
    rcon(`fill ${a.cx - 16} 100 ${o.z - 1} ${a.cx - 1} 102 ${o.z - 1} minecraft:obsidian`)
    rcon(`fill ${a.cx + 1} 100 ${o.z - 1} ${a.cx + 16} 102 ${o.z - 1} minecraft:obsidian`)
    await sleep(1000)
    const r = await lab.cmd(`bot circuit autodoor at=${o.x},100,${o.z} f=north`, /自检通过/, /自检失败|没开工|没盖完/, 60_000)
    assert(r.ok, r.text)
    return { said: r.text }
  },
  async '综合_跟随玩家时听到指令盖东西_盖完不再跟'(lab) {
    const a = await lab.arena(9600, 0, 24)
    rcon(`tp ${TESTER} ${a.cx + 6.5} 100 ${a.cz + 6.5}`)
    lab.give('minecraft:cobblestone', 8)
    await sleep(1200)
    assert((await lab.cmd('bot follow 3', /跟着/, /看不到/, 6000)).ok, 'follow')
    await sleep(2000)
    const r = await lab.cmd(`bot build wall w=4 h=1 at=${a.cx},100,${a.cz - 6} f=north`, DONE, FAILED, 60_000)
    assert(r.ok, r.text)
    const p0 = lab.pos()
    rcon(`tp ${TESTER} ${a.cx - 12.5} 100 ${a.cz + 12.5}`)
    await sleep(3000)
    assert(Math.hypot(lab.pos().x - p0.x, lab.pos().z - p0.z) < 1, '盖完还在跟随（应已取消）')
    return {}
  },
  async '综合_开怪夜晚站岗一分钟'(lab) {
    const a = await lab.arena(9700, 0, 24)
    lab.give('minecraft:iron_sword', 1); lab.give('minecraft:shield', 1); lab.give('minecraft:cooked_beef', 16)
    // 用围墙限制怪物活动范围；测试员切换为创造模式，避免共享血量干扰机器人战斗判定。
    rcon(`gamemode creative ${TESTER}`)
    const w = (x1, z1, x2, z2) => rcon(`fill ${x1} 100 ${z1} ${x2} 104 ${z2} minecraft:stone`)
    w(a.cx - 24, a.cz - 24, a.cx + 24, a.cz - 24); w(a.cx - 24, a.cz + 24, a.cx + 24, a.cz + 24); w(a.cx - 24, a.cz - 24, a.cx - 24, a.cz + 24); w(a.cx + 24, a.cz - 24, a.cx + 24, a.cz + 24)
    rcon(`tp ${TESTER} ${a.cx + 3.5} 100 ${a.cz + 0.5}`)
    rcon('time set 18000')
    await sleep(800)
    assert((await lab.cmd('bot stay', /守着/, /$^/, 5000)).ok, 'stay')
    const types = ['zombie', 'skeleton', 'spider', 'zombie', 'creeper', 'zombie']
    for (const t of types) {
      const ang = Math.random() * 6.28
      rcon(`summon minecraft:${t} ${a.cx + Math.cos(ang) * 12} 100 ${a.cz + Math.sin(ang) * 12}`)
      await sleep(9000)
    }
    await sleep(12_000)
    const left = ['zombie', 'skeleton', 'spider', 'creeper'].map((t) => lab.near(t, a)).reduce((x, y) => x + y)
    rcon('time set 1000')
    assert(left <= 1, `还有 ${left} 只怪`)
    return { left, hp: lab.health(), said: lab.chatSince().slice(-3) }
  },
  // ---- AI 链路（假模型）----
  async 'AI_砌墙材料够_真实执行'(lab) {
    const a = await lab.arena(9800, 0, 24)
    const o = { x: a.cx, y: 100, z: a.cz - 4 }
    const blocks = BP.place(BP.TEMPLATES.wall.build({ w: 10, h: 3, m: 'cobblestone' }), o, 'north')
    giveFor(lab, blocks)
    await sleep(1000)
    const r = await lab.cmd(`bot 砌堵墙 ${o.x},100,${o.z}`, DONE, FAILED, 180_000)
    assert(r.ok, r.text)
    assert(!verify(lab, blocks).length, '不完整')
    return {}
  },
  async 'AI_不许用稀有材料和红线指令'(lab) {
    await sleep(61_000) // AI 全局每分钟 6 次：等额度窗口过去
    const a = await lab.arena(9900, 0, 24)
    lab.give('minecraft:diamond_block', 4); lab.give('minecraft:tnt', 2); lab.give('minecraft:stone', 64)
    await sleep(800)
    const start = Date.now()
    lab.say(`bot 钻石墙 ${a.cx},100,${a.cz - 3}`)
    const t1 = await lab.waitChat(/稀有|没能完成|格式不正确|做不了/, 15_000, start)
    assert(t1, '钻石没被拒绝')
    assert(lab.count('minecraft:diamond_block') === 4, '钻石被用了')
    await sleep(1500)
    const s2 = Date.now()
    lab.say('bot 填大的')
    assert(await lab.waitChat(/没能完成|格式不正确|做不了|256/, 15_000, s2), '大范围 fill 没被拒绝')
    await sleep(1500)
    const s3 = Date.now()
    lab.say('bot 炸掉')
    assert(await lab.waitChat(/不放 tnt|没能完成|格式不正确|做不了/, 15_000, s3), 'TNT 没被拒绝')
    assert(lab.count('minecraft:tnt') === 2, 'TNT 被用了')
    await sleep(61_000) // 校验重试也计入额度：等窗口过去，免得这里测到的是额度而不是拒绝
    const s4 = Date.now()
    lab.say(`bot 冒险跳 ${a.cx + 5} 100 ${a.cz}`)
    assert(await lab.waitChat(/没能完成|格式不正确|做不了/, 15_000, s4), 'AI 不该能选 risk')
    return { said: lab.chatSince().slice(-6) }
  },
  async 'AI_额度用完要回话'(lab) {
    await sleep(61_000)
    await lab.arena(10100, 0, 16)
    const start = Date.now()
    for (let i = 0; i < 7; i++) { lab.say('bot 闲聊'); await sleep(1400) }
    assert(await lab.waitChat(/额度暂时用完/, 8000, start), '额度用完没有提示')
    return {}
  },
  async 'AI_搭灯并通过自检'(lab) {
    await sleep(61_000)
    const a = await lab.arena(10000, 0, 24)
    const o = { x: a.cx, y: 100, z: a.cz - 4 }
    giveFor(lab, BP.place(BP.CIRCUITS.lamp.blocks(), o, 'north'))
    await sleep(1000)
    const r = await lab.cmd(`bot 搭灯 ${o.x},100,${o.z}`, /搭好并自检通过/, /自检失败|没开工|没盖完/, 60_000)
    assert(r.ok, r.text)
    return {}
  },
}

async function main() {
  const lab = createLab({ fakeAI: true })
  rcon('gamerule spawn_mobs false')
  rcon('kill @e[type=!player]')
  await lab.startBot()
  await lab.startTester()
  await lab.run('complex', scenarios, process.argv.slice(2))
  await lab.stop()
  process.exit(0)
}
main().catch((err) => { console.error(err); process.exit(1) })
