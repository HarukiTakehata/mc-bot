// 装备兼容性与长距离步行场景：使用隔离测试世界，判定走服务器侧。
const { createLab, rcon, assert, sleep, NAME, TESTER } = require('./harness')
const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

async function surface(who, x, z) {
  rcon('forceload remove all')
  rcon(`forceload add ${x - 24} ${z - 24} ${x + 24} ${z + 24}`)
  await sleep(4000)
  // 落在海上会失败（只肯落陆地）：往旁边挪着试
  let out
  for (const d of [0, 300, -300, 600, -600]) {
    out = rcon(`spreadplayers ${x + d} ${z} 0 64 false ${who}`)
    if (/Spread/.test(out)) break
  }
  if (!/Spread/.test(out)) throw new Error(`spreadplayers 失败: ${out}`)
  await sleep(2500)
}
const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'pale_oak_log']
const logCount = (lab) => LOGS.reduce((n, l) => n + lab.count(`minecraft:${l}`), 0)
async function gear(lab) {
  rcon(`gamemode creative ${TESTER}`)
  lab.give('minecraft:iron_axe[minecraft:enchantments={"minecraft:efficiency":3,"minecraft:unbreaking":2}]', 1)
  lab.give('minecraft:iron_pickaxe[minecraft:enchantments={"minecraft:efficiency":5}]', 1)
  rcon(`item replace entity ${NAME} armor.head with minecraft:iron_helmet[minecraft:enchantments={"minecraft:aqua_affinity":1,"minecraft:protection":2}]`)
  await sleep(1500)
}

const scenarios = {
  async '附魔斧加头盔_砍树'(lab) {
    const a = await lab.arena(29900, 0)
    // 自行搭建测试树，避免依赖固定世界种子在某个坐标生成树木。
    rcon(`fill ${a.cx + 2} 103 ${a.cz - 2} ${a.cx + 6} 105 ${a.cz + 2} minecraft:oak_leaves[persistent=true]`)
    rcon(`fill ${a.cx + 4} 100 ${a.cz} ${a.cx + 4} 104 ${a.cz} minecraft:oak_log`)
    await gear(lab)
    const item = lab.tester.inventory.items().find((i) => i.name === 'iron_axe')
    const shape = item && JSON.stringify({ enchants: item.enchants }).slice(0, 200)
    const r = await lab.cmd('bot chop 4', /砍树.*(完成|结束)|挖到|已挖|收集|砍了|共|找不到/, /失败|TypeError/, 120_000)
    await lab.idle(60_000)
    const got = logCount(lab)
    assert(got >= 3, `只砍到 ${got}；说: ${lab.chatSince().slice(-5).join(' | ')}`)
    return { got, shape, said: r.text }
  },
  async '附魔镐_效率真的算进挖掘时间'(lab) {
    const a = await lab.arena(30000, 0); await gear(lab)
    lab.setblock(a.cx + 2, 100, a.cz, 'minecraft:obsidian')
    lab.give('minecraft:diamond_pickaxe[minecraft:enchantments={"minecraft:efficiency":5}]', 1)
    await sleep(1000)
    const start = Date.now()
    const r = await lab.cmd('bot mine obsidian 1', /obsidian|黑曜石/, /失败|TypeError/, 40_000)
    await lab.idle(30_000)
    assert(lab.block(a.cx + 2, 100, a.cz, 'minecraft:air'), `黑曜石还在；${r.text}`)
    assert(Date.now() - start < 12_000, `太慢，效率没算上: ${Date.now() - start}ms`)
    return { ms: Date.now() - start }
  },
  async '只戴头盔不拿工具_挖泥土'(lab) {
    const a = await lab.arena(30100, 0, 16, { floor: 'dirt' })
    rcon(`gamemode creative ${TESTER}`)
    rcon(`item replace entity ${NAME} armor.head with minecraft:iron_helmet[minecraft:enchantments={"minecraft:protection":2}]`)
    await sleep(1000)
    await lab.cmd('bot mine dirt 2', /dirt|泥土/, /失败|TypeError/, 30_000)
    await lab.idle(30_000)
    assert(lab.count('minecraft:dirt') >= 1, `没挖到；${lab.chatSince().slice(-4).join(' | ')}`)
    return { dirt: lab.count('minecraft:dirt') }
  },
}
scenarios['走路_目标在崖下不冲出平台'] = async (lab) => {
  const a = await lab.arena(30600, 0, 8)
  const hp = lab.health()
  const r = await lab.cmd(`bot goto ${a.cx + 40} 70 ${a.cz}`, /^到了/, /失败|走不到|到不了|没进展|超时/, 180_000)
  assert(lab.health() >= hp - 6, `摔伤 ${hp}→${lab.health()}；${r.text}`)
  return { said: r.text }
}
scenarios['水下_冰层底下憋气游到开口'] = async (lab) => {
  const a = await lab.arena(30700, 0, 12)
  const c = a.cx
  rcon(`fill ${c - 7} 95 ${a.cz - 1} ${c + 3} 98 ${a.cz + 1} minecraft:water`)
  rcon(`fill ${c + 2} 99 ${a.cz - 1} ${c + 3} 99 ${a.cz + 1} minecraft:air`)
  rcon(`tp ${NAME} ${c - 4.5} 97 ${a.cz + 0.5}`)
  await sleep(26_000)
  const p = lab.pos()
  assert(!lab.chatSince(lab.mark).some((t) => /我挂了/.test(t)), '淹死了')
  assert(lab.health() >= 12, `血太低 ${lab.health()}`)
  assert(p.x > c + 1 && p.y > 97.5, `没游到开口: ${JSON.stringify(p)}`)
  return { p, hp: lab.health() }
}
// 自然地形长路：从几块分散的地表走到另一块，统计是否到达、用时、卡住次数
const ROUTES = [[0, 0, 180, 60], [600, 600, 600, 860], [-900, 300, -1100, 480], [1500, -700, 1320, -900], [-1800, -1800, -1560, -1800], [2600, 1400, 2600, 1150]]
ROUTES.forEach(([x1, z1, x2, z2], i) => {
  scenarios[`走路_自然地形${i + 1}_${x1},${z1}到${x2},${z2}`] = async (lab) => {
    rcon(`gamemode creative ${TESTER}`)
    lab.give('minecraft:cooked_beef', 32) // 长途会饿，没吃的会饿到只剩 1 血
    await surface(TESTER, x2, z2)
    const to = lab.pos(TESTER)
    await surface(NAME, x1, z1)
    rcon(`tp ${TESTER} ${to.x} ${to.y + 2} ${to.z}`) // 目标区保持加载
    const from = lab.pos()
    const mark = lab.log.length
    const start = Date.now()
    const r = await lab.cmd(`bot goto ${Math.floor(to.x)} ${Math.floor(to.y)} ${Math.floor(to.z)}`, /^到了/, /失败|走不到|到不了|没进展|超时/, 600_000)
    const stuck = (lab.log.slice(mark).match(/卡住了/g) || []).length
    const p = lab.pos(), left = hyp(p, to)
    // 目标常落在树冠上（spreadplayers 选的落点），走到贴着树冠也算走到
    assert((r.ok && left < 5) || left < 3, `${r.text}；还差 ${left.toFixed(1)} 格；卡住 ${stuck} 次；从 ${JSON.stringify(from)}`)
    return { ms: Date.now() - start, walked: Math.round(hyp(from, to)), stuck }
  }
})
async function main() {
  const lab = createLab()
  try {
    await lab.startBot(); await lab.startTester()
    await lab.run('gear', scenarios, process.argv.slice(2))
  } finally { await lab.stop() }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
