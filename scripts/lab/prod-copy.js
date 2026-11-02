// 正式服拷贝上的场景：真实地形、真实位置、现有场景没覆盖的条件。
// 用法：LAB_CONTAINER=<用正式服备份起的实验服> node scripts/lab/prod-copy.js [场景名片段...]
// 只连 harness 固定的本机实验服端口；会改实验服世界、停启实验服容器，绝不能指向正式服。
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { createLab, rcon, assert, sleep, NAME, TESTER, LAB, PORT } = require('./harness')

const ROOT = path.resolve(__dirname, '../..')
// 正式服日志里机器人的落脚点（耕地边上，附近刷掠夺者）
const HOME = { x: 3047, y: 76, z: -1665 }
const FARMLAND = { x: 3041, y: 75, z: -1651 }

// 真实地表：spreadplayers 会落到树冠上（实测：目标 y 比地面高 30~40 格，机器人只能停在树下），踩着树叶原木就换个点
function surface(x, z) {
  rcon(`gamemode survival ${TESTER}`)
  for (let i = 0; i < 16; i++, x += i % 2 ? 23 : 0, z += i % 2 ? 0 : 23) {
    rcon(`forceload add ${x - 8} ${z - 8} ${x + 8} ${z + 8}`)
    rcon(`spreadplayers ${x} ${z} 0 1 false ${TESTER}`)
    const p = posOf(TESTER), bx = Math.floor(p.x), by = Math.floor(p.y) - 1, bz = Math.floor(p.z)
    // spreadplayers 失败时人留在原地，原地坐标当目标会"一步没走就到了"（实测假通过）
    if (Math.hypot(p.x - x, p.z - z) > 4) continue
    const tree = ['#minecraft:leaves', '#minecraft:logs'].some((t) => /passed/i.test(rcon(`execute if block ${bx} ${by} ${bz} ${t}`)))
    if (!tree) return { x: bx, z: bz, y: Math.round(p.y) }
  }
  throw new Error(`${x},${z} 附近找不到不在树上的地面`)
}
function posOf(who) {
  const c = rcon(`data get entity ${who} Pos`).match(/\[([^\]]+)\]/)?.[1].split(',').map((n) => Number(n.trim().replace(/[dDfF]$/, '')))
  return { x: c[0], y: c[1], z: c[2] }
}
// 共享血量：测试员受伤机器人也掉血。不需要它在场时切旁观，聊天照常
const park = (x, y, z) => { rcon(`tp ${TESTER} ${x} ${y} ${z}`); rcon(`gamemode spectator ${TESTER}`) }

// 从正式服日志里机器人的落脚点出发，赶到 (dx, dz) 外的真实地表
async function travel(lab, dx, dz, { rockets = 64, weather = 'clear', timeout = 300_000 } = {}) {
  rcon('forceload remove all')
  const target = surface(HOME.x + dx, HOME.z + dz)
  rcon('forceload remove all')
  rcon(`forceload add ${HOME.x - 16} ${HOME.z - 16} ${HOME.x + 16} ${HOME.z + 16}`)
  rcon(`tp ${NAME} ${HOME.x + 0.5} ${HOME.y} ${HOME.z + 0.5}`)
  park(target.x + 0.5, target.y + 30, target.z + 0.5)
  rcon(`weather ${weather}`)
  lab.give('minecraft:elytra'); lab.give('minecraft:firework_rocket', rockets); lab.give('minecraft:cooked_beef', 16)
  await sleep(3000)
  const r = await lab.cmd(`bot goto ${target.x} ${target.y} ${target.z}`, /到了/, /未到目标/, timeout)
  rcon('weather clear')
  const p = lab.pos()
  const flown = Math.hypot(p.x - HOME.x, p.z - HOME.z)
  assert(flown > Math.hypot(dx, dz) * 0.5, `几乎没离开出发点（${flown.toFixed(0)} 格）；${r.text}`)
  return { ok: r.ok, said: r.text, off: Math.hypot(p.x - target.x, p.z - target.z), dy: +(p.y - target.y).toFixed(1), target, ms: r.ms, rocketsLeft: lab.count('minecraft:firework_rocket') }
}

