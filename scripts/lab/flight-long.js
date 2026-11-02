// 长途鞘翅实机测试：自然地形、未生成区块、山、海、没带够、半路取消。判定走服务器侧坐标。
const { createLab, rcon, assert, sleep, NAME, TESTER } = require('./harness')
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const DONE = /已飞抵并落地|已飞行并步行对接到/
const END = /已飞抵并落地|已飞行并步行对接到|已提前落地|未确认安全落地|飞行预检失败|耐久不够|这趟约需|执行失败|失败|超时/

function kit(lab, rockets = 128) {
  rcon(`gamemode creative ${TESTER}`) // 假人不躲不打，共享血量下别连累机器人
  rcon(`item replace entity ${NAME} armor.chest with minecraft:elytra`)
  lab.give('minecraft:firework_rocket', rockets)
  rcon(`effect give ${NAME} minecraft:saturation 3 10 true`)
}
async function surface(lab, x, z) {
  await lab.feed()
  rcon(`gamemode creative ${TESTER}`) // 先切创造再送上天：生存模式摔死会经共享血量连带机器人（实测第一个场景总是莫名死亡）
  rcon(`forceload remove all`)
  rcon(`forceload add ${x - 32} ${z - 32} ${x + 32} ${z + 32}`)
  await sleep(4000)
  const out = rcon(`spreadplayers ${x} ${z} 0 24 false ${NAME}`)
  rcon(`tp ${TESTER} ${x} 200 ${z}`)
  await sleep(4000)
  return out
}
async function trip(lab, cmd, ms) {
  const start = Date.now()
  lab.say(cmd)
  const text = await lab.waitChat(END, ms, start)
  return { text, ms: Date.now() - start }
}
function finish(lab, r, to) {
  const p = lab.pos(), say = lab.chatSince().slice(-8)
  assert(r.text && DONE.test(r.text), `结果: ${r.text}; 位置 ${JSON.stringify(p)}; 说: ${say.join(' | ')}`)
  assert(dist2(p, to) <= 8, `没到: ${JSON.stringify(p)} 目标 ${JSON.stringify(to)}`)
  return { pos: p, ms: r.ms, said: r.text, rocketsLeft: lab.count('minecraft:firework_rocket'), hp: lab.health() }
}

