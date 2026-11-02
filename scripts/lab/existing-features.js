// 已有功能的实机复杂场景。用法：node scripts/lab/existing-features.js [场景名片段...]
const { createLab, rcon, assert, sleep, NAME, TESTER } = require('./harness')

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const FAIL = /失败|做不了|拿不到|找不到|不认识|没有|挖不动|需要/

const scenarios = {
  // ---- 生存链：自然地形，空背包 ----
  async '自然地形_空手到石镐'(lab) {
    rcon('forceload remove all'); rcon(`spreadplayers 0 0 0 30 false ${NAME}`); rcon(`spreadplayers 0 0 0 30 false ${TESTER}`)
    await sleep(4000)
    const r = await lab.cmd('bot get stone_pickaxe', /拿到了 1 个 stone_pickaxe/, /拿不到|试了 3 轮|重新规划还是/, 240_000)
    assert(lab.count('minecraft:stone_pickaxe') >= 1, `服务器背包里没有石镐；机器人说: ${r.text}`)
    return { ms: r.ms, said: r.text }
  },
  async '自然地形_空手到铁镐'(lab) {
    rcon('forceload remove all'); rcon(`spreadplayers 0 0 0 30 false ${NAME}`); rcon(`spreadplayers 0 0 0 30 false ${TESTER}`)
    await sleep(4000)
    const r = await lab.cmd('bot get iron_pickaxe', /拿到了 1 个 iron_pickaxe/, /拿不到|试了 3 轮|重新规划还是/, 540_000)
    const have = lab.count('minecraft:iron_pickaxe')
    assert(have >= 1, `服务器背包里没有铁镐；机器人说: ${r.text}`)
    return { ms: r.ms, said: r.text }
  },
  async '合成链_有原料时的递归与熔炉'(lab) {
    await lab.arena(2000, 0)
    lab.give('minecraft:oak_log', 8); lab.give('minecraft:cobblestone', 16); lab.give('minecraft:raw_iron', 3); lab.give('minecraft:coal', 2)
    await sleep(800)
    const r1 = await lab.cmd('bot get iron_ingot 3', /拿到了 3 个 iron_ingot/, /拿不到|试了 3 轮|背包里已经有/, 90_000)
    assert(r1.ok && lab.count('minecraft:iron_ingot') >= 3, `铁锭: ${r1.text}`)
    const r2 = await lab.cmd('bot craft bucket', /做好了 bucket/, /做不了/, 30_000)
    assert(r2.ok && lab.count('minecraft:bucket') >= 1, `桶: ${r2.text}`)
    return { ingot: r1.ms, bucket: r2.ms }
  },
  // ---- 容器 ----
  async '箱子_查看取出存入杂物'(lab) {
    const a = await lab.arena(2100, 0)
    lab.setblock(a.cx + 2, 100, a.cz, 'minecraft:chest')
    rcon(`item replace block ${a.cx + 2} 100 ${a.cz} container.0 with minecraft:iron_ingot 7`)
    lab.give('minecraft:cobblestone', 12); lab.give('minecraft:dirt', 5); lab.give('minecraft:diamond', 1)
    await sleep(800)
    const see = await lab.cmd('bot chest', /箱子里: .*iron_ingotx7/, /没有|打不开/, 20_000)
    assert(see.ok, `chest: ${see.text}`)
    const wd = await lab.cmd('bot withdraw iron_ingot 3', /拿出来 3 个/, /没有/, 20_000)
    assert(wd.ok && lab.count('minecraft:iron_ingot') === 3, `取: ${wd.text} 实有 ${lab.count('minecraft:iron_ingot')}`)
    const dp = await lab.cmd('bot deposit iron_ingot', /放进去 3 个/, /没有/, 20_000)
    assert(dp.ok && lab.count('minecraft:iron_ingot') === 0, `存: ${dp.text}`)
    // 箱子记忆：走远了还记得，fetch 走回来拿；箱子被清空后不瞎报
    rcon(`tp ${NAME} ${a.cx - 10.5} 100 ${a.cz + 0.5}`); await sleep(1200)
    const q = await lab.cmd('bot chests iron_ingot', /iron_ingot 上次看到在/, /没有/, 8000)
    assert(q.ok, `chests: ${q.text}`)
    const fe = await lab.cmd('bot fetch iron_ingot 2', /从箱子拿到 2 个/, /找不到|还差/, 40_000)
    assert(fe.ok && lab.count('minecraft:iron_ingot') === 2, `fetch: ${fe.text} 实有 ${lab.count('minecraft:iron_ingot')}`)
    rcon(`data merge block ${a.cx + 2} 100 ${a.cz} {Items:[]}`); await sleep(300)
    const gone = await lab.cmd('bot fetch iron_ingot 2', /找不到 iron_ingot 了/, /从箱子拿到/, 20_000)
    assert(gone.ok && lab.count('minecraft:iron_ingot') === 2, `过期记忆: ${gone.text}`)
    rcon(`clear ${TESTER} minecraft:iron_ingot`); await sleep(500)
    const du = await lab.cmd('bot dump', /存了杂物/, /箱子满|没有/, 20_000)
    // 共享背包模组同步有延迟：机器人说完立刻读服务器会读到旧背包（正式服拷贝上偶发）
    let settled = false
    for (let i = 0; i < 10 && !settled; i++) { settled = lab.count('minecraft:cobblestone') === 0 && lab.count('minecraft:diamond') === 1; if (!settled) await sleep(300) }
    assert(du.ok && settled, `杂物: ${du.text}；圆石 ${lab.count('minecraft:cobblestone')} 钻石 ${lab.count('minecraft:diamond')}`)
    return {}
  },
  // ---- 农牧 ----
  async '种田_成熟作物收割补种且不踩田'(lab) {
    const a = await lab.arena(2200, 0)
    rcon(`fill ${a.cx + 2} 99 ${a.cz - 1} ${a.cx + 4} 99 ${a.cz + 1} minecraft:farmland[moisture=7]`)
    lab.setblock(a.cx + 3, 99, a.cz, 'minecraft:water')
    for (const [x, z] of [[2, -1], [3, -1], [4, -1], [2, 0], [4, 0], [2, 1], [3, 1], [4, 1]]) lab.setblock(a.cx + x, 100, a.cz + z, 'minecraft:wheat[age=7]')
    await sleep(800)
    const r = await lab.cmd('bot farm 8', /收了 \d+ 株/, /没有成熟/, 120_000)
    assert(r.ok, `farm: ${r.text}`)
    const harvested = Number(r.text.match(/收了 (\d+)/)[1]), replanted = Number(r.text.match(/种下 (\d+)/)[1])
    let farmland = 0
    for (const [x, z] of [[2, -1], [3, -1], [4, -1], [2, 0], [4, 0], [2, 1], [3, 1], [4, 1]]) if (lab.block(a.cx + x, 99, a.cz + z, 'minecraft:farmland')) farmland++
    assert(harvested === 8, `应收 8 株，收了 ${harvested}`)
    assert(farmland === 8, `耕地被踩坏，还剩 ${farmland}/8`)
    assert(lab.count('minecraft:wheat') >= 6, `小麦入包不足: ${lab.count('minecraft:wheat')}`)
    assert(replanted >= 6, `补种不足: ${replanted}`)
    return { harvested, replanted, wheat: lab.count('minecraft:wheat') }
  },
  async '畜牧_繁殖剪毛挤奶打猎'(lab) {
    const a = await lab.arena(2300, 0)
    for (let i = 0; i < 2; i++) rcon(`summon minecraft:cow ${a.cx + 5} 100 ${a.cz + i * 2}`)
    for (let i = 0; i < 2; i++) rcon(`summon minecraft:sheep ${a.cx - 5} 100 ${a.cz + i * 2}`)
    rcon(`summon minecraft:pig ${a.cx} 100 ${a.cz + 6}`)
    lab.give('minecraft:wheat', 4); lab.give('minecraft:shears', 1); lab.give('minecraft:bucket', 1); lab.give('minecraft:iron_sword', 1)
    await sleep(1500)
    const breed = await lab.cmd('bot breed cow', /喂了两只/, /不到 2 只|需要|只喂到/, 45_000)
    assert(breed.ok, `breed: ${breed.text}`)
    await sleep(6000)
    const cows = lab.near('cow', a)
    assert(cows >= 3, `牛应繁殖到 3 只，实际 ${cows}`)
    const shear = await lab.cmd('bot shear', /剪了 \d+ 只羊/, /没有/, 45_000)
    assert(shear.ok, `shear: ${shear.text}`)
    const wool = rcon(`clear ${NAME} #minecraft:wool 0`)
    const shorn = rcon(`execute positioned ${a.cx} 100 ${a.cz} if entity @e[type=sheep,distance=..32,nbt={Sheared:1b}]`)
    assert(/Found [1-9]/.test(wool), `羊毛没入包。服务器: ${wool}；被剪的羊: ${shorn}`)
    const milk = await lab.cmd('bot milk', /挤到一桶牛奶/, /没有|没挤到/, 30_000)
    assert(milk.ok && lab.count('minecraft:milk_bucket') === 1, `milk: ${milk.text}`)
    const hunt = await lab.cmd('bot hunt pig 1', /打了 1 只 pig/, /没有/, 45_000)
    assert(hunt.ok, `hunt: ${hunt.text}`)
    return {}
  },
  async '钓鱼_真实咬钩'(lab) {
    const a = await lab.arena(2400, 0)
    rcon(`fill ${a.cx + 2} 95 ${a.cz - 3} ${a.cx + 8} 99 ${a.cz + 3} minecraft:water`)
    lab.give('minecraft:fishing_rod', 1)
    await sleep(800)
    const r = await lab.cmd('bot fish 1', /钓到 1 次/, /一条都没|没有|浮漂没/, 90_000)
    assert(r.ok, `fish: ${r.text}`)
    return { said: r.text, pufferOrCod: ['cod', 'salmon', 'tropical_fish', 'pufferfish'].map((n) => lab.count(`minecraft:${n}`)) }
  },
  // ---- 挖掘安全 ----
  async '隧道_遇岩浆必须停且不死'(lab) {
    const a = await lab.arena(2500, 0, 16)
    rcon(`fill ${a.cx + 1} 100 ${a.cz - 1} ${a.cx + 12} 104 ${a.cz + 1} minecraft:stone`)
    lab.setblock(a.cx + 8, 100, a.cz, 'minecraft:lava')
    lab.give('minecraft:iron_pickaxe', 1)
    await sleep(800)
    const hp = lab.health()
    const r = await lab.cmd('bot tunnel 12 east', /挖了 \d+ 格隧道/, /$^/, 90_000)
    assert(r.text, '没有结果')
    const dug = Number(r.text.match(/挖了 (\d+)/)[1])
    assert(/岩浆/.test(r.text), `应报岩浆: ${r.text}`)
    assert(dug <= 6, `挖太近岩浆了: ${dug}`)
    assert(lab.health() >= hp, '掉血了')
    assert(lab.block(a.cx + 8, 100, a.cz, 'minecraft:lava'), '岩浆还应在原位')
    return { dug }
  },
  async '向下挖_空洞前停下'(lab) {
    const a = await lab.arena(2600, 0)
    rcon(`fill ${a.cx - 1} 92 ${a.cz - 1} ${a.cx + 1} 95 ${a.cz + 1} minecraft:air`)
    lab.give('minecraft:iron_pickaxe', 1)
    await sleep(800)
    const hp = lab.health()
    const r = await lab.cmd('bot digdown 10', /往下挖了 \d+ 格/, /$^/, 60_000)
    assert(r.text && /空洞/.test(r.text), `应在空洞前停: ${r.text}`)
    const p = lab.pos()
    assert(p.y >= 96, `掉进洞了 y=${p.y}`)
    assert(lab.health() >= hp, '掉血了')
    return { y: p.y }
  },
  async '模组方块_挖矿寻路都不破坏'(lab) {
    const a = await lab.arena(2700, 0)
    const spec = 'refinedstorage:controller'
    lab.setblock(a.cx + 4, 100, a.cz, spec)
    lab.setblock(a.cx + 6, 100, a.cz, 'minecraft:coal_ore')
    rcon(`fill ${a.cx + 5} 100 ${a.cz - 3} ${a.cx + 5} 102 ${a.cz + 3} refinedstorage:controller`)
    lab.give('minecraft:iron_pickaxe', 1)
    await sleep(1200)
    const r = await lab.cmd('bot mine coal_ore 1', /挖完了/, /找不到|需要/, 60_000)
    assert(lab.block(a.cx + 4, 100, a.cz, spec), '模组方块被破坏')
    let wall = 0
    for (let z = -3; z <= 3; z++) for (let y = 100; y <= 102; y++) if (lab.block(a.cx + 5, y, a.cz + z, spec)) wall++
    assert(wall === 21, `模组墙被破坏，剩 ${wall}/21`)
    return { said: r.text }
  },
  // ---- 导航 ----
  async '导航_跨水沟绕墙到坐标'(lab) {
    const a = await lab.arena(2800, 0, 24)
    rcon(`fill ${a.cx + 5} 95 ${a.cz - 24} ${a.cx + 7} 99 ${a.cz + 24} minecraft:water`)
    rcon(`fill ${a.cx + 12} 100 ${a.cz - 20} ${a.cx + 12} 103 ${a.cz + 20} minecraft:stone`)
    const r = await lab.cmd(`bot goto ${a.cx + 20} 100 ${a.cz}`, /^到了/, /失败|超时/, 120_000)
    const p = lab.pos()
    assert(dist(p, { x: a.cx + 20.5, y: 100, z: a.cz + 0.5 }) < 3, `没到: ${JSON.stringify(p)} ${r.text}`)
    return { ms: r.ms, said: r.text }
  },
  async '导航_不可达目标要及时认输'(lab) {
    const a = await lab.arena(2900, 0, 20)
    rcon(`fill ${a.cx + 10} 100 ${a.cz + 0} ${a.cx + 14} 104 ${a.cz + 4} minecraft:obsidian`)
    rcon(`fill ${a.cx + 11} 101 ${a.cz + 1} ${a.cx + 13} 103 ${a.cz + 3} minecraft:air`)
    const start = Date.now()
    lab.say(`bot goto ${a.cx + 12} 101 ${a.cz + 2}`)
    const text = await lab.waitChat(/失败|到了|卡住|超时|No path|已停止/, 200_000, start)
    assert(text, '3 分钟多没有任何结论')
    const said = !/^到了/.test(text)
    assert(said, `明明进不去却说到了: ${text}`)
    assert(lab.block(a.cx + 10, 102, a.cz + 2, 'minecraft:obsidian'), '黑曜石墙被破坏')
    return { ms: Date.now() - start, said: text }
  },
  async '跟随_带距离并在停止后不再动'(lab) {
    const a = await lab.arena(3000, 0, 24)
    const r = await lab.cmd('bot follow 3', /跟着 Tester/, /看不到/, 8000)
    assert(r.ok, r.text)
    rcon(`tp ${TESTER} ${a.cx + 18.5} 100 ${a.cz + 0.5}`)
    await sleep(9000)
    const p = lab.pos()
    assert(dist(p, lab.pos(TESTER)) < 6, `没跟上: ${dist(p, lab.pos(TESTER)).toFixed(1)}`)
    lab.say('bot stop')
    await sleep(800)
    const p0 = lab.pos()
    rcon(`tp ${TESTER} ${a.cx - 10.5} 100 ${a.cz + 0.5}`)
    await sleep(3000)
    assert(dist(lab.pos(), p0) < 0.8, 'stop 后还在动')
    return {}
  },
  // ---- 打断与排队 ----
  async '打断_挖矿中stop立刻生效且可接新任务'(lab) {
    const a = await lab.arena(3100, 0)
    rcon(`fill ${a.cx + 3} 100 ${a.cz - 3} ${a.cx + 8} 103 ${a.cz + 3} minecraft:obsidian`)
    lab.give('minecraft:diamond_pickaxe', 1)
    await sleep(800)
    lab.say('bot mine obsidian 10')
    await sleep(7000)
    const start = Date.now()
    lab.say('bot stop')
    const s = await lab.waitChat(/停下了/, 8000, start)
    assert(s, 'stop 没回复')
    assert(await lab.idle(10_000), 'stop 后 10 秒仍未空闲')
    const next = await lab.cmd('bot pos', /我在/, /$^/, 5000)
    assert(next.ok, '之后不响应')
    const r = await lab.cmd(`bot goto ${a.cx - 5} 100 ${a.cz}`, /^到了/, /失败/, 30_000)
    assert(r.ok, `stop 后新任务失败: ${r.text}`)
    return { stopMs: Date.now() - start }
  },
  async '排队_忙时指令按序执行stop清空'(lab) {
    const a = await lab.arena(3200, 0)
    rcon(`fill ${a.cx + 3} 100 ${a.cz - 3} ${a.cx + 8} 103 ${a.cz + 3} minecraft:obsidian`)
    lab.give('minecraft:diamond_pickaxe', 1)
    await sleep(800)
    lab.say('bot mine obsidian 1'); await sleep(1500)
    lab.say(`bot goto ${a.cx - 3} 100 ${a.cz}`); await sleep(400)
    lab.say(`bot goto ${a.cx - 6} 100 ${a.cz}`)
    const q = await lab.waitChat(/排第 2 个/, 8000)
    assert(q, '没有排队提示')
    const done = await lab.waitChat(/^到了/, 90_000)
    assert(done, '排队指令没执行')
    await sleep(6000)
    const p = lab.pos()
    assert(Math.abs(p.x - (a.cx - 6)) < 2.5, `排队第二条没执行到位: ${JSON.stringify(p)}`)
    return {}
  },
  // ---- 战斗（共享血量）----
  async '战斗_僵尸近战并回到原位'(lab) {
    const a = await lab.arena(3300, 0)
    lab.give('minecraft:iron_sword', 1)
    await sleep(800)
    rcon(`summon minecraft:zombie ${a.cx + 4} 100 ${a.cz}`)
    await sleep(15_000)
    assert(lab.near('zombie', a) === 0, '15 秒还没打死僵尸')
    await sleep(3000)
    const p = lab.pos()
    assert(dist(p, { x: a.cx + 0.5, y: 100, z: a.cz + 0.5 }) < 3.5, `没回原位: ${JSON.stringify(p)}`)
    assert(lab.health() > 10, `掉血过多: ${lab.health()}`)
    return { hp: lab.health() }
  },
  async '战斗_苦力怕不让它在身边炸'(lab) {
    const a = await lab.arena(3400, 0)
    lab.give('minecraft:iron_sword', 1)
    await sleep(800)
    const hp = lab.health()
    rcon(`summon minecraft:creeper ${a.cx + 6} 100 ${a.cz}`)
    await sleep(18_000)
    const craters = !lab.block(a.cx + 1, 99, a.cz, 'minecraft:stone') || !lab.block(a.cx, 99, a.cz, 'minecraft:stone')
    const hpAfter = lab.health()
    assert(!craters, '苦力怕在机器人脚边炸了')
    assert(hpAfter >= hp - 6, `被炸掉血太多: ${hp} → ${hpAfter}`)
    return { hpBefore: hp, hpAfter, creepers: lab.near('creeper', a), craterAtStart: craters }
  },
  async '战斗_骷髅持盾接近并击杀'(lab) {
    const a = await lab.arena(3500, 0, 24)
    lab.give('minecraft:iron_sword', 1); lab.give('minecraft:shield', 1)
    await sleep(800)
    rcon(`summon minecraft:skeleton ${a.cx + 11} 100 ${a.cz}`)
    await sleep(25_000)
    assert(lab.near('skeleton', a) === 0, '25 秒还没打死骷髅')
    return { hp: lab.health() }
  },
  async '战斗_保护附近队友'(lab) {
    const a = await lab.arena(3600, 0, 24)
    lab.give('minecraft:iron_sword', 1)
    await sleep(800)
    rcon(`tp ${TESTER} ${a.cx + 10.5} 100 ${a.cz + 0.5}`)
    rcon(`summon minecraft:zombie ${a.cx + 13} 100 ${a.cz}`)
    await sleep(18_000)
    assert(lab.near('zombie', a) === 0, '没有帮队友打僵尸')
    return { hp: lab.health() }
  },
  async '战斗_低血撤退并吃东西'(lab) {
    const a = await lab.arena(3700, 0, 24)
    lab.give('minecraft:iron_sword', 1); lab.give('minecraft:cooked_beef', 8)
    await sleep(800)
    rcon(`damage ${NAME} 14 minecraft:generic`)
    await sleep(600)
    rcon(`summon minecraft:zombie ${a.cx + 4} 100 ${a.cz}`)
    const p0 = lab.pos()
    // 看撤退途中跑得最远的距离：吃完回血后它会走回来，只看最后一刻会误判
    let moved = 0
    for (let i = 0; i < 16; i++) { await sleep(500); moved = Math.max(moved, dist(lab.pos(), p0)) }
    assert(moved > 4 && moved < 80, `血少时应撤退且活着: 移动 ${moved.toFixed(1)}`)
    return { moved, hp: lab.health(), beefLeft: lab.count('minecraft:cooked_beef') }
  },
  // ---- 睡觉 ----
  async '睡觉_夜晚上床并跳过夜晚'(lab) {
    const a = await lab.arena(3800, 0)
    rcon('time set 18000')
    lab.setblock(a.cx + 4, 100, a.cz, 'minecraft:white_bed[part=foot,facing=east]')
    lab.setblock(a.cx + 5, 100, a.cz, 'minecraft:white_bed[part=head,facing=east]')
    await sleep(800)
    const r = await lab.cmd('bot sleep', /晚安/, /失败|没有床/, 30_000)
    assert(r.ok, `sleep: ${r.text}`)
    return { said: r.text }
  },
  // ---- 地点 / 只读 ----
  async '地点_记住删除并前往'(lab) {
    const a = await lab.arena(3900, 0, 20)
    const m = await lab.cmd('bot mark 实验点', /记住了 实验点/, /$^/, 5000)
    assert(m.ok, m.text)
    rcon(`tp ${NAME} ${a.cx + 12.5} 100 ${a.cz + 0.5}`)
    await sleep(1500)
    const g = await lab.cmd('bot go 实验点', /到 实验点 了/, /失败|没记过/, 30_000)
    assert(g.ok && dist(lab.pos(), { x: a.cx + 0.5, y: 100, z: a.cz + 0.5 }) < 2.5, `go: ${g.text}`)
    const u = await lab.cmd('bot unmark 实验点', /已删除地点/, /$^/, 5000)
    assert(u.ok, u.text)
    return {}
  },
  async '读指令_scan_advice_look_inv_plan'(lab) {
    await lab.arena(4000, 0)
    lab.give('minecraft:oak_log', 3) // 镐子+工作台要 3 根：只给 2 根时结果取决于附近有没有树
    await sleep(800)
    for (const [c, re] of [['scan', /位置:/], ['advice', /储备|补给|缺|血|镐|食物/], ['look', /附近/], ['inv', /oak_log/], ['plan wooden_pickaxe', /共 \d+ 步|已经有/], ['hp', /血量/], ['status', /任务:/], ['places', /记过|\(/]]) {
      const r = await lab.cmd(`bot ${c}`, re, /$^/, 6000)
      assert(r.ok, `${c} 无正确响应`)
      await sleep(500)
    }
    return {}
  },
  // ---- 共享背包竞态 ----
  async '共享背包_合成中队友拿走材料不崩'(lab) {
    await lab.arena(4100, 0)
    lab.give('minecraft:oak_log', 4)
    await sleep(800)
    lab.say('bot get stick 8')
    await sleep(400)
    rcon(`clear ${TESTER} minecraft:oak_log`)
    const text = await lab.waitChat(/拿到了|拿不到|试了 3 轮|重新规划还是|失败|已停止/, 200_000)
    assert(text, '竞态后没有结论')
    assert(!!lab.child, 'bot 崩了')
    await lab.idle(30_000)
    const after = await lab.cmd('bot pos', /我在/, /$^/, 5000)
    assert(after.ok, '竞态后不响应')
    return { said: text }
  },
  // ---- 死亡恢复 ----
  async '死亡_重生后恢复响应'(lab) {
    await lab.arena(4200, 0)
    rcon(`kill ${NAME}`)
    const text = await lab.waitChat(/我挂了/, 15_000)
    assert(text, '没有死亡提示')
    await sleep(3000)
    const r = await lab.cmd('bot hp', /血量/, /$^/, 8000)
    assert(r.ok, '重生后不响应')
    const r2 = await lab.cmd('bot lastdeath', /./, /$^/, 5000)
    return { lastdeath: r2.text }
  },
  async '大背包_误用参数不崩'(lab) {
    await lab.arena(4300, 0)
    for (const m of ['bot mine', 'bot mine stone 99999', 'bot goto a b c', 'bot craft __proto__', 'bot get ../../etc 1', 'bot tunnel 北 9999', 'bot farm -1', 'bot breed dragon', 'bot equip']) {
      lab.say(m); await sleep(900)
    }
    await sleep(11_000) // 每人 10 秒 8 条的限流窗口过去
    assert(!!lab.child, 'bot 崩了')
    const r = await lab.cmd('bot pos', /我在/, /$^/, 8000)
    assert(r.ok, '误用后不响应')
    return { said: lab.chatSince().slice(-10) }
  },
}

async function main() {
  const lab = createLab({})
  rcon('gamerule spawn_mobs false')
  rcon('kill @e[type=!player]')
  await lab.startBot()
  await lab.startTester()
  await lab.run('existing', scenarios, process.argv.slice(2))
  await lab.stop()
  process.exit(0)
}
main().catch((err) => { console.error(err); process.exit(1) })