const scenarios = {
  async '真实地形_站在耕地上垫高'(lab) {
    rcon('forceload remove all'); rcon(`forceload add ${FARMLAND.x - 16} ${FARMLAND.z - 16} ${FARMLAND.x + 16} ${FARMLAND.z + 16}`)
    await sleep(2500)
    rcon(`setblock ${FARMLAND.x} ${FARMLAND.y} ${FARMLAND.z} minecraft:farmland`)
    rcon(`fill ${FARMLAND.x} ${FARMLAND.y + 1} ${FARMLAND.z} ${FARMLAND.x} ${FARMLAND.y + 6} ${FARMLAND.z} minecraft:air`)
    rcon(`tp ${NAME} ${FARMLAND.x + 0.5} ${FARMLAND.y + 1} ${FARMLAND.z + 0.5}`)
    park(HOME.x + 0.5, HOME.y + 3, HOME.z + 0.5)
    lab.give('minecraft:dirt', 16)
    await sleep(2500)
    const r = await lab.cmd('bot pillar 3', /垫高了 \d+ 格/, /垫不了|没有垫脚/, 30_000)
    const p = lab.pos()
    assert(lab.block(FARMLAND.x, FARMLAND.y + 1, FARMLAND.z, 'minecraft:dirt'), `耕地上没放上土；机器人说: ${r.text}`)
    assert(/垫高了 3 格/.test(r.text || '') && p.y >= FARMLAND.y + 3.9, `没垫到 3 格: y=${p.y.toFixed(2)}；${r.text}`)
    return { said: r.text, y: p.y }
  },
  async '土径上垫高'(lab) {
    const a = await lab.arena(6000, 0, 6, { tester: false, floor: 'dirt_path' })
    park(a.cx + 4.5, 101, a.cz + 4.5)
    lab.give('minecraft:dirt', 8)
    await sleep(1500)
    const r = await lab.cmd('bot pillar 2', /垫高了 \d+ 格/, /垫不了|没有垫脚/, 30_000)
    assert(/垫高了 2 格/.test(r.text || '') && lab.block(a.cx, 100, a.cz, 'minecraft:dirt'), `土径上没垫起来: ${r.text}`)
    return { said: r.text }
  },
  async '浅水里垫高_不掉血不卡死'(lab) {
    const a = await lab.arena(6100, 0, 6, { tester: false })
    park(a.cx + 4.5, 101, a.cz + 4.5)
    rcon(`setblock ${a.cx} 100 ${a.cz} minecraft:water`)
    rcon(`tp ${NAME} ${a.cx + 0.5} 100 ${a.cz + 0.5}`)
    lab.give('minecraft:dirt', 8)
    await sleep(2500)
    const before = lab.health()
    const r = await lab.cmd('bot pillar 2', /垫高了 \d+ 格/, /垫不了|没有垫脚/, 30_000)
    assert(!!r.text, '垫高没有回话')
    assert(await lab.idle(15_000), '垫高后没回到空闲')
    assert(lab.health() >= before - 1, `掉血了: ${before} -> ${lab.health()}`)
    return { said: r.text, y: lab.pos().y }
  },
  async '私聊查询_私聊回复_公屏不出现'(lab) {
    await lab.arena(6200, 0, 6)
    const heard = []
    const onChat = (u, text) => { if (u === NAME) heard.push(['chat', text]) }
    const onWhisper = (u, text) => { if (u === NAME) heard.push(['whisper', text]) }
    lab.tester.on('chat', onChat); lab.tester.on('whisper', onWhisper)
    try {
      lab.tester.chat(`/msg ${NAME} pos`)
      lab.tester.chat(`/msg ${NAME} inv`)
      await sleep(5000)
    } finally { lab.tester.off('chat', onChat); lab.tester.off('whisper', onWhisper) }
    assert(heard.some(([via, t]) => via === 'whisper' && /我在/.test(t)), `没收到私聊的坐标: ${JSON.stringify(heard)}`)
    assert(!heard.some(([via]) => via === 'chat'), `公屏出现了回复: ${JSON.stringify(heard)}`)
    return { heard }
  },
  async '背包满时挖矿_说清楚而不是卡住'(lab) {
    const a = await lab.arena(6300, 0, 8, { tester: false })
    park(a.cx + 6.5, 101, a.cz + 6.5)
    lab.give('minecraft:stone_pickaxe')
    await sleep(500)
    for (let i = 0; i < 35; i++) lab.give('minecraft:dirt', 64)
    await sleep(1500)
    const r = await lab.cmd('bot mine stone 3', /挖了|挖到|拿到/, /满|装不下|放不下|没地方|挖不|需要/, 90_000)
    const idle = await lab.idle(30_000)
    assert(!!r.text, '挖矿 90 秒没有任何结果回话')
    assert(idle, '挖矿后没回到空闲')
    return { said: r.text, stoneInBag: lab.count('minecraft:stone'), cobble: lab.count('minecraft:cobblestone') }
  },
  async '真实地形_夜里开怪守点90秒'(lab) {
    rcon('forceload remove all'); rcon(`forceload add ${HOME.x - 32} ${HOME.z - 32} ${HOME.x + 32} ${HOME.z + 32}`)
    await sleep(2500)
    rcon(`tp ${NAME} ${HOME.x + 0.5} ${HOME.y} ${HOME.z + 0.5}`)
    park(HOME.x + 0.5, HOME.y + 20, HOME.z + 0.5)
    lab.give('minecraft:iron_sword'); lab.give('minecraft:shield'); lab.give('minecraft:bow'); lab.give('minecraft:arrow', 32); lab.give('minecraft:cooked_beef', 16)
    lab.give('minecraft:iron_chestplate'); lab.give('minecraft:iron_helmet')
    await sleep(1500)
    await lab.cmd('bot stay', /守着/, /$^/, 10_000)
    rcon('time set 18000'); rcon('gamerule spawn_mobs true')
    for (const m of ['zombie', 'skeleton', 'spider', 'creeper', 'pillager']) rcon(`summon minecraft:${m} ${HOME.x + 10} ${HOME.y + 1} ${HOME.z + 6}`)
    const start = Date.now()
    let minHealth = 20
    while (Date.now() - start < 90_000) { minHealth = Math.min(minHealth, lab.health()); await sleep(2000) }
    rcon('gamerule spawn_mobs false')
    const died = lab.chatSince(start).some((t) => /我挂了/.test(t))
    const p = lab.pos()
    assert(!died, `守点时死了；最低血量 ${minHealth}`)
    assert(Math.hypot(p.x - HOME.x, p.z - HOME.z) < 12, `离开守点太远: ${p.x.toFixed(0)} ${p.z.toFixed(0)}`)
    return { minHealth, left: lab.near('zombie', { cx: HOME.x, cz: HOME.z }) + lab.near('skeleton', { cx: HOME.x, cz: HOME.z }) }
  },
  async '真实位置_鞘翅远行300格'(lab) {
    const r = await travel(lab, 300, 40)
    assert(r.ok && r.off < 8, `没到: 偏差 ${r.off.toFixed(1)} 格；${r.said}`)
    return r
  },
  async '真实位置_鞘翅远行1500格'(lab) {
    const r = await travel(lab, -1500, 200, { timeout: 600_000 })
    assert(r.ok && r.off < 8, `没到: 偏差 ${r.off.toFixed(1)} 格；${r.said}`)
    return r
  },
  async '雷雨天_鞘翅远行300格'(lab) {
    const r = await travel(lab, 40, 300, { weather: 'thunder' })
    assert(r.ok && r.off < 8, `没到: 偏差 ${r.off.toFixed(1)} 格；${r.said}`)
    return r
  },
  // 只有 2 枚烟花：飞不完 600 格。要么步行到达，要么说清楚原因并停在安全的地面上，不能摔死、不能沉默
  async '烟花只有2枚_远行600格'(lab) {
    const r = await travel(lab, 600, 0, { rockets: 2, timeout: 600_000 })
    assert(!!r.said, '远行没有任何结果回话')
    assert(r.ok || /烟花|步行|未到目标/.test(r.said), `结果说不清: ${r.said}`)
    assert(lab.health() > 10, `掉血太多: ${lab.health()}`)
    return r
  },
  async '下界_走到玩家身边'(lab) {
    rcon('forceload remove all')
    rcon(`execute in minecraft:the_nether run forceload add -48 -48 48 48`)
    await sleep(3000)
    for (const who of [NAME, TESTER]) {
      rcon(`effect give ${who} minecraft:fire_resistance 600 0 true`); rcon(`effect give ${who} minecraft:resistance 600 4 true`)
    }
    rcon(`execute in minecraft:the_nether run spreadplayers 0 0 0 4 under 100 false ${TESTER}`)
    rcon(`execute in minecraft:the_nether run spreadplayers 24 24 0 4 under 100 false ${NAME}`)
    await sleep(4000)
    const t = posOf(TESTER)
    const r = await lab.cmd('bot come', /到了/, /未到目标|太远|看不到/, 120_000)
    const p = lab.pos()
    const off = Math.hypot(p.x - t.x, p.z - t.z)
    rcon(`execute in minecraft:the_nether run forceload remove all`)
    assert(r.ok && off < 5, `下界没走到: 偏差 ${off.toFixed(1)}；${r.text}`)
    return { said: r.text, off }
  },
  // 放最后：要停启实验服容器
  async '断服_没进服时退避_恢复后清零'(lab) {
    await lab.stop()
    lab.tester = null
    const retry = path.join(ROOT, 'data', 'reconnect.json')
    fs.rmSync(retry, { force: true })
    spawnSync('docker', ['stop', '-t', '30', LAB], { encoding: 'utf8' })
    const env = { ...process.env, MC_HOST: '127.0.0.1', MC_PORT: String(PORT), MC_NAME: NAME, MC_VERSION: '26.1', DEEPSEEK_API_KEY: '' }
    const runOnce = () => new Promise((resolve) => {
      const started = Date.now()
      let log = ''
      const child = spawn(process.execPath, ['--require', './log-time.js', 'bot.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', (s) => { log += s }); child.stderr.on('data', (s) => { log += s })
      child.on('exit', () => resolve({ log, ms: Date.now() - started }))
    })
    const first = await runOnce()
    const second = await runOnce()
    const saved = JSON.parse(fs.readFileSync(retry, 'utf8'))
    spawnSync('docker', ['start', LAB], { encoding: 'utf8' })
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) { try { rcon('list'); break } catch { await sleep(3000) } }
    await sleep(5000)
    await lab.startBot()
    await lab.startTester()
    await sleep(2000)
    const after = JSON.parse(fs.readFileSync(retry, 'utf8'))
    assert(/连续第 1 次没进服，15 秒后/.test(first.log) && first.ms >= 14_000, `第一次没按 15 秒退避: ${first.ms}ms ${first.log.slice(-300)}`)
    assert(/连续第 2 次没进服，30 秒后/.test(second.log) && second.ms >= 29_000, `第二次没按 30 秒退避: ${second.ms}ms`)
    assert(!/\n\s+at /.test(first.log + second.log), '仍在打印整段堆栈')
    assert(saved.failures === 2 && after.failures === 0, `计数不对: 断服时 ${saved.failures}，恢复后 ${after.failures}`)
    return { firstMs: first.ms, secondMs: second.ms, firstLog: first.log.trim().split('\n') }
  },
}

async function main() {
  const lab = createLab({})
  rcon('gamerule spawn_mobs false')
  await lab.startBot()
  await lab.startTester()
  await lab.run('prod-copy', scenarios, process.argv.slice(2))
  await lab.stop()
  process.exit(0)
}
main().catch((err) => { console.error(err); process.exit(1) })