const scenarios = {
  async '长途_自然地形1500格_不给高度'(lab) {
    await surface(lab, 100, 100); kit(lab)
    const to = { x: 1600, z: 100 }
    return finish(lab, await trip(lab, `bot fly ${to.x} ${to.z}`, 300_000), to)
  },
  async '长途_未生成区块6000格'(lab) {
    await surface(lab, -300, 2000); kit(lab, 256)
    const to = { x: -6300, z: 2500 }
    return finish(lab, await trip(lab, `bot fly ${to.x} ${to.z}`, 600_000), to)
  },
  async '越山_60格高墙挡在航线上'(lab) {
    const a = await lab.arena(20000, 0, 60); kit(lab)
    for (let y = 100; y < 164; y += 16) rcon(`fill ${a.cx + 40} ${y} ${a.cz - 60} ${a.cx + 42} ${y + 15} ${a.cz + 60} minecraft:stone`)
    rcon(`tp ${NAME} ${a.cx - 50.5} 100 ${a.cz + 0.5}`)
    await sleep(3000)
    const to = { x: a.cx + 58, z: a.cz }
    return finish(lab, await trip(lab, `bot fly ${to.x} 100 ${to.z}`, 120_000), to)
  },
  async '目标点是水_就近落地再走'(lab) {
    const a = await lab.arena(21000, 0, 60); kit(lab)
    rcon(`fill ${a.cx + 30} 99 ${a.cz - 8} ${a.cx + 46} 99 ${a.cz + 8} minecraft:water`)
    rcon(`tp ${NAME} ${a.cx - 50.5} 100 ${a.cz + 0.5}`)
    await sleep(3000)
    const r = await trip(lab, `bot fly ${a.cx + 38} 100 ${a.cz}`, 120_000)
    const p = lab.pos(), say = lab.chatSince()
    assert(r.text && !/失败/.test(r.text), `结果: ${r.text}`)
    assert(dist2(p, { x: a.cx + 38, z: a.cz }) < 70, `离目标太远: ${JSON.stringify(p)}; ${say.join(' | ')}`)
    return { pos: p, said: r.text, hp: lab.health() }
  },
  async '大海_四周无落点_落水不死'(lab) {
    const a = await lab.arena(22000, 0, 90); kit(lab)
    rcon(`fill ${a.cx - 10} 95 ${a.cz - 90} ${a.cx + 90} 99 ${a.cz + 90} minecraft:water`)
    rcon(`tp ${NAME} ${a.cx - 60.5} 100 ${a.cz + 0.5}`)
    await sleep(3000)
    const r = await trip(lab, `bot fly ${a.cx + 70} ${a.cz}`, 150_000)
    const p = lab.pos()
    assert(r.text, `没结果: ${JSON.stringify(p)}; ${lab.chatSince().join(' | ')}`)
    assert(lab.health() >= 10, `掉血: ${lab.health()}`)
    return { pos: p, said: r.text, hp: lab.health() }
  },
  async '落水_水塘里下令_游上岸再飞'(lab) {
    const a = await lab.arena(28000, 0, 50); kit(lab)
    rcon(`fill ${a.cx - 12} 95 ${a.cz - 12} ${a.cx + 12} 99 ${a.cz + 12} minecraft:water`)
    rcon(`tp ${NAME} ${a.cx + 0.5} 98 ${a.cz + 0.5}`)
    await sleep(3000)
    const to = { x: a.cx + 800, z: a.cz }
    return finish(lab, await trip(lab, `bot fly ${to.x} ${to.z}`, 180_000), to)
  },
  async '落水_大水面离岸很远_游上岸再飞'(lab) {
    // 平台不能太大：fill 上限 32768 格，超了静默不生效，机器人会从半空摔死（实测）
    const a = await lab.arena(29000, 0, 30); kit(lab)
    rcon(`forceload add ${a.cx - 96} ${a.cz - 96} ${a.cx + 96} ${a.cz + 96}`)
    await sleep(2000)
    for (let x = a.cx - 90; x < a.cx + 90; x += 30) {
      rcon(`fill ${x} 94 ${a.cz - 90} ${x + 29} 94 ${a.cz + 90} minecraft:stone`)
      rcon(`fill ${x} 95 ${a.cz - 90} ${x + 29} 99 ${a.cz + 90} minecraft:water`)
    }
    rcon(`tp ${NAME} ${a.cx + 0.5} 98 ${a.cz + 0.5}`)
    await sleep(3000)
    const to = { x: a.cx + 800, z: a.cz }
    return finish(lab, await trip(lab, `bot fly ${to.x} ${to.z}`, 500_000), to)
  },
  async '烟花不够_起飞前拒绝并报数'(lab) {
    await lab.arena(23000, 0, 16); kit(lab, 2)
    const r = await trip(lab, 'bot fly 28000 0', 15_000)
    assert(r.text && /这趟约需 \d+/.test(r.text), `结果: ${r.text}`)
    assert(dist2(lab.pos(), { x: 23000, z: 0 }) < 3, '不该起飞')
    return { said: r.text }
  },
  async '半路stop_高空安全降落'(lab) {
    // 这里只验证喊停后的降落，起飞地点用平台（自然地形能不能找到起飞点由其他场景覆盖）
    await lab.arena(5000, -3000, 30); kit(lab)
    const start = Date.now()
    const ground = lab.pos().y
    lab.say('bot fly 7000 -3000')
    // 可能要先走到开阔地，真飞起来才喊停（只看高度会把走上山坡当成起飞）
    const logAt = lab.log.length
    for (let i = 0; i < 120 && !/\[flight\] \d+ CRUISE/.test(lab.log.slice(logAt)); i++) await sleep(1000)
    await sleep(5000)
    const up = lab.pos()
    assert(/\[flight\] \d+ CRUISE/.test(lab.log.slice(logAt)) && up.y > ground + 10, `没飞起来: ${JSON.stringify(up)}; ${lab.chatSince().join(' | ')}`)
    lab.say('bot stop')
    const text = await lab.waitChat(/已提前落地|未确认安全落地|已飞抵/, 150_000, start)
    assert(text, `没落地: ${JSON.stringify(lab.pos())}; ${lab.chatSince().join(' | ')}`)
    assert(lab.health() >= 10, `掉血: ${lab.health()}`)
    return { stoppedAt: up, pos: lab.pos(), said: text, hp: lab.health() }
  },
  async '耐久见底_换备用鞘翅接着飞'(lab) {
    const a = await lab.arena(24000, 0, 40); kit(lab, 128)
    rcon(`item replace entity ${NAME} armor.chest with minecraft:elytra[damage=270]`)
    lab.give('minecraft:elytra', 1)
    const land = 24000 + 3000
    rcon(`forceload add ${land - 30} -30 ${land + 30} 30`)
    await sleep(2500)
    rcon(`fill ${land - 30} 99 -30 ${land + 30} 99 30 minecraft:stone`)
    rcon(`fill ${land - 30} 100 -30 ${land + 30} 130 30 minecraft:air`)
    const to = { x: land, z: 0 }
    const r = await trip(lab, `bot fly ${to.x} 100 ${to.z}`, 400_000)
    assert(lab.chatSince().some((t) => /换上备用鞘翅/.test(t)), '没换备用鞘翅')
    return { ...finish(lab, r, to), said: lab.chatSince().slice(-6) }
  },
}
async function main() {
  const lab = createLab()
  try {
    await lab.startBot(); await lab.startTester()
    await lab.run('flight', scenarios, process.argv.slice(2))
  } finally { await lab.stop() }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
