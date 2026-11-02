// 生产服同种子世界（没有玩家建筑）：从真实出生点走真实目的地和四周，再在真实地形上砍树。只连实验容器。
const { createLab, rcon, assert, sleep, NAME, TESTER } = require('./harness')
const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const SPAWN = [207, 107]
const ROUTES = [[172, 52], [460, 107], [-60, 107], [207, 370], [207, -160], [20, -80], [400, 300], [20, 300], [800, 107], [207, 720]]

async function surface(who, x, z) {
  rcon('forceload remove all')
  rcon(`forceload add ${x - 24} ${z - 24} ${x + 24} ${z + 24}`)
  await sleep(4000)
  const out = rcon(`spreadplayers ${x} ${z} 0 48 false ${who}`)
  if (!/Spread/.test(out)) throw new Error(`spreadplayers 失败: ${out}`)
  await sleep(2500)
}
const scenarios = {}
ROUTES.forEach(([x, z], i) => {
  scenarios[`真实地形${i + 1}_出生点到${x},${z}`] = async (lab) => {
    rcon(`gamemode creative ${TESTER}`)
    lab.give('minecraft:cooked_beef', 32)
    await surface(TESTER, x, z)
    const to = lab.pos(TESTER)
    await surface(NAME, ...SPAWN)
    rcon(`tp ${TESTER} ${to.x} ${to.y + 2} ${to.z}`)
    const from = lab.pos(), mark = lab.log.length, start = Date.now()
    const r = await lab.cmd(`bot goto ${Math.floor(to.x)} ${Math.floor(to.y)} ${Math.floor(to.z)}`, /^到了/, /失败|走不到|到不了|没进展|超时/, 600_000)
    const stuck = (lab.log.slice(mark).match(/卡住了/g) || []).length
    const p = lab.pos(), left = hyp(p, to)
    // spreadplayers 的落点常在树冠上：脚下是树叶时，贴到 6 格内并如实报“走不到”也算合格
    const canopy = /passed/i.test(rcon(`execute if block ${Math.floor(to.x)} ${Math.floor(to.y) - 1} ${Math.floor(to.z)} #minecraft:leaves`))
    assert((r.ok && left < 5) || left < 3 || (canopy && left < 6), `${r.text}；还差 ${left.toFixed(1)} 格；卡住 ${stuck} 次；从 ${JSON.stringify(from)}；到 ${JSON.stringify(to)}`)
    return { ms: Date.now() - start, walked: Math.round(hyp(from, to)), stuck }
  }
})
scenarios['真实地形_砍树数量和背包一致'] = async (lab) => {
  rcon(`gamemode creative ${TESTER}`)
  await surface(NAME, 172, 60) // 出生点是平原，这里有树
  lab.give('minecraft:iron_axe', 1)
  await sleep(1000)
  const r = await lab.cmd('bot chop 4', /挖完了|找不到/, /失败|TypeError/, 170_000)
  assert(r.ok && /挖了 \d+/.test(r.text), `chop: ${r.text}`)
  await lab.idle(30_000)
  const said = Number(r.text.match(/挖了 (\d+)/)[1])
  const logs = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log'].reduce((n, l) => n + lab.count(`minecraft:${l}`), 0)
  assert(said === logs, `说挖了 ${said}，背包 ${logs}；${rcon(`data get entity ${NAME} Inventory`).slice(0, 300)}`)
  return { said, logs }
}
async function main() {
  const lab = createLab()
  try {
    await lab.startBot(); await lab.startTester()
    await lab.run('prod', scenarios, process.argv.slice(2))
  } finally { await lab.stop() }
  process.exit(0)
}
if (require.main === module) main().catch((err) => { console.error(err); process.exit(1) })
